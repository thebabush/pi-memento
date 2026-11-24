import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import { describe, expect, it } from 'vitest';
import { asEntryId, asToolCallId, asTransactionId } from '../ids.js';
import type { TransactionBeginEvent, TransactionEndEvent } from '../types.js';
import type { ForkItem, Item, ToolItem, TransactionItem } from './model.js';
import { buildSessionView, sessionTitle, summarizeToolCall } from './view.js';

const meta = { path: 'p/s.jsonl', id: 'sess', cwd: '/work/proj', modified: 0, running: false };

let clock = 0;
function base(id: string, parentId: string | null) {
  clock += 1;
  return { id, parentId, timestamp: new Date(clock * 1000).toISOString() };
}

function user(id: string, parentId: string | null, text: string): SessionEntry {
  return { ...base(id, parentId), type: 'message', message: { role: 'user', content: text, timestamp: clock } };
}

function assistant(
  id: string,
  parentId: string | null,
  text: string,
  calls: { id: string; name: string; args?: Record<string, unknown> }[] = [],
): SessionEntry {
  return {
    ...base(id, parentId),
    type: 'message',
    message: {
      role: 'assistant',
      content: [
        ...(text ? [{ type: 'text' as const, text }] : []),
        ...calls.map((call) => ({ type: 'toolCall' as const, id: call.id, name: call.name, arguments: call.args ?? {} })),
      ],
      api: 'anthropic-messages',
      provider: 'anthropic',
      model: 'test',
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'toolUse',
      timestamp: clock,
    },
  };
}

function result(id: string, parentId: string, callId: string, toolName: string, text: string, isError = false): SessionEntry {
  return {
    ...base(id, parentId),
    type: 'message',
    message: { role: 'toolResult', toolCallId: callId, toolName, content: [{ type: 'text', text }], isError, timestamp: clock },
  };
}

function begin(id: string, parentId: string, tx: string, purpose?: string): SessionEntry {
  const data: TransactionBeginEvent = {
    version: 1,
    kind: 'begin',
    transactionId: asTransactionId(tx),
    ...(purpose && { purpose }),
    boundaryToolCallId: asToolCallId(`${tx}-begin`),
    boundaryEntryId: asEntryId(`${tx}-begin-entry`),
  };
  return { ...base(id, parentId), type: 'custom', customType: 'context-transaction', data };
}

function end(id: string, parentId: string, data: TransactionEndEvent): SessionEntry {
  return { ...base(id, parentId), type: 'custom', customType: 'context-transaction', data };
}

function endEvent(tx: string, rest: Partial<TransactionEndEvent> & Pick<TransactionEndEvent, 'disposition'>): TransactionEndEvent {
  const common = {
    version: 1 as const,
    kind: 'end' as const,
    transactionId: asTransactionId(tx),
    boundaryToolCallId: asToolCallId(`${tx}-end`),
    boundaryEntryId: asEntryId(`${tx}-end-entry`),
  };
  switch (rest.disposition) {
    case 'commit':
      return { ...common, disposition: 'commit' };
    case 'compact':
      return { ...common, disposition: 'compact', summary: rest.summary ?? 'summary', carryforward: rest.carryforward, next: rest.next };
    case 'squash':
      return { ...common, disposition: 'squash', result: rest.result ?? 'result', carryforward: rest.carryforward, next: rest.next };
    case 'revert':
      return { ...common, disposition: 'revert', carryforward: rest.carryforward ?? 'lesson', next: rest.next ?? 'next' };
  }
}

function only<T extends Item['kind']>(items: readonly Item[], kind: T): Extract<Item, { kind: T }>[] {
  return items.filter((item): item is Extract<Item, { kind: T }> => item.kind === kind);
}

