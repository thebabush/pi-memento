import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { ExtensionContext, SessionEntry } from '@earendil-works/pi-coding-agent';
import { describe, expect, it } from 'vitest';
import { assertExclusiveBoundary, assertHealthyReplay, transactionEvents } from './session.js';
import { TRANSACTION_ENTRY_TYPE, type ReplayResult, type TransactionEvent } from './types.js';

let clock = 0;

interface ToolCallPart {
  type: 'toolCall';
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

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

function assistantEntry(id: string, content: ({ type: 'text'; text: string } | ToolCallPart)[]): SessionEntry {
  return messageEntry(id, {
    role: 'assistant',
    content,
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
  } as AgentMessage);
}

function customEntry(id: string, customType: string, data: unknown): SessionEntry {
  return {
    type: 'custom',
    id,
    parentId: null,
    timestamp: new Date(clock++).toISOString(),
    customType,
    data,
  };
}

function toolCall(id: string, name: string): ToolCallPart {
  return { type: 'toolCall', id, name, arguments: {} };
}

function contextWithLeaf(leaf: SessionEntry | undefined): ExtensionContext {
  return { sessionManager: { getLeafEntry: () => leaf } } as unknown as ExtensionContext;
}

describe('transactionEvents', () => {
  const begin: TransactionEvent = {
    version: 1,
    kind: 'begin',
    transactionId: 'tx',
    boundaryToolCallId: 'begin-call',
    boundaryEntryId: 'begin-entry',
  };
  const end: TransactionEvent = {
    version: 1,
    kind: 'end',
    transactionId: 'tx',
    disposition: 'commit',
    boundaryToolCallId: 'end-call',
    boundaryEntryId: 'end-entry',
  };

  it('returns nothing for an empty branch', () => {
    expect(transactionEvents([])).toEqual([]);
  });

  it('keeps valid transaction entries and skips everything else', () => {
    const entries: SessionEntry[] = [
      userEntry('user', 'hello'),
      customEntry('other-extension', 'some-other-type', begin),
      customEntry('begin', TRANSACTION_ENTRY_TYPE, begin),
      customEntry('wrong-version', TRANSACTION_ENTRY_TYPE, { ...begin, version: 2 }),
      customEntry('not-an-object', TRANSACTION_ENTRY_TYPE, 'garbage'),
      customEntry('missing-data', TRANSACTION_ENTRY_TYPE, undefined),
      customEntry('invalid-shape', TRANSACTION_ENTRY_TYPE, { ...end, summary: 'commit forbids summary' }),
      customEntry('end', TRANSACTION_ENTRY_TYPE, end),
    ];

    expect(transactionEvents(entries)).toEqual([begin, end]);
  });
});

describe('assertHealthyReplay', () => {
  function replayWith(diagnostics: ReplayResult['diagnostics']): ReplayResult {
    return { roots: [], openStack: [], records: new Map(), diagnostics };
  }

  it('accepts a replay without diagnostics', () => {
    expect(() => assertHealthyReplay(replayWith([]))).not.toThrow();
  });

  it('throws with the first diagnostic message', () => {
    const replay = replayWith([
      { code: 'unknown_end', message: 'transaction ghost ends without a matching begin', transactionId: 'ghost' },
      { code: 'non_lifo_end', message: 'later diagnostic', transactionId: 'other' },
    ]);

    expect(() => assertHealthyReplay(replay)).toThrow(
      'Transaction metadata is inconsistent: transaction ghost ends without a matching begin',
    );
  });
});

describe('assertExclusiveBoundary', () => {
  it('returns the leaf id when the tool call is the only one in the assistant message', () => {
    const leaf = assistantEntry('leaf', [
      { type: 'text', text: 'opening a transaction' },
      toolCall('call-1', 'transaction_begin'),
    ]);

    expect(assertExclusiveBoundary(contextWithLeaf(leaf), 'call-1', 'transaction_begin')).toBe('leaf');
  });

  it('throws when there is no leaf entry', () => {
    expect(() => assertExclusiveBoundary(contextWithLeaf(undefined), 'call-1', 'transaction_begin')).toThrow(
      'transaction_begin must be called from a persisted assistant message',
    );
  });

  it('throws when the leaf is not an assistant message', () => {
    const leaf = userEntry('leaf', 'not an assistant message');

    expect(() => assertExclusiveBoundary(contextWithLeaf(leaf), 'call-1', 'transaction_begin')).toThrow(
      'transaction_begin must be called from a persisted assistant message',
    );
  });

  it('throws when the leaf is not a message entry', () => {
    const leaf = customEntry('leaf', TRANSACTION_ENTRY_TYPE, undefined);

    expect(() => assertExclusiveBoundary(contextWithLeaf(leaf), 'call-1', 'transaction_begin')).toThrow(
      'transaction_begin must be called from a persisted assistant message',
    );
  });

  it('throws when a sibling tool call shares the assistant message', () => {
    const leaf = assistantEntry('leaf', [
      toolCall('call-1', 'transaction_begin'),
      toolCall('call-2', 'read_file'),
    ]);

    expect(() => assertExclusiveBoundary(contextWithLeaf(leaf), 'call-1', 'transaction_begin')).toThrow(
      'transaction_begin must be the only tool call in its assistant message; call it again by itself',
    );
  });

  it('throws when the tool call id does not match', () => {
    const leaf = assistantEntry('leaf', [toolCall('other-call', 'transaction_begin')]);

    expect(() => assertExclusiveBoundary(contextWithLeaf(leaf), 'call-1', 'transaction_begin')).toThrow(
      'transaction_begin must be the only tool call in its assistant message',
    );
  });

  it('throws when the tool name does not match', () => {
    const leaf = assistantEntry('leaf', [toolCall('call-1', 'transaction_begin')]);

    expect(() => assertExclusiveBoundary(contextWithLeaf(leaf), 'call-1', 'transaction_end')).toThrow(
      'transaction_end must be the only tool call in its assistant message',
    );
  });
});
