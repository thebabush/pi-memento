import type { SQLOutputValue } from 'node:sqlite';
import { StringEnum, Type } from '@earendil-works/pi-ai';
import { defineTool, type ExtensionContext, type SessionEntry } from '@earendil-works/pi-coding-agent';
import { assertNever } from './assert.js';
import {
  asEntryId,
  asSessionId,
  asTransactionId,
  type EntryId,
  type SessionId,
  type TransactionId,
} from './ids.js';
import { closeIndexDb, openIndexDb, type IndexDb } from './search-db.js';
import { readSessionFileEntries, searchableText, syncEntries, syncProject } from './search-index.js';
import {
  searchIndex,
  type EntrySearchHit,
  type SearchHit,
  type SearchLayer,
  type SearchOptions,
} from './search.js';
import { isTransactionEvent } from './types.js';
import { computeVisibleEntryIds } from './visibility.js';

export type SearchScope = 'branch' | 'session' | 'project';

// Rendered tool-result budgets; both leave room for the model to keep the
// result in context without drowning it.
const SEARCH_CHAR_BUDGET = 8000;
const RECALL_CHAR_BUDGET = 20000;

// One lazily opened index handle per session directory, shared by both tools.
const openDbs = new Map<string, IndexDb>();

function indexDbFor(sessionDir: string): IndexDb {
  const cached = openDbs.get(sessionDir);
  if (cached) return cached;
  const db = openIndexDb(sessionDir);
  openDbs.set(sessionDir, db);
  return db;
}

/** Closes and forgets every cached index handle (tests and shutdown). */
export function closeSearchDbs(): void {
  for (const db of openDbs.values()) {
    try {
      closeIndexDb(db);
    } catch {
      // Already closed; nothing to release.
    }
  }
  openDbs.clear();
}

interface SearchToolResult<Details> {
  content: { type: 'text'; text: string }[];
  details: Details;
}

interface SearchDetails {
  layer: SearchLayer;
  scope: SearchScope;
  total: number;
  shown: number;
}

interface EntryRecallDetails {
  sessionId: SessionId;
  entryId: EntryId;
}

interface TransactionRecallDetails {
  sessionId: SessionId;
  transactionId: TransactionId;
}

type RecallDetails = EntryRecallDetails | TransactionRecallDetails;

function textResult<Details>(text: string, details: Details): SearchToolResult<Details> {
  return { content: [{ type: 'text', text }], details };
}

type IndexRow = Record<string, SQLOutputValue>;

