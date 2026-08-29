import type { SQLOutputValue } from 'node:sqlite';
import { asEntryId, asSessionId, asTransactionId, type EntryId, type SessionId, type TransactionId } from './ids.js';
import type { IndexDb } from './search-db.js';

export type SearchLayer = 'takeaways' | 'full';

interface SearchHitBase {
  sessionId: SessionId;
  score: number; // higher is better (negated bm25)
}

export interface EntrySearchHit extends SearchHitBase {
  kind: 'entry';
  entryId: EntryId;
  role: string;
  timestamp: string;
  snippet: string;
}

export interface TakeawaySearchHit extends SearchHitBase {
  kind: 'takeaway';
  transactionId: TransactionId;
  // An open transaction legitimately has no disposition or takeaway yet.
  purpose?: string;
  disposition?: string;
  takeaway?: string; // summary or result
  carryforward?: string;
}

export type SearchHit = EntrySearchHit | TakeawaySearchHit;

export interface SearchResult {
  hits: SearchHit[];
  // False only when a filtered scan hit the total-scan budget while fewer
  // than `limit` hits were collected and matching rows may remain unseen;
  // the results may then be incomplete. True everywhere else: unfiltered
  // queries, `limit` hits collected, or matches exhausted within budget.
  scanExhausted: boolean;
}

export interface SearchOptions {
  query: string;
  layer: SearchLayer;
  limit?: number; // default 20
  sessionId?: SessionId; // restrict to one session
  entryIdFilter?: ReadonlySet<EntryId>; // e.g. active-branch entry ids; entry hits only, applied to entryId
}

const DEFAULT_LIMIT = 20;
// When entryIdFilter forces post-filtering in JS, ranked rows are fetched in
// batches of this size until enough hits are collected or the matches run out…
const SCAN_BATCH_SIZE = 200;
// …but never more than this many rows in total, so a pathological query that
// matches everything still terminates quickly.
const SCAN_BUDGET = 5000;

// bm25() returns lower-is-better; both queries order ascending and hits carry
// the negated value so higher is better. rowid breaks rank ties so that
// LIMIT/OFFSET pagination is stable across re-runs of the statement.
const ENTRY_SQL = `
  SELECT e.session_id, e.entry_id, e.role, e.timestamp,
         snippet(entries_fts, 0, '<<', '>>', '…', 24) AS snip,
         bm25(entries_fts) AS rank
  FROM entries_fts JOIN entries e ON e.rowid = entries_fts.rowid
  WHERE entries_fts MATCH ? AND (? IS NULL OR e.session_id = ?)
  ORDER BY rank, e.rowid
  LIMIT ? OFFSET ?`;

const TAKEAWAY_SQL = `
  SELECT t.session_id, t.transaction_id, t.purpose, t.disposition, t.summary, t.result,
         t.carryforward, t.begin_entry_id, t.end_entry_id,
         bm25(takeaways_fts, 1.0, 2.0, 1.5) AS rank
  FROM takeaways_fts JOIN takeaways t ON t.rowid = takeaways_fts.rowid
  WHERE takeaways_fts MATCH ? AND (? IS NULL OR t.session_id = ?)
  ORDER BY rank, t.rowid
  LIMIT ? OFFSET ?`;

/**
 * Recognizes errors SQLite raises for a problem in the FTS5 MATCH expression
 * itself, as opposed to a broken statement or database. Message shapes
 * observed empirically with node:sqlite:
 *
 * - 'fts5: syntax error near "…"' — stray parentheses, bare or trailing
 *   operators (`AND`, `NOT foo`)
 * - 'unterminated string' — an unbalanced double quote
 * - 'unknown special query: …' — a leading `*`
 * - 'no such column: …' — a `col:term`, `-term`, or `{col} term` query naming
 *   a column the FTS table does not have
 *
 * 'no such column' is deliberately counted as query syntax: the MATCH string
 * is the only user-controlled text that can name a column, our own SQL is
 * fixed and test-covered, and the phrase fallback cures the user-typed form
 * (`"col:term"` is a plain phrase). The residual risk of masking a
 * programmer's bad column reference is accepted for that UX.
 */
