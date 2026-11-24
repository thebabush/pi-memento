/**
 * Prompt-cache prefix identity across transaction dispositions.
 *
 * These tests run the full request pipeline — transaction projection,
 * convertToLlm, and pi-ai's real Anthropic request builder — and capture the
 * canonical provider payload via `onPayload`, the exact params object handed
 * to the SDK. Network is stubbed out; the request never leaves the process.
 *
 * Invariants, with P = the request once the transaction_begin turn is answered:
 * - KEEP (commit): every later request extends the previous one verbatim.
 * - REVERT / COMPACT / SQUASH: P, then the agent's transaction_end call and its
 *   result carrying what the disposition retains; P is untouched.
 * - REVERT + MESSAGE: the same, then the new message.
 *
 * Comparison uses a test-local canonicalization, which ignores
 * only the moving cache_control markers and the string-vs-text-block content
 * representation — both render to the same tokens on the provider side.
 */

import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { Context, Model, Tool } from '@earendil-works/pi-ai';
import { Type } from '@earendil-works/pi-ai';
import { stream } from '@earendil-works/pi-ai/api/anthropic-messages';
import { convertToLlm } from '@earendil-works/pi-coding-agent';
import { describe, expect, it } from 'vitest';
import { asEntryId, asToolCallId, asTransactionId } from './ids.js';
import { projectMessages } from './project.js';
import { replayTransactions } from './replay.js';
import type { TransactionBeginEvent, TransactionEndEvent, TransactionEvent } from './types.js';

const model: Model<'anthropic-messages'> = {
  id: 'claude-test-1',
  name: 'Claude Test',
  api: 'anthropic-messages',
  provider: 'anthropic',
  baseUrl: 'https://anthropic.invalid',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200000,
  maxTokens: 8192,
};

const SYSTEM_PROMPT = 'You are a test agent. Stay deterministic.';

const tools: Tool[] = [
  { name: 'probe', description: 'Probe something', parameters: Type.Object({ target: Type.String() }) },
];

let timestamp = 0;

function user(text: string): AgentMessage {
  return { role: 'user', content: text, timestamp: timestamp++ };
}

function assistant(text: string): AgentMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: timestamp++,
  } as AgentMessage;
}

function toolTurn(name: string, id: string, args: Record<string, unknown>, result: string): AgentMessage[] {
  return [
    {
      role: 'assistant',
      content: [{ type: 'toolCall', id, name, arguments: args }],
      api: 'anthropic-messages',
      provider: 'anthropic',
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'toolUse',
      timestamp: timestamp++,
    } as AgentMessage,
    {
      role: 'toolResult',
      toolCallId: id,
      toolName: name,
      content: [{ type: 'text', text: result }],
      isError: false,
      timestamp: timestamp++,
    },
  ];
}

function begin(id: string, callId: string): TransactionBeginEvent {
  return {
    version: 1,
    kind: 'begin',
    transactionId: asTransactionId(id),
    boundaryToolCallId: asToolCallId(callId),
    boundaryEntryId: asEntryId(`entry-${callId}`),
  };
}

function end(
  id: string,
  callId: string,
  disposition: TransactionEndEvent['disposition'],
  extra: { summary?: string; result?: string; carryforward?: string } = {},
): TransactionEndEvent {
  const base = {
    version: 1,
    kind: 'end',
    transactionId: asTransactionId(id),
    boundaryToolCallId: asToolCallId(callId),
    boundaryEntryId: asEntryId(`entry-${callId}`),
  } as const;
  switch (disposition) {
    case 'commit':
      return { ...base, disposition };
    case 'compact':
      return { ...base, disposition, summary: extra.summary ?? 'summary', ...(extra.carryforward && { carryforward: extra.carryforward }) };
    case 'squash':
      return { ...base, disposition, result: extra.result ?? 'result', ...(extra.carryforward && { carryforward: extra.carryforward }) };
    case 'revert':
      return { ...base, disposition, carryforward: extra.carryforward ?? 'takeaway' };
  }
}

interface CapturedRequest {
  raw: Record<string, unknown>;
  canonical: { system: string; tools: string; messages: string[] };
}

