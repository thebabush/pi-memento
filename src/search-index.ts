import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import { asEntryId, asSessionId, type EntryId, type SessionId } from './ids.js';
import { withIndexTransaction, type IndexDb } from './search-db.js';
import { isTransactionEvent, TRANSACTION_ENTRY_TYPE, type TransactionEvent } from './types.js';

export interface SearchableText {
  role: string;
  text: string;
}

function partText(part: unknown): string | undefined {
  if (!part || typeof part !== 'object') return undefined;
  const candidate = part as Record<string, unknown>;
  if (candidate.type === 'text' && typeof candidate.text === 'string') return candidate.text;
  if (candidate.type === 'thinking' && typeof candidate.thinking === 'string') return candidate.thinking;
  if (candidate.type === 'toolCall' && typeof candidate.name === 'string') {
    return `${candidate.name} ${JSON.stringify(candidate.arguments ?? {})}`;
  }
  return undefined;
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map(partText)
    .filter((text): text is string => text !== undefined && text.length > 0)
    .join('\n');
}

export function searchableText(entry: SessionEntry): SearchableText | undefined {
  switch (entry.type) {
    case 'message': {
      const text = contentText('content' in entry.message ? entry.message.content : undefined);
      return text.trim().length > 0 ? { role: entry.message.role, text } : undefined;
    }
    case 'branch_summary':
    case 'compaction':
      return entry.summary.trim().length > 0 ? { role: entry.type, text: entry.summary } : undefined;
    case 'custom_message': {
      const text = contentText(entry.content);
      return text.trim().length > 0 ? { role: entry.type, text } : undefined;
    }
    default:
      return undefined;
  }
}

function upsertTakeaway(db: IndexDb, sessionId: SessionId, entryId: EntryId, event: TransactionEvent): void {
  if (event.kind === 'begin') {
    db.statements.upsertTakeawayBegin.run(sessionId, event.transactionId, event.purpose ?? null, entryId);
  } else {
    db.statements.upsertTakeawayEnd.run(
      sessionId,
      event.transactionId,
      event.disposition,
      event.summary ?? null,
      event.result ?? null,
      event.carryforward ?? null,
      event.next ?? null,
      entryId,
    );
  }
  const row = db.statements.getTakeaway.get(sessionId, event.transactionId);
  if (!row) return;
  const rowid = row.rowid ?? null;
  db.statements.deleteTakeawayFts.run(rowid);
  db.statements.insertTakeawayFts.run(
    rowid,
    row.purpose ?? null,
    row.summary ?? row.result ?? null,
    row.carryforward ?? null,
    row.next ?? null,
  );
}

function indexEntry(db: IndexDb, sessionId: SessionId, entry: SessionEntry): void {
  if (entry.type === 'custom') {
    if (entry.customType === TRANSACTION_ENTRY_TYPE && isTransactionEvent(entry.data)) {
      upsertTakeaway(db, sessionId, asEntryId(entry.id), entry.data);
    }
    return;
  }
  const extracted = searchableText(entry);
  if (!extracted) return;
  const row = db.statements.insertEntry.get(
    sessionId,
    entry.id,
    entry.parentId,
    entry.timestamp,
    extracted.role,
    extracted.text,
  );
  if (row) db.statements.insertEntryText.run(row.rowid ?? null, extracted.text);
}

function syncNewEntries(
  db: IndexDb,
  sessionId: SessionId,
  entries: readonly SessionEntry[],
  fileSize: number | null,
  filePath: string | null,
): void {
  const state = db.statements.getSyncState.get(sessionId);
  const indexed = state ? Number(state.entry_count) : 0;
  const fresh = entries.slice(indexed);
  if (fresh.length === 0 && state) {
    // File-backed sync with nothing new to index but a grown file (only a
    // torn or unparseable tail): refresh the recorded file_size so future
    // syncs skip the file instead of re-parsing it forever. Recording the
    // size seen at torn time is safe because a torn line can only complete
    // by adding bytes, which changes the size again. Memory syncs (fileSize
    // null) stay complete no-ops so they never clobber a recorded file_size.
    if (fileSize !== null && (state.file_size === null || Number(state.file_size) !== fileSize)) {
      db.statements.upsertSyncState.run(sessionId, indexed, fileSize, filePath);
    }
    return;
  }
  withIndexTransaction(db, () => {
    for (const entry of fresh) indexEntry(db, sessionId, entry);
    db.statements.upsertSyncState.run(sessionId, indexed + fresh.length, fileSize, filePath);
  });
}

export function syncEntries(db: IndexDb, sessionId: SessionId, entries: readonly SessionEntry[]): void {
  syncNewEntries(db, sessionId, entries, null, null);
}

function parseJsonObject(line: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(line);
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    // Torn or corrupt line; the caller stops at it.
  }
  return undefined;
}

/** Shallow shape check at the file boundary; entry bodies stay as pi wrote them. */
function isSessionEntryLike(value: Record<string, unknown>): value is Record<string, unknown> & SessionEntry {
  return (
    typeof value.type === 'string' &&
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    typeof value.timestamp === 'string' &&
    (value.parentId === null || value.parentId === undefined || typeof value.parentId === 'string')
  );
}

export interface ParsedSessionFile {
  sessionId: SessionId;
  fileSize: number;
  entries: SessionEntry[];
}

export function readSessionFileEntries(filePath: string): ParsedSessionFile | undefined {
  let buffer: Buffer;
  try {
    buffer = readFileSync(filePath);
  } catch {
    return undefined;
  }
  const fileSize = buffer.length;
  const content = buffer.toString('utf8');

  const headerEnd = content.indexOf('\n');
  const header = parseJsonObject(headerEnd < 0 ? content : content.slice(0, headerEnd));
  if (
    !header ||
    header.type !== 'session' ||
    typeof header.id !== 'string' ||
    header.id.length === 0 ||
    typeof header.cwd !== 'string'
  ) {
    return undefined;
  }

  const entries: SessionEntry[] = [];
  const lines = headerEnd < 0 ? [] : content.slice(headerEnd + 1).split('\n');
  for (const line of lines) {
    if (line === '') continue;
    const parsed = parseJsonObject(line);
    // A torn last line from a concurrent writer (or a corrupt line) stops the
    // scan without advancing the high-water mark past it.
    if (!parsed || !isSessionEntryLike(parsed)) break;
    entries.push(parsed);
  }

  return { sessionId: asSessionId(header.id), fileSize, entries };
}

export function syncSessionFile(db: IndexDb, filePath: string, opts?: { skipSessionId?: SessionId }): void {
  const parsed = readSessionFileEntries(filePath);
  if (!parsed || opts?.skipSessionId === parsed.sessionId) return;

  const state = db.statements.getSyncState.get(parsed.sessionId);
  if (state && state.file_size !== null && Number(state.file_size) === parsed.fileSize) return;

  syncNewEntries(db, parsed.sessionId, parsed.entries, parsed.fileSize, filePath);
}

export function syncProject(db: IndexDb, sessionDir: string, opts?: { skipSessionId?: SessionId }): void {
  let names: string[];
  try {
    names = readdirSync(sessionDir);
  } catch {
    return;
  }
  for (const name of names.sort()) {
    if (!name.endsWith('.jsonl')) continue;
    try {
      syncSessionFile(db, join(sessionDir, name), opts);
    } catch {
      // Best-effort discovery: one broken session file must not block the rest.
    }
  }
}