export function isFts5QueryError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message;
  return (
    message.includes('fts5: syntax error') ||
    message.includes('unterminated string') ||
    message.includes('unknown special query') ||
    message.includes('no such column')
  );
}

/**
 * Runs an FTS5 MATCH with a raw user query; if SQLite rejects its syntax
 * (unbalanced quotes, bare operators, stray parentheses), retries with the
 * query wrapped as a double-quoted phrase, doubling embedded quotes. If even
 * the phrase form is rejected as query syntax, returns no rows rather than
 * throwing: search is best-effort over untrusted query strings. Any other
 * error (missing table, closed database, broken SQL) propagates.
 */
export function runMatchQuery<T>(query: string, run: (match: string) => T[]): T[] {
  try {
    return run(query);
  } catch (error) {
    if (!isFts5QueryError(error)) throw error;
    // Invalid MATCH syntax; fall through to the phrase form.
  }
  try {
    return run(`"${query.replaceAll('"', '""')}"`);
  } catch (error) {
    if (!isFts5QueryError(error)) throw error;
    return [];
  }
}

type IndexRow = Record<string, SQLOutputValue>;

function asText(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asScore(value: unknown): number {
  if (typeof value === 'number') return -value;
  if (typeof value === 'bigint') return -Number(value);
  return 0;
}

/**
 * Decodes one ENTRY_SQL row, narrowing every column in one place. A row
 * missing a required field (impossible while the schema's NOT NULL
 * constraints hold) is dropped rather than surfaced with holes.
 */
function decodeEntryHitRow(row: IndexRow): EntrySearchHit | undefined {
  const sessionId = asText(row.session_id);
  const entryId = asText(row.entry_id);
  const role = asText(row.role);
  const timestamp = asText(row.timestamp);
  const snippet = asText(row.snip);
  if (
    sessionId === undefined ||
    entryId === undefined ||
    role === undefined ||
    timestamp === undefined ||
    snippet === undefined
  ) {
    return undefined;
  }
  return {
    kind: 'entry',
    sessionId: asSessionId(sessionId),
    score: asScore(row.rank),
    entryId: asEntryId(entryId),
    role,
    timestamp,
    snippet,
  };
}

interface DecodedTakeawayHitRow {
  hit: TakeawaySearchHit;
  // Boundary entry ids feed the branch filter only; they are not hit fields.
  beginEntryId?: EntryId;
  endEntryId?: EntryId;
}

/** Decodes one TAKEAWAY_SQL row; same contract as decodeEntryHitRow. */
function decodeTakeawayHitRow(row: IndexRow): DecodedTakeawayHitRow | undefined {
  const sessionId = asText(row.session_id);
  const transactionId = asText(row.transaction_id);
  if (sessionId === undefined || transactionId === undefined) return undefined;
  const beginEntryId = asText(row.begin_entry_id);
  const endEntryId = asText(row.end_entry_id);
  return {
    hit: {
      kind: 'takeaway',
      sessionId: asSessionId(sessionId),
      score: asScore(row.rank),
      transactionId: asTransactionId(transactionId),
      purpose: asText(row.purpose),
      disposition: asText(row.disposition),
      takeaway: asText(row.summary) ?? asText(row.result),
      carryforward: asText(row.carryforward),
    },
    beginEntryId: beginEntryId === undefined ? undefined : asEntryId(beginEntryId),
    endEntryId: endEntryId === undefined ? undefined : asEntryId(endEntryId),
  };
}

/**
 * Collects up to `limit` hits from ranked rows. Without a filter a single
 * fetch of `limit` rows suffices and the scan is always exhaustive. With a
 * filter, rows are fetched in batches and filtered in JS until `limit` hits
 * are collected, the matches run out (a short batch), or the scan budget is
 * reached. `scanExhausted` is false only in the last case with fewer than
 * `limit` hits: the budget was consumed while the final batch came back full,
 * so more matching rows may remain unseen. (When the match count equals the
 * budget exactly this is conservatively still reported as not exhausted.)
 */
function scanRankedRows<Row>(
  fetchBatch: (batchLimit: number, offset: number) => Row[],
  toHit: (row: Row) => SearchHit | undefined,
  limit: number,
  filtered: boolean,
): SearchResult {
  const hits: SearchHit[] = [];
  if (!filtered) {
    for (const row of fetchBatch(limit, 0)) {
      const hit = toHit(row);
      if (hit) hits.push(hit);
    }
    return { hits, scanExhausted: true };
  }

  let offset = 0;
  while (hits.length < limit) {
    const batchLimit = Math.min(SCAN_BATCH_SIZE, SCAN_BUDGET - offset);
    if (batchLimit <= 0) return { hits, scanExhausted: false };
    const rows = fetchBatch(batchLimit, offset);
    for (const row of rows) {
      const hit = toHit(row);
      if (hit) {
        hits.push(hit);
        if (hits.length >= limit) break;
      }
    }
    if (rows.length < batchLimit) break; // matches exhausted
    offset += rows.length;
  }
  return { hits, scanExhausted: true };
}

function entryHits(db: IndexDb, options: SearchOptions, limit: number): SearchResult {
  const sessionId = options.sessionId ?? null;
  const statement = db.database.prepare(ENTRY_SQL);
  return scanRankedRows(
    (batchLimit, offset) =>
      runMatchQuery(options.query, (match) =>
        statement.all(match, sessionId, sessionId, batchLimit, offset),
      ),
    (row) => {
      const hit = decodeEntryHitRow(row);
      if (!hit) return undefined;
      if (options.entryIdFilter && !options.entryIdFilter.has(hit.entryId)) return undefined;
      return hit;
    },
    limit,
    options.entryIdFilter !== undefined,
  );
}

function takeawayOnBranch(
  filter: ReadonlySet<EntryId>,
  beginEntryId: EntryId | undefined,
  endEntryId: EntryId | undefined,
): boolean {
  return (
    (beginEntryId !== undefined && filter.has(beginEntryId)) ||
    (endEntryId !== undefined && filter.has(endEntryId))
  );
}

function takeawayHits(db: IndexDb, options: SearchOptions, limit: number): SearchResult {
  const sessionId = options.sessionId ?? null;
  const statement = db.database.prepare(TAKEAWAY_SQL);
  return scanRankedRows(
    (batchLimit, offset) =>
      runMatchQuery(options.query, (match) =>
        statement.all(match, sessionId, sessionId, batchLimit, offset),
      ),
    (row) => {
      const decoded = decodeTakeawayHitRow(row);
      if (!decoded) return undefined;
      if (
        options.entryIdFilter &&
        !takeawayOnBranch(options.entryIdFilter, decoded.beginEntryId, decoded.endEntryId)
      ) {
        return undefined;
      }
      return decoded.hit;
    },
    limit,
    options.entryIdFilter !== undefined,
  );
}

export function searchIndex(db: IndexDb, options: SearchOptions): SearchResult {
  const limit = options.limit ?? DEFAULT_LIMIT;
  if (limit <= 0 || options.query.length === 0) return { hits: [], scanExhausted: true };

  const takeaways = takeawayHits(db, options, limit);
  if (options.layer === 'takeaways') return takeaways;

  // bm25 scores from two different FTS tables are only roughly comparable;
  // the merged ordering is a useful heuristic, not an exact relevance rank.
  const entries = entryHits(db, options, limit);
  const hits = [...takeaways.hits, ...entries.hits].sort((a, b) => b.score - a.score).slice(0, limit);
  return { hits, scanExhausted: takeaways.scanExhausted && entries.scanExhausted };
}
