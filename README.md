# pi-memento

Explicit, nested transactions over an agent's own model-visible conversation context: commit, compact, squash, or revert a stretch of exploration without ever rewriting session history.

pi-memento is an extension for pi, the `@earendil-works/pi-coding-agent` coding agent. It is experimental (v0.1.0) and MIT licensed.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/projection-dark.svg">
  <img alt="Canonical history projected into model-visible context: commit keeps the body, compact summarizes it, squash replaces it with a result, revert leaves only a carryforward." src="docs/assets/projection-light.svg">
</picture>

## What it is

Spawning a subagent bundles two separable things:

- an **execution** axis: a separate agent loop, with its own isolation, its own model calls, and a spawn/return boundary that has to be decided up front; and
- a **context** axis: the caller's context keeps only the conclusion; the exploration that produced it is hidden.

Forking couples them. You can only get the context effect by also paying the execution cost, and you have to commit to the boundary before you know how the exploration will go.

pi-memento **decouples the context axis from execution and generalizes it.** It delivers the context effect alone, inside the same agent loop, and lifts the constraints a fork boundary imposes:

- **Any granularity, any point.** Wrap a single tool call or a hundred; open a transaction wherever the work starts getting speculative.
- **Reactive, not up-front.** Decide what to do with a stretch *after* seeing how it went: keep it, summarize it, replace it with a one-line result, or throw it away.
- **Nestable.** Isolate a sub-investigation inside a larger one; each closes independently.
- **A full-keep escape hatch (`commit`)** that a fork boundary cannot express: sometimes the exploration *is* the answer and you want all of it inline.

The two approaches compose rather than compete: subagents partition work across new contexts; pi-memento grooms the memory of a single context, and a subagent can use pi-memento internally.

This is the primitive a long-horizon agent needs, at any depth of a task tree, to keep its working memory clean while doing unpredictable, findings-compound work. Reverse-engineering a protocol is the canonical case: chase many hypotheses inline, keep the one that panned out, squash the rest to their conclusions, and revert the dead ends down to the lesson they taught.

## The model

The extension registers three tools:

```
transaction_begin({ purpose? })
transaction_end({ disposition, result?, carryforward?, next? })
transaction_status()
```

`transaction_begin` and `transaction_end` must each be the **only** tool call in their assistant message (an exclusive boundary). `transaction_end` always closes the **innermost** open transaction (LIFO); transactions nest. `transaction_status` is read-only and reports the currently open stack.

`transaction_end` takes one of four dispositions, each defining what happens to the transaction body in the projected context:

| Disposition | Effect on projected context | Notes |
|---|---|---|
| `commit`  | Keeps the body inline, as if no transaction had wrapped it. | No `result`/`carryforward`/`next`. |
| `compact` | Replaces the body with a summary the extension **generates via a model call**. | The only disposition that calls the model. Optional `carryforward` and `next`. |
| `squash`  | Replaces the body with an explicit `result` string the agent writes itself. | `result` required and non-empty; no model call. Optional `carryforward` and `next`. |
| `revert`  | Removes the body entirely. | **Requires** a non-empty `carryforward` **and** a non-empty `next`, so a dead end leaves both its lesson and the action to take instead. |

Only the body is dropped: the agent's own `transaction_begin` and `transaction_end` calls stay in context, and the `transaction_end` result carries what the disposition retains (summary, result, carryforward, next action). The agent therefore sees that it opened and closed the transaction and what came of it, instead of an unexplained takeaway, which otherwise tends to make it redo the closed work.

`carryforward` is a small durable lesson or instruction that survives the projection: the one thing you want to keep even when the exploration itself is compacted, squashed, or discarded.

`next` is the concrete next action to take once the transaction closes; on a revert it is required, so the abandoned approach is replaced by what to do instead rather than re-investigated.

## When to open a transaction

Open one when a block of work is likely to be noisy, exploratory, disposable, compressible, worth keeping only as a conclusion, or worth abandoning while retaining one lesson.