function asText(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Decodes the sync_state read; only file_path is consumed here. */
function decodeSyncStateRow(row: IndexRow): { filePath?: string } {
  return { filePath: asText(row.file_path) };
}

interface RecalledEntryRow {
  role: string;
  timestamp: string;
  text: string;
}

/**
 * Decodes the entry-recall row, narrowing every column in one place. A row
 * missing a required field (impossible while the schema's NOT NULL
 * constraints hold) decodes to undefined and is treated as not found.
 */
function decodeRecalledEntryRow(row: IndexRow): RecalledEntryRow | undefined {
  const role = asText(row.role);
  const timestamp = asText(row.timestamp);
  const text = asText(row.text);
  if (role === undefined || timestamp === undefined || text === undefined) return undefined;
  return { role, timestamp, text };
}

interface RecalledTakeawayRow {
  purpose?: string;
  disposition?: string;
  takeaway?: string; // summary or result
  carryforward?: string;
  beginEntryId?: EntryId;
  endEntryId?: EntryId;
}

/** Decodes the transaction-recall row; every takeaway column is nullable. */
function decodeRecalledTakeawayRow(row: IndexRow): RecalledTakeawayRow {
  const beginEntryId = asText(row.begin_entry_id);
  const endEntryId = asText(row.end_entry_id);
  return {
    purpose: asText(row.purpose),
    disposition: asText(row.disposition),
    takeaway: asText(row.summary) ?? asText(row.result),
    carryforward: asText(row.carryforward),
    beginEntryId: beginEntryId === undefined ? undefined : asEntryId(beginEntryId),
    endEntryId: endEntryId === undefined ? undefined : asEntryId(endEntryId),
  };
}

function normalized(value: string | undefined): string | undefined {
  const result = value?.trim();
  return result ? result : undefined;
}

function entryMarker(hit: EntrySearchHit, currentSessionId: SessionId, visible: ReadonlySet<EntryId>): string {
  if (hit.sessionId !== currentSessionId) return 'other session';
  return visible.has(hit.entryId) ? 'visible' : 'forgotten';
}

function renderHit(hit: SearchHit, currentSessionId: SessionId, visible: ReadonlySet<EntryId>): string {
  const foreign = hit.sessionId !== currentSessionId;
  switch (hit.kind) {
    case 'entry': {
      const marker = entryMarker(hit, currentSessionId, visible);
      const provenance = foreign ? ` session=${hit.sessionId}` : '';
      const recallSession = foreign ? ` sessionId=${hit.sessionId}` : '';
      return [
        `entry (${marker}) ${hit.role} @ ${hit.timestamp}${provenance}`,
        `  ${hit.snippet}`,
        `  recall: entryId=${hit.entryId}${recallSession}`,
      ].join('\n');
    }
    case 'takeaway': {
      const marker = `${hit.disposition ?? 'open'}${foreign ? ', other session' : ''}`;
      const lines = [`takeaway (${marker})${hit.purpose ? ` purpose: ${hit.purpose}` : ''}`];
      if (hit.takeaway) lines.push(`  ${hit.takeaway}`);
      if (hit.carryforward) lines.push(`  carryforward: ${hit.carryforward}`);
      lines.push(`  recall: transactionId=${hit.transactionId}${foreign ? ` sessionId=${hit.sessionId}` : ''}`);
      return lines.join('\n');
    }
    default:
      return assertNever(hit);
  }
}

function emptyResultText(query: string, layer: SearchLayer, scope: SearchScope): string {
  const escalations: string[] = [];
  if (layer === 'takeaways') escalations.push("layer 'full' to search complete entry text");
  if (scope === 'branch') escalations.push("scope 'session' to include other branches");
  if (scope !== 'project') escalations.push("scope 'project' to include other sessions");
  const hint = escalations.length > 0 ? ` Try ${escalations.join(', then ')}.` : '';
  return (
    `No matches for "${query}" (layer=${layer}, scope=${scope}).${hint}` +
    ' Note: terms shorter than 3 characters cannot match (trigram index).'
  );
}

// Appended when the branch-scope scan budget cut the search short.
const SCAN_CUT_SHORT_NOTE =
  "Note: the scan budget was reached before this branch was fully searched; results may be incomplete. Narrow the query or drop the branch filter with scope 'session'.";

function scopeOptions(
  scope: SearchScope,
  sessionId: SessionId,
  branch: readonly SessionEntry[],
): Pick<SearchOptions, 'sessionId' | 'entryIdFilter'> {
  switch (scope) {
    case 'branch':
      // Branch scope must filter on ALL branch entry ids (every entry type):
      // takeaway rows reference the transaction custom entries, not messages.
      return { sessionId, entryIdFilter: new Set(branch.map((entry) => asEntryId(entry.id))) };
    case 'session':
      return { sessionId };
    case 'project':
      return {};
    default:
      return assertNever(scope);
  }
}

interface RenderSearchOptions {
  hits: SearchHit[];
  layer: SearchLayer;
  scope: SearchScope;
  currentSessionId: SessionId;
  visible: ReadonlySet<EntryId>;
  scanExhausted: boolean;
}

function renderSearchResult(options: RenderSearchOptions): SearchToolResult<SearchDetails> {
  const { hits, layer, scope, scanExhausted } = options;
  const blocks = hits.map((hit) => renderHit(hit, options.currentSessionId, options.visible));
  const parts = [`${hits.length} hit${hits.length === 1 ? '' : 's'} (layer=${layer}, scope=${scope})`];
  let used = parts[0]!.length;
  let shown = 0;
  for (const block of blocks) {
    if (used + block.length + 2 > SEARCH_CHAR_BUDGET) break;
    parts.push(block);
    used += block.length + 2;
    shown += 1;
  }
  let text = parts.join('\n\n');
  if (shown < blocks.length) {
    text += `\n\n…truncated: ${blocks.length - shown} more hit${blocks.length - shown === 1 ? '' : 's'} not shown; narrow the query.`;
  }
  if (!scanExhausted) text += `\n\n${SCAN_CUT_SHORT_NOTE}`;
  return textResult(text, { layer, scope, total: hits.length, shown });
}

export const contextSearchTool = defineTool({
  name: 'context_search',
  label: 'Search forgotten context',
  description:
    'Search canonical session history for this project, including work hidden from the current context by squash, revert, compact, compaction, or abandoned branches.',
  promptSnippet: 'Search your own forgotten conversational history.',
  promptGuidelines: [
    'Use context_search to search your own forgotten history: work that was reverted, squashed, or compacted away, lost to compaction, or left on abandoned branches. Nothing is ever lost; projections only hide canonical history.',
    "context_search defaults are narrow and cheap: final takeaways on the current branch. Escalate layer to 'full' or scope to 'session'/'project' only when the defaults do not surface what you need.",
    "Use context_recall with a hit's entryId or transactionId (plus sessionId for hits from other sessions) to pull the full content behind a hit.",
    'Wrap a noisy search-and-recall excursion in a transaction and squash it when done, so the excursion itself does not pollute your context.',
  ],
  parameters: Type.Object({
    query: Type.String({ description: 'Search terms; terms of 3+ characters (trigram index)' }),
    layer: Type.Optional(StringEnum(['takeaways', 'full'] as const)),
    scope: Type.Optional(StringEnum(['branch', 'session', 'project'] as const)),
  }),
  async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
    const query = normalized(params.query);
    if (!query) throw new Error('query must be a non-empty string');
    const layer: SearchLayer = params.layer ?? 'takeaways';
    const scope: SearchScope = params.scope ?? 'branch';

    const db = indexDbFor(ctx.sessionManager.getSessionDir());
    const sessionId = asSessionId(ctx.sessionManager.getSessionId());
    syncEntries(db, sessionId, ctx.sessionManager.getEntries());
    if (scope === 'project') {
      syncProject(db, ctx.sessionManager.getSessionDir(), { skipSessionId: sessionId });
    }

    const branch = ctx.sessionManager.getBranch();
    const { hits, scanExhausted } = searchIndex(db, {
      query,
      layer,
      ...scopeOptions(scope, sessionId, branch),
    });
    if (hits.length === 0) {
      const suffix = scanExhausted ? '' : `\n\n${SCAN_CUT_SHORT_NOTE}`;
      return textResult(emptyResultText(query, layer, scope) + suffix, {
        layer,
        scope,
        total: 0,
        shown: 0,
      });
    }

    const visible = computeVisibleEntryIds(branch);
    return renderSearchResult({ hits, layer, scope, currentSessionId: sessionId, visible, scanExhausted });
  },
});

