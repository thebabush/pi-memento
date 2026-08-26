import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { describe, expect, it } from 'vitest';
import { projectMessages } from './project.js';
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
  extra: { summary?: string; result?: string; carryforward?: string } = {},
): TransactionEndEvent {
  const base = {
    version: 1,
    kind: 'end',
    transactionId: id,
    boundaryToolCallId: callId,
    boundaryEntryId: `entry-${callId}`,
  } as const;
  switch (disposition) {
    case 'commit':
      return { ...base, disposition };
    case 'compact':
      return { ...base, disposition, summary: extra.summary ?? 'summary', ...(extra.carryforward && { carryforward: extra.carryforward }) };
    case 'squash':
      return { ...base, disposition, result: extra.result ?? 'result', ...(extra.carryforward && { carryforward: extra.carryforward }) };
    case 'revert':
      return { ...base, disposition, carryforward: extra.carryforward ?? 'takeaway' };
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
    const events: TransactionEvent[] = [
      begin('tx-1', 'begin-1'),
      end('tx-1', 'end-1', 'revert', { carryforward: 'Do not retry X' }),
    ];

    const result = projectMessages(messages, replayTransactions(events));

    expect(result.safe).toBe(true);
    expect(text(result.messages)).toBe('before|[Carryforward: Do not retry X]|after');
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
    const events: TransactionEvent[] = [
      begin('outer', 'outer-b'),
      begin('inner', 'inner-b', 'outer'),
      end('inner', 'inner-e', 'revert', { carryforward: 'inner takeaway' }),
    ];

    const result = projectMessages(messages, replayTransactions(events));

    expect(result.safe).toBe(true);
    expect(text(result.messages)).toBe('outer work|[Carryforward: inner takeaway]|outer continues');
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
    const events: TransactionEvent[] = [
      begin('outer', 'outer-b'),
      begin('inner', 'inner-b', 'outer'),
      end('inner', 'inner-e', 'commit'),
      end('outer', 'outer-e', 'revert', { carryforward: 'outer takeaway' }),
    ];

    const result = projectMessages(messages, replayTransactions(events));

    expect(text(result.messages)).toBe('before|[Carryforward: outer takeaway]|after');
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
    const events: TransactionEvent[] = [
      begin('compact', 'compact-b'),
      end('compact', 'compact-e', 'compact', { summary: 'Found Y' }),
      begin('squash', 'squash-b'),
      end('squash', 'squash-e', 'squash', { result: 'foo is synchronous' }),
    ];

    const result = projectMessages(messages, replayTransactions(events));

    expect(text(result.messages)).toBe('[Transaction summary: Found Y]|[Transaction result: foo is synchronous]');
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
