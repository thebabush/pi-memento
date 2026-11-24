import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { ToolCall } from '@earendil-works/pi-ai';
import { assertNever } from './assert.js';
import type { ToolCallId } from './ids.js';
import type {
  ReplayResult,
  TransactionDiagnostic,
  TransactionEndEvent,
  TransactionRecord,
} from './types.js';

interface LocatedTransaction {
  record: TransactionRecord;
  start: number;
  /** Index of the transaction_begin result; the body starts right after it. */
  beginResult: number;
  /** Index of the transaction_end call (equals `end` while still open). */
  endCall: number;
  /** One past the transaction_end result (or the end of the context while open). */
  end: number;
  children: LocatedTransaction[];
}

export interface ProjectionResult {
  messages: AgentMessage[];
  diagnostics: TransactionDiagnostic[];
  safe: boolean;
}

function toolCalls(message: AgentMessage): ToolCall[] {
  if (message.role !== 'assistant') return [];
  return message.content.filter((part): part is ToolCall => part.type === 'toolCall');
}

function findExclusiveAssistantCall(
  messages: readonly AgentMessage[],
  toolCallId: ToolCallId,
  toolName: 'transaction_begin' | 'transaction_end',
): number {
  return messages.findIndex((message) => {
    const calls = toolCalls(message);
    return calls.length === 1 && calls[0]?.id === toolCallId && calls[0].name === toolName;
  });
}

function findToolResult(
  messages: readonly AgentMessage[],
  toolCallId: ToolCallId,
  toolName: 'transaction_begin' | 'transaction_end',
): number {
  return messages.findIndex(
    (message) =>
      message.role === 'toolResult' &&
      message.toolCallId === toolCallId &&
      message.toolName === toolName,
  );
}

function locateRecord(
  messages: readonly AgentMessage[],
  record: TransactionRecord,
  diagnostics: TransactionDiagnostic[],
): LocatedTransaction | undefined {
  const beginCall = findExclusiveAssistantCall(messages, record.begin.boundaryToolCallId, 'transaction_begin');
  const beginResult = findToolResult(messages, record.begin.boundaryToolCallId, 'transaction_begin');
  const endCall = record.end
    ? findExclusiveAssistantCall(messages, record.end.boundaryToolCallId, 'transaction_end')
    : -1;
  const endResult = record.end
    ? findToolResult(messages, record.end.boundaryToolCallId, 'transaction_end')
    : -1;

  const beginAbsent = beginCall < 0 && beginResult < 0;
  const endAbsent = !record.end || (endCall < 0 && endResult < 0);

  if (record.end && beginAbsent && endAbsent) return undefined;

  if (!record.end && beginAbsent) {
    diagnostics.push({
      code: 'missing_boundary',
      transactionId: record.transactionId,
      message: `Open transaction ${record.transactionId} begins outside the current context`,
    });
    return undefined;
  }

  const beginPartial = beginCall < 0 || beginResult < 0;
  const endPartial = Boolean(record.end) && (endCall < 0 || endResult < 0);
  if (beginPartial || endPartial) {
    diagnostics.push({
      code: 'partial_boundary',
      transactionId: record.transactionId,
      message: `Transaction ${record.transactionId} has only part of a boundary in the current context`,
    });
    return undefined;
  }

  if (beginResult <= beginCall || (record.end && (endCall <= beginResult || endResult <= endCall))) {
    diagnostics.push({
      code: 'partial_boundary',
      transactionId: record.transactionId,
      message: `Transaction ${record.transactionId} boundaries are out of order`,
    });
    return undefined;
  }

  const children = record.children
    .map((child) => locateRecord(messages, child, diagnostics))
    .filter((child): child is LocatedTransaction => child !== undefined);

  return {
    record,
    start: beginCall,
    beginResult,
    endCall: record.end ? endCall : messages.length,
    end: record.end ? endResult + 1 : messages.length,
    children,
  };
}

/**
 * The transaction_end result text: what the agent sees for a closed
 * transaction. The tool returns exactly this, and the projection renders the
 * stored end result from the end event with it, so the agent keeps seeing the
 * same bytes on every later request.
 */
export function closedTransactionText(end: TransactionEndEvent): string {
  const header = `Closed transaction ${end.transactionId} with disposition ${end.disposition}`;
  const lines = [header];
  switch (end.disposition) {
    case 'commit':
      return header;
    case 'compact':
      lines.push(`Its body is replaced in your context by this summary:\n${end.summary}`);
      break;
    case 'squash':
      lines.push(`Its body is replaced in your context by this result:\n${end.result}`);
      break;
    case 'revert':
      lines.push('Its body is removed from your context.');
      break;
    default:
      return assertNever(end);
  }
  if (end.carryforward) lines.push(`Carryforward: ${end.carryforward}`);
  if (end.next) lines.push(`Next action: ${end.next}`);
  return lines.join('\n');
}

function messageText(message: AgentMessage): string | undefined {
  if (message.role !== 'toolResult' || message.content.length !== 1) return undefined;
  const [part] = message.content;
  return part?.type === 'text' ? part.text : undefined;
}

/**
 * The stored end result, rendered with the retained content. Sessions written
 * by this version already store exactly that text, so the original object is
 * returned (visibility tracks messages by identity); older sessions stored a
 * bare acknowledgement and get a copy.
 */
function renderEndResult(message: AgentMessage, end: TransactionEndEvent): AgentMessage {
  const text = closedTransactionText(end);
  if (message.role !== 'toolResult' || messageText(message) === text) return message;
  return { ...message, content: [{ type: 'text', text }] };
}

function renderContainer(
  messages: readonly AgentMessage[],
  start: number,
  end: number,
  children: readonly LocatedTransaction[],
): AgentMessage[] {
  const output: AgentMessage[] = [];
  let cursor = start;
  for (const child of [...children].sort((a, b) => a.start - b.start)) {
    if (child.start < cursor || child.end > end) continue;
    output.push(...messages.slice(cursor, child.start));
    output.push(...renderTransaction(messages, child));
    cursor = child.end;
  }
  output.push(...messages.slice(cursor, end));
  return output;
}

/**
 * A closed transaction keeps its boundary turns, so the agent can see that it
 * opened and closed it: the transaction_begin call and result, then the
 * transaction_end call and a result that carries what the disposition retains.
 * Only the body between them is dropped (commit keeps it). Without the
 * boundaries the takeaway reads like an unexplained message and the agent
 * tends to redo the work it just closed.
 */
function renderTransaction(messages: readonly AgentMessage[], located: LocatedTransaction): AgentMessage[] {
  const { record, start, beginResult, endCall, end, children } = located;
  if (!record.end || record.end.disposition === 'commit') return renderContainer(messages, start, end, children);
  const endResult = messages[end - 1];
  if (!endResult) return renderContainer(messages, start, end, children);
  return [
    ...messages.slice(start, beginResult + 1),
    ...messages.slice(endCall, end - 1),
    renderEndResult(endResult, record.end),
  ];
}

export function projectMessages(messages: readonly AgentMessage[], replay: ReplayResult): ProjectionResult {
  const diagnostics = [...replay.diagnostics];
  const roots = replay.roots
    .map((record) => locateRecord(messages, record, diagnostics))
    .filter((record): record is LocatedTransaction => record !== undefined);

  if (diagnostics.length > 0) {
    return { messages: [...messages], diagnostics, safe: false };
  }

  return {
    messages: renderContainer(messages, 0, messages.length, roots),
    diagnostics,
    safe: true,
  };
}