function sessionEntriesFor(
  db: IndexDb,
  ctx: ExtensionContext,
  sessionId: SessionId,
): readonly SessionEntry[] {
  if (sessionId === asSessionId(ctx.sessionManager.getSessionId())) return ctx.sessionManager.getEntries();
  const state = db.statements.getSyncState.get(sessionId);
  const filePath = state === undefined ? undefined : decodeSyncStateRow(state).filePath;
  if (!filePath) {
    throw new Error(
      `session ${sessionId} has no recorded session file in the index; run context_search with scope 'project' first`,
    );
  }
  const parsed = readSessionFileEntries(filePath);
  if (!parsed || parsed.sessionId !== sessionId) {
    throw new Error(`could not read session ${sessionId} back from ${filePath}`);
  }
  return parsed.entries;
}

function recallEntry(db: IndexDb, sessionId: SessionId, entryId: EntryId): SearchToolResult<RecallDetails> {
  const row = db.database
    .prepare('SELECT role, timestamp, text FROM entries WHERE session_id = ? AND entry_id = ?')
    .get(sessionId, entryId);
  const entry = row === undefined ? undefined : decodeRecalledEntryRow(row);
  if (!entry) {
    throw new Error(`no indexed entry ${entryId} in session ${sessionId}; take the id from a context_search hit`);
  }
  const text = `Entry ${entryId} (session ${sessionId}, ${entry.role} @ ${entry.timestamp})\n\n${entry.text}`;
  return textResult(text, { sessionId, entryId });
}

