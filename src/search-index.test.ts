import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { SessionEntry, SessionHeader } from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { asEntryId, asSessionId, asToolCallId, asTransactionId } from './ids.js';
import { openIndexDb, type IndexDb } from './search-db.js';
import { syncEntries, syncProject, syncSessionFile } from './search-index.js';
import { TRANSACTION_ENTRY_TYPE, type TransactionBeginEvent, type TransactionEndEvent } from './types.js';

let clock = 0;
let dir: string;
let db: IndexDb;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'memento-search-'));
  db = openIndexDb(dir);
});

afterEach(() => {
  db.database.close();
  rmSync(dir, { recursive: true, force: true });
});

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

function toolResultEntry(id: string, toolCallId: string, text: string): SessionEntry {
  return messageEntry(id, {
    role: 'toolResult',
    toolCallId,
    toolName: 'read_file',
    content: [{ type: 'text', text }],
    isError: false,
    timestamp: clock++,
  });
}

function modelChangeEntry(id: string): SessionEntry {
  return {
    type: 'model_change',
    id,
    parentId: null,
    timestamp: new Date(clock++).toISOString(),
    provider: 'test',
    modelId: 'test',
  };
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

function begin(transactionId: string, entryId: string, purpose?: string): TransactionBeginEvent {
  return {
    version: 1,
    kind: 'begin',
    transactionId: asTransactionId(transactionId),
    purpose,
    boundaryToolCallId: asToolCallId(`${transactionId}-begin-call`),
    boundaryEntryId: asEntryId(entryId),
  };
}

function indexedEntryIds(sessionId: string): string[] {
  return db.database
    .prepare('SELECT entry_id FROM entries WHERE session_id = ? ORDER BY rowid')
    .all(sessionId)
    .map((row) => String(row.entry_id));
}

function matchEntryIds(query: string): string[] {
  return db.database
    .prepare(
      `SELECT e.entry_id FROM entries_fts f JOIN entries e ON e.rowid = f.rowid
       WHERE entries_fts MATCH ? ORDER BY e.rowid`,
    )
    .all(query)
    .map((row) => String(row.entry_id));
}

function matchTakeawayIds(query: string): string[] {
  return db.database
    .prepare(
      `SELECT t.transaction_id FROM takeaways_fts f JOIN takeaways t ON t.rowid = f.rowid
       WHERE takeaways_fts MATCH ? ORDER BY t.rowid`,
    )
    .all(query)
    .map((row) => String(row.transaction_id));
}

function header(id: string): string {
  const value: SessionHeader = {
    type: 'session',
    version: 3,
    id,
    timestamp: new Date(clock++).toISOString(),
    cwd: '/tmp/project',
  };
  return JSON.stringify(value);
}

function writeSessionFile(name: string, sessionId: string, entries: SessionEntry[]): string {
  const filePath = join(dir, name);
  writeFileSync(filePath, [header(sessionId), ...entries.map((entry) => JSON.stringify(entry))].map((line) => `${line}\n`).join(''));
  return filePath;
}

describe('syncEntries', () => {
  it('indexes message text, tool calls, and tool results and skips non-text entries', () => {
    syncEntries(db, asSessionId('sess'), [
      userEntry('u1', 'please investigate the frobnicateWidget helper'),
      assistantEntry('a1', [
        { type: 'text', text: 'reading the file now' },
        { type: 'toolCall', id: 'call-1', name: 'read_file', arguments: { path: 'src/widget-helpers.ts' } },
      ]),
      toolResultEntry('t1', 'call-1', 'export function frobnicateWidget() {}'),
      modelChangeEntry('m1'),
    ]);

    expect(indexedEntryIds('sess')).toEqual(['u1', 'a1', 't1']);
    expect(
      db.database.prepare("SELECT role FROM entries WHERE entry_id = 't1'").get()?.role,
    ).toBe('toolResult');
    expect(matchEntryIds('frobnicateWidget')).toEqual(['u1', 't1']);
    // Trigram tokenization matches substrings of identifiers and tool arguments.
    expect(matchEntryIds('obnicateWidg')).toEqual(['u1', 't1']);
    expect(matchEntryIds('"widget-helpers.ts"')).toEqual(['a1']);
  });

  it('supports snippet() over matched entries via external-content FTS', () => {
    syncEntries(db, asSessionId('sess'), [userEntry('u1', 'please investigate the frobnicateWidget helper')]);

    const row = db.database
      .prepare(
        `SELECT snippet(entries_fts, 0, '[', ']', '…', 64) AS snippet
         FROM entries_fts WHERE entries_fts MATCH 'frobnicateWidget'`,
      )
      .get();
    expect(String(row?.snippet)).toContain('frobnicateWidget');
  });

  it('indexes branch summaries, compactions, and custom messages', () => {
    const entries: SessionEntry[] = [
      {
        type: 'branch_summary',
        id: 'b1',
        parentId: null,
        timestamp: new Date(clock++).toISOString(),
        fromId: 'u0',
        summary: 'explored the tokenizer dead end',
      },
      {
        type: 'compaction',
        id: 'c1',
        parentId: 'b1',
        timestamp: new Date(clock++).toISOString(),
        summary: 'earlier work settled the parser design',
        firstKeptEntryId: 'b1',
        tokensBefore: 100,
      },
      {
        type: 'custom_message',
        id: 'cm1',
        parentId: 'c1',
        timestamp: new Date(clock++).toISOString(),
        customType: 'some-extension',
        content: 'remember the flag --strict-nulls',
        display: false,
      },
    ];

    syncEntries(db, asSessionId('sess'), entries);

    expect(indexedEntryIds('sess')).toEqual(['b1', 'c1', 'cm1']);
    expect(matchEntryIds('tokenizer dead end')).toEqual(['b1']);
    expect(matchEntryIds('parser design')).toEqual(['c1']);
    expect(matchEntryIds('"--strict-nulls"')).toEqual(['cm1']);
  });

  it('indexes only the tail on a second sync and is a no-op when nothing grew', () => {
    const entries = [userEntry('u1', 'first message text')];
    syncEntries(db, asSessionId('sess'), entries);
    expect(indexedEntryIds('sess')).toEqual(['u1']);

    const grown = [...entries, userEntry('u2', 'second message text')];
    syncEntries(db, asSessionId('sess'), grown);
    expect(indexedEntryIds('sess')).toEqual(['u1', 'u2']);

    syncEntries(db, asSessionId('sess'), grown);
    expect(indexedEntryIds('sess')).toEqual(['u1', 'u2']);
    expect(db.statements.getSyncState.get('sess')?.entry_count).toBe(2);
    expect(matchEntryIds('message text')).toEqual(['u1', 'u2']);
  });

  it('keeps the same entry indexed once for two sessions independently', () => {
    syncEntries(db, asSessionId('one'), [userEntry('u1', 'session one content')]);
    syncEntries(db, asSessionId('two'), [userEntry('u1', 'session two content')]);

    expect(indexedEntryIds('one')).toEqual(['u1']);
    expect(indexedEntryIds('two')).toEqual(['u1']);
  });
});

describe('syncEntries takeaways', () => {
  function endEvent(event: TransactionEndEvent): TransactionEndEvent {
    return event;
  }

  it('upserts a squash across separate begin and end syncs', () => {
    const entries: SessionEntry[] = [
      transactionEntry('begin-1', begin('tx-1', 'begin-1', 'investigate flaky websocket reconnects')),
    ];
    syncEntries(db, asSessionId('sess'), entries);

    let row = db.statements.getTakeaway.get('sess', 'tx-1');
    expect(row?.purpose).toBe('investigate flaky websocket reconnects');
    expect(row?.result).toBeNull();

    entries.push(
      transactionEntry(
        'end-1',
        endEvent({
          version: 1,
          kind: 'end',
          transactionId: asTransactionId('tx-1'),
          disposition: 'squash',
          result: 'reconnect loop was missing backoff jitter',
          carryforward: 'always add jitter to retry loops',
          boundaryToolCallId: asToolCallId('tx-1-end-call'),
          boundaryEntryId: asEntryId('end-1'),
        }),
      ),
    );
    syncEntries(db, asSessionId('sess'), entries);

    row = db.database
      .prepare('SELECT * FROM takeaways WHERE session_id = ? AND transaction_id = ?')
      .get('sess', 'tx-1');
    expect(row).toMatchObject({
      purpose: 'investigate flaky websocket reconnects',
      disposition: 'squash',
      result: 'reconnect loop was missing backoff jitter',
      carryforward: 'always add jitter to retry loops',
      begin_entry_id: 'begin-1',
      end_entry_id: 'end-1',
    });

    expect(matchTakeawayIds('purpose: "flaky websocket"')).toEqual(['tx-1']);
    expect(matchTakeawayIds('takeaway: "backoff jitter"')).toEqual(['tx-1']);
    expect(matchTakeawayIds('carryforward: "retry loops"')).toEqual(['tx-1']);
    // Takeaway custom entries never land in the entries index.
    expect(indexedEntryIds('sess')).toEqual([]);
  });

  it('records a revert carryforward without polluting other columns', () => {
    syncEntries(db, asSessionId('sess'), [
      transactionEntry('begin-1', begin('tx-1', 'begin-1')),
      transactionEntry(
        'end-1',
        endEvent({
          version: 1,
          kind: 'end',
          transactionId: asTransactionId('tx-1'),
          disposition: 'revert',
          carryforward: 'the legacy parser cannot handle multiline headers',
          boundaryToolCallId: asToolCallId('tx-1-end-call'),
          boundaryEntryId: asEntryId('end-1'),
        }),
      ),
    ]);

    const row = db.statements.getTakeaway.get('sess', 'tx-1');
    expect(row?.summary).toBeNull();
    expect(row?.result).toBeNull();
    expect(matchTakeawayIds('carryforward: "multiline headers"')).toEqual(['tx-1']);
    expect(matchTakeawayIds('takeaway: "multiline headers"')).toEqual([]);
  });

  it('indexes the next action in its own column', () => {
    syncEntries(db, asSessionId('sess'), [
      transactionEntry('begin-1', begin('tx-1', 'begin-1')),
      transactionEntry(
        'end-1',
        endEvent({
          version: 1,
          kind: 'end',
          transactionId: asTransactionId('tx-1'),
          disposition: 'revert',
          carryforward: 'the legacy parser cannot handle multiline headers',
          next: 'switch the ingest path to the streaming parser',
          boundaryToolCallId: asToolCallId('tx-1-end-call'),
          boundaryEntryId: asEntryId('end-1'),
        }),
      ),
    ]);

    const row = db.statements.getTakeaway.get('sess', 'tx-1');
    expect(row?.next).toBe('switch the ingest path to the streaming parser');
    expect(matchTakeawayIds('next: "streaming parser"')).toEqual(['tx-1']);
    expect(matchTakeawayIds('carryforward: "streaming parser"')).toEqual([]);
    // An unqualified query spans the new column too.
    expect(matchTakeawayIds('"streaming parser"')).toEqual(['tx-1']);
  });
});

describe('syncSessionFile', () => {
  it('indexes a session file and only the appended tail on re-sync', () => {
    const filePath = writeSessionFile('one.jsonl', 'sess-file', [
      userEntry('u1', 'first file message'),
      userEntry('u2', 'second file message'),
    ]);

    syncSessionFile(db, filePath);
    expect(indexedEntryIds('sess-file')).toEqual(['u1', 'u2']);

    appendFileSync(filePath, `${JSON.stringify(userEntry('u3', 'appended file message'))}\n`);
    syncSessionFile(db, filePath);
    expect(indexedEntryIds('sess-file')).toEqual(['u1', 'u2', 'u3']);
    expect(db.statements.getSyncState.get('sess-file')?.entry_count).toBe(3);

    syncSessionFile(db, filePath);
    expect(indexedEntryIds('sess-file')).toEqual(['u1', 'u2', 'u3']);
  });

  it('records file_path and preserves it across a later in-memory sync', () => {
    const filePath = writeSessionFile('one.jsonl', 'sess-file', [userEntry('u1', 'first file message')]);

    syncSessionFile(db, filePath);
    expect(db.statements.getSyncState.get('sess-file')?.file_path).toBe(filePath);

    syncEntries(db, asSessionId('sess-file'), [
      userEntry('u1', 'first file message'),
      userEntry('u2', 'second message'),
    ]);
    expect(indexedEntryIds('sess-file')).toEqual(['u1', 'u2']);
    expect(db.statements.getSyncState.get('sess-file')?.file_path).toBe(filePath);
  });

  it('stops at a torn trailing line and indexes it once completed', () => {
    const filePath = writeSessionFile('torn.jsonl', 'sess-torn', [userEntry('u1', 'complete line')]);
    const torn = JSON.stringify(userEntry('u2', 'initially torn line'));
    appendFileSync(filePath, torn.slice(0, 25));

    expect(() => syncSessionFile(db, filePath)).not.toThrow();
    expect(indexedEntryIds('sess-torn')).toEqual(['u1']);

    appendFileSync(filePath, `${torn.slice(25)}\n`);
    syncSessionFile(db, filePath);
    expect(indexedEntryIds('sess-torn')).toEqual(['u1', 'u2']);
  });

  it('refreshes file_size when the file grows only by an unparseable tail', () => {
    const filePath = writeSessionFile('tail.jsonl', 'sess-tail', [userEntry('u1', 'complete line')]);
    syncSessionFile(db, filePath);
    const before = db.statements.getSyncState.get('sess-tail');

    const garbage = 'this is not json and never will be\n';
    appendFileSync(filePath, garbage);
    syncSessionFile(db, filePath);

    // Nothing new was indexable, but the recorded size follows the file so
    // future syncs skip it via the size check instead of re-parsing forever.
    const after = db.statements.getSyncState.get('sess-tail');
    expect(after?.entry_count).toBe(1);
    expect(Number(after?.file_size)).toBe(Number(before?.file_size) + garbage.length);
    expect(after?.file_path).toBe(filePath);
    expect(indexedEntryIds('sess-tail')).toEqual(['u1']);

    // Unchanged content re-syncs through the size-skip early return: the
    // sync_state row and the indexed entries stay exactly as they were.
    syncSessionFile(db, filePath);
    expect(db.statements.getSyncState.get('sess-tail')).toEqual(after);
    expect(indexedEntryIds('sess-tail')).toEqual(['u1']);

    // A memory sync with nothing fresh stays a complete no-op and does not
    // clobber the recorded file_size.
    syncEntries(db, asSessionId('sess-tail'), [userEntry('u1', 'complete line')]);
    expect(db.statements.getSyncState.get('sess-tail')).toEqual(after);
  });

  it('skips a garbage file without throwing', () => {
    const filePath = join(dir, 'garbage.jsonl');
    writeFileSync(filePath, 'not json at all\n{"also": "not a session"}\n');

    expect(() => syncSessionFile(db, filePath)).not.toThrow();
    expect(db.database.prepare('SELECT count(*) AS n FROM entries').get()?.n).toBe(0);
  });

  it('skips a file whose header has no session id', () => {
    const filePath = join(dir, 'headless.jsonl');
    writeFileSync(filePath, `${JSON.stringify({ type: 'session', cwd: '/tmp/project' })}\n`);
    appendFileSync(filePath, `${JSON.stringify(userEntry('u1', 'orphaned message'))}\n`);

    syncSessionFile(db, filePath);
    expect(db.database.prepare('SELECT count(*) AS n FROM entries').get()?.n).toBe(0);
  });

  it('ignores a missing file', () => {
    expect(() => syncSessionFile(db, join(dir, 'missing.jsonl'))).not.toThrow();
  });
});

describe('syncProject', () => {
  it('indexes every session file and honors skipSessionId', () => {
    writeSessionFile('one.jsonl', 'sess-one', [userEntry('u1', 'first session content')]);
    writeSessionFile('two.jsonl', 'sess-two', [userEntry('u1', 'second session content')]);
    writeFileSync(join(dir, 'notes.txt'), 'not a session file');

    syncProject(db, dir, { skipSessionId: asSessionId('sess-two') });
    expect(indexedEntryIds('sess-one')).toEqual(['u1']);
    expect(indexedEntryIds('sess-two')).toEqual([]);

    syncProject(db, dir);
    expect(indexedEntryIds('sess-two')).toEqual(['u1']);
  });

  it('ignores a missing session directory', () => {
    expect(() => syncProject(db, join(dir, 'does-not-exist'))).not.toThrow();
  });
});
