import type { ExtensionContext, SessionEntry } from '@earendil-works/pi-coding-agent';
import { asEntryId, type EntryId, type ToolCallId } from './ids.js';
import { replayTransactions } from './replay.js';
import {
  isTransactionEvent,
  TRANSACTION_ENTRY_TYPE,
  type ReplayResult,
  type TransactionEvent,
  type TransactionRecord,
} from './types.js';

export function transactionEvents(entries: readonly SessionEntry[]): TransactionEvent[] {
  return entries.flatMap((entry) => {
    if (entry.type !== 'custom' || entry.customType !== TRANSACTION_ENTRY_TYPE) return [];
    return isTransactionEvent(entry.data) ? [entry.data] : [];
  });
}

export function currentTransactions(ctx: ExtensionContext): ReplayResult {
  return replayTransactions(transactionEvents(ctx.sessionManager.getBranch()));
}

export function assertHealthyReplay(replay: ReplayResult): void {
  const [first] = replay.diagnostics;
  if (!first) return;
  throw new Error(`Transaction metadata is inconsistent: ${first.message}`);
}

/**
 * Number of tool results persisted on `branch` since the last boundary of the
 * open transaction `record`: its own begin, or the end of whichever closed
 * child sits latest on the branch. The boundary's own tool result is part of
 * the boundary rather than a call made since it, so it is not counted.
 * Undefined when no boundary entry can be located on the branch.
 */
export function toolCallsSinceLastBoundary(
  branch: readonly SessionEntry[],
  record: TransactionRecord,
): number | undefined {
  // Keyed by string: it is looked up with pi's raw entry ids.
  const boundaryToolCallIds = new Map<string, ToolCallId>([
    [record.begin.boundaryEntryId, record.begin.boundaryToolCallId],
  ]);
  for (const child of record.children) {
    if (child.end) boundaryToolCallIds.set(child.end.boundaryEntryId, child.end.boundaryToolCallId);
  }
  let reference = -1;
  let boundaryEntry: SessionEntry | undefined;
  for (let index = branch.length - 1; index >= 0 && !boundaryEntry; index -= 1) {
    const entry = branch[index];
    if (entry && boundaryToolCallIds.has(entry.id)) [reference, boundaryEntry] = [index, entry];
  }
  if (!boundaryEntry) return undefined;

  const boundaryToolCallId = boundaryToolCallIds.get(boundaryEntry.id);
  let count = 0;
  for (const entry of branch.slice(reference + 1)) {
    if (entry.type !== 'message' || entry.message.role !== 'toolResult') continue;
    if (entry.message.toolCallId !== boundaryToolCallId) count += 1;
  }
  return count;
}

export function assertExclusiveBoundary(ctx: ExtensionContext, toolCallId: ToolCallId, toolName: string): EntryId {
  const leaf = ctx.sessionManager.getLeafEntry();
  if (!leaf || leaf.type !== 'message' || leaf.message.role !== 'assistant') {
    throw new Error(`${toolName} must be called from a persisted assistant message`);
  }

  const calls = leaf.message.content.filter((part) => part.type === 'toolCall');
  if (calls.length !== 1 || calls[0]?.id !== toolCallId || calls[0]?.name !== toolName) {
    throw new Error(`${toolName} must be the only tool call in its assistant message; call it again by itself`);
  }
  return asEntryId(leaf.id);
}
