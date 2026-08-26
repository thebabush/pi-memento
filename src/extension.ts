import { StringEnum, Type, type Usage } from '@earendil-works/pi-ai';
import { defineTool, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';
import { projectMessages } from './project.js';
import { handleTransactionCompaction } from './pi-compaction.js';
import {
  assertExclusiveBoundary,
  assertHealthyReplay,
  currentTransactions,
} from './session.js';
import { summarizeOpenTransaction } from './summarize.js';
import {
  TRANSACTION_ENTRY_TYPE,
  type TransactionBeginEvent,
  type TransactionDisposition,
  type TransactionEndEvent,
} from './types.js';

const STATUS_KEY = 'context-transactions';

function normalized(value: string | undefined): string | undefined {
  const result = value?.trim();
  return result ? result : undefined;
}

interface RetainedContent {
  label: string;
  value: string;
  carryforward?: string;
}

function retainedContent(event: TransactionEndEvent): RetainedContent | undefined {
  switch (event.disposition) {
    case 'commit':
      return undefined;
    case 'compact':
      return { label: 'Summary', value: event.summary, carryforward: event.carryforward };
    case 'squash':
      return { label: 'Result', value: event.result, carryforward: event.carryforward };
    case 'revert':
      return { label: 'Carryforward', value: event.carryforward };
  }
}

function updateStatus(ctx: ExtensionContext): void {
  const replay = currentTransactions(ctx);
  if (replay.diagnostics.length > 0) {
    ctx.ui.setStatus(STATUS_KEY, 'transactions: unsafe metadata');
    return;
  }
  const count = replay.openStack.length;
  ctx.ui.setStatus(STATUS_KEY, count > 0 ? `transactions: ${count} open` : undefined);
}

function createBeginTool(pi: ExtensionAPI) {
  return defineTool({
  name: 'transaction_begin',
  label: 'Begin context transaction',
  description:
    'Begin a nested speculative transaction over conversational context. Call this tool by itself, with no sibling tool calls.',
  promptSnippet: 'Begin a speculative conversational-context transaction.',
  promptGuidelines: [
    'Open a transaction at the start of speculative or exploratory work whose step-by-step detail you will not need afterward — reverse engineering, dead-end-heavy debugging, or sifting large dumps for a few facts — then squash or compact it when done so the exploration noise leaves your context.',
    'On a long or multi-step task, open a transaction near the start so you can later compact your own working history into a summary while keeping the user\'s original request in view; a transaction cannot be opened retroactively over work already done.',
    'Transactions nest: you may open one inside another to isolate a sub-investigation, and each closes independently in last-opened-first order.',
    'A transaction only projects conversational context — it never rolls back the world. Reverting, squashing, or compacting does not undo files written, commands run, or any other side effect, so never treat an open transaction as a sandbox for destructive or irreversible actions.',
    'Call transaction_begin and transaction_end as exclusive tool calls, never alongside another tool call.',
    'Close every transaction when the speculative work is complete.',
  ],
  parameters: Type.Object({
    purpose: Type.Optional(Type.String({ description: 'Short description of the speculative work' })),
  }),
  executionMode: 'sequential',
  async execute(toolCallId, params, _signal, _onUpdate, ctx) {
    const boundaryEntryId = assertExclusiveBoundary(ctx, toolCallId, 'transaction_begin');
    const replay = currentTransactions(ctx);
    assertHealthyReplay(replay);
    const parent = replay.openStack.at(-1);
    const purpose = normalized(params.purpose);
    const event: TransactionBeginEvent = {
      version: 1,
      kind: 'begin',
      transactionId: toolCallId,
      ...(parent && { parentTransactionId: parent.transactionId }),
      ...(purpose && { purpose }),
      boundaryToolCallId: toolCallId,
      boundaryEntryId,
    };
    pi.appendEntry(TRANSACTION_ENTRY_TYPE, event);
    updateStatus(ctx);
    return {
      content: [{ type: 'text', text: `Opened transaction ${event.transactionId}${event.purpose ? `: ${event.purpose}` : ''}` }],
      details: event,
    };
  },
  });
}

function createEndTool(pi: ExtensionAPI) {
  return defineTool({
  name: 'transaction_end',
  label: 'End context transaction',
  description:
    'Close the current context transaction. Call this tool by itself, with no sibling tool calls.',
  promptSnippet: 'Commit, compact, squash, or revert the current context transaction.',
  promptGuidelines: [
    'Use transaction_end to close the innermost open context transaction before finishing.',
    'A revert requires a carryforward takeaway: a short note on why the approach was abandoned, so the lesson survives even though the exploration is discarded.',
  ],
  parameters: Type.Object({
    disposition: StringEnum(['commit', 'compact', 'squash', 'revert'] as const),
    result: Type.Optional(Type.String({ description: 'Required explicit result for squash' })),
    carryforward: Type.Optional(
      Type.String({
        description:
          'Small durable lesson or future instruction. Required for revert: the takeaway explaining why the work was abandoned.',
      }),
    ),
  }),
  executionMode: 'sequential',
  async execute(toolCallId, params, _signal, _onUpdate, ctx) {
    const boundaryEntryId = assertExclusiveBoundary(ctx, toolCallId, 'transaction_end');
    const replay = currentTransactions(ctx);
    assertHealthyReplay(replay);
    const transaction = replay.openStack.at(-1);
    if (!transaction) throw new Error('There is no open transaction to close');

    const disposition: TransactionDisposition = params.disposition;
    const result = normalized(params.result);
    const carryforward = normalized(params.carryforward);
    if (disposition === 'squash' && !result) throw new Error('A squash disposition requires a non-empty result');
    if (disposition !== 'squash' && result) throw new Error('result is only valid with the squash disposition');
    if (disposition === 'commit' && carryforward) {
      throw new Error('carryforward is only valid with compact, squash, or revert');
    }
    if (disposition === 'revert' && !carryforward) {
      throw new Error('A revert disposition requires a non-empty carryforward takeaway explaining why the work was abandoned');
    }

    let summary: string | undefined;
    let summaryUsage: Usage | undefined;
    if (disposition === 'compact') {
      const generated = await summarizeOpenTransaction(ctx, replay, transaction, toolCallId);
      summary = generated.summary;
      summaryUsage = generated.usage;
    }

    const eventBase = {
      version: 1,
      kind: 'end',
      transactionId: transaction.transactionId,
      boundaryToolCallId: toolCallId,
      boundaryEntryId,
    } as const;
    let event: TransactionEndEvent;
    switch (disposition) {
      case 'commit':
        event = { ...eventBase, disposition };
        break;
      case 'compact':
        if (!summary) throw new Error('Compact summarization did not produce a summary');
        event = { ...eventBase, disposition, summary, ...(carryforward && { carryforward }) };
        break;
      case 'squash':
        if (!result) throw new Error('A squash disposition requires a non-empty result');
        event = { ...eventBase, disposition, result, ...(carryforward && { carryforward }) };
        break;
      case 'revert':
        if (!carryforward) {
          throw new Error('A revert disposition requires a non-empty carryforward takeaway explaining why the work was abandoned');
        }
        event = { ...eventBase, disposition, carryforward };
        break;
    }
    pi.appendEntry(TRANSACTION_ENTRY_TYPE, event);
    updateStatus(ctx);
    return {
      content: [{ type: 'text', text: `Closed transaction ${event.transactionId} with disposition ${disposition}` }],
      details: event,
      ...(summaryUsage && { usage: summaryUsage }),
    };
  },
  renderResult(result, { expanded, isPartial }, theme) {
    if (isPartial) return new Text(theme.fg('dim', 'Closing transaction…'), 0, 0);
    const event = result.details as TransactionEndEvent;
    const retained = retainedContent(event);
    let text = theme.fg('success', `transaction ${event.disposition}`);
    if (!retained) return new Text(text, 0, 0);
    if (expanded) {
      text += `\n${theme.fg('dim', `${retained.label}:`)} ${retained.value}`;
      if (retained.carryforward) text += `\n${theme.fg('dim', 'Carryforward:')} ${retained.carryforward}`;
    } else {
      const preview = retained.value.replace(/\s+/g, ' ').slice(0, 80);
      const ellipsis = retained.value.length > 80 ? '…' : '';
      text += ` ${theme.fg('muted', `— ${retained.label.toLowerCase()}: ${preview}${ellipsis}`)}`;
    }
    return new Text(text, 0, 0);
  },
  });
}

const statusTool = defineTool({
  name: 'transaction_status',
  label: 'Context transaction status',
  description: 'Show the currently open nested conversational-context transactions.',
  parameters: Type.Object({}),
  async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
    const replay = currentTransactions(ctx);
    const open = replay.openStack.map((record) => ({
      transactionId: record.transactionId,
      purpose: record.begin.purpose,
    }));
    return {
      content: [{ type: 'text', text: JSON.stringify({ open, diagnostics: replay.diagnostics }, null, 2) }],
      details: { open, diagnostics: replay.diagnostics },
    };
  },
});

export default function contextTransactionsExtension(pi: ExtensionAPI): void {
  pi.registerTool(createBeginTool(pi));
  pi.registerTool(createEndTool(pi));
  pi.registerTool(statusTool);

  pi.on('context', (event, ctx) => {
    const projected = projectMessages(event.messages, currentTransactions(ctx));
    if (!projected.safe) ctx.ui.setStatus(STATUS_KEY, 'transactions: projection disabled');
    return { messages: projected.messages };
  });

  pi.on('session_start', (_event, ctx) => updateStatus(ctx));
  pi.on('session_tree', (_event, ctx) => updateStatus(ctx));

  pi.on('session_before_compact', handleTransactionCompaction);
}
