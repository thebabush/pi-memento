import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { describe, expect, it } from 'vitest';
import { closedTransactionText, projectMessages } from './project.js';
import { replayTransactions } from './replay.js';
import type { TransactionBeginEvent, TransactionEndEvent, TransactionEvent } from './types.js';

let timestamp = 0;

function user(text: string): AgentMessage {
  return { role: 'user', content: text, timestamp: timestamp++ };
}

function assistant(text: string): AgentMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    provider: 'test',
    model: 'test',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'stop',
    timestamp: timestamp++,
  } as AgentMessage;
}

function boundary(name: 'transaction_begin' | 'transaction_end', id: string): AgentMessage[] {
  return [
    {
      role: 'assistant',
      content: [{ type: 'toolCall', id, name, arguments: {} }],
      provider: 'test',
      model: 'test',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: 'toolUse',
      timestamp: timestamp++,
    } as AgentMessage,
    {
      role: 'toolResult',
      toolCallId: id,
      toolName: name,
      content: [{ type: 'text', text: 'ok' }],
      isError: false,
      timestamp: timestamp++,
    },
  ];
}

function begin(id: string, callId: string, parentTransactionId?: string): TransactionBeginEvent {
  return {
    version: 1,
    kind: 'begin',
    transactionId: id,
    parentTransactionId,
    boundaryToolCallId: callId,
    boundaryEntryId: `entry-${callId}`,
  };
}

function end(
  id: string,
  callId: string,
  disposition: TransactionEndEvent['disposition'],
  extra: { summary?: string; result?: string; carryforward?: string; next?: string } = {},
): TransactionEndEvent {
  const base = {
    version: 1,
    kind: 'end',
    transactionId: id,
    boundaryToolCallId: callId,
    boundaryEntryId: `entry-${callId}`,
  } as const;
  const optional = {
    ...(extra.carryforward && { carryforward: extra.carryforward }),
    ...(extra.next && { next: extra.next }),
  };
  switch (disposition) {
    case 'commit':
      return { ...base, disposition };
    case 'compact':
      return { ...base, disposition, summary: extra.summary ?? 'summary', ...optional };
    case 'squash':
      return { ...base, disposition, result: extra.result ?? 'result', ...optional };
    case 'revert':
      return { ...base, disposition, carryforward: extra.carryforward ?? 'takeaway', ...optional };
  }
}

function text(messages: AgentMessage[]): string {
  return messages
    .flatMap((message) => {
      if (message.role === 'custom') return [String(message.content)];
      if (message.role === 'user' && typeof message.content === 'string') return [message.content];
      if (message.role === 'assistant') {
        return message.content.filter((part) => part.type === 'text').map((part) => part.text);
      }
      if (message.role === 'toolResult') {
        return message.content.flatMap((part) => (part.type === 'text' ? [`${message.toolName}: ${part.text}`] : []));
      }
      return [];
    })
    .join('|');
}