function recallTransaction(
  db: IndexDb,
  ctx: ExtensionContext,
  sessionId: SessionId,
  transactionId: TransactionId,
): SearchToolResult<RecallDetails> {
  const row = db.database
    .prepare(
      `SELECT purpose, disposition, summary, result, carryforward, begin_entry_id, end_entry_id
       FROM takeaways WHERE session_id = ? AND transaction_id = ?`,
    )
    .get(sessionId, transactionId);
  if (!row) {
    throw new Error(
      `no indexed transaction ${transactionId} in session ${sessionId}; take the id from a context_search hit`,
    );
  }
  const takeawayRow = decodeRecalledTakeawayRow(row);

  const entries = sessionEntriesFor(db, ctx, sessionId);

  const beginEntryId = takeawayRow.beginEntryId;
  const beginIndex = beginEntryId ? entries.findIndex((entry) => entry.id === beginEntryId) : -1;
  if (beginIndex < 0) {
    throw new Error(
      `could not locate the begin boundary of transaction ${transactionId} in session ${sessionId}`,
    );
  }
  const endEntryId = takeawayRow.endEntryId;
  const endIndexRaw = endEntryId ? entries.findIndex((entry) => entry.id === endEntryId) : -1;
  // An open transaction (or an end boundary the index has not seen yet) runs
  // through the end of the session.
  const endIndex = endIndexRaw >= 0 ? endIndexRaw : entries.length;

  // The custom boundary entries carry the ids of their boundary tool-call
  // machinery: the assistant message holding the call (boundaryEntryId) and
  // its tool result (boundaryToolCallId). In a real session the end call and
  // both tool results sit between the two custom entries, so a plain slice
  // would leak them into the body. Exclude them by id; a missing or malformed
  // event simply contributes no exclusions and the slice degrades to the
  // looser form rather than failing.
  const boundaryEntryIds = new Set<string>();
  const boundaryToolCallIds = new Set<string>();
  for (const index of [beginIndex, endIndexRaw]) {
    const entry = index >= 0 ? entries[index] : undefined;
    if (!entry || entry.type !== 'custom' || !isTransactionEvent(entry.data)) continue;
    boundaryEntryIds.add(entry.data.boundaryEntryId);
    boundaryToolCallIds.add(entry.data.boundaryToolCallId);
  }
  const isBoundaryNoise = (entry: SessionEntry): boolean => {
    if (boundaryEntryIds.has(entry.id)) return true;
    return (
      entry.type === 'message' &&
      entry.message.role === 'toolResult' &&
      boundaryToolCallIds.has(entry.message.toolCallId)
    );
  };

  const bodyLines = entries.slice(beginIndex + 1, endIndex).flatMap((entry) => {
    if (isBoundaryNoise(entry)) return [];
    const extracted = searchableText(entry);
    return extracted ? [`[${extracted.role}] ${extracted.text}`] : [];
  });

  const headerLines = [`Transaction ${transactionId} (session ${sessionId})`];
  if (takeawayRow.purpose) headerLines.push(`Purpose: ${takeawayRow.purpose}`);
  headerLines.push(`Disposition: ${takeawayRow.disposition ?? 'open'}`);
  if (takeawayRow.takeaway) headerLines.push(`Takeaway: ${takeawayRow.takeaway}`);
  if (takeawayRow.carryforward) headerLines.push(`Carryforward: ${takeawayRow.carryforward}`);
  headerLines.push(`--- body (${bodyLines.length} entries) ---`);

  let text = `${headerLines.join('\n')}\n${bodyLines.join('\n\n')}`;
  if (text.length > RECALL_CHAR_BUDGET) {
    text = `${text.slice(0, RECALL_CHAR_BUDGET)}\n…[truncated at ${RECALL_CHAR_BUDGET} characters]`;
  }
  return textResult(text, { sessionId, transactionId });
}

export const contextRecallTool = defineTool({
  name: 'context_recall',
  label: 'Recall forgotten context',
  description:
    'Recall the full stored content behind a context_search hit: one entry by entryId, or a whole transaction body by transactionId.',
  promptSnippet: 'Recall the full content behind a context_search hit.',
  promptGuidelines: [
    "Use context_recall with an id from a context_search hit: entryId for one entry's full text, transactionId for a whole transaction body. Pass sessionId when the hit came from another session.",
  ],
  parameters: Type.Object({
    entryId: Type.Optional(Type.String({ description: 'Entry id from a context_search entry hit' })),
    transactionId: Type.Optional(Type.String({ description: 'Transaction id from a context_search takeaway hit' })),
    sessionId: Type.Optional(
      Type.String({ description: 'Session id of the hit; defaults to the current session' }),
    ),
  }),
  async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
    const rawEntryId = normalized(params.entryId);
    const rawTransactionId = normalized(params.transactionId);
    if ((rawEntryId === undefined) === (rawTransactionId === undefined)) {
      throw new Error('provide exactly one of entryId or transactionId');
    }

    const db = indexDbFor(ctx.sessionManager.getSessionDir());
    const currentSessionId = asSessionId(ctx.sessionManager.getSessionId());
    const rawSessionId = normalized(params.sessionId);
    const sessionId = rawSessionId === undefined ? currentSessionId : asSessionId(rawSessionId);
    // Lazy sync so a recall straight after new work still sees it.
    syncEntries(db, currentSessionId, ctx.sessionManager.getEntries());

    if (rawEntryId !== undefined) return recallEntry(db, sessionId, asEntryId(rawEntryId));
    return recallTransaction(db, ctx, sessionId, asTransactionId(rawTransactionId!));
  },
});
