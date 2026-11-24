import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import { describe, expect, it } from 'vitest';
import { asEntryId, asToolCallId, asTransactionId } from './ids.js';
import { computeVisibleEntryIds } from './visibility.js';
import { TRANSACTION_ENTRY_TYPE, type TransactionBeginEvent, type TransactionEndEvent } from './types.js';

let clock = 0;

function messageEntry(id: string, message: AgentMessage): SessionEntry {
  return {
    type: 'message',
    id,
    parentId: null,
    timestamp: new Date(clock++).toISOString(),
    message,
  };
}

function userEntry(id: string, text: string): SessionEntry {
  return messageEntry(id, { role: 'user', content: text, timestamp: clock++ });
}

function assistantEntry(id: string, text: string): SessionEntry {
  return messageEntry(id, {
    role: 'assistant',
    content: [{ type: 'text', text }],
    provider: 'test',
    model: 'test',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: clock++,
  } as AgentMessage);
}

function boundaryEntries(name: 'transaction_begin' | 'transaction_end', callId: string): SessionEntry[] {
  return [
    messageEntry(`${callId}-call`, {
      role: 'assistant',
      content: [{ type: 'toolCall', id: callId, name, arguments: {} }],
      provider: 'test',
      model: 'test',
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'toolUse',
      timestamp: clock++,
    } as AgentMessage),
    messageEntry(`${callId}-result`, {
      role: 'toolResult',
      toolCallId: callId,
      toolName: name,
      content: [{ type: 'text', text: 'ok' }],
      isError: false,
      timestamp: clock++,
    }),
  ];
}

function transactionEntry(id: string, event: TransactionBeginEvent | TransactionEndEvent): SessionEntry {
  return {
    type: 'custom',
    id,
    parentId: null,
    timestamp: new Date(clock++).toISOString(),
    customType: TRANSACTION_ENTRY_TYPE,
    data: event,
  };
}

function begin(transactionId: string, callId: string, parentTransactionId?: string): TransactionBeginEvent {
  return {
    version: 1,
    kind: 'begin',
    transactionId: asTransactionId(transactionId),
    ...(parentTransactionId && { parentTransactionId: asTransactionId(parentTransactionId) }),
    boundaryToolCallId: asToolCallId(callId),
    boundaryEntryId: asEntryId(`${callId}-call`),
  };
}

function end(
  transactionId: string,
  callId: string,
  disposition: TransactionEndEvent['disposition'],
  extra: { summary?: string; result?: string; carryforward?: string } = {},
): TransactionEndEvent {
  const base = {
    version: 1,
    kind: 'end',
    transactionId: asTransactionId(transactionId),
    boundaryToolCallId: asToolCallId(callId),
    boundaryEntryId: asEntryId(`${callId}-call`),
  } as const;
  switch (disposition) {
    case 'commit':
      return { ...base, disposition };
    case 'compact':
      return { ...base, disposition, summary: extra.summary ?? 'summary' };
    case 'squash':
      return { ...base, disposition, result: extra.result ?? 'result' };
    case 'revert':
      return { ...base, disposition, carryforward: extra.carryforward ?? 'takeaway' };
  }
}

function compactionEntry(id: string, firstKeptEntryId: string): SessionEntry {
  return {
    type: 'compaction',
    id,
    parentId: null,
    timestamp: new Date(clock++).toISOString(),
    summary: 'compacted earlier work',
    firstKeptEntryId,
    tokensBefore: 100,
  };
}

function closedTransaction(
  transactionId: string,
  bodyText: string,
  disposition: TransactionEndEvent['disposition'],
): SessionEntry[] {
  return [
    ...boundaryEntries('transaction_begin', `${transactionId}-b`),
    transactionEntry(`${transactionId}-begin-entry`, begin(transactionId, `${transactionId}-b`)),
    assistantEntry(`${transactionId}-body`, bodyText),
    ...boundaryEntries('transaction_end', `${transactionId}-e`),
    transactionEntry(`${transactionId}-end-entry`, end(transactionId, `${transactionId}-e`, disposition)),
  ];
}

