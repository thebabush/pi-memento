import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { Api, AssistantMessage, Context, Model, StopReason, TextContent } from '@earendil-works/pi-ai';
import type { ExtensionContext, SessionEntry } from '@earendil-works/pi-coding-agent';
import { describe, expect, it } from 'vitest';
import { currentTransactions } from './session.js';
import { generateSummary, summarizeOpenTransaction } from './summarize.js';
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

function assistantCallEntry(id: string, toolCallId: string, toolName: string): SessionEntry {
  return messageEntry(id, {
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
  } as AgentMessage);
}

function boundaryEntries(
  entryId: string,
  toolName: 'transaction_begin' | 'transaction_end',
  toolCallId: string,
  event: TransactionEvent,
): SessionEntry[] {
  return [
    assistantCallEntry(entryId, toolCallId, toolName),
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

function completion(content: string | TextContent[], stopReason: StopReason = 'stop'): AssistantMessage {
  return {
    role: 'assistant',
    content: typeof content === 'string' ? [{ type: 'text', text: content }] : content,
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

type CompleteFn = (model: Model<Api>, request: Context) => Promise<AssistantMessage>;

function summaryContext(
  options: {
    model?: Model<Api> | undefined;
    hasAuth?: boolean;
    complete?: CompleteFn;
    entries?: SessionEntry[];
  } = {},
): ExtensionContext {
  return {
    model: 'model' in options ? options.model : fakeModel(),
    modelRegistry: {
      hasConfiguredAuth: () => options.hasAuth ?? true,
      complete:
        options.complete ??
        (() => Promise.reject(new Error('modelRegistry.complete should not have been called'))),
    },
    sessionManager: { getBranch: () => options.entries ?? [] },
  } as unknown as ExtensionContext;
}

function userMessage(text: string): AgentMessage {
  return { role: 'user', content: text, timestamp: clock++ };
}

function requestText(request: Context): string {
  return request.messages
    .flatMap((message) => (message.role === 'user' && Array.isArray(message.content) ? message.content : []))
    .flatMap((part) => (part.type === 'text' ? [part.text] : []))
    .join('\n');
}

describe('generateSummary', () => {
  const request = { systemPrompt: 'summarize', emptyError: 'nothing to summarize' };

  it('throws without an active model', async () => {
    const ctx = summaryContext({ model: undefined });

    await expect(generateSummary(ctx, { ...request, messages: [userMessage('hi')] })).rejects.toThrow(
      'Cannot generate a summary without an active model',
    );
  });

  it('throws when no authentication is configured', async () => {
    const ctx = summaryContext({ hasAuth: false });

    await expect(generateSummary(ctx, { ...request, messages: [userMessage('hi')] })).rejects.toThrow(
      'No authentication is configured for test/test-model',
    );
  });

  it('throws the empty error when the serialized conversation is empty', async () => {
    const ctx = summaryContext();

    await expect(generateSummary(ctx, { ...request, messages: [] })).rejects.toThrow('nothing to summarize');
  });

  it('throws when the completion is aborted', async () => {
    const ctx = summaryContext({ complete: () => Promise.resolve(completion('partial', 'aborted')) });

    await expect(generateSummary(ctx, { ...request, messages: [userMessage('hi')] })).rejects.toThrow(
      'Summarization aborted',
    );
  });

  it('throws when the completion stops with an error', async () => {
    const ctx = summaryContext({ complete: () => Promise.resolve(completion('partial', 'error')) });

    await expect(generateSummary(ctx, { ...request, messages: [userMessage('hi')] })).rejects.toThrow(
      'Summarization error',
    );
  });

  it('joins multiple text parts, trims, and sends the serialized conversation', async () => {
    let captured: Context | undefined;
    const ctx = summaryContext({
      complete: (_model, completeRequest) => {
        captured = completeRequest;
        return Promise.resolve(
          completion([
            { type: 'text', text: '  first part ' },
            { type: 'text', text: ' second part  ' },
          ]),
        );
      },
    });

    const generated = await generateSummary(ctx, { ...request, messages: [userMessage('hello world')] });

    expect(generated.summary).toBe('first part \n second part');
    expect(generated.usage).toMatchObject({ input: 5, output: 7, totalTokens: 12 });
    if (!captured) throw new Error('expected the completion request to be captured');
    expect(captured.systemPrompt).toBe('summarize');
    expect(requestText(captured)).toContain('hello world');
  });

  it('throws when the completion has only blank text', async () => {
    const ctx = summaryContext({ complete: () => Promise.resolve(completion('   ')) });

    await expect(generateSummary(ctx, { ...request, messages: [userMessage('hi')] })).rejects.toThrow(
      'Summarization returned an empty result',
    );
  });
});

describe('summarizeOpenTransaction', () => {
  function openTransactionEntries(): SessionEntry[] {
    const begin: TransactionEvent = {
      version: 1,
      kind: 'begin',
      transactionId: 'tx',
      boundaryToolCallId: 'begin-call',
      boundaryEntryId: 'begin-entry',
    };
    return linked([
      userEntry('before', 'durable before text'),
      ...boundaryEntries('begin-entry', 'transaction_begin', 'begin-call', begin),
      userEntry('inside', 'inside the transaction body'),
      assistantCallEntry('end-leaf', 'end-call', 'transaction_end'),
    ]);
  }

  it('summarizes only the transaction body', async () => {
    let captured: Context | undefined;
    const ctx = summaryContext({
      entries: openTransactionEntries(),
      complete: (_model, completeRequest) => {
        captured = completeRequest;
        return Promise.resolve(completion('the transaction summary'));
      },
    });
    const replay = currentTransactions(ctx);
    const transaction = replay.openStack.at(-1);
    if (!transaction) throw new Error('expected an open transaction');

    const generated = await summarizeOpenTransaction(ctx, replay, transaction, 'end-call');

    expect(generated.summary).toBe('the transaction summary');
    if (!captured) throw new Error('expected the completion request to be captured');
    const conversation = requestText(captured);
    expect(conversation).toContain('inside the transaction body');
    expect(conversation).not.toContain('durable before text');
  });

  it('throws when the end tool call is not in the branch', async () => {
    const ctx = summaryContext({ entries: openTransactionEntries() });
    const replay = currentTransactions(ctx);
    const transaction = replay.openStack.at(-1);
    if (!transaction) throw new Error('expected an open transaction');

    await expect(summarizeOpenTransaction(ctx, replay, transaction, 'missing-call')).rejects.toThrow(
      'Could not locate the transaction body for summarization',
    );
  });
});
