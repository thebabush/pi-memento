declare const brand: unique symbol;

type Brand<T, B extends string> = T & { readonly [brand]: B };

/**
 * Compile-time-only newtypes for the identifiers pi-memento passes around.
 * pi's own types (SessionEntry, ToolCall, tool results) carry plain strings;
 * the as* constructors are pure casts that mark the boundary where a raw
 * string is blessed into the branded world. Persisted transaction events are
 * blessed by the isTransactionEvent type guard, which validates the ids.
 * Branded ids are still strings at runtime, so they compare against pi's raw
 * ids and bind to node:sqlite statements unchanged.
 */
export type SessionId = Brand<string, 'SessionId'>;
export type EntryId = Brand<string, 'EntryId'>;
export type TransactionId = Brand<string, 'TransactionId'>;
export type ToolCallId = Brand<string, 'ToolCallId'>;

export function asSessionId(value: string): SessionId {
  return value as SessionId;
}

export function asEntryId(value: string): EntryId {
  return value as EntryId;
}

export function asTransactionId(value: string): TransactionId {
  return value as TransactionId;
}

export function asToolCallId(value: string): ToolCallId {
  return value as ToolCallId;
}
