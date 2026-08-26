import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { Api, AssistantMessage, Context, Model, StopReason } from '@earendil-works/pi-ai';
import type {
  ExtensionContext,
  SessionBeforeCompactEvent,
  SessionEntry,
} from '@earendil-works/pi-coding-agent';
import { describe, expect, it } from 'vitest';
import { handleTransactionCompaction, prepareProjectedCompaction } from './pi-compaction.js';
import { TRANSACTION_ENTRY_TYPE, type TransactionEvent } from './types.js';

let clock = 0;

function messageEntry(id: string, message: AgentMessage): SessionEntry {
  return {
    type: 'message',
    id,
    parentId: null,
    timestamp: new Date(clock++).toISOString(),
    message,
  };
}

function userEntry(id: string, text: string): SessionEntry {
  return messageEntry(id, { role: 'user', content: text, timestamp: clock++ });
}

function assistantTextEntry(id: string, text: string): SessionEntry {
  return messageEntry(id, {
    role: 'assistant',
    content: [{ type: 'text', text }],
    provider: 'test',
    model: 'test',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: clock++,
  } as AgentMessage);
}

function boundaryEntries(
  entryId: string,
  toolName: 'transaction_begin' | 'transaction_end',
  toolCallId: string,
  event: TransactionEvent,
): SessionEntry[] {
  return [
    messageEntry(entryId, {
      role: 'assistant',
      content: [{ type: 'toolCall', id: toolCallId, name: toolName, arguments: {} }],
      provider: 'test',
      model: 'test',
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'toolUse',
      timestamp: clock++,
    } as AgentMessage),
    {
      type: 'custom',
      id: `${entryId}-metadata`,
      parentId: null,
      timestamp: new Date(clock++).toISOString(),
      customType: TRANSACTION_ENTRY_TYPE,
      data: event,
    },
    messageEntry(`${entryId}-result`, {
      role: 'toolResult',
      toolCallId,
      toolName,
      content: [{ type: 'text', text: 'ok' }],
      isError: false,
      timestamp: clock++,
    }),
  ];
}

function linked(entries: SessionEntry[]): SessionEntry[] {
  return entries.map((entry, index) => ({ ...entry, parentId: entries[index - 1]?.id ?? null }));
}

function event(
  branchEntries: SessionEntry[],
  firstKeptEntryId: string,
  reason: SessionBeforeCompactEvent['reason'] = 'threshold',
): SessionBeforeCompactEvent {
  return {
    type: 'session_before_compact',
    branchEntries,
    preparation: {
      firstKeptEntryId,
      messagesToSummarize: [],
      turnPrefixMessages: [],
      isSplitTurn: false,
      tokensBefore: 10_000,
      fileOps: { read: new Set(), written: new Set(), edited: new Set() },
      settings: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
    },
    reason,
    willRetry: false,
    signal: new AbortController().signal,
  };
}

function revertedEntries(): SessionEntry[] {
  const begin: TransactionEvent = {
    version: 1,
    kind: 'begin',
    transactionId: 'tx',
    boundaryToolCallId: 'begin-call',
    boundaryEntryId: 'begin-entry',
  };
  const end: TransactionEvent = {
    version: 1,
    kind: 'end',
    transactionId: 'tx',
    disposition: 'revert',
    carryforward: 'do not retry the discarded hypothesis',
    boundaryToolCallId: 'end-call',
    boundaryEntryId: 'end-entry',
  };
  return linked([
    userEntry('before', 'durable before'),
    ...boundaryEntries('begin-entry', 'transaction_begin', 'begin-call', begin),
    assistantTextEntry('dead-work', 'reverted details'),
    ...boundaryEntries('end-entry', 'transaction_end', 'end-call', end),
    userEntry('kept', 'recent context'),
  ]);
}

function openFromStartEntries(): SessionEntry[] {
  const begin: TransactionEvent = {
    version: 1,
    kind: 'begin',
    transactionId: 'open-tx',
    boundaryToolCallId: 'begin-call',
    boundaryEntryId: 'begin-entry',
  };
  return linked([
    ...boundaryEntries('begin-entry', 'transaction_begin', 'begin-call', begin),
    assistantTextEntry('open-work', 'still speculative'),
  ]);
}

function fakeModel(): Model<Api> {
  return {
    id: 'test-model',
    name: 'Test Model',
    api: 'anthropic-messages',
    provider: 'test',
    baseUrl: 'https://example.invalid',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8_192,
  };
}

interface Notification {
  message: string;
  type: 'info' | 'warning' | 'error' | undefined;
}

function fakeContext(complete?: (model: Model<Api>, request: Context) => Promise<AssistantMessage>): {
  ctx: ExtensionContext;
  notifications: Notification[];
} {
  const notifications: Notification[] = [];
  const ctx = {
    ui: {
      notify: (message: string, type?: 'info' | 'warning' | 'error') => {
        notifications.push({ message, type });
      },
    },
    model: fakeModel(),
    modelRegistry: {
      hasConfiguredAuth: () => true,
      complete:
        complete ?? (() => Promise.reject(new Error('modelRegistry.complete should not have been called'))),
    },
  } as unknown as ExtensionContext;
  return { ctx, notifications };
}

