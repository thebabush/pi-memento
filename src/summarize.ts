import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { type Usage, uuidv7 } from '@earendil-works/pi-ai';
import {
  buildSessionContext,
  convertToLlm,
  serializeConversation,
  type ExtensionContext,
} from '@earendil-works/pi-coding-agent';
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

function containsToolCall(message: AgentMessage, toolCallId: string): boolean {
  return (
    message.role === 'assistant' &&
    message.content.some((part) => part.type === 'toolCall' && part.id === toolCallId)
  );
}

export async function summarizeOpenTransaction(
  ctx: ExtensionContext,
  replay: ReplayResult,
  transaction: TransactionRecord,
  endToolCallId: string,
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

  return generateSummary(ctx, {
    messages: projected.messages.slice(beginResultIndex + 1, endCallIndex),
    systemPrompt:
      'Summarize a speculative agent transaction for future context. Preserve conclusions, evidence, changes made, unresolved questions, and operational state. Omit dead ends and conversational narration. Do not invent facts.',
    emptyError: 'Cannot compact an empty transaction',
    signal: ctx.signal,
  });
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
  const summary = response.content
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
    .trim();
  if (!summary) throw new Error('Summarization returned an empty result');
  return { summary, usage: response.usage };
}
