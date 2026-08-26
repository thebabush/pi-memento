# pi Integration Contract

This document describes the actual integration contract between pi-memento and `@earendil-works/pi-coding-agent` 0.84.x. The extension pins and tests its supported pi version (0.84.3) because the repository and package namespace have recently changed.

## Architecture

The extension keeps two layers:

1. A pure transaction engine that replays immutable events, validates nesting, builds intervals, and projects `AgentMessage[]`.
2. A thin pi adapter that registers tools and hooks, reads the active session branch, writes custom entries, and invokes a summarizer.

The extension needs only public pi APIs:

| Need | pi surface |
|---|---|
| Agent-facing operations | `pi.registerTool()` |
| Durable metadata | `pi.appendEntry()` |
| Active branch and boundary IDs | `ctx.sessionManager.getBranch()` and `getLeafId()` |
| Model-visible projection | `pi.on('context')` |
| Safe compaction | `pi.on('session_before_compact')` |
| Generated summaries | `ctx.modelRegistry.complete()` |

It does not use `before_provider_request`, rewrite the JSONL file, or mutate `SessionManager` internals.

## Durable event schema

Transaction events are persisted as one custom entry type, versioned from the start:

```ts
type TransactionEventV1 =
  | {
      version: 1;
      kind: 'begin';
      transactionId: string;
      parentTransactionId?: string;
      purpose?: string;
      boundaryToolCallId: string;
      boundaryEntryId: string;
    }
  | {
      version: 1;
      kind: 'end';
      transactionId: string;
      disposition: 'commit' | 'compact' | 'squash' | 'revert';
      summary?: string;
      result?: string;
      carryforward?: string;
      boundaryToolCallId: string;
      boundaryEntryId: string;
    };
```

Persisted with:

```ts
pi.appendEntry('context-transaction', event);
```

These are immutable events rather than state snapshots. Replaying only matching custom entries from `ctx.sessionManager.getBranch()` reconstructs the active branch's stack and closed transactions.

## Tool contract

The extension registers three sequential tools:

```ts
transaction_begin({ purpose?: string })

transaction_end({
  disposition: 'commit' | 'compact' | 'squash' | 'revert';
  result?: string;
  carryforward?: string;
})

transaction_status()
```

Rules:

- `transaction_begin` and `transaction_end` must be the only tool call in their assistant message. `executionMode: 'sequential'` prevents races but does not enforce exclusivity, so the implementation inspects the current leaf assistant message and rejects mixed batches.
- `transaction_end` always closes the top stack item; v1 exposes no arbitrary transaction ID to the model.
- `squash` requires a non-empty `result`.
- `result` is rejected for other dispositions to avoid ambiguous durable memory.
- `revert` requires a non-empty `carryforward`, so a discarded exploration still leaves its lesson.
- `carryforward` is rejected for `commit`.
- Empty `purpose` and `carryforward` values are normalized away.
- For `compact`, the summary is generated before appending the end event. Failure or cancellation leaves the transaction open and returns an error tool result.
- `transaction_status` is read-only and may coexist with other tool calls.

The boundary tool's `toolCallId` is the message-level anchor. The current leaf ID is recorded as `boundaryEntryId`; when the tool executes, pi has synchronized the current assistant message into the session.

## Projection contract

The `context` handler receives the current message list and returns a replacement list without changing session history. It:

1. Replays transaction events from the active branch.
2. Locates begin/end assistant tool calls and matching tool results by `boundaryToolCallId`.
3. Rejects or conservatively retains malformed intervals; it never deletes content based on a partially matched boundary.
4. Builds the nested interval tree.
5. Projects children before parents.

Disposition behavior:

| State/disposition | Projected context |
|---|---|
| Open | Raw transaction, with closed child projections applied |
| Commit | Raw transaction, with closed child projections applied |
| Compact | One synthetic transaction-summary message, then optional carryforward |
| Squash | One synthetic result message, then optional carryforward |
| Revert | Carryforward only |

The parent disposition owns its entire interval after child projection. Consequently, reverting an outer transaction also removes a committed inner transaction.

Synthetic messages use pi's custom agent-message shape:

```ts
{
  role: 'custom',
  customType: 'context-transaction-projection',
  content: '[Transaction result: ...]',
  display: false,
  details: { transactionId, kind },
  timestamp: endTimestamp,
}
```

They exist only in the derived context. They are never appended as canonical custom-message entries.

## Compaction contract

Transaction-aware compaction is mandatory. Pi's default compactor works from canonical branch history and can otherwise summarize reverted material back into model context.

The `session_before_compact` handler:

1. Chooses a cut that does not bisect any transaction interval.
2. Keeps every open transaction entirely in the retained tail.
3. Applies the same projection engine to the prefix being summarized.
4. Generates a summary from that projected prefix through `ctx.modelRegistry.complete()`.
5. Returns a complete custom compaction result with the adjusted `firstKeptEntryId`, original `tokensBefore`, summary-model usage, and versioned details.

If an open transaction is too large to retain, compaction is cancelled with an explicit instruction to close the transaction. Automatically summarizing its interior would make a later exact commit, squash, or revert impossible.

Compaction details record:

```ts
{
  contextTransactions: {
    version: 1,
    projectionApplied: true,
    requestedFirstKeptEntryId,
    adjustedFirstKeptEntryId,
  }
}
```

This enables safe migration and prevents future versions from assuming that an old summary respected transaction dispositions.

## Branching and lifecycle

- State is recomputed from `getBranch()` rather than maintained in a global in-memory stack. Branch navigation and resume then work naturally.
- A branch taken before an end event sees the transaction as open.
- A branch taken before a begin event does not see the transaction.
- Session reload during an open transaction preserves it as open.
- Session switch, fork, and `/tree` need no special mutation handlers because every operation reads the active branch on demand.
- A malformed event log disables destructive projection entirely: the context is passed through unmodified, and the diagnostics are reported by `transaction_status`.

## Compatibility boundary

The adapter relies on these public behaviors:

- Context messages preserve assistant tool-call IDs and matching tool-result IDs.
- A custom entry appended during tool execution becomes part of the active branch.
- `context` runs before each provider request and handler results are chained.
- `session_before_compact` can replace default compaction.
- `modelRegistry.complete()` remains callable from extension handlers and tools.

The extension pins pi 0.84.x. Widening the supported range remains future work and should be preceded by contract tests around these assumptions against the newer version.