The property that matters is atomicity at the semantic level: this entire episode was one unit of thought; decide what representation of that episode should survive.

While a transaction is open, the extension counts tool calls since its last boundary (its begin, or the end of its latest closed nested transaction) and every `PI_MEMENTO_NUDGE_EVERY` of them (default 20; `0` disables) appends a short reminder to the tool result: open a nested transaction if the current stretch is a sub-experiment, or close the transaction if its work is done. The reminder is persisted inside the tool result, so the prompt prefix stays append-only.

## Searching forgotten context

The extension also registers two read-only tools:

```
context_search({ query, layer?, scope? })
context_recall({ entryId? | transactionId?, sessionId? })
```

`context_search` searches the agent's own history, including everything the projection hides: bodies of squashed, reverted, and compacted transactions, material dropped by compaction, and work left on abandoned branches. It is backed by a per-project SQLite FTS5 index, `memento-index.sqlite3`, stored next to pi's session files. The index is a derived, disposable artifact: it is rebuilt from canonical history on any schema mismatch and can be deleted at any time.

Defaults are narrow and cheap. `layer` defaults to `takeaways` (transaction purposes, results, summaries, carryforwards, and next actions) and `scope` defaults to `branch` (the active branch of the current session). Escalate `layer` to `full` to search complete entry text, and `scope` to `session` or `project` to include other branches and other sessions. Hits already visible in the current model context are omitted and only counted in the result header, so what is rendered is what the model has actually lost sight of; the remaining entry hits are marked `forgotten` or labeled with their originating session, and takeaway hits carry their disposition. An empty `takeaways` result when no transaction has closed yet says so explicitly instead of suggesting a wider layer.

`context_recall` pulls the full stored content behind a hit: a single entry by `entryId`, or a whole transaction body (header plus everything between its boundaries) by `transactionId`.

Nothing is ever lost. Transactions and compaction only hide content from the projected context; search reads the canonical history underneath.

## Build & run

pi-memento is a plugin, not a vendored fork. It runs a project-local, pinned pi that is a separate binary from any globally installed `pi`; running it does not touch your global install.

```sh
npm install      # fetches pinned pi (@earendil-works/pi-coding-agent@0.84.3) into node_modules
npm run build    # compiles the extension to dist/
./bin/memento    # launches the pinned pi with the extension loaded
```

Optionally symlink the launcher onto your `PATH`:

```sh
ln -s "$PWD/bin/memento" ~/.local/bin/memento
```

Reproducibility comes from `package-lock.json`, and the pinned pi ships its own model catalog, so the build needs no network beyond `npm install`.

Development:

```sh
npm test
npm run check
npm run build
```

## Projection & compaction safety

A transaction only ever affects **conversational context**. The projection is a *view* over canonical history, which stays append-only (JSONL), so a transaction effect is never a rewrite of what happened.

It follows that a transaction **does not roll back the world.** Reverting, squashing, or compacting does not undo files written, commands run, or any other side effect. An open transaction is not a sandbox; never treat it as one for destructive or irreversible actions.

Compaction is transaction-aware. It moves cuts off transaction boundaries so no interval is bisected, keeps every open transaction entirely in the retained tail, and summarizes only the projected durable prefix. On inconsistent boundaries or metadata it **fails closed**, cancelling rather than falling back to raw history, so a later exact `commit`, `squash`, or `revert` can never be undermined by a summary that ignored the dispositions.

## Non-goals

pi-memento does not provide:

- filesystem, shell, or process rollback
- VM/container snapshots
- database transactions
- distributed agent memory, shared facts between agents, or voting/consensus
- semantic search across history
- automatic long-term memory management

The project is strictly about transactional control over a single agent's conversational context.

## Status

Experimental (v0.1). Pinned to pi `@earendil-works/pi-coding-agent` 0.84.x.

See [docs/pi-contract.md](./docs/pi-contract.md) for the integration contract with pi.

## License

MIT