describe('projectMessages', () => {
  it('removes a reverted transaction and retains its carryforward', () => {
    const messages = [
      user('before'),
      ...boundary('transaction_begin', 'begin-1'),
      assistant('dead end'),
      ...boundary('transaction_end', 'end-1'),
      user('after'),
    ];
    const closed = end('tx-1', 'end-1', 'revert', { carryforward: 'Do not retry X' });
    const events: TransactionEvent[] = [begin('tx-1', 'begin-1'), closed];

    const result = projectMessages(messages, replayTransactions(events));

    expect(result.safe).toBe(true);
    expect(text(result.messages)).toBe(
      `before|transaction_begin: ok|transaction_end: ${closedTransactionText(closed)}|after`,
    );
    expect(closedTransactionText(closed)).toContain('Carryforward: Do not retry X');
  });

  it('projects a revert as its carryforward followed by its next action', () => {
    const messages = [
      user('before'),
      ...boundary('transaction_begin', 'begin-1'),
      assistant('dead end'),
      ...boundary('transaction_end', 'end-1'),
      user('after'),
    ];
    const closed = end('tx-1', 'end-1', 'revert', { carryforward: 'X is a dead end', next: 'try Y instead' });
    const events: TransactionEvent[] = [begin('tx-1', 'begin-1'), closed];

    const result = projectMessages(messages, replayTransactions(events));

    expect(result.safe).toBe(true);
    expect(text(result.messages)).toBe(
      `before|transaction_begin: ok|transaction_end: ${closedTransactionText(closed)}|after`,
    );
    expect(closedTransactionText(closed)).toBe(
      'Closed transaction tx-1 with disposition revert\nIts body is removed from your context.\n' +
        'Carryforward: X is a dead end\nNext action: try Y instead',
    );
  });

  it('retains a committed transaction exactly', () => {
    const messages = [user('before'), ...boundary('transaction_begin', 'b'), assistant('work'), ...boundary('transaction_end', 'e')];
    const result = projectMessages(messages, replayTransactions([begin('tx', 'b'), end('tx', 'e', 'commit')]));

    expect(result.messages).toEqual(messages);
  });

  it('projects a reverted child inside an open parent', () => {
    const messages = [
      ...boundary('transaction_begin', 'outer-b'),
      assistant('outer work'),
      ...boundary('transaction_begin', 'inner-b'),
      assistant('inner dead end'),
      ...boundary('transaction_end', 'inner-e'),
      assistant('outer continues'),
    ];
    const closed = end('inner', 'inner-e', 'revert', { carryforward: 'inner takeaway' });
    const events: TransactionEvent[] = [begin('outer', 'outer-b'), begin('inner', 'inner-b', 'outer'), closed];

    const result = projectMessages(messages, replayTransactions(events));

    expect(result.safe).toBe(true);
    expect(text(result.messages)).toBe(
      'transaction_begin: ok|outer work|transaction_begin: ok|' +
        `transaction_end: ${closedTransactionText(closed)}|outer continues`,
    );
    expect(result.messages.some((message) => message.role === 'toolResult' && message.toolCallId === 'outer-b')).toBe(true);
  });

  it('lets an outer revert remove a committed child', () => {
    const messages = [
      user('before'),
      ...boundary('transaction_begin', 'outer-b'),
      ...boundary('transaction_begin', 'inner-b'),
      assistant('important child work'),
      ...boundary('transaction_end', 'inner-e'),
      ...boundary('transaction_end', 'outer-e'),
      user('after'),
    ];
    const closed = end('outer', 'outer-e', 'revert', { carryforward: 'outer takeaway' });
    const events: TransactionEvent[] = [
      begin('outer', 'outer-b'),
      begin('inner', 'inner-b', 'outer'),
      end('inner', 'inner-e', 'commit'),
      closed,
    ];

    const result = projectMessages(messages, replayTransactions(events));

    expect(text(result.messages)).toBe(
      `before|transaction_begin: ok|transaction_end: ${closedTransactionText(closed)}|after`,
    );
    expect(text(result.messages)).not.toContain('important child work');
  });

  it('replaces compact and squash transactions with their durable outputs', () => {
    const messages = [
      ...boundary('transaction_begin', 'compact-b'),
      assistant('long investigation'),
      ...boundary('transaction_end', 'compact-e'),
      ...boundary('transaction_begin', 'squash-b'),
      assistant('derivation'),
      ...boundary('transaction_end', 'squash-e'),
    ];
    const compacted = end('compact', 'compact-e', 'compact', { summary: 'Found Y' });
    const squashed = end('squash', 'squash-e', 'squash', { result: 'foo is synchronous', next: 'call it directly' });
    const events: TransactionEvent[] = [begin('compact', 'compact-b'), compacted, begin('squash', 'squash-b'), squashed];

    const result = projectMessages(messages, replayTransactions(events));

    expect(text(result.messages)).toBe(
      `transaction_begin: ok|transaction_end: ${closedTransactionText(compacted)}|` +
        `transaction_begin: ok|transaction_end: ${closedTransactionText(squashed)}`,
    );
    expect(closedTransactionText(compacted)).toBe(
      'Closed transaction compact with disposition compact\nIts body is replaced in your context by this summary:\nFound Y',
    );
    // The agent's own boundary calls stay in context.
    const calls = result.messages.flatMap((message) =>
      message.role === 'assistant' ? message.content.filter((part) => part.type === 'toolCall').map((part) => part.id) : [],
    );
    expect(calls).toEqual(['compact-b', 'compact-e', 'squash-b', 'squash-e']);
  });

  it('keeps the stored end result object when it already carries the retained text', () => {
    const closed = end('tx', 'e', 'squash', { result: 'done' });
    const endTurn = boundary('transaction_end', 'e');
    const stored = endTurn[1]!;
    if (stored.role === 'toolResult') stored.content = [{ type: 'text', text: closedTransactionText(closed) }];
    const messages = [...boundary('transaction_begin', 'b'), assistant('work'), ...endTurn];

    const result = projectMessages(messages, replayTransactions([begin('tx', 'b'), closed]));

    expect(result.messages.at(-1)).toBe(stored);
  });

  it('fails closed when only one side of a boundary is visible', () => {
    const messages = [user('before'), boundary('transaction_begin', 'b')[0]!, assistant('work')];
    const result = projectMessages(messages, replayTransactions([begin('tx', 'b')]));

    expect(result.safe).toBe(false);
    expect(result.messages).toEqual(messages);
    expect(result.diagnostics[0]?.code).toBe('partial_boundary');
  });

  it('fails closed when an open transaction begins outside the current context', () => {
    const messages = [user('before'), assistant('work')];
    const result = projectMessages(messages, replayTransactions([begin('tx', 'b')]));

    expect(result.safe).toBe(false);
    expect(result.messages).toEqual(messages);
    expect(result.diagnostics[0]?.code).toBe('missing_boundary');
  });

  it('fails closed when a boundary assistant message contains a sibling tool call', () => {
    const mixed = boundary('transaction_begin', 'b');
    const assistantMessage = mixed[0]!;
    if (assistantMessage.role === 'assistant') {
      assistantMessage.content.push({ type: 'toolCall', id: 'sibling', name: 'read', arguments: {} });
    }
    const messages = [user('before'), ...mixed, assistant('work')];
    const result = projectMessages(messages, replayTransactions([begin('tx', 'b')]));

    expect(result.safe).toBe(false);
    expect(result.messages).toEqual(messages);
  });
});
