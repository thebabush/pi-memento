import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import type { ReplayResult, TransactionRecord } from './types.js';

export interface TransactionCompactionDetails {
  contextTransactions: {
    version: 1;
    projectionApplied: true;
    requestedFirstKeptEntryId: string;
    adjustedFirstKeptEntryId: string;
  };
}

export type TransactionCompactionPlan =
  | {
      ok: true;
      firstKeptEntryId: string;
      firstKeptIndex: number;
      prefixEntries: SessionEntry[];
      details: TransactionCompactionDetails;
    }
  | {
      ok: false;
      code: 'invalid_replay' | 'missing_cut' | 'invalid_boundary' | 'nothing_to_compact';
      reason: string;
    };

function isExclusiveBoundary(
  entry: SessionEntry,
  toolCallId: string,
  toolName: 'transaction_begin' | 'transaction_end',
): boolean {
  if (entry.type !== 'message' || entry.message.role !== 'assistant') return false;
  const calls = entry.message.content.filter((part) => part.type === 'toolCall');
  return calls.length === 1 && calls[0]?.id === toolCallId && calls[0].name === toolName;
}

function findToolResultIndex(
  entries: readonly SessionEntry[],
  afterIndex: number,
  toolCallId: string,
  toolName: 'transaction_begin' | 'transaction_end',
): number {
  return entries.findIndex(
    (entry, index) =>
      index > afterIndex &&
      entry.type === 'message' &&
      entry.message.role === 'toolResult' &&
      entry.message.toolCallId === toolCallId &&
      entry.message.toolName === toolName,
  );
}

function locateInterval(
  entries: readonly SessionEntry[],
  entryIndexes: ReadonlyMap<string, number>,
  record: TransactionRecord,
): { start: number; end: number } | undefined {
  const start = entryIndexes.get(record.begin.boundaryEntryId);
  if (start === undefined || !isExclusiveBoundary(entries[start]!, record.begin.boundaryToolCallId, 'transaction_begin')) {
    return undefined;
  }
  const beginResult = findToolResultIndex(
    entries,
    start,
    record.begin.boundaryToolCallId,
    'transaction_begin',
  );
  if (beginResult < 0) return undefined;

  if (!record.end) return { start, end: entries.length };

  const endCall = entryIndexes.get(record.end.boundaryEntryId);
  if (
    endCall === undefined ||
    endCall <= beginResult ||
    !isExclusiveBoundary(entries[endCall]!, record.end.boundaryToolCallId, 'transaction_end')
  ) {
    return undefined;
  }
  const endResult = findToolResultIndex(entries, endCall, record.end.boundaryToolCallId, 'transaction_end');
  if (endResult < 0) return undefined;
  return { start, end: endResult };
}

export function planTransactionCompaction(
  entries: readonly SessionEntry[],
  replay: ReplayResult,
  requestedFirstKeptEntryId: string,
): TransactionCompactionPlan {
  if (replay.diagnostics.length > 0) {
    return { ok: false, code: 'invalid_replay', reason: replay.diagnostics[0]!.message };
  }

  const entryIndexes = new Map(entries.map((entry, index) => [entry.id, index]));
  const requestedCut = entryIndexes.get(requestedFirstKeptEntryId);
  if (requestedCut === undefined) {
    return {
      ok: false,
      code: 'missing_cut',
      reason: `Pi's requested compaction cut ${requestedFirstKeptEntryId} is not on the active branch`,
    };
  }

  let adjustedCut = requestedCut;
  let cutBlocker: TransactionRecord | undefined;
  for (const record of replay.records.values()) {
    const interval = locateInterval(entries, entryIndexes, record);
    if (!interval) {
      return {
        ok: false,
        code: 'invalid_boundary',
        reason: `Transaction ${record.transactionId} has invalid or missing session boundaries`,
      };
    }
    if (adjustedCut > interval.start && adjustedCut <= interval.end) {
      adjustedCut = interval.start;
      cutBlocker = record;
    }
  }

  if (adjustedCut === 0) {
    const openBlocker = cutBlocker && !cutBlocker.end ? cutBlocker : undefined;
    return {
      ok: false,
      code: 'nothing_to_compact',
      reason: openBlocker
        ? `The transaction-safe cut is at the beginning of the session because transaction ${openBlocker.transactionId}${openBlocker.begin.purpose ? ` (${openBlocker.begin.purpose})` : ''} is still open; close it with transaction_end so compaction can free context`
        : 'The transaction-safe cut is at the beginning of the session, so compaction cannot free context',
    };
  }

  const adjustedEntry = entries[adjustedCut];
  if (!adjustedEntry) {
    return { ok: false, code: 'missing_cut', reason: 'The adjusted compaction cut is outside the active branch' };
  }

  return {
    ok: true,
    firstKeptEntryId: adjustedEntry.id,
    firstKeptIndex: adjustedCut,
    prefixEntries: entries.slice(0, adjustedCut),
    details: {
      contextTransactions: {
        version: 1,
        projectionApplied: true,
        requestedFirstKeptEntryId,
        adjustedFirstKeptEntryId: adjustedEntry.id,
      },
    },
  };
}
