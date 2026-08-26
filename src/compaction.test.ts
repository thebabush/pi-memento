import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import { describe, expect, it } from 'vitest';
import { planTransactionCompaction } from './compaction.js';
import { replayTransactions } from './replay.js';
import type { TransactionBeginEvent, TransactionEndEvent } from './types.js';

let timestamp = 0;

function entry(id: string, message: AgentMessage): SessionEntry {
  return {
    type: 'message',
    id,
    parentId: null,
    timestamp: new Date(timestamp++).toISOString(),
    message,
  };
}

function user(id: string, text: string): SessionEntry {
  return entry(id, { role: 'user', content: text, timestamp: timestamp++ });
}

function boundary(
  entryPrefix: string,
  name: 'transaction_begin' | 'transaction_end',
  callId: string,
): SessionEntry[] {
  return [
    entry(entryPrefix, {
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
      timestamp: timestamp++,
    } as AgentMessage),
    entry(`${entryPrefix}-result`, {
      role: 'toolResult',
      toolCallId: callId,
      toolName: name,
      content: [{ type: 'text', text: 'ok' }],
      isError: false,
      timestamp: timestamp++,
    }),
  ];
}

function begin(id: string, callId: string, boundaryEntryId: string, parentTransactionId?: string): TransactionBeginEvent {
  return {
    version: 1,
    kind: 'begin',
    transactionId: id,
    parentTransactionId,
    boundaryToolCallId: callId,
    boundaryEntryId,
  };
}

function end(id: string, callId: string, boundaryEntryId: string): TransactionEndEvent {
  return {
    version: 1,
    kind: 'end',
    transactionId: id,
    disposition: 'revert',
    carryforward: 'takeaway',
    boundaryToolCallId: callId,
    boundaryEntryId,
  };
}

describe('planTransactionCompaction', () => {
  it('keeps pi\'s cut when it is after a complete transaction', () => {
    const entries = [
      user('before', 'before'),
      ...boundary('begin-entry', 'transaction_begin', 'begin-call'),
      user('work', 'work'),
      ...boundary('end-entry', 'transaction_end', 'end-call'),
      user('kept', 'kept'),
    ];
    const replay = replayTransactions([
      begin('tx', 'begin-call', 'begin-entry'),
      end('tx', 'end-call', 'end-entry'),
    ]);

    const plan = planTransactionCompaction(entries, replay, 'kept');

    expect(plan.ok).toBe(true);
    if (plan.ok) expect(plan.firstKeptEntryId).toBe('kept');
  });

  it('moves a cut inside a closed transaction to its begin boundary', () => {
    const entries = [
      user('before', 'before'),
      ...boundary('begin-entry', 'transaction_begin', 'begin-call'),
      user('work', 'work'),
      ...boundary('end-entry', 'transaction_end', 'end-call'),
    ];
    const replay = replayTransactions([
      begin('tx', 'begin-call', 'begin-entry'),
      end('tx', 'end-call', 'end-entry'),
    ]);

    const plan = planTransactionCompaction(entries, replay, 'work');

    expect(plan.ok).toBe(true);
    if (plan.ok) {
      expect(plan.firstKeptEntryId).toBe('begin-entry');
      expect(plan.prefixEntries.map((item) => item.id)).toEqual(['before']);
    }
  });

  it('moves a nested cut to the outer transaction boundary', () => {
    const entries = [
      user('before', 'before'),
      ...boundary('outer-b', 'transaction_begin', 'outer-b-call'),
      ...boundary('inner-b', 'transaction_begin', 'inner-b-call'),
      user('inner-work', 'work'),
      ...boundary('inner-e', 'transaction_end', 'inner-e-call'),
      ...boundary('outer-e', 'transaction_end', 'outer-e-call'),
    ];
    const replay = replayTransactions([
      begin('outer', 'outer-b-call', 'outer-b'),
      begin('inner', 'inner-b-call', 'inner-b', 'outer'),
      end('inner', 'inner-e-call', 'inner-e'),
      end('outer', 'outer-e-call', 'outer-e'),
    ]);

    const plan = planTransactionCompaction(entries, replay, 'inner-work');

    expect(plan.ok).toBe(true);
    if (plan.ok) expect(plan.firstKeptEntryId).toBe('outer-b');
  });

  it('keeps an open transaction entirely in the retained tail', () => {
    const entries = [
      user('before', 'before'),
      ...boundary('begin-entry', 'transaction_begin', 'begin-call'),
      user('work', 'work'),
    ];
    const replay = replayTransactions([begin('tx', 'begin-call', 'begin-entry')]);

    const plan = planTransactionCompaction(entries, replay, 'work');

    expect(plan.ok).toBe(true);
    if (plan.ok) expect(plan.firstKeptEntryId).toBe('begin-entry');
  });

  it('tells the model to close an open transaction spanning the whole session', () => {
    const entries = [
      ...boundary('begin-entry', 'transaction_begin', 'begin-call'),
      user('work', 'work'),
    ];
    const replay = replayTransactions([
      { ...begin('open-tx', 'begin-call', 'begin-entry'), purpose: 'giant refactor' },
    ]);

    const plan = planTransactionCompaction(entries, replay, 'work');

    expect(plan).toMatchObject({ ok: false, code: 'nothing_to_compact' });
    if (!plan.ok) {
      expect(plan.reason).toContain('open-tx');
      expect(plan.reason).toContain('giant refactor');
      expect(plan.reason).toContain('transaction_end');
    }
  });

  it('fails safely when a boundary entry is missing', () => {
    const entries = [user('before', 'before'), user('kept', 'kept')];
    const replay = replayTransactions([begin('tx', 'missing', 'missing-entry')]);

    const plan = planTransactionCompaction(entries, replay, 'kept');

    expect(plan).toMatchObject({ ok: false, code: 'invalid_boundary' });
  });
});
