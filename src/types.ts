export const TRANSACTION_ENTRY_TYPE = 'context-transaction';
export const TRANSACTION_EVENT_VERSION = 1;

export type TransactionDisposition = 'commit' | 'compact' | 'squash' | 'revert';

export interface TransactionBeginEvent {
  version: 1;
  kind: 'begin';
  transactionId: string;
  parentTransactionId?: string;
  purpose?: string;
  boundaryToolCallId: string;
  boundaryEntryId: string;
}

interface TransactionEndEventBase {
  version: 1;
  kind: 'end';
  transactionId: string;
  boundaryToolCallId: string;
  boundaryEntryId: string;
}

export type TransactionEndEvent =
  | (TransactionEndEventBase & {
      disposition: 'commit';
      summary?: never;
      result?: never;
      carryforward?: never;
    })
  | (TransactionEndEventBase & {
      disposition: 'compact';
      summary: string;
      result?: never;
      carryforward?: string;
    })
  | (TransactionEndEventBase & {
      disposition: 'squash';
      summary?: never;
      result: string;
      carryforward?: string;
    })
  | (TransactionEndEventBase & {
      disposition: 'revert';
      summary?: never;
      result?: never;
      carryforward: string;
    });

export type TransactionEvent = TransactionBeginEvent | TransactionEndEvent;

export interface TransactionRecord {
  transactionId: string;
  parentTransactionId?: string;
  begin: TransactionBeginEvent;
  end?: TransactionEndEvent;
  children: TransactionRecord[];
}

export interface TransactionDiagnostic {
  code:
    | 'duplicate_begin'
    | 'parent_mismatch'
    | 'unknown_end'
    | 'non_lifo_end'
    | 'missing_boundary'
    | 'partial_boundary';
  message: string;
  transactionId?: string;
}

export interface ReplayResult {
  roots: TransactionRecord[];
  openStack: TransactionRecord[];
  records: Map<string, TransactionRecord>;
  diagnostics: TransactionDiagnostic[];
}

export function isTransactionEvent(value: unknown): value is TransactionEvent {
  if (!value || typeof value !== 'object') return false;
  const event = value as Record<string, unknown>;
  if (event.version !== TRANSACTION_EVENT_VERSION) return false;
  const hasBoundary =
    typeof event.transactionId === 'string' &&
    event.transactionId.length > 0 &&
    typeof event.boundaryToolCallId === 'string' &&
    event.boundaryToolCallId.length > 0 &&
    typeof event.boundaryEntryId === 'string' &&
    event.boundaryEntryId.length > 0;
  if (!hasBoundary) return false;

  if (event.kind === 'begin') {
    return (
      (event.parentTransactionId === undefined || typeof event.parentTransactionId === 'string') &&
      (event.purpose === undefined || typeof event.purpose === 'string')
    );
  }
  if (event.kind === 'end') {
    const carryforwardValid = event.carryforward === undefined || typeof event.carryforward === 'string';
    if (event.disposition === 'commit') {
      return event.summary === undefined && event.result === undefined && event.carryforward === undefined;
    }
    if (event.disposition === 'compact') {
      return (
        typeof event.summary === 'string' &&
        event.summary.trim().length > 0 &&
        event.result === undefined &&
        carryforwardValid
      );
    }
    if (event.disposition === 'squash') {
      return (
        event.summary === undefined &&
        typeof event.result === 'string' &&
        event.result.trim().length > 0 &&
        carryforwardValid
      );
    }
    if (event.disposition === 'revert') {
      return (
        event.summary === undefined &&
        event.result === undefined &&
        typeof event.carryforward === 'string' &&
        event.carryforward.trim().length > 0
      );
    }
    return false;
  }
  return false;
}
