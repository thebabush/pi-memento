import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import { isTransactionEvent, TRANSACTION_ENTRY_TYPE, type TransactionEndEvent } from '../types.js';
import type { Item, Lane, SessionView, ToolItem, TransactionItem } from './model.js';

export interface SessionMeta {
  path: string;
  id: string;
  cwd: string;
  modified: number;
  running: boolean;
}

/** Where new items go: the session or lane top level, or an open transaction's body. */
interface Frame {
  items: Item[];
  transaction?: TransactionItem;
}

interface BuildState {
  children: Map<string, SessionEntry[]>;
  /** Tool items by pi's tool call id, so a later result can fill its call in. */
  tools: Map<string, ToolItem>;
  answered: Set<string>;
  /** Entries on the path from the root to the most recently written entry. */
  currentPath: Set<string>;
  running: boolean;
}

const MAX_OUTPUT_CHARS = 20_000;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function partsText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .flatMap((part: unknown) =>
      part && typeof part === 'object' && 'type' in part && part.type === 'text' && 'text' in part && typeof part.text === 'string'
        ? [part.text]
        : [],
    )
    .join('\n');
}

function clip(text: string): string {
  return text.length > MAX_OUTPUT_CHARS
    ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n… ${text.length - MAX_OUTPUT_CHARS} more characters`
    : text;
}

function firstLine(text: string, max = 160): string {
  const line = text.trim().split('\n', 1)[0] ?? '';
  const more = line.length > max || text.trim().includes('\n');
  return line.length > max ? `${line.slice(0, max)}…` : more ? `${line} …` : line;
}

/** One line that tells the reader what a tool call did. */
export function summarizeToolCall(name: string, args: Record<string, unknown>): string {
  const pick = (...keys: string[]) => {
    for (const key of keys) {
      const value = args[key];
      if (typeof value === 'string' && value.trim()) return value;
    }
    return undefined;
  };
  const known = pick('command', 'path', 'file_path', 'pattern', 'query', 'url');
  if (known) return firstLine(known);
  const anyString = Object.values(args).find((value): value is string => typeof value === 'string' && value.trim() !== '');
  if (anyString) return firstLine(anyString);
  const json = JSON.stringify(args);
  return json === '{}' ? name : firstLine(json);
}

function takeawayText(end: TransactionEndEvent): string {
  const lines: string[] = [];
  if (end.disposition === 'compact') lines.push(end.summary);
  if (end.disposition === 'squash') lines.push(end.result);
  if (end.disposition !== 'commit') {
    if (end.carryforward) lines.push(`Carryforward: ${end.carryforward}`);
    if (end.next) lines.push(`Next: ${end.next}`);
  }
  return lines.join('\n');
}

function top(frames: readonly Frame[]): Frame {
  const frame = frames[frames.length - 1];
  if (!frame) throw new Error('view builder lost its frame stack');
  return frame;
}

function addMessage(entry: Extract<SessionEntry, { type: 'message' }>, frames: Frame[], state: BuildState): void {
  const message = entry.message;
  const into = top(frames).items;
  switch (message.role) {
    case 'user': {
      const text = partsText(message.content).trim();
      if (text) into.push({ kind: 'user', id: entry.id, text });
      return;
    }
    case 'assistant': {
      const text = partsText(message.content).trim();
      if (text) into.push({ kind: 'assistant', id: entry.id, text });
      for (const part of message.content) {
        // The transaction card stands for its own begin/end calls.
        if (part.type !== 'toolCall' || part.name.startsWith('transaction_')) continue;
        const tool: ToolItem = {
          kind: 'tool',
          id: part.id,
          name: part.name,
          summary: summarizeToolCall(part.name, part.arguments),
          output: '',
          isError: false,
          tokens: 0,
          running: false,
        };
        into.push(tool);
        state.tools.set(part.id, tool);
      }
      return;
    }
    case 'toolResult': {
      const tool = state.tools.get(message.toolCallId);
      if (!tool) return;
      const output = partsText(message.content);
      tool.output = clip(output);
      tool.isError = message.isError;
      tool.tokens = estimateTokens(output);
      state.answered.add(message.toolCallId);
      return;
    }
    case 'bashExecution':
      into.push({
        kind: 'tool',
        id: entry.id,
        name: 'bash',
        summary: `! ${firstLine(message.command)}`,
        output: clip(message.output),
        isError: message.exitCode !== 0 && message.exitCode !== undefined,
        tokens: estimateTokens(message.output),
        running: false,
      });
      return;
    case 'custom':
      if (message.display) into.push({ kind: 'note', id: entry.id, label: message.customType, text: partsText(message.content) });
      return;
    case 'branchSummary':
      into.push({ kind: 'note', id: entry.id, label: 'Branch summary', text: message.summary });
      return;
    case 'compactionSummary':
      into.push({ kind: 'note', id: entry.id, label: 'Compaction summary', text: message.summary });
      return;
    default:
      return;
  }
}

function addEntry(entry: SessionEntry, frames: Frame[], state: BuildState): void {
  switch (entry.type) {
    case 'message':
      addMessage(entry, frames, state);
      return;
    case 'custom': {
      if (entry.customType !== TRANSACTION_ENTRY_TYPE || !isTransactionEvent(entry.data)) return;
      const event = entry.data;
      if (event.kind === 'begin') {
        const transaction: TransactionItem = {
          kind: 'transaction',
          id: entry.id,
          transactionId: event.transactionId,
          purpose: event.purpose ?? '',
          disposition: 'open',
          takeaway: '',
          split: false,
          children: [],
          steps: 0,
          tokens: 0,
        };
        top(frames).items.push(transaction);
        frames.push({ items: transaction.children, transaction });
        return;
      }
      const index = frames.findIndex((frame) => frame.transaction?.transactionId === event.transactionId);
      const closing = frames[index]?.transaction;
      if (index < 0 || !closing) {
        // Opened before a branch point: this lane only sees the close.
        const text = takeawayText(event);
        top(frames).items.push({
          kind: 'note',
          id: entry.id,
          label: `Closed transaction ${event.transactionId} (${event.disposition})`,
          text,
        });
        return;
      }
      closing.disposition = event.disposition;
      closing.takeaway = takeawayText(event);
      frames.splice(index);
      return;
    }
    case 'compaction':
      top(frames).items.push({
        kind: 'note',
        id: entry.id,
        label: `Compacted by pi (${Math.round(entry.tokensBefore / 1000)}k tokens before)`,
        text: entry.summary,
      });
      return;
    case 'branch_summary':
      top(frames).items.push({ kind: 'note', id: entry.id, label: 'Branch summary', text: entry.summary });
      return;
    case 'custom_message':
      if (entry.display) {
        top(frames).items.push({ kind: 'note', id: entry.id, label: entry.customType, text: partsText(entry.content) });
      }
      return;
    default:
      return;
  }
}

function firstUserText(items: readonly Item[]): string | undefined {
  for (const item of items) {
    if (item.kind === 'user') return item.text;
    if (item.kind === 'transaction') {
      const nested = firstUserText(item.children);
      if (nested) return nested;
    }
  }
  return undefined;
}

/** Follow a chain of single children, recursing only where the history branches. */
function walk(start: SessionEntry, frames: Frame[], state: BuildState): void {
  let entry: SessionEntry | undefined = start;
  while (entry) {
    addEntry(entry, frames, state);
    const kids: SessionEntry[] = state.children.get(entry.id) ?? [];
    const [only] = kids;
    if (kids.length <= 1) {
      entry = only;
      continue;
    }
    for (const frame of frames) if (frame.transaction) frame.transaction.split = true;
    top(frames).items.push({ kind: 'fork', id: `fork-${entry.id}`, lanes: buildLanes(kids, state) });
    return;
  }
}

function buildLanes(starts: readonly SessionEntry[], state: BuildState): Lane[] {
  return starts.map((start, index) => {
    const items: Item[] = [];
    walk(start, [{ items }], state);
    const current = state.currentPath.has(start.id);
    const label = firstUserText(items);
    return {
      id: start.id,
      label: label ? firstLine(label, 60) : `Branch ${index + 1}`,
      current,
      running: current && state.running,
      items,
    };
  });
}

/** Fill in running flags and the step/token totals of every transaction, bottom up. */
function finish(items: readonly Item[], state: BuildState): { steps: number; tokens: number } {
  let steps = 0;
  let tokens = 0;
  for (const item of items) {
    switch (item.kind) {
      case 'tool':
        item.running = state.running && !state.answered.has(item.id) && item.output === '';
        steps += 1;
        tokens += item.tokens;
        break;
      case 'user':
      case 'assistant':
        tokens += estimateTokens(item.text);
        break;
      case 'transaction': {
        const inner = finish(item.children, state);
        item.steps = inner.steps;
        item.tokens = inner.tokens + estimateTokens(item.takeaway);
        steps += inner.steps;
        tokens += item.tokens;
        break;
      }
      case 'fork':
        for (const lane of item.lanes) {
          const inner = finish(lane.items, state);
          if (lane.current) {
            steps += inner.steps;
            tokens += inner.tokens;
          }
        }
        break;
      case 'note':
        tokens += estimateTokens(item.text);
        break;
    }
  }
  return { steps, tokens };
}

export function sessionTitle(entries: readonly SessionEntry[]): string {
  let name: string | undefined;
  for (const entry of entries) if (entry.type === 'session_info' && entry.name?.trim()) name = entry.name.trim();
  if (name) return name;
  for (const entry of entries) {
    if (entry.type === 'message' && entry.message.role === 'user') {
      const text = partsText(entry.message.content).trim();
      if (text) return firstLine(text, 80);
    }
  }
  return 'Untitled session';
}

export function buildSessionView(entries: readonly SessionEntry[], meta: SessionMeta): SessionView {
  const ids = new Set(entries.map((entry) => entry.id));
  const roots: SessionEntry[] = [];
  const children = new Map<string, SessionEntry[]>();
  for (const entry of entries) {
    if (entry.parentId === null || !ids.has(entry.parentId)) {
      roots.push(entry);
      continue;
    }
    const siblings = children.get(entry.parentId);
    if (siblings) siblings.push(entry);
    else children.set(entry.parentId, [entry]);
  }

  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const currentPath = new Set<string>();
  for (let entry = entries[entries.length - 1]; entry; entry = entry.parentId ? byId.get(entry.parentId) : undefined) {
    if (currentPath.has(entry.id)) break;
    currentPath.add(entry.id);
  }

  const state: BuildState = { children, tools: new Map(), answered: new Set(), currentPath, running: meta.running };
  const items: Item[] = [];
  const [root] = roots;
  if (roots.length > 1) items.push({ kind: 'fork', id: 'fork-root', lanes: buildLanes(roots, state) });
  else if (root) walk(root, [{ items }], state);
  const totals = finish(items, state);

  const transactions = entries.filter(
    (entry) =>
      entry.type === 'custom' &&
      entry.customType === TRANSACTION_ENTRY_TYPE &&
      isTransactionEvent(entry.data) &&
      entry.data.kind === 'begin',
  ).length;

  return {
    path: meta.path,
    id: meta.id,
    title: sessionTitle(entries),
    project: projectName(meta.cwd),
    cwd: meta.cwd,
    modified: meta.modified,
    running: meta.running,
    entries: entries.length,
    transactions,
    tokens: totals.tokens,
    items,
  };
}

export function projectName(cwd: string): string {
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}
