import type {
  ReplayResult,
  TransactionDiagnostic,
  TransactionEvent,
  TransactionRecord,
} from './types.js';

export function replayTransactions(events: readonly TransactionEvent[]): ReplayResult {
  const roots: TransactionRecord[] = [];
  const records = new Map<string, TransactionRecord>();
  const stack: TransactionRecord[] = [];
  const diagnostics: TransactionDiagnostic[] = [];

  for (const event of events) {
    if (event.kind === 'begin') {
      if (records.has(event.transactionId)) {
        diagnostics.push({
          code: 'duplicate_begin',
          transactionId: event.transactionId,
          message: `Transaction ${event.transactionId} begins more than once`,
        });
        continue;
      }

      const parent = stack.at(-1);
      if (event.parentTransactionId !== parent?.transactionId) {
        diagnostics.push({
          code: 'parent_mismatch',
          transactionId: event.transactionId,
          message: `Transaction ${event.transactionId} declares parent ${event.parentTransactionId ?? '<root>'}, expected ${parent?.transactionId ?? '<root>'}`,
        });
      }

      const record: TransactionRecord = {
        transactionId: event.transactionId,
        parentTransactionId: parent?.transactionId,
        begin: event,
        children: [],
      };
      records.set(record.transactionId, record);
      if (parent) parent.children.push(record);
      else roots.push(record);
      stack.push(record);
      continue;
    }

    const record = records.get(event.transactionId);
    if (!record) {
      diagnostics.push({
        code: 'unknown_end',
        transactionId: event.transactionId,
        message: `Transaction ${event.transactionId} ends without a matching begin`,
      });
      continue;
    }

    const active = stack.at(-1);
    if (active !== record) {
      diagnostics.push({
        code: 'non_lifo_end',
        transactionId: event.transactionId,
        message: `Transaction ${event.transactionId} cannot close while ${active?.transactionId ?? 'no transaction'} is active`,
      });
      continue;
    }

    record.end = event;
    stack.pop();
  }

  return { roots, openStack: [...stack], records, diagnostics };
}