// Anthropic moves cache markers and uses a text-block array for the last user
// message. Normalize those representation changes, preserving prompt content.
function stripCacheControl(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripCacheControl);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== 'cache_control').map(([key, entry]) => [key, stripCacheControl(entry)]),
  );
}

function canonicalizeRequest(payload: Record<string, unknown>): CapturedRequest['canonical'] {
  const normalizeContent = (content: unknown) => typeof content === 'string' ? [{ type: 'text', text: content }] : content;
  if (!Array.isArray(payload.messages)) throw new Error('expected Anthropic messages');
  return {
    system: JSON.stringify(stripCacheControl(normalizeContent(payload.system))),
    tools: JSON.stringify(stripCacheControl(payload.tools)),
    messages: payload.messages.map((message: Record<string, unknown>) =>
      JSON.stringify(stripCacheControl({ ...message, content: normalizeContent(message.content) })),
    ),
  };
}

/**
 * Runs the projection + convertToLlm + pi-ai buildParams pipeline exactly as
 * the live agent does, capturing the params object immediately before the SDK
 * call. The stub fetch guarantees nothing leaves the process.
 */
async function buildRequest(messages: readonly AgentMessage[], events: TransactionEvent[]): Promise<CapturedRequest> {
  const projected = projectMessages(messages, replayTransactions(events));
  expect(projected.safe).toBe(true);

  const context: Context = { systemPrompt: SYSTEM_PROMPT, messages: convertToLlm(projected.messages), tools };
  let captured: Record<string, unknown> | undefined;
  const eventStream = stream(model, context, {
    apiKey: 'test-key',
    maxRetries: 0,
    onPayload: (payload) => {
      captured = structuredClone(payload) as Record<string, unknown>;
      return undefined;
    },
    fetch: (async () => {
      throw new Error('offline: request captured before transport');
    }) as unknown as typeof globalThis.fetch,
  });
  const result = await eventStream.result();
  expect(result.stopReason).toBe('error');
  expect(captured).toBeDefined();

  if (!captured) throw new Error('expected a captured payload');
  return { raw: captured, canonical: canonicalizeRequest(captured) };
}

function expectExtends(next: CapturedRequest, previous: CapturedRequest): void {
  expect(next.canonical.system).toBe(previous.canonical.system);
  expect(next.canonical.tools).toBe(previous.canonical.tools);
  expect(next.canonical.messages.slice(0, previous.canonical.messages.length)).toEqual(previous.canonical.messages);
}

function collectCacheMarkers(value: unknown, path: string, found: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => collectCacheMarkers(entry, `${path}[${index}]`, found));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      if (key === 'cache_control') found.push(path);
      else collectCacheMarkers(entry, `${path}.${key}`, found);
    }
  }
}

/** Transcript prefix P: an exchange that ends ready for a provider request. */
function checkpointTranscript(): AgentMessage[] {
  return [user('please investigate the flaky test'), assistant('I will look into it.'), user('go ahead')];
}

