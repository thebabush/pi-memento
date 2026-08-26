import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { ToolCall } from '@earendil-works/pi-ai';
import type {
  ReplayResult,
  TransactionDiagnostic,
  TransactionEndEvent,
  TransactionRecord,
} from './types.js';

interface LocatedTransaction {
  record: TransactionRecord;
  start: number;
  end: number;
  children: LocatedTransaction[];
}

type TransactionProjectionMessage = Extract<AgentMessage, { role: 'custom' }>;

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
  toolCallId: string,
  toolName: 'transaction_begin' | 'transaction_end',
): number {
  return messages.findIndex((message) => {
    const calls = toolCalls(message);
    return calls.length === 1 && calls[0]?.id === toolCallId && calls[0].name === toolName;
  });
}

function findToolResult(
  messages: readonly AgentMessage[],
  toolCallId: string,
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
    end: record.end ? endResult + 1 : messages.length,
    children,
  };
}

function syntheticMessage(
  label: 'summary' | 'result' | 'carryforward',
  content: string,
  end: TransactionEndEvent,
  timestamp: number,
): TransactionProjectionMessage {
  const title = label === 'summary' ? 'Transaction summary' : label === 'result' ? 'Transaction result' : 'Carryforward';
  return {
    role: 'custom',
    customType: 'context-transaction-projection',
    content: `[${title}: ${content}]`,
    display: false,
    details: { transactionId: end.transactionId, kind: label },
    timestamp,
  };
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

function renderTransaction(messages: readonly AgentMessage[], located: LocatedTransaction): AgentMessage[] {
  const { record, start, end, children } = located;
  const projectedRaw = renderContainer(messages, start, end, children);
  if (!record.end || record.end.disposition === 'commit') return projectedRaw;

  const timestamp = messages[end - 1]?.timestamp ?? Date.now();
  const replacement: AgentMessage[] = [];
  if (record.end.disposition === 'compact' && record.end.summary) {
    replacement.push(syntheticMessage('summary', record.end.summary, record.end, timestamp));
  }
  if (record.end.disposition === 'squash' && record.end.result) {
    replacement.push(syntheticMessage('result', record.end.result, record.end, timestamp));
  }
  if (record.end.carryforward) {
    replacement.push(syntheticMessage('carryforward', record.end.carryforward, record.end, timestamp));
  }
  return replacement;
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
