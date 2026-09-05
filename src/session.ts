import type { ExtensionContext, SessionEntry } from '@earendil-works/pi-coding-agent';
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
  if (replay.diagnostics.length === 0) return;
  throw new Error(`Transaction metadata is inconsistent: ${replay.diagnostics[0]!.message}`);
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
  const boundaryToolCallIds = new Map([[record.begin.boundaryEntryId, record.begin.boundaryToolCallId]]);
  for (const child of record.children) {
    if (child.end) boundaryToolCallIds.set(child.end.boundaryEntryId, child.end.boundaryToolCallId);
  }
  let reference = -1;
  for (let index = branch.length - 1; index >= 0 && reference < 0; index -= 1) {
    if (boundaryToolCallIds.has(branch[index]!.id)) reference = index;
  }
  if (reference < 0) return undefined;

  const boundaryToolCallId = boundaryToolCallIds.get(branch[reference]!.id);
  let count = 0;
  for (const entry of branch.slice(reference + 1)) {
    if (entry.type !== 'message' || entry.message.role !== 'toolResult') continue;
    if (entry.message.toolCallId !== boundaryToolCallId) count += 1;
  }
  return count;
}

export function assertExclusiveBoundary(ctx: ExtensionContext, toolCallId: string, toolName: string): string {
  const leaf = ctx.sessionManager.getLeafEntry();
  if (!leaf || leaf.type !== 'message' || leaf.message.role !== 'assistant') {
    throw new Error(`${toolName} must be called from a persisted assistant message`);
  }

  const calls = leaf.message.content.filter((part) => part.type === 'toolCall');
  if (calls.length !== 1 || calls[0]?.id !== toolCallId || calls[0]?.name !== toolName) {
    throw new Error(`${toolName} must be the only tool call in its assistant message; call it again by itself`);
  }
  return leaf.id;
}
