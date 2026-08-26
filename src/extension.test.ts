import type { AgentMessage, AgentToolResult } from '@earendil-works/pi-agent-core';
import type { Api, AssistantMessage, Model, StopReason } from '@earendil-works/pi-ai';
import type { ExtensionAPI, ExtensionContext, SessionEntry } from '@earendil-works/pi-coding-agent';
import { describe, expect, it } from 'vitest';
import contextTransactionsExtension from './extension.js';
import { TRANSACTION_ENTRY_TYPE, type TransactionEvent } from './types.js';

let clock = 0;

interface ToolCallPart {
  type: 'toolCall';
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

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

function assistantEntry(id: string, content: ({ type: 'text'; text: string } | ToolCallPart)[]): SessionEntry {
  return messageEntry(id, {
    role: 'assistant',
    content,
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

function customEntry(id: string, customType: string, data: unknown): SessionEntry {
  return {
    type: 'custom',
    id,
    parentId: null,
    timestamp: new Date(clock++).toISOString(),
    customType,
    data,
  };
}

function toolCall(id: string, name: string): ToolCallPart {
  return { type: 'toolCall', id, name, arguments: {} };
}

function boundaryEntries(
  entryId: string,
  toolName: 'transaction_begin' | 'transaction_end',
  toolCallId: string,
  event: TransactionEvent,
): SessionEntry[] {
  return [
    assistantEntry(entryId, [toolCall(toolCallId, toolName)]),
    customEntry(`${entryId}-metadata`, TRANSACTION_ENTRY_TYPE, event),
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

interface AppendedEntry {
  customType: string;
  data: unknown;
}

interface RegisteredTool {
  name: string;
  promptGuidelines?: string[];
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: ExtensionContext,
  ) => Promise<AgentToolResult<unknown>>;
}

interface Harness {
  tools: Map<string, RegisteredTool>;
  handlers: Map<string, unknown>;
  appended: AppendedEntry[];
  entries: SessionEntry[];
}

function createHarness(initialEntries: SessionEntry[] = []): Harness {
  const tools = new Map<string, RegisteredTool>();
  const handlers = new Map<string, unknown>();
  const appended: AppendedEntry[] = [];
  const entries = [...initialEntries];
  const pi = {
    registerTool: (tool: RegisteredTool) => {
      tools.set(tool.name, tool);
    },
    on: (event: string, handler: unknown) => {
      handlers.set(event, handler);
    },
    appendEntry: (customType: string, data?: unknown) => {
      appended.push({ customType, data });
      entries.push({
        type: 'custom',
        id: `appended-${appended.length}`,
        parentId: entries.at(-1)?.id ?? null,
        timestamp: new Date(clock++).toISOString(),
        customType,
        data,
      });
    },
  } as unknown as ExtensionAPI;
  contextTransactionsExtension(pi);
  return { tools, handlers, appended, entries };
}

function getTool(harness: Harness, name: string): RegisteredTool {
  const tool = harness.tools.get(name);
  if (!tool) throw new Error(`tool ${name} was not registered`);
  return tool;
}

interface StatusCall {
  key: string;
  text: string | undefined;
}

function toolContext(
  harness: Harness,
  leaf: SessionEntry | undefined,
  complete?: () => Promise<AssistantMessage>,
): { ctx: ExtensionContext; statuses: StatusCall[] } {
  const statuses: StatusCall[] = [];
  const ctx = {
    sessionManager: {
      getBranch: () => harness.entries,
      getLeafEntry: () => leaf,
    },
    ui: {
      setStatus: (key: string, text?: string) => {
        statuses.push({ key, text });
      },
    },
    model: fakeModel(),
    modelRegistry: {
      hasConfiguredAuth: () => true,
      complete:
        complete ?? (() => Promise.reject(new Error('modelRegistry.complete should not have been called'))),
    },
  } as unknown as ExtensionContext;
  return { ctx, statuses };
}

function resultText(result: AgentToolResult<unknown>): string {
  return result.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n');
}

function messageText(messages: readonly AgentMessage[]): string {
  return messages
    .flatMap((message) => {
      if (message.role === 'custom' || message.role === 'user') {
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

function userMessage(text: string): AgentMessage {
  return { role: 'user', content: text, timestamp: clock++ };
}

function assistantCallMessage(toolCallId: string, name: string): AgentMessage {
  const entry = assistantEntry(`message-${clock++}`, [toolCall(toolCallId, name)]);
  if (entry.type !== 'message') throw new Error('expected a message entry');
  return entry.message;
}

function assistantTextMessage(text: string): AgentMessage {
  const entry = assistantEntry(`message-${clock++}`, [{ type: 'text', text }]);
  if (entry.type !== 'message') throw new Error('expected a message entry');
  return entry.message;
}

function toolResultMessage(toolCallId: string, toolName: string): AgentMessage {
  return {
    role: 'toolResult',
    toolCallId,
    toolName,
    content: [{ type: 'text', text: 'ok' }],
    isError: false,
    timestamp: clock++,
  };
}

type ContextHandler = (
  event: { type: 'context'; messages: AgentMessage[] },
  ctx: ExtensionContext,
) => { messages: AgentMessage[] };

describe('contextTransactionsExtension', () => {
  it('registers the transaction tools and handlers', () => {
    const harness = createHarness();

    expect([...harness.tools.keys()].sort()).toEqual([
      'transaction_begin',
      'transaction_end',
      'transaction_status',
    ]);
    expect([...harness.handlers.keys()].sort()).toEqual([
      'context',
      'session_before_compact',
      'session_start',
      'session_tree',
    ]);
  });

  it('surfaces a trigger-condition guideline telling the model when to open a transaction', () => {
    const harness = createHarness();

    const guidelines = getTool(harness, 'transaction_begin').promptGuidelines ?? [];
    const trigger = guidelines.find((guideline) => /reverse engineering|exploratory|speculative/.test(guideline));

    expect(trigger).toBeDefined();
    expect(trigger).toMatch(/open a transaction/i);
  });

  it('nudges the model to open a transaction early on long tasks', () => {
    const harness = createHarness();

    const guidelines = getTool(harness, 'transaction_begin').promptGuidelines ?? [];
    const earlyOpen = guidelines.find((guideline) => /near the start|retroactively/.test(guideline));

    expect(earlyOpen).toBeDefined();
    expect(earlyOpen).toMatch(/long or multi-step/i);
  });

  it('warns that a transaction does not roll back side effects', () => {
    const harness = createHarness();

    const guidelines = getTool(harness, 'transaction_begin').promptGuidelines ?? [];
    const caveat = guidelines.find((guideline) => /never rolls back the world|side effect/.test(guideline));

    expect(caveat).toBeDefined();
    expect(caveat).toMatch(/destructive or irreversible/i);
  });
});

describe('transaction_begin', () => {
  it('appends a begin event bound to the exclusive tool call', async () => {
    const harness = createHarness();
    const leaf = assistantEntry('leaf', [toolCall('call-1', 'transaction_begin')]);
    const { ctx, statuses } = toolContext(harness, leaf);

    const result = await getTool(harness, 'transaction_begin').execute('call-1', {}, undefined, undefined, ctx);

    expect(resultText(result)).toBe('Opened transaction call-1');
    expect(harness.appended).toEqual([
      {
        customType: TRANSACTION_ENTRY_TYPE,
        data: {
          version: 1,
          kind: 'begin',
          transactionId: 'call-1',
          boundaryToolCallId: 'call-1',
          boundaryEntryId: 'leaf',
        },
      },
    ]);
    expect(statuses).toEqual([{ key: 'context-transactions', text: 'transactions: 1 open' }]);
  });

  it('carries the trimmed purpose', async () => {
    const harness = createHarness();
    const leaf = assistantEntry('leaf', [toolCall('call-1', 'transaction_begin')]);
    const { ctx } = toolContext(harness, leaf);

    const result = await getTool(harness, 'transaction_begin').execute(
      'call-1',
      { purpose: '  explore hypothesis  ' },
      undefined,
      undefined,
      ctx,
    );

    expect(resultText(result)).toBe('Opened transaction call-1: explore hypothesis');
    expect(harness.appended[0]?.data).toMatchObject({ purpose: 'explore hypothesis' });
  });

  it('records the open transaction as the parent of a nested begin', async () => {
    const outerBegin: TransactionEvent = {
      version: 1,
      kind: 'begin',
      transactionId: 'outer',
      boundaryToolCallId: 'outer-call',
      boundaryEntryId: 'outer-entry',
    };
    const harness = createHarness([customEntry('outer-metadata', TRANSACTION_ENTRY_TYPE, outerBegin)]);
    const leaf = assistantEntry('leaf', [toolCall('call-2', 'transaction_begin')]);
    const { ctx, statuses } = toolContext(harness, leaf);

    await getTool(harness, 'transaction_begin').execute('call-2', {}, undefined, undefined, ctx);

    expect(harness.appended[0]?.data).toEqual({
      version: 1,
      kind: 'begin',
      transactionId: 'call-2',
      parentTransactionId: 'outer',
      boundaryToolCallId: 'call-2',
      boundaryEntryId: 'leaf',
    });
    expect(statuses).toEqual([{ key: 'context-transactions', text: 'transactions: 2 open' }]);
  });

  it('rejects a begin with a sibling tool call and appends nothing', async () => {
    const harness = createHarness();
    const leaf = assistantEntry('leaf', [
      toolCall('call-1', 'transaction_begin'),
      toolCall('call-2', 'read_file'),
    ]);
    const { ctx, statuses } = toolContext(harness, leaf);

    await expect(
      getTool(harness, 'transaction_begin').execute('call-1', {}, undefined, undefined, ctx),
    ).rejects.toThrow('transaction_begin must be the only tool call in its assistant message');
    expect(harness.appended).toEqual([]);
    expect(statuses).toEqual([]);
  });
});

describe('transaction_end', () => {
  function openBegin(transactionId: string): TransactionEvent {
    return {
      version: 1,
      kind: 'begin',
      transactionId,
      boundaryToolCallId: `${transactionId}-begin-call`,
      boundaryEntryId: `${transactionId}-begin-entry`,
    };
  }

  it('throws when there is no open transaction', async () => {
    const harness = createHarness();
    const leaf = assistantEntry('end-leaf', [toolCall('end-call', 'transaction_end')]);
    const { ctx } = toolContext(harness, leaf);

    await expect(
      getTool(harness, 'transaction_end').execute('end-call', { disposition: 'commit' }, undefined, undefined, ctx),
    ).rejects.toThrow('There is no open transaction to close');
    expect(harness.appended).toEqual([]);
  });

  it('appends a commit end event for the innermost open transaction', async () => {
    const harness = createHarness([customEntry('begin-metadata', TRANSACTION_ENTRY_TYPE, openBegin('tx'))]);
    const leaf = assistantEntry('end-leaf', [toolCall('end-call', 'transaction_end')]);
    const { ctx, statuses } = toolContext(harness, leaf);

    const result = await getTool(harness, 'transaction_end').execute(
      'end-call',
      { disposition: 'commit' },
      undefined,
      undefined,
      ctx,
    );

    expect(resultText(result)).toBe('Closed transaction tx with disposition commit');
    expect(harness.appended).toEqual([
      {
        customType: TRANSACTION_ENTRY_TYPE,
        data: {
          version: 1,
          kind: 'end',
          transactionId: 'tx',
          disposition: 'commit',
          boundaryToolCallId: 'end-call',
          boundaryEntryId: 'end-leaf',
        },
      },
    ]);
    expect(statuses).toEqual([{ key: 'context-transactions', text: undefined }]);
  });

  it('rejects a result with a non-squash disposition', async () => {
    const harness = createHarness([customEntry('begin-metadata', TRANSACTION_ENTRY_TYPE, openBegin('tx'))]);
    const leaf = assistantEntry('end-leaf', [toolCall('end-call', 'transaction_end')]);
    const { ctx } = toolContext(harness, leaf);

    await expect(
      getTool(harness, 'transaction_end').execute(
        'end-call',
        { disposition: 'revert', result: 'not allowed' },
        undefined,
        undefined,
        ctx,
      ),
    ).rejects.toThrow('result is only valid with the squash disposition');
    expect(harness.appended).toEqual([]);
  });

  it('rejects a squash without a result', async () => {
    const harness = createHarness([customEntry('begin-metadata', TRANSACTION_ENTRY_TYPE, openBegin('tx'))]);
    const leaf = assistantEntry('end-leaf', [toolCall('end-call', 'transaction_end')]);
    const { ctx } = toolContext(harness, leaf);

    await expect(
      getTool(harness, 'transaction_end').execute(
        'end-call',
        { disposition: 'squash', result: '   ' },
        undefined,
        undefined,
        ctx,
      ),
    ).rejects.toThrow('A squash disposition requires a non-empty result');
    expect(harness.appended).toEqual([]);
  });

  it('rejects a carryforward with the commit disposition', async () => {
    const harness = createHarness([customEntry('begin-metadata', TRANSACTION_ENTRY_TYPE, openBegin('tx'))]);
    const leaf = assistantEntry('end-leaf', [toolCall('end-call', 'transaction_end')]);
    const { ctx } = toolContext(harness, leaf);

    await expect(
      getTool(harness, 'transaction_end').execute(
        'end-call',
        { disposition: 'commit', carryforward: 'lesson' },
        undefined,
        undefined,
        ctx,
      ),
    ).rejects.toThrow('carryforward is only valid with compact, squash, or revert');
    expect(harness.appended).toEqual([]);
  });

  it('rejects a revert without a carryforward takeaway', async () => {
    const harness = createHarness([customEntry('begin-metadata', TRANSACTION_ENTRY_TYPE, openBegin('tx'))]);
    const leaf = assistantEntry('end-leaf', [toolCall('end-call', 'transaction_end')]);
    const { ctx } = toolContext(harness, leaf);

    await expect(
      getTool(harness, 'transaction_end').execute(
        'end-call',
        { disposition: 'revert', carryforward: '   ' },
        undefined,
        undefined,
        ctx,
      ),
    ).rejects.toThrow('A revert disposition requires a non-empty carryforward takeaway');
    expect(harness.appended).toEqual([]);
  });

  it('appends a revert event carrying the trimmed takeaway', async () => {
    const harness = createHarness([customEntry('begin-metadata', TRANSACTION_ENTRY_TYPE, openBegin('tx'))]);
    const leaf = assistantEntry('end-leaf', [toolCall('end-call', 'transaction_end')]);
    const { ctx } = toolContext(harness, leaf);

    const result = await getTool(harness, 'transaction_end').execute(
      'end-call',
      { disposition: 'revert', carryforward: '  the BLE app fakes its checksum  ' },
      undefined,
      undefined,
      ctx,
    );

    expect(resultText(result)).toBe('Closed transaction tx with disposition revert');
    expect(harness.appended).toEqual([
      {
        customType: TRANSACTION_ENTRY_TYPE,
        data: {
          version: 1,
          kind: 'end',
          transactionId: 'tx',
          disposition: 'revert',
          carryforward: 'the BLE app fakes its checksum',
          boundaryToolCallId: 'end-call',
          boundaryEntryId: 'end-leaf',
        },
      },
    ]);
  });

  it('appends a squash event with the trimmed result and carryforward', async () => {
    const harness = createHarness([customEntry('begin-metadata', TRANSACTION_ENTRY_TYPE, openBegin('tx'))]);
    const leaf = assistantEntry('end-leaf', [toolCall('end-call', 'transaction_end')]);
    const { ctx } = toolContext(harness, leaf);

    const result = await getTool(harness, 'transaction_end').execute(
      'end-call',
      { disposition: 'squash', result: '  final answer  ', carryforward: '  lesson  ' },
      undefined,
      undefined,
      ctx,
    );

    expect(resultText(result)).toBe('Closed transaction tx with disposition squash');
    expect(harness.appended).toEqual([
      {
        customType: TRANSACTION_ENTRY_TYPE,
        data: {
          version: 1,
          kind: 'end',
          transactionId: 'tx',
          disposition: 'squash',
          result: 'final answer',
          carryforward: 'lesson',
          boundaryToolCallId: 'end-call',
          boundaryEntryId: 'end-leaf',
        },
      },
    ]);
  });

  function compactBranch(): SessionEntry[] {
    const begin: TransactionEvent = {
      version: 1,
      kind: 'begin',
      transactionId: 'begin-call',
      boundaryToolCallId: 'begin-call',
      boundaryEntryId: 'begin-entry',
    };
    return linked([
      userEntry('before', 'durable before text'),
      ...boundaryEntries('begin-entry', 'transaction_begin', 'begin-call', begin),
      userEntry('inside', 'inside the transaction body'),
      assistantEntry('end-leaf', [toolCall('end-call', 'transaction_end')]),
    ]);
  }

  it('compacts with the generated summary and reports its usage', async () => {
    const harness = createHarness(compactBranch());
    const leaf = harness.entries.at(-1);
    const { ctx, statuses } = toolContext(harness, leaf, () =>
      Promise.resolve(completion('generated transaction summary')),
    );

    const result = await getTool(harness, 'transaction_end').execute(
      'end-call',
      { disposition: 'compact' },
      undefined,
      undefined,
      ctx,
    );

    expect(resultText(result)).toBe('Closed transaction begin-call with disposition compact');
    expect(result.usage).toMatchObject({ input: 5, output: 7, totalTokens: 12 });
    expect(harness.appended).toEqual([
      {
        customType: TRANSACTION_ENTRY_TYPE,
        data: {
          version: 1,
          kind: 'end',
          transactionId: 'begin-call',
          disposition: 'compact',
          summary: 'generated transaction summary',
          boundaryToolCallId: 'end-call',
          boundaryEntryId: 'end-leaf',
        },
      },
    ]);
    expect(statuses).toEqual([{ key: 'context-transactions', text: undefined }]);
  });

  it('leaves the transaction open when compact summarization fails', async () => {
    const harness = createHarness(compactBranch());
    const leaf = harness.entries.at(-1);
    const { ctx, statuses } = toolContext(harness, leaf, () =>
      Promise.reject(new Error('summarizer exploded')),
    );

    await expect(
      getTool(harness, 'transaction_end').execute('end-call', { disposition: 'compact' }, undefined, undefined, ctx),
    ).rejects.toThrow('summarizer exploded');
    expect(harness.appended).toEqual([]);
    expect(statuses).toEqual([]);
  });
});

describe('transaction_status', () => {
  it('lists open transactions with purposes and diagnostics', async () => {
    const openBegin: TransactionEvent = {
      version: 1,
      kind: 'begin',
      transactionId: 'tx-a',
      purpose: 'find the bug',
      boundaryToolCallId: 'begin-call',
      boundaryEntryId: 'begin-entry',
    };
    const ghostEnd: TransactionEvent = {
      version: 1,
      kind: 'end',
      transactionId: 'ghost',
      disposition: 'commit',
      boundaryToolCallId: 'ghost-call',
      boundaryEntryId: 'ghost-entry',
    };
    const harness = createHarness([
      customEntry('begin-metadata', TRANSACTION_ENTRY_TYPE, openBegin),
      customEntry('ghost-metadata', TRANSACTION_ENTRY_TYPE, ghostEnd),
    ]);
    const { ctx } = toolContext(harness, undefined);

    const result = await getTool(harness, 'transaction_status').execute(
      'status-call',
      {},
      undefined,
      undefined,
      ctx,
    );

    const parsed = JSON.parse(resultText(result)) as { open: unknown; diagnostics: unknown };
    expect(parsed.open).toEqual([{ transactionId: 'tx-a', purpose: 'find the bug' }]);
    expect(parsed.diagnostics).toMatchObject([{ code: 'unknown_end', transactionId: 'ghost' }]);
    expect(harness.appended).toEqual([]);
  });
});

describe('context handler', () => {
  it('projects a reverted transaction out of the messages', () => {
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
      carryforward: 'the pairing handshake is not GATT-based',
      boundaryToolCallId: 'end-call',
      boundaryEntryId: 'end-entry',
    };
    const harness = createHarness([
      customEntry('begin-metadata', TRANSACTION_ENTRY_TYPE, begin),
      customEntry('end-metadata', TRANSACTION_ENTRY_TYPE, end),
    ]);
    const messages: AgentMessage[] = [
      userMessage('hello before'),
      assistantCallMessage('begin-call', 'transaction_begin'),
      toolResultMessage('begin-call', 'transaction_begin'),
      assistantTextMessage('reverted body secret'),
      assistantCallMessage('end-call', 'transaction_end'),
      toolResultMessage('end-call', 'transaction_end'),
      userMessage('after the transaction'),
    ];
    const { ctx, statuses } = toolContext(harness, undefined);

    const handler = harness.handlers.get('context') as ContextHandler;
    const result = handler({ type: 'context', messages }, ctx);

    expect(messageText(result.messages)).toBe(
      'hello before|[Carryforward: the pairing handshake is not GATT-based]|after the transaction',
    );
    expect(messageText(result.messages)).not.toContain('reverted body secret');
    expect(statuses).toEqual([]);
  });

  it('returns the messages unchanged and disables projection on inconsistent metadata', () => {
    const ghostEnd: TransactionEvent = {
      version: 1,
      kind: 'end',
      transactionId: 'ghost',
      disposition: 'commit',
      boundaryToolCallId: 'ghost-call',
      boundaryEntryId: 'ghost-entry',
    };
    const harness = createHarness([customEntry('ghost-metadata', TRANSACTION_ENTRY_TYPE, ghostEnd)]);
    const messages: AgentMessage[] = [userMessage('hello'), assistantTextMessage('world')];
    const { ctx, statuses } = toolContext(harness, undefined);

    const handler = harness.handlers.get('context') as ContextHandler;
    const result = handler({ type: 'context', messages }, ctx);

    expect(result.messages).toEqual(messages);
    expect(statuses).toEqual([{ key: 'context-transactions', text: 'transactions: projection disabled' }]);
  });
});
