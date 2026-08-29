import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  closeIndexDb,
  INDEX_DB_FILENAME,
  INDEX_SCHEMA_VERSION,
  openIndexDb,
  resetIndexDb,
  withIndexTransaction,
  type IndexDb,
} from './search-db.js';

let dir: string;
let db: IndexDb | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'memento-index-'));
  db = undefined;
});

afterEach(() => {
  db?.database.close();
  rmSync(dir, { recursive: true, force: true });
});

function tableNames(handle: IndexDb): string[] {
  return handle.database
    .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((row) => String(row.name));
}

function countEntries(handle: IndexDb): number {
  return Number(handle.database.prepare('SELECT count(*) AS n FROM entries').get()?.n);
}

describe('openIndexDb', () => {
  it('creates the schema and stamps the schema version', () => {
    db = openIndexDb(dir);

    const names = tableNames(db);
    for (const expected of ['sync_state', 'entries', 'entries_fts', 'takeaways', 'takeaways_fts']) {
      expect(names).toContain(expected);
    }
    expect(db.database.prepare('PRAGMA user_version').get()?.user_version).toBe(INDEX_SCHEMA_VERSION);
  });

  it('keeps data across reopen when the schema version matches', () => {
    db = openIndexDb(dir);
    db.statements.insertEntry.get('sess', 'entry-1', null, '2026-01-01T00:00:00.000Z', 'user', 'hello world');
    closeIndexDb(db);

    db = openIndexDb(dir);
    expect(countEntries(db)).toBe(1);
  });

  it('rebuilds an empty index when the schema version differs', () => {
    db = openIndexDb(dir);
    db.statements.insertEntry.get('sess', 'entry-1', null, '2026-01-01T00:00:00.000Z', 'user', 'hello world');
    closeIndexDb(db);

    const raw = new DatabaseSync(join(dir, INDEX_DB_FILENAME));
    raw.exec(`PRAGMA user_version = ${INDEX_SCHEMA_VERSION + 1}`);
    raw.close();

    db = openIndexDb(dir);
    expect(countEntries(db)).toBe(0);
    expect(db.database.prepare('PRAGMA user_version').get()?.user_version).toBe(INDEX_SCHEMA_VERSION);
  });

  it('treats a duplicate entry insert as a no-op', () => {
    db = openIndexDb(dir);

    const first = db.statements.insertEntry.get('sess', 'entry-1', null, '2026-01-01T00:00:00.000Z', 'user', 'hello world');
    const second = db.statements.insertEntry.get('sess', 'entry-1', null, '2026-01-01T00:00:00.000Z', 'user', 'hello world');

    expect(first?.rowid).toBeDefined();
    expect(second).toBeUndefined();
    expect(countEntries(db)).toBe(1);
  });
});

describe('resetIndexDb', () => {
  it('drops all indexed data and recreates the schema', () => {
    db = openIndexDb(dir);
    db.statements.insertEntry.get('sess', 'entry-1', null, '2026-01-01T00:00:00.000Z', 'user', 'hello world');
    db.statements.upsertSyncState.run('sess', 1, null, null);

    resetIndexDb(db);

    expect(countEntries(db)).toBe(0);
    expect(db.statements.getSyncState.get('sess')).toBeUndefined();
  });
});

describe('withIndexTransaction', () => {
  it('commits all writes together', () => {
    db = openIndexDb(dir);
    const handle = db;

    withIndexTransaction(handle, () => {
      handle.statements.insertEntry.get('sess', 'entry-1', null, '2026-01-01T00:00:00.000Z', 'user', 'hello world');
      handle.statements.upsertSyncState.run('sess', 1, null, null);
    });

    expect(countEntries(handle)).toBe(1);
    expect(handle.statements.getSyncState.get('sess')?.entry_count).toBe(1);
  });

  it('rolls everything back when the batch throws', () => {
    db = openIndexDb(dir);
    const handle = db;

    expect(() =>
      withIndexTransaction(handle, () => {
        handle.statements.insertEntry.get('sess', 'entry-1', null, '2026-01-01T00:00:00.000Z', 'user', 'hello world');
        throw new Error('boom');
      }),
    ).toThrow('boom');

    expect(countEntries(handle)).toBe(0);
  });
});
