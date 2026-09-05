import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { join } from 'node:path';

export const INDEX_DB_FILENAME = 'memento-index.sqlite3';
export const INDEX_SCHEMA_VERSION = 3;

export interface IndexStatements {
  getSyncState: StatementSync;
  upsertSyncState: StatementSync;
  insertEntry: StatementSync;
  insertEntryText: StatementSync;
  upsertTakeawayBegin: StatementSync;
  upsertTakeawayEnd: StatementSync;
  getTakeaway: StatementSync;
  deleteTakeawayFts: StatementSync;
  insertTakeawayFts: StatementSync;
}

export interface IndexDb {
  database: DatabaseSync;
  statements: IndexStatements;
}

const TABLES = ['sync_state', 'entries', 'entries_fts', 'takeaways', 'takeaways_fts'];

function dropSchema(database: DatabaseSync): void {
  for (const table of TABLES) database.exec(`DROP TABLE IF EXISTS ${table}`);
}

function createSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS sync_state (
      session_id TEXT PRIMARY KEY,
      entry_count INTEGER NOT NULL,
      file_size INTEGER,
      file_path TEXT
    );
    CREATE TABLE IF NOT EXISTS entries (
      session_id TEXT NOT NULL,
      entry_id TEXT NOT NULL,
      parent_id TEXT,
      timestamp TEXT NOT NULL,
      role TEXT NOT NULL,
      text TEXT NOT NULL,
      PRIMARY KEY (session_id, entry_id)
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
      text, content='entries', content_rowid='rowid', tokenize='trigram'
    );
    CREATE TABLE IF NOT EXISTS takeaways (
      session_id TEXT NOT NULL,
      transaction_id TEXT NOT NULL,
      purpose TEXT,
      disposition TEXT,
      summary TEXT,
      result TEXT,
      carryforward TEXT,
      next TEXT,
      begin_entry_id TEXT,
      end_entry_id TEXT,
      PRIMARY KEY (session_id, transaction_id)
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS takeaways_fts USING fts5(
      purpose, takeaway, carryforward, next, tokenize='trigram'
    );
    PRAGMA user_version = ${INDEX_SCHEMA_VERSION};
  `);
}

function prepareStatements(database: DatabaseSync): IndexStatements {
  return {
    getSyncState: database.prepare(
      'SELECT entry_count, file_size, file_path FROM sync_state WHERE session_id = ?',
    ),
    upsertSyncState: database.prepare(
      // COALESCE keeps a previously recorded file_path when a later
      // memory-backed sync passes NULL for it.
      `INSERT INTO sync_state (session_id, entry_count, file_size, file_path) VALUES (?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         entry_count = excluded.entry_count,
         file_size = excluded.file_size,
         file_path = COALESCE(excluded.file_path, sync_state.file_path)`,
    ),
    insertEntry: database.prepare(
      `INSERT INTO entries (session_id, entry_id, parent_id, timestamp, role, text) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING RETURNING rowid`,
    ),
    insertEntryText: database.prepare('INSERT INTO entries_fts (rowid, text) VALUES (?, ?)'),
    upsertTakeawayBegin: database.prepare(
      `INSERT INTO takeaways (session_id, transaction_id, purpose, begin_entry_id) VALUES (?, ?, ?, ?)
       ON CONFLICT(session_id, transaction_id) DO UPDATE SET
         purpose = excluded.purpose,
         begin_entry_id = excluded.begin_entry_id`,
    ),
    upsertTakeawayEnd: database.prepare(
      `INSERT INTO takeaways (session_id, transaction_id, disposition, summary, result, carryforward, next, end_entry_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id, transaction_id) DO UPDATE SET
         disposition = excluded.disposition,
         summary = excluded.summary,
         result = excluded.result,
         carryforward = excluded.carryforward,
         next = excluded.next,
         end_entry_id = excluded.end_entry_id`,
    ),
    getTakeaway: database.prepare(
      `SELECT rowid, purpose, summary, result, carryforward, next FROM takeaways
       WHERE session_id = ? AND transaction_id = ?`,
    ),
    deleteTakeawayFts: database.prepare('DELETE FROM takeaways_fts WHERE rowid = ?'),
    insertTakeawayFts: database.prepare(
      'INSERT INTO takeaways_fts (rowid, purpose, takeaway, carryforward, next) VALUES (?, ?, ?, ?, ?)',
    ),
  };
}

function readUserVersion(database: DatabaseSync): number {
  const row = database.prepare('PRAGMA user_version').get();
  return Number(row?.user_version ?? 0);
}

export function openIndexDb(sessionDir: string): IndexDb {
  const database = new DatabaseSync(join(sessionDir, INDEX_DB_FILENAME), { timeout: 5000 });
  database.exec('PRAGMA journal_mode=WAL');
  // The { timeout } open option may not exist on the oldest supported Node; the pragma always does.
  database.exec('PRAGMA busy_timeout = 5000');
  if (readUserVersion(database) !== INDEX_SCHEMA_VERSION) dropSchema(database);
  createSchema(database);
  return { database, statements: prepareStatements(database) };
}

export function resetIndexDb(db: IndexDb): void {
  dropSchema(db.database);
  createSchema(db.database);
}

export function closeIndexDb(db: IndexDb): void {
  db.database.close();
}

export function withIndexTransaction<T>(db: IndexDb, fn: () => T): T {
  db.database.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.database.exec('COMMIT');
    return result;
  } catch (error) {
    db.database.exec('ROLLBACK');
    throw error;
  }
}
