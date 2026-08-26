import type { ExtensionContext, SessionEntry } from '@earendil-works/pi-coding-agent';
import { replayTransactions } from './replay.js';
import {
  isTransactionEvent,
  TRANSACTION_ENTRY_TYPE,
  type ReplayResult,
  type TransactionEvent,
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
