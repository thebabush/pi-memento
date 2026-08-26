import {
  buildSessionContext,
  type CompactionResult,
  type ExtensionContext,
  type SessionBeforeCompactEvent,
} from '@earendil-works/pi-coding-agent';
import {
  planTransactionCompaction,
  type TransactionCompactionDetails,
  type TransactionCompactionPlan,
} from './compaction.js';
import { projectMessages } from './project.js';
import { replayTransactions } from './replay.js';
import { transactionEvents } from './session.js';
import { generateSummary } from './summarize.js';
import type { ReplayResult } from './types.js';

const EMPTY_PROJECTED_PREFIX_SUMMARY =
  'No durable conversational context was retained from the compacted history prefix.';

export interface TransactionCompactionHookResult {
  cancel?: boolean;
  compaction?: CompactionResult<TransactionCompactionDetails>;
}

export type ProjectedCompactionPreparation =
  | { required: false }
  | {
      required: true;
      ok: true;
      plan: Extract<TransactionCompactionPlan, { ok: true }>;
      messages: ReturnType<typeof buildSessionContext>['messages'];
    }
  | {
      required: true;
      ok: false;
      reason: string;
    };

function requiresTransactionProjection(replay: ReplayResult): boolean {
  if (replay.diagnostics.length > 0) return true;
  if (replay.openStack.length > 0) return true;
  return [...replay.records.values()].some(
    (record) => record.end !== undefined && record.end.disposition !== 'commit',
  );
}

export function prepareProjectedCompaction(event: SessionBeforeCompactEvent): ProjectedCompactionPreparation {
  const replay = replayTransactions(transactionEvents(event.branchEntries));
  if (!requiresTransactionProjection(replay)) return { required: false };

  const plan = planTransactionCompaction(event.branchEntries, replay, event.preparation.firstKeptEntryId);
  if (!plan.ok) return { required: true, ok: false, reason: plan.reason };

  const prefixReplay = replayTransactions(transactionEvents(plan.prefixEntries));
  if (prefixReplay.openStack.length > 0) {
    return {
      required: true,
      ok: false,
      reason: `Transaction-safe compaction unexpectedly split open transaction ${prefixReplay.openStack.at(-1)!.transactionId}`,
    };
  }

  const prefixContext = buildSessionContext(plan.prefixEntries).messages;
  const projected = projectMessages(prefixContext, prefixReplay);
  if (!projected.safe) {
    return {
      required: true,
      ok: false,
      reason: projected.diagnostics[0]?.message ?? 'The compacted prefix could not be projected safely',
    };
  }

  return { required: true, ok: true, plan, messages: projected.messages };
}

function compactionSystemPrompt(customInstructions?: string): string {
  const base = `Summarize the durable conversational context below for an agent that will continue the work.

Preserve:
- the user's goals and constraints
- decisions and their rationale
- verified facts and evidence
- code and filesystem changes
- unresolved questions, blockers, and next steps
- operational state needed to continue

The transcript has already had reverted and squashed transaction details removed. Do not infer, restore, or mention omitted work. Be concise, concrete, and do not invent facts.`;
  const custom = customInstructions?.trim();
  return custom ? `${base}\n\nAdditional compaction instructions:\n${custom}` : base;
}

export async function handleTransactionCompaction(
  event: SessionBeforeCompactEvent,
  ctx: ExtensionContext,
): Promise<TransactionCompactionHookResult | undefined> {
  const prepared = prepareProjectedCompaction(event);
  if (!prepared.required) return undefined;

  if (!prepared.ok) {
    const overflowNote =
      event.reason === 'overflow'
        ? '. The context overflowed and will keep overflowing until compaction can proceed'
        : '';
    ctx.ui.notify(`Transaction-aware compaction cancelled: ${prepared.reason}${overflowNote}`, 'warning');
    return { cancel: true };
  }

  try {
    const generated =
      prepared.messages.length === 0
        ? undefined
        : await generateSummary(ctx, {
            messages: prepared.messages,
            systemPrompt: compactionSystemPrompt(event.customInstructions),
            emptyError: 'The transaction-projected compaction prefix is empty',
            signal: event.signal,
          });

    const compaction: CompactionResult<TransactionCompactionDetails> = {
      summary: generated?.summary ?? EMPTY_PROJECTED_PREFIX_SUMMARY,
      firstKeptEntryId: prepared.plan.firstKeptEntryId,
      tokensBefore: event.preparation.tokensBefore,
      ...(generated && { usage: generated.usage }),
      details: prepared.plan.details,
    };
    return { compaction };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`Transaction-aware compaction cancelled: ${reason}`, 'warning');
    return { cancel: true };
  }
}