describe('buildSessionView', () => {
  it('pairs tool calls with their results and keeps text in order', () => {
    const entries = [
      user('u1', null, 'find the bug'),
      assistant('a1', 'u1', 'Looking.', [{ id: 'c1', name: 'bash', args: { command: 'rg -n bug src/' } }]),
      result('r1', 'a1', 'c1', 'bash', 'src/a.ts:1: bug'),
      assistant('a2', 'r1', 'Found it.'),
    ];
    const view = buildSessionView(entries, meta);
    expect(view.items.map((item) => item.kind)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    const [tool] = only(view.items, 'tool');
    expect(tool).toMatchObject({ name: 'bash', summary: 'rg -n bug src/', output: 'src/a.ts:1: bug', isError: false });
    expect(tool?.tokens).toBe(Math.ceil('src/a.ts:1: bug'.length / 4));
    expect(view).toMatchObject({ title: 'find the bug', project: 'proj', entries: 4, transactions: 0 });
  });

  it('nests transaction bodies in cards, hides the transaction tools, and keeps the takeaway', () => {
    const entries = [
      user('u1', null, 'go'),
      assistant('a1', 'u1', '', [{ id: 'T1-begin', name: 'transaction_begin' }]),
      begin('b1', 'a1', 'T1', 'outer'),
      result('r1', 'b1', 'T1-begin', 'transaction_begin', 'Opened T1'),
      assistant('a2', 'r1', '', [{ id: 'c1', name: 'read', args: { path: 'src/a.ts' } }]),
      result('r2', 'a2', 'c1', 'read', 'contents'),
      assistant('a3', 'r2', '', [{ id: 'T2-begin', name: 'transaction_begin' }]),
      begin('b2', 'a3', 'T2', 'inner'),
      assistant('a4', 'b2', '', [{ id: 'c2', name: 'bash', args: { command: 'false' } }]),
      result('r3', 'a4', 'c2', 'bash', 'boom', true),
      end('e2', 'r3', endEvent('T2', { disposition: 'revert', carryforward: 'not XOR', next: 'try RC4' })),
      end('e1', 'e2', endEvent('T1', { disposition: 'compact', summary: 'it is RC4' })),
      assistant('a5', 'e1', 'Done.'),
    ];
    const view = buildSessionView(entries, meta);
    expect(view.items.map((item) => item.kind)).toEqual(['user', 'transaction', 'assistant']);
    const [outer] = only(view.items, 'transaction');
    expect(outer).toMatchObject({ purpose: 'outer', disposition: 'compact', takeaway: 'it is RC4', steps: 2, split: false });
    expect(outer?.children.map((item) => item.kind)).toEqual(['tool', 'transaction']);
    const [inner] = only(outer?.children ?? [], 'transaction');
    expect(inner).toMatchObject({ purpose: 'inner', disposition: 'revert', steps: 1 });
    expect(inner?.takeaway).toBe('Carryforward: not XOR\nNext: try RC4');
    expect(only(inner?.children ?? [], 'tool')[0]).toMatchObject({ isError: true, output: 'boom' });
    expect(view.transactions).toBe(2);
  });

  it('leaves a transaction with no end open', () => {
    const entries = [user('u1', null, 'go'), begin('b1', 'u1', 'T1', 'exploring'), user('u2', 'b1', 'more')];
    const [card] = only(buildSessionView(entries, meta).items, 'transaction');
    expect(card).toMatchObject({ disposition: 'open', takeaway: '' });
    expect(card?.children.map((item) => item.kind)).toEqual(['user']);
  });

  it('splits branches into lanes and marks the one holding the latest entry', () => {
    const entries = [
      user('u1', null, 'start'),
      assistant('a1', 'u1', 'ok'),
      user('u2', 'a1', 'first idea'),
      assistant('a2', 'u2', 'tried it'),
      user('u3', 'a1', 'second idea'),
    ];
    const view = buildSessionView(entries, meta);
    expect(view.items.map((item) => item.kind)).toEqual(['user', 'assistant', 'fork']);
    const [fork] = only(view.items, 'fork');
    expect(fork?.lanes.map((lane) => [lane.label, lane.current])).toEqual([
      ['first idea', false],
      ['second idea', true],
    ]);
  });

  it('marks a transaction open across a branch point as split and notes the close inside the lane', () => {
    const entries = [
      user('u1', null, 'start'),
      begin('b1', 'u1', 'T1', 'explore'),
      user('u2', 'b1', 'line A'),
      end('e1', 'u2', endEvent('T1', { disposition: 'squash', result: 'A wins' })),
      user('u3', 'b1', 'line B'),
    ];
    const view = buildSessionView(entries, meta);
    const [card] = only(view.items, 'transaction');
    expect(card).toMatchObject({ split: true, disposition: 'open' });
    const fork: ForkItem | undefined = only(card?.children ?? [], 'fork')[0];
    const laneA = fork?.lanes[0]?.items ?? [];
    expect(only(laneA, 'note')[0]).toMatchObject({ label: 'Closed transaction T1 (squash)', text: 'A wins' });
  });

  it('flags tool calls without a result as running only while the session is live', () => {
    const entries = [user('u1', null, 'go'), assistant('a1', 'u1', '', [{ id: 'c1', name: 'bash', args: { command: 'sleep 9' } }])];
    const live: ToolItem | undefined = only(buildSessionView(entries, { ...meta, running: true }).items, 'tool')[0];
    const done: ToolItem | undefined = only(buildSessionView(entries, meta).items, 'tool')[0];
    expect(live?.running).toBe(true);
    expect(done?.running).toBe(false);
  });

  it('sums steps and tokens bottom up', () => {
    const entries = [
      user('u1', null, 'go'),
      begin('b1', 'u1', 'T1'),
      assistant('a1', 'b1', '', [{ id: 'c1', name: 'bash', args: { command: 'x' } }]),
      result('r1', 'a1', 'c1', 'bash', 'x'.repeat(400)),
      end('e1', 'r1', endEvent('T1', { disposition: 'commit' })),
    ];
    const card: TransactionItem | undefined = only(buildSessionView(entries, meta).items, 'transaction')[0];
    expect(card).toMatchObject({ steps: 1, tokens: 100, disposition: 'commit', takeaway: '' });
  });
});

describe('summarizeToolCall', () => {
  it('prefers the command or path, then any string, then compact JSON', () => {
    expect(summarizeToolCall('bash', { command: 'ls\npwd' })).toBe('ls …');
    expect(summarizeToolCall('read', { path: 'src/a.ts', offset: 3 })).toBe('src/a.ts');
    expect(summarizeToolCall('custom', { name: 'x' })).toBe('x');
    expect(summarizeToolCall('custom', { n: 1 })).toBe('{"n":1}');
    expect(summarizeToolCall('status', {})).toBe('status');
  });
});

describe('sessionTitle', () => {
  it('uses the session name when set, else the first user message', () => {
    const entries = [user('u1', null, 'first line\nsecond')];
    expect(sessionTitle(entries)).toBe('first line …');
    expect(sessionTitle([...entries, { ...base('i1', 'u1'), type: 'session_info', name: 'Named' }])).toBe('Named');
    expect(sessionTitle([])).toBe('Untitled session');
  });
});
