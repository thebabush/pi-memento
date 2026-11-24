import type { AgentMessage } from '@earendil-works/pi-agent-core';
import {
  type Api,
  type AssistantMessage,
  type Context,
  type Model,
  type SimpleStreamOptions,
  type ThinkingLevel,
  type Tool,
  type Usage,
  uuidv7,
} from '@earendil-works/pi-ai';
import {
  buildSessionContext,
  convertToLlm,
  serializeConversation,
  type ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import type { ToolCallId } from './ids.js';
import { projectMessages } from './project.js';
import type { ReplayResult, TransactionRecord } from './types.js';

export interface GeneratedSummary {
  summary: string;
  usage: Usage;
}

export interface SummaryRequest {
  messages: readonly AgentMessage[];
  systemPrompt: string;
  emptyError: string;
  signal?: AbortSignal;
}

const TRANSACTION_SUMMARY_PROMPT =
  'Summarize a speculative agent transaction for future context. Preserve conclusions, evidence, changes made, unresolved questions, and operational state. Omit dead ends and conversational narration. Do not invent facts.';

/**
 * The parts of the agent's own provider request that the extension cannot read
 * from ExtensionContext: the active tools, in the order the agent sends them,
 * and the thinking level (undefined when thinking is off). pi's tool listing
 * omits `constrainedSampling`, which built-in tools only set under experimental
 * features; with those enabled the tools render differently and the summary
 * request misses the cache (it still works, at full price).
 */
export interface AgentRequestShape {
  tools: readonly Tool[];
  reasoning?: ThinkingLevel;
}

function containsToolCall(message: AgentMessage, toolCallId: ToolCallId): boolean {
  return (
    message.role === 'assistant' &&
    message.content.some((part) => part.type === 'toolCall' && part.id === toolCallId)
  );
}

export async function summarizeOpenTransaction(
  ctx: ExtensionContext,
  replay: ReplayResult,
  transaction: TransactionRecord,
  endToolCallId: ToolCallId,
  agentRequest?: AgentRequestShape,
): Promise<GeneratedSummary> {
  if (!ctx.model) throw new Error('Cannot compact a transaction without an active model');
  if (!ctx.modelRegistry.hasConfiguredAuth(ctx.model)) {
    throw new Error(`No authentication is configured for ${ctx.model.provider}/${ctx.model.id}`);
  }

  const projected = projectMessages(buildSessionContext(ctx.sessionManager.getBranch()).messages, replay);
  if (!projected.safe) {
    throw new Error(`Cannot compact an unsafe transaction projection: ${projected.diagnostics[0]?.message}`);
  }

  const beginResultIndex = projected.messages.findIndex(
    (message) => message.role === 'toolResult' && message.toolCallId === transaction.begin.boundaryToolCallId,
  );
  const endCallIndex = projected.messages.findIndex((message) => containsToolCall(message, endToolCallId));
  if (beginResultIndex < 0 || endCallIndex <= beginResultIndex) {
    throw new Error('Could not locate the transaction body for summarization');
  }

  const body = projected.messages.slice(beginResultIndex + 1, endCallIndex);
  if (!serializeConversation(convertToLlm([...body])).trim()) throw new Error('Cannot compact an empty transaction');
  if (agentRequest) {
    const turn = projected.messages.slice(0, endCallIndex + 1);
    const cached = await summarizeInPlace(ctx, agentRequest, turn, transaction, endToolCallId);
    if (cached.summary) return { summary: cached.summary, usage: cached.usage };
    const isolated = await summarizeIsolated(ctx, body);
    return { summary: isolated.summary, usage: addUsage(cached.usage, isolated.usage) };
  }
  return summarizeIsolated(ctx, body);
}

function summarizeIsolated(ctx: ExtensionContext, body: readonly AgentMessage[]): Promise<GeneratedSummary> {
  return generateSummary(ctx, {
    messages: body,
    systemPrompt: TRANSACTION_SUMMARY_PROMPT,
    emptyError: 'Cannot compact an empty transaction',
    signal: ctx.signal,
  });
}

/**
 * Ask for the summary as the agent's next turn to make its prefix eligible for
 * cache reuse: the agent's last request (system prompt,
 * tools, projected messages, cache session id), then its own transaction_end
 * call, then a result for that call carrying the summarize instruction. An
 * isolated request would re-prefill the transaction body at full price.
 *
 * Every part has to match what the agent sends:
 * - The transaction_end call itself must be included. Codex continues a
 *   server-side response chain over WebSocket only when the new input extends
 *   the previous request plus the previous response; anything else falls back
 *   to a full request (and drops the chain, so the agent's next turn would pay
 *   too).
 * - Request settings: changing reasoning can invalidate cached messages, so the request goes
 *   through `completeLikeAgent` with the agent's thinking level.
 * - Transport: the Codex chain is only used when it is requested explicitly.
 *   Extensions cannot read pi's transport setting, so this assumes pi's
 *   default, `auto`.
 *
 * Returns no summary when the model answered with something other than text
 * (e.g. a tool call), so the caller can fall back to an isolated request.
 */
async function summarizeInPlace(
  ctx: ExtensionContext,
  agentRequest: AgentRequestShape,
  turn: readonly AgentMessage[],
  transaction: TransactionRecord,
  endToolCallId: ToolCallId,
): Promise<{ summary?: string; usage: Usage }> {
  if (!ctx.model) throw new Error('Cannot compact a transaction without an active model');
  const purpose = transaction.begin.purpose ? ` (purpose: ${transaction.begin.purpose})` : '';
  const instruction =
    `Closing transaction ${transaction.transactionId}${purpose} with disposition compact. ` +
    'Everything after its transaction_begin call is about to be replaced in your context by the summary you write now. ' +
    `${TRANSACTION_SUMMARY_PROMPT} Summarize only the transaction body, not what came before it. ` +
    'Reply with the summary as plain text. Do not call any tools.';
  const result: AgentMessage = {
    role: 'toolResult',
    toolCallId: endToolCallId,
    toolName: 'transaction_end',
    content: [{ type: 'text', text: instruction }],
    isError: false,
    timestamp: Date.now(),
  };
  const response = await completeLikeAgent(
    ctx,
    ctx.model,
    { systemPrompt: ctx.getSystemPrompt(), messages: convertToLlm([...turn, result]), tools: [...agentRequest.tools] },
    {
      reasoning: agentRequest.reasoning,
      sessionId: ctx.sessionManager.getSessionId(),
      transport: 'auto',
      signal: ctx.signal,
    },
  );
  if (response.stopReason === 'aborted' || response.stopReason === 'error') {
    throw new Error(`Summarization ${response.stopReason}`);
  }
  // Tool-call preambles and token-limited answers are not durable summaries.
  // No tools are executed on this side request; retry with the isolated prompt.
  const summary = isCompleteText(response) ? responseText(response) : '';
  return { ...(summary && { summary }), usage: response.usage };
}

/** pi-ai stream options the summary request sets; sessionId is pi's prompt-cache key. */
type AgentStreamOptions = Pick<SimpleStreamOptions, 'reasoning' | 'signal'> &
  Required<Pick<SimpleStreamOptions, 'sessionId' | 'transport'>>;

/**
 * Complete a request the way the agent loop does: through the provider's
 * `streamSimple`, which maps the thinking level to the provider's own reasoning
 * settings. `modelRegistry` only exposes `complete`, which skips that mapping,
 * so this repeats the registry's auth step with its public accessors.
 */
async function completeLikeAgent(
  ctx: ExtensionContext,
  model: Model<Api>,
  context: Context,
  options: AgentStreamOptions,
): Promise<AssistantMessage> {
  const provider = ctx.modelRegistry.getProvider(model.provider);
  const resolution = await ctx.modelRegistry.getProviderAuth(model.provider);
  if (!provider || !resolution) throw new Error(`Provider is not configured: ${model.provider}`);
  const { auth, env } = resolution;
  const requestModel = auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model;
  return provider
    .streamSimple(requestModel, context, { ...options, apiKey: auth.apiKey, headers: auth.headers, env })
    .result();
}

function responseText(response: AssistantMessage): string {
  return response.content
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
    .trim();
}

function isCompleteText(response: AssistantMessage): boolean {
  return response.stopReason === 'stop' && !response.content.some((part) => part.type === 'toolCall');
}

function addUsage(a: Usage, b: Usage): Usage {
  const optional = (x?: number, y?: number) => (x === undefined && y === undefined ? undefined : (x ?? 0) + (y ?? 0));
  const reasoning = optional(a.reasoning, b.reasoning);
  const cacheWrite1h = optional(a.cacheWrite1h, b.cacheWrite1h);
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    ...(cacheWrite1h !== undefined && { cacheWrite1h }),
    ...(reasoning !== undefined && { reasoning }),
    totalTokens: a.totalTokens + b.totalTokens,
    cost: {
      input: a.cost.input + b.cost.input,
      output: a.cost.output + b.cost.output,
      cacheRead: a.cost.cacheRead + b.cost.cacheRead,
      cacheWrite: a.cost.cacheWrite + b.cost.cacheWrite,
      total: a.cost.total + b.cost.total,
    },
  };
}

export async function generateSummary(ctx: ExtensionContext, request: SummaryRequest): Promise<GeneratedSummary> {
  if (!ctx.model) throw new Error('Cannot generate a summary without an active model');
  if (!ctx.modelRegistry.hasConfiguredAuth(ctx.model)) {
    throw new Error(`No authentication is configured for ${ctx.model.provider}/${ctx.model.id}`);
  }

  const conversation = serializeConversation(convertToLlm([...request.messages]));
  if (!conversation.trim()) throw new Error(request.emptyError);

  const response = await ctx.modelRegistry.complete(
    ctx.model,
    {
      systemPrompt: request.systemPrompt,
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: conversation }],
          timestamp: Date.now(),
        },
      ],
    },
    {
      signal: request.signal,
      cacheRetention: 'none',
      sessionId: uuidv7(),
    },
  );

  if (response.stopReason === 'aborted' || response.stopReason === 'error') {
    throw new Error(`Summarization ${response.stopReason}`);
  }
  if (!isCompleteText(response)) throw new Error('Summarization returned an incomplete result');
  const summary = responseText(response);
  if (!summary) throw new Error('Summarization returned an empty result');
  return { summary, usage: response.usage };
}