function completion(text: string, stopReason: StopReason = 'stop'): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'anthropic-messages',
    provider: 'test',
    model: 'test-model',
    usage: {
      input: 5,
      output: 7,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 12,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: clock++,
  };
}

function messageText(messages: readonly AgentMessage[]): string {
  return messages
    .flatMap((message) => {
      if (message.role === 'custom') {
        return typeof message.content === 'string'
          ? [message.content]
          : message.content.filter((part) => part.type === 'text').map((part) => part.text);
      }
      if (message.role === 'user') {
        return typeof message.content === 'string'
          ? [message.content]
          : message.content.filter((part) => part.type === 'text').map((part) => part.text);
      }
      if (message.role === 'assistant') {
        return message.content.filter((part) => part.type === 'text').map((part) => part.text);
      }
      return [];
    })
    .join('|');
}

describe('prepareProjectedCompaction', () => {
  it('removes reverted work from the summarizer input', () => {
    const begin: TransactionEvent = {
      version: 1,
      kind: 'begin',
      transactionId: 'tx',
      boundaryToolCallId: 'begin-call',
      boundaryEntryId: 'begin-entry',
    };
    const end: TransactionEvent = {
      version: 1,
      kind: 'end',
      transactionId: 'tx',
      disposition: 'revert',
      carryforward: 'Do not retry the discarded hypothesis',
      boundaryToolCallId: 'end-call',
      boundaryEntryId: 'end-entry',
    };
    const entries = linked([
      userEntry('before', 'durable before'),
      ...boundaryEntries('begin-entry', 'transaction_begin', 'begin-call', begin),
      assistantTextEntry('dead-work', 'secret reverted details'),
      ...boundaryEntries('end-entry', 'transaction_end', 'end-call', end),
      userEntry('kept', 'recent context'),
    ]);

    const prepared = prepareProjectedCompaction(event(entries, 'kept'));

    expect(prepared).toMatchObject({ required: true, ok: true });
    if (prepared.required && prepared.ok) {
      expect(messageText(prepared.messages)).toBe(
        'durable before|[Carryforward: Do not retry the discarded hypothesis]',
      );
      expect(messageText(prepared.messages)).not.toContain('secret reverted details');
    }
  });

  it('moves the retained tail before an open transaction', () => {
    const begin: TransactionEvent = {
      version: 1,
      kind: 'begin',
      transactionId: 'open-tx',
      boundaryToolCallId: 'begin-call',
      boundaryEntryId: 'begin-entry',
    };
    const entries = linked([
      userEntry('before', 'durable before'),
      ...boundaryEntries('begin-entry', 'transaction_begin', 'begin-call', begin),
      assistantTextEntry('open-work', 'still speculative'),
    ]);

    const prepared = prepareProjectedCompaction(event(entries, 'open-work'));

    expect(prepared).toMatchObject({ required: true, ok: true });
    if (prepared.required && prepared.ok) {
      expect(prepared.plan.firstKeptEntryId).toBe('begin-entry');
      expect(messageText(prepared.messages)).toBe('durable before');
    }
  });

  it('leaves commit-only history to pi\'s default compactor', () => {
    const begin: TransactionEvent = {
      version: 1,
      kind: 'begin',
      transactionId: 'tx',
      boundaryToolCallId: 'begin-call',
      boundaryEntryId: 'begin-entry',
    };
    const end: TransactionEvent = {
      version: 1,
      kind: 'end',
      transactionId: 'tx',
      disposition: 'commit',
      boundaryToolCallId: 'end-call',
      boundaryEntryId: 'end-entry',
    };
    const entries = linked([
      userEntry('before', 'before'),
      ...boundaryEntries('begin-entry', 'transaction_begin', 'begin-call', begin),
      assistantTextEntry('work', 'committed work'),
      ...boundaryEntries('end-entry', 'transaction_end', 'end-call', end),
      userEntry('kept', 'kept'),
    ]);

    expect(prepareProjectedCompaction(event(entries, 'kept'))).toEqual({ required: false });
  });

  it('fails closed on replay diagnostics even when every transaction committed', () => {
    const begin: TransactionEvent = {
      version: 1,
      kind: 'begin',
      transactionId: 'tx',
      boundaryToolCallId: 'begin-call',
      boundaryEntryId: 'begin-entry',
    };
    const end: TransactionEvent = {
      version: 1,
      kind: 'end',
      transactionId: 'tx',
      disposition: 'commit',
      boundaryToolCallId: 'end-call',
      boundaryEntryId: 'end-entry',
    };
    const ghostEnd: TransactionEvent = {
      version: 1,
      kind: 'end',
      transactionId: 'ghost',
      disposition: 'commit',
      boundaryToolCallId: 'ghost-call',
      boundaryEntryId: 'ghost-entry',
    };
    const entries = linked([
      userEntry('before', 'before'),
      ...boundaryEntries('begin-entry', 'transaction_begin', 'begin-call', begin),
      assistantTextEntry('work', 'committed work'),
      ...boundaryEntries('end-entry', 'transaction_end', 'end-call', end),
      {
        type: 'custom',
        id: 'ghost-metadata',
        parentId: null,
        timestamp: new Date(clock++).toISOString(),
        customType: TRANSACTION_ENTRY_TYPE,
        data: ghostEnd,
      },
      userEntry('kept', 'kept'),
    ]);

    const prepared = prepareProjectedCompaction(event(entries, 'kept'));

    expect(prepared).toMatchObject({ required: true, ok: false });
    if (prepared.required && !prepared.ok) {
      expect(prepared.reason).toContain('ends without a matching begin');
    }
  });
});

