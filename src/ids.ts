declare const brand: unique symbol;

type Brand<T, B extends string> = T & { readonly [brand]: B };

/**
 * Compile-time-only newtypes for the identifiers the search subsystem passes
 * around. pi's own types (SessionEntry, TransactionEvent) carry plain
 * strings; the as* constructors are pure casts that mark the boundary where a
 * raw string is blessed into the branded world. Branded ids are still
 * strings at runtime, so they bind to node:sqlite statements unchanged.
 */
export type SessionId = Brand<string, 'SessionId'>;
export type EntryId = Brand<string, 'EntryId'>;
export type TransactionId = Brand<string, 'TransactionId'>;

export function asSessionId(value: string): SessionId {
  return value as SessionId;
}

export function asEntryId(value: string): EntryId {
  return value as EntryId;
}

export function asTransactionId(value: string): TransactionId {
  return value as TransactionId;
}