describe('computeVisibleEntryIds', () => {
  it('keeps every message on a plain branch', () => {
    const branch = [userEntry('u1', 'hello'), assistantEntry('a1', 'hi'), userEntry('u2', 'more')];

    expect(computeVisibleEntryIds(branch)).toEqual(new Set(['u1', 'a1', 'u2']));
  });

  it('hides the body and boundaries of a squashed transaction', () => {
    const branch = [
      userEntry('u1', 'before'),
      ...closedTransaction('tx', 'dead end work', 'squash'),
      userEntry('u2', 'after'),
    ];

    // The boundary turns stay in context. The stored end result here is a bare
    // acknowledgement, which the projection renders as a copy carrying the
    // retained text, so the stored entry itself counts as hidden.
    expect(computeVisibleEntryIds(branch)).toEqual(new Set(['u1', 'tx-b-call', 'tx-b-result', 'tx-e-call', 'u2']));
  });

  it('keeps the body of an open transaction visible', () => {
    const branch = [
      userEntry('u1', 'before'),
      ...boundaryEntries('transaction_begin', 'tx-b'),
      transactionEntry('tx-begin-entry', begin('tx', 'tx-b')),
      assistantEntry('tx-body', 'in progress'),
    ];

    expect(computeVisibleEntryIds(branch)).toEqual(
      new Set(['u1', 'tx-b-call', 'tx-b-result', 'tx-body']),
    );
  });

  it('keeps a committed transaction fully visible', () => {
    const branch = [userEntry('u1', 'before'), ...closedTransaction('tx', 'kept work', 'commit')];

    expect(computeVisibleEntryIds(branch)).toEqual(
      new Set(['u1', 'tx-b-call', 'tx-b-result', 'tx-body', 'tx-e-call', 'tx-e-result']),
    );
  });

  it('hides messages before the latest compaction cut', () => {
    const branch = [
      userEntry('u1', 'ancient'),
      userEntry('u2', 'kept'),
      compactionEntry('c1', 'u2'),
      userEntry('u3', 'recent'),
    ];

    expect(computeVisibleEntryIds(branch)).toEqual(new Set(['u2', 'u3']));
  });

  it('keeps the whole branch when firstKeptEntryId is unknown', () => {
    const branch = [
      userEntry('u1', 'ancient'),
      compactionEntry('c1', 'not-in-this-branch'),
      userEntry('u2', 'recent'),
    ];

    expect(computeVisibleEntryIds(branch)).toEqual(new Set(['u1', 'u2']));
  });

  it('still honors a post-cut disposition when a closed transaction sits before the cut', () => {
    const branch = [
      userEntry('u1', 'ancient'),
      ...closedTransaction('tx1', 'pre-cut exploration', 'revert'),
      userEntry('u2', 'kept'),
      compactionEntry('c1', 'u2'),
      ...closedTransaction('tx2', 'post-cut exploration', 'revert'),
      userEntry('u3', 'after'),
    ];

    // tx1's boundary messages fall entirely before the cut; that must not
    // disable projection for the tail, so tx2's revert still applies.
    expect(computeVisibleEntryIds(branch)).toEqual(new Set(['u2', 'tx2-b-call', 'tx2-b-result', 'tx2-e-call', 'u3']));
  });

  it('fails open when the projection is unsafe', () => {
    const branch = [
      userEntry('u1', 'before'),
      ...boundaryEntries('transaction_begin', 'tx-b'),
      transactionEntry('tx-begin-entry', begin('tx', 'tx-b')),
      assistantEntry('tx-body', 'work'),
      // The end event exists but its boundary messages are absent mid-branch,
      // producing a partial_boundary diagnostic.
      transactionEntry('tx-end-entry', end('tx', 'tx-e', 'revert')),
      userEntry('u2', 'after'),
    ];

    expect(computeVisibleEntryIds(branch)).toEqual(
      new Set(['u1', 'tx-b-call', 'tx-b-result', 'tx-body', 'u2']),
    );
  });
});
