import { describe, expect, it } from 'vitest';
import { asEntryId, asToolCallId, asTransactionId } from './ids.js';
import { replayTransactions } from './replay.js';
import type { TransactionBeginEvent, TransactionEndEvent } from './types.js';

function begin(id: string, parentTransactionId?: string): TransactionBeginEvent {
  return {
    version: 1,
    kind: 'begin',
    transactionId: asTransactionId(id),
    parentTransactionId: parentTransactionId === undefined ? undefined : asTransactionId(parentTransactionId),
    boundaryToolCallId: asToolCallId(`${id}-begin`),
    boundaryEntryId: asEntryId(`${id}-begin-entry`),
  };
}

function end(id: string): TransactionEndEvent {
  return {
    version: 1,
    kind: 'end',
    transactionId: asTransactionId(id),
    disposition: 'commit',
    boundaryToolCallId: asToolCallId(`${id}-end`),
    boundaryEntryId: asEntryId(`${id}-end-entry`),
  };
}

describe('replayTransactions', () => {
  it('reconstructs a nested stack', () => {
    const replay = replayTransactions([begin('outer'), begin('inner', 'outer')]);
    expect(replay.openStack.map((record) => record.transactionId)).toEqual(['outer', 'inner']);
    expect(replay.roots[0]?.children[0]?.transactionId).toBe('inner');
    expect(replay.diagnostics).toEqual([]);
  });

  it('diagnoses non-LIFO closure without corrupting the stack', () => {
    const replay = replayTransactions([begin('outer'), begin('inner', 'outer'), end('outer')]);
    expect(replay.diagnostics[0]?.code).toBe('non_lifo_end');
    expect(replay.openStack.map((record) => record.transactionId)).toEqual(['outer', 'inner']);
  });
});