describe('handleTransactionCompaction', () => {
  it('defers commit-only clean history to pi\'s default compactor without notifying', async () => {
    const begin: TransactionEvent = {
      version: 1,
      kind: 'begin',
      transactionId: 'tx',
      boundaryToolCallId: 'begin-call',
      boundaryEntryId: 'begin-entry',
    };
    const end: TransactionEvent = {
      version: 1,
      kind: 'end',
      transactionId: 'tx',
      disposition: 'commit',
      boundaryToolCallId: 'end-call',
      boundaryEntryId: 'end-entry',
    };
    const entries = linked([
      userEntry('before', 'before'),
      ...boundaryEntries('begin-entry', 'transaction_begin', 'begin-call', begin),
      assistantTextEntry('work', 'committed work'),
      ...boundaryEntries('end-entry', 'transaction_end', 'end-call', end),
      userEntry('kept', 'kept'),
    ]);
    const { ctx, notifications } = fakeContext();

    await expect(handleTransactionCompaction(event(entries, 'kept'), ctx)).resolves.toBeUndefined();
    expect(notifications).toEqual([]);
  });

  it('cancels a manual compaction with a warning when planning fails', async () => {
    const { ctx, notifications } = fakeContext();

    const result = await handleTransactionCompaction(event(openFromStartEntries(), 'open-work', 'manual'), ctx);

    expect(result).toEqual({ cancel: true });
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.type).toBe('warning');
    expect(notifications[0]?.message).toContain('Transaction-aware compaction cancelled');
    expect(notifications[0]?.message).toContain('transaction open-tx');
    expect(notifications[0]?.message).toContain('is still open');
    expect(notifications[0]?.message).not.toContain('will keep overflowing');
  });

  it('mentions the overflow consequence when an overflow compaction is cancelled', async () => {
    const { ctx, notifications } = fakeContext();

    const result = await handleTransactionCompaction(
      event(openFromStartEntries(), 'open-work', 'overflow'),
      ctx,
    );

    expect(result).toEqual({ cancel: true });
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.type).toBe('warning');
    expect(notifications[0]?.message).toContain('will keep overflowing');
  });

  it('cancels with the error message when summarization rejects', async () => {
    const { ctx, notifications } = fakeContext(() => Promise.reject(new Error('summarizer exploded')));

    const result = await handleTransactionCompaction(event(revertedEntries(), 'kept'), ctx);

    expect(result).toEqual({ cancel: true });
    expect(notifications).toEqual([
      { message: 'Transaction-aware compaction cancelled: summarizer exploded', type: 'warning' },
    ]);
  });

  it('cancels when the summarizer response stops with an error', async () => {
    const { ctx, notifications } = fakeContext(() => Promise.resolve(completion('partial', 'error')));

    const result = await handleTransactionCompaction(event(revertedEntries(), 'kept'), ctx);

    expect(result).toEqual({ cancel: true });
    expect(notifications).toEqual([
      { message: 'Transaction-aware compaction cancelled: Summarization error', type: 'warning' },
    ]);
  });

  it('returns a projected compaction when summarization succeeds', async () => {
    const { ctx, notifications } = fakeContext(() => Promise.resolve(completion('projected summary')));

    const result = await handleTransactionCompaction(event(revertedEntries(), 'kept'), ctx);

    expect(notifications).toEqual([]);
    expect(result?.cancel).toBeUndefined();
    expect(result?.compaction).toMatchObject({
      summary: 'projected summary',
      firstKeptEntryId: 'kept',
      tokensBefore: 10_000,
      usage: { totalTokens: 12 },
      details: {
        contextTransactions: {
          projectionApplied: true,
          requestedFirstKeptEntryId: 'kept',
          adjustedFirstKeptEntryId: 'kept',
        },
      },
    });
  });

  it('appends custom instructions to the summarization system prompt', async () => {
    let capturedSystemPrompt: string | undefined;
    const { ctx } = fakeContext((_model, request) => {
      capturedSystemPrompt = request.systemPrompt;
      return Promise.resolve(completion('projected summary'));
    });

    const result = await handleTransactionCompaction(
      { ...event(revertedEntries(), 'kept'), customInstructions: 'Keep the secret token ZED-42.' },
      ctx,
    );

    expect(result?.compaction?.summary).toBe('projected summary');
    expect(capturedSystemPrompt).toContain(
      'Additional compaction instructions:\nKeep the secret token ZED-42.',
    );
  });
});
