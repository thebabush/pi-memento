import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { Api, AssistantMessage, Context, Model, StopReason, TextContent } from '@earendil-works/pi-ai';
import type { ExtensionContext, SessionEntry } from '@earendil-works/pi-coding-agent';
import { describe, expect, it } from 'vitest';
import { currentTransactions } from './session.js';
import { type AgentRequestShape, generateSummary, summarizeOpenTransaction } from './summarize.js';
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

type CompleteFn = (
  model: Model<Api>,
  request: Context,
  options?: { sessionId?: string; reasoning?: string; transport?: string; apiKey?: string },
) => Promise<AssistantMessage>;

function summaryContext(
  options: {
    model?: Model<Api> | undefined;
    hasAuth?: boolean;
    complete?: CompleteFn;
    /** The provider's streamSimple, used by the in-place (cache-friendly) summary. */
    streamSimple?: CompleteFn;
    entries?: SessionEntry[];
  } = {},
): ExtensionContext {
  const streamSimple =
    options.streamSimple ?? (() => Promise.reject(new Error('provider.streamSimple should not have been called')));
  return {
    model: 'model' in options ? options.model : fakeModel(),
    modelRegistry: {
      hasConfiguredAuth: () => options.hasAuth ?? true,
      complete:
        options.complete ??
        (() => Promise.reject(new Error('modelRegistry.complete should not have been called'))),
      getProvider: () => ({
        streamSimple: (model: Model<Api>, request: Context, requestOptions: Parameters<CompleteFn>[2]) => ({
          result: () => streamSimple(model, request, requestOptions),
        }),
      }),
      getProviderAuth: () => Promise.resolve({ auth: { apiKey: 'test-key' } }),
    },
    sessionManager: { getBranch: () => options.entries ?? [], getSessionId: () => 'session-1' },
    getSystemPrompt: () => 'agent system prompt',
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

  it.each(['length', 'toolUse'] as const)('rejects a partial summary ending in %s', async (stopReason) => {
    const ctx = summaryContext({ complete: () => Promise.resolve(completion('partial summary', stopReason)) });

    await expect(generateSummary(ctx, { ...request, messages: [userMessage('hi')] })).rejects.toThrow(
      'Summarization returned an incomplete result',
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

  describe('with the agent request shape', () => {
    const agentRequest = {
      tools: [{ name: 'bash', description: 'run a command', parameters: { type: 'object', properties: {} } }],
      reasoning: 'medium',
    } as unknown as AgentRequestShape;

    function openTransaction(ctx: ExtensionContext) {
      const replay = currentTransactions(ctx);
      const transaction = replay.openStack.at(-1);
      if (!transaction) throw new Error('expected an open transaction');
      return { replay, transaction };
    }

    it("matches the agent's request shape to allow prefix cache reuse", async () => {
      const calls: { request: Context; options: Parameters<CompleteFn>[2] }[] = [];
      const ctx = summaryContext({
        entries: openTransactionEntries(),
        streamSimple: (_model, request, options) => {
          calls.push({ request, options });
          return Promise.resolve(completion('in-place summary'));
        },
      });
      const { replay, transaction } = openTransaction(ctx);

      const generated = await summarizeOpenTransaction(ctx, replay, transaction, 'end-call', agentRequest);

      expect(generated.summary).toBe('in-place summary');
      expect(calls).toHaveLength(1);
      const [{ request, options }] = calls;
      expect(request.systemPrompt).toBe('agent system prompt');
      expect(request.tools).toEqual(agentRequest.tools);
      expect(options).toMatchObject({ sessionId: 'session-1', reasoning: 'medium', transport: 'auto', apiKey: 'test-key' });
      const conversation = JSON.stringify(request.messages);
      expect(conversation).toContain('durable before text');
      expect(conversation).toContain('inside the transaction body');
      const [endCall, last] = request.messages.slice(-2);
      expect(endCall).toMatchObject({ role: 'assistant' });
      expect(JSON.stringify(endCall)).toContain('end-call');
      expect(last).toMatchObject({ role: 'toolResult', toolCallId: 'end-call', toolName: 'transaction_end' });
      expect(JSON.stringify(last)).toContain('Closing transaction tx');
    });

    it('falls back to an isolated summary when the model does not answer with text', async () => {
      const requests: Context[] = [];
      const ctx = summaryContext({
        entries: openTransactionEntries(),
        streamSimple: (_model, request) => {
          requests.push(request);
          return Promise.resolve(completion([], 'toolUse'));
        },
        complete: (_model, request) => {
          requests.push(request);
          return Promise.resolve(completion('isolated summary'));
        },
      });
      const { replay, transaction } = openTransaction(ctx);

      const generated = await summarizeOpenTransaction(ctx, replay, transaction, 'end-call', agentRequest);

      expect(generated.summary).toBe('isolated summary');
      expect(requests).toHaveLength(2);
      expect(requestText(requests[1])).not.toContain('durable before text');
      expect(generated.usage).toMatchObject({ input: 10, output: 14, totalTokens: 24 });
      expect(generated.usage).not.toHaveProperty('reasoning');
    });

    it.each(['length', 'toolUse'] as const)('does not retain a partial in-place answer ending in %s', async (stopReason) => {
      const partial = completion('Let me check one more thing.', stopReason);
      if (stopReason === 'toolUse') {
        partial.content.push({ type: 'toolCall', id: 'probe', name: 'bash', arguments: { command: 'pwd' } });
      }
      const ctx = summaryContext({
        entries: openTransactionEntries(),
        streamSimple: () => Promise.resolve(partial),
        complete: () => Promise.resolve(completion('complete isolated summary')),
      });
      const { replay, transaction } = openTransaction(ctx);

      const generated = await summarizeOpenTransaction(ctx, replay, transaction, 'end-call', agentRequest);

      expect(generated.summary).toBe('complete isolated summary');
      expect(generated.usage).toMatchObject({ input: 10, output: 14, totalTokens: 24 });
    });

    it('throws instead of falling back when the in-place request fails', async () => {
      let calls = 0;
      const ctx = summaryContext({
        entries: openTransactionEntries(),
        streamSimple: () => {
          calls++;
          return Promise.resolve(completion('partial', 'error'));
        },
      });
      const { replay, transaction } = openTransaction(ctx);

      await expect(summarizeOpenTransaction(ctx, replay, transaction, 'end-call', agentRequest)).rejects.toThrow(
        'Summarization error',
      );
      expect(calls).toBe(1);
    });

    it('rejects an empty transaction before calling the model', async () => {
      const begin: TransactionEvent = {
        version: 1,
        kind: 'begin',
        transactionId: 'tx',
        boundaryToolCallId: 'begin-call',
        boundaryEntryId: 'begin-entry',
      };
      const ctx = summaryContext({
        entries: linked([
          userEntry('before', 'durable before text'),
          ...boundaryEntries('begin-entry', 'transaction_begin', 'begin-call', begin),
          assistantCallEntry('end-leaf', 'end-call', 'transaction_end'),
        ]),
      });
      const { replay, transaction } = openTransaction(ctx);

      await expect(summarizeOpenTransaction(ctx, replay, transaction, 'end-call', agentRequest)).rejects.toThrow(
        'Cannot compact an empty transaction',
      );
    });
  });
});