describe('prompt-cache prefix identity across transactions', () => {
  it('KEEP: committed transactions leave every request append-only', async () => {
    const prefix = checkpointTranscript();
    const checkpoint = await buildRequest(prefix, []);

    const withBegin = [...prefix, ...toolTurn('transaction_begin', 'begin-1', {}, 'Opened transaction begin-1')];
    const afterBegin = await buildRequest(withBegin, [begin('tx-1', 'begin-1')]);
    expectExtends(afterBegin, checkpoint);

    const withWork = [...withBegin, ...toolTurn('probe', 'probe-1', { target: 'flaky test' }, 'found a race')];
    const duringWork = await buildRequest(withWork, [begin('tx-1', 'begin-1')]);
    expectExtends(duringWork, afterBegin);

    const committed = [...withWork, ...toolTurn('transaction_end', 'end-1', { disposition: 'commit' }, 'Closed transaction')];
    const events = [begin('tx-1', 'begin-1'), end('tx-1', 'end-1', 'commit')];
    const afterCommit = await buildRequest(committed, events);
    expectExtends(afterCommit, duringWork);

    const followUp = await buildRequest([...committed, user('now fix it')], events);
    expectExtends(followUp, afterCommit);
  });

  /**
   * Requests at the transaction checkpoint (its begin turn already answered),
   * then after closing it with `disposition`: the checkpoint request must be an
   * untouched prefix of the post-close request.
   */
  async function closeAt(
    disposition: TransactionEndEvent['disposition'],
    extra: { summary?: string; result?: string; carryforward?: string },
    after: AgentMessage[] = [],
  ): Promise<{ checkpoint: CapturedRequest; closed: CapturedRequest }> {
    const opened = [...checkpointTranscript(), ...toolTurn('transaction_begin', 'begin-1', {}, 'Opened transaction begin-1')];
    const checkpoint = await buildRequest(opened, [begin('tx-1', 'begin-1')]);
    const transcript = [
      ...opened,
      ...toolTurn('probe', 'probe-1', { target: 'hypothesis A' }, 'noisy dump'),
      ...toolTurn('transaction_end', 'end-1', { disposition }, 'Closed transaction'),
      ...after,
    ];
    const closed = await buildRequest(transcript, [begin('tx-1', 'begin-1'), end('tx-1', 'end-1', disposition, extra)]);
    expect(closed.canonical.messages.slice(0, checkpoint.canonical.messages.length)).toEqual(checkpoint.canonical.messages);
    expect(closed.canonical.system).toBe(checkpoint.canonical.system);
    expect(closed.canonical.tools).toBe(checkpoint.canonical.tools);
    expect(JSON.stringify(closed.canonical.messages)).not.toContain('noisy dump');
    return { checkpoint, closed };
  }

  it('REVERT: keeps the checkpoint prefix, then only the end turn carrying the carryforward', async () => {
    const { checkpoint, closed } = await closeAt('revert', { carryforward: 'Hypothesis A is dead' });
    // The agent's transaction_end call, then its result.
    expect(closed.canonical.messages.length).toBe(checkpoint.canonical.messages.length + 2);
    expect(closed.canonical.messages.at(-2)).toContain('transaction_end');
    expect(closed.canonical.messages.at(-1)).toContain('Carryforward: Hypothesis A is dead');
  });

  it('REVERT + MESSAGE: appends the new message after the end turn', async () => {
    const { checkpoint, closed } = await closeAt('revert', { carryforward: 'Hypothesis A is dead' }, [
      user('try hypothesis B instead'),
    ]);
    const tail = JSON.stringify(closed.canonical.messages.slice(checkpoint.canonical.messages.length));
    expect(tail).toContain('Carryforward: Hypothesis A is dead');
    expect(closed.canonical.messages.at(-1)).toContain('try hypothesis B instead');
  });

  it('COMPACT: keeps the checkpoint prefix, then the end turn carrying the summary', async () => {
    const { checkpoint, closed } = await closeAt('compact', { summary: 'Race is a lock ordering issue' });
    expect(closed.canonical.messages.length).toBe(checkpoint.canonical.messages.length + 2);
    expect(closed.canonical.messages.at(-1)).toContain('Race is a lock ordering issue');
  });

  it('SQUASH: keeps the checkpoint prefix, then the end turn carrying the result', async () => {
    const { checkpoint, closed } = await closeAt('squash', { result: 'Root cause: double unlock' });
    expect(closed.canonical.messages.length).toBe(checkpoint.canonical.messages.length + 2);
    expect(closed.canonical.messages.at(-1)).toContain('Root cause: double unlock');
  });

  it('places cache_control on the stable breakpoints only', async () => {
    const prefix = checkpointTranscript();
    const { raw } = await buildRequest(prefix, []);

    const markers: string[] = [];
    collectCacheMarkers(raw, '$', markers);
    // One on the last tool, one on the system block, one on the last block of
    // the last message: at most 4 breakpoints are allowed per request.
    expect(markers.length).toBeLessThanOrEqual(4);
    expect(markers).toContain(`$.tools[${tools.length - 1}]`);
    expect(markers.some((path) => path.startsWith('$.system['))).toBe(true);
    const messages = raw.messages as unknown[];
    expect(markers.some((path) => path.startsWith(`$.messages[${messages.length - 1}]`))).toBe(true);
  });
});
