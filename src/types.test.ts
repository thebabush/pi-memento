import { describe, expect, it } from 'vitest';
import { isTransactionEvent } from './types.js';

const endBase = {
  version: 1,
  kind: 'end',
  transactionId: 'tx',
  boundaryToolCallId: 'call',
  boundaryEntryId: 'entry',
} as const;

describe('isTransactionEvent', () => {
  it('accepts semantically valid disposition payloads', () => {
    expect(isTransactionEvent({ ...endBase, disposition: 'commit' })).toBe(true);
    expect(isTransactionEvent({ ...endBase, disposition: 'compact', summary: 'durable summary' })).toBe(true);
    expect(isTransactionEvent({ ...endBase, disposition: 'squash', result: 'durable result' })).toBe(true);
    expect(isTransactionEvent({ ...endBase, disposition: 'revert', carryforward: 'avoid X' })).toBe(true);
  });

  it('rejects disposition payloads that would project destructively', () => {
    expect(isTransactionEvent({ ...endBase, disposition: 'compact' })).toBe(false);
    expect(isTransactionEvent({ ...endBase, disposition: 'squash', result: '   ' })).toBe(false);
    expect(isTransactionEvent({ ...endBase, disposition: 'commit', carryforward: 'ambiguous' })).toBe(false);
    expect(isTransactionEvent({ ...endBase, disposition: 'revert', result: 'not allowed' })).toBe(false);
    expect(isTransactionEvent({ ...endBase, disposition: 'revert' })).toBe(false);
    expect(isTransactionEvent({ ...endBase, disposition: 'revert', carryforward: '   ' })).toBe(false);
  });
});
