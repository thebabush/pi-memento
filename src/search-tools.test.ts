import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentMessage, AgentToolResult } from '@earendil-works/pi-agent-core';
import type { ExtensionContext, SessionEntry, SessionHeader } from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { asSessionId } from './ids.js';
import { closeIndexDb, openIndexDb } from './search-db.js';
import { syncEntries } from './search-index.js';
import { closeSearchDbs, contextRecallTool, contextSearchTool } from './search-tools.js';
import { TRANSACTION_ENTRY_TYPE, type TransactionBeginEvent, type TransactionEndEvent } from './types.js';

let clock = 0;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'memento-search-tools-'));
});

afterEach(() => {
  closeSearchDbs();
  rmSync(dir, { recursive: true, force: true });
});

function messageEntry(id: string, parentId: string | null, message: AgentMessage): SessionEntry {
  return {
    type: 'message',
    id,
    parentId,
    timestamp: new Date(clock++).toISOString(),
    message,
  };
}

function userEntry(id: string, text: string, parentId: string | null = null): SessionEntry {
  return messageEntry(id, parentId, { role: 'user', content: text, timestamp: clock++ });
}

function assistantEntry(id: string, text: string): SessionEntry {
  return messageEntry(id, null, {
    role: 'assistant',
    content: [{ type: 'text', text }],
    provider: 'test',
    model: 'test',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: clock++,
  } as AgentMessage);
}

function boundaryCallEntry(name: 'transaction_begin' | 'transaction_end', callId: string): SessionEntry {
  return messageEntry(`${callId}-call`, null, {
    role: 'assistant',
    content: [{ type: 'toolCall', id: callId, name, arguments: {} }],
    provider: 'test',
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
    timestamp: clock++,
  } as AgentMessage);
}

function boundaryResultEntry(name: 'transaction_begin' | 'transaction_end', callId: string): SessionEntry {
  return messageEntry(`${callId}-result`, null, {
    role: 'toolResult',
    toolCallId: callId,
    toolName: name,
    content: [{ type: 'text', text: 'ok' }],
    isError: false,
    timestamp: clock++,
  });
}

function transactionEntry(id: string, event: TransactionBeginEvent | TransactionEndEvent): SessionEntry {
  return {
    type: 'custom',
    id,
    parentId: null,
    timestamp: new Date(clock++).toISOString(),
    customType: TRANSACTION_ENTRY_TYPE,
    data: event,
  };
}

function begin(transactionId: string, callId: string, purpose?: string): TransactionBeginEvent {
  return {
    version: 1,
    kind: 'begin',
    transactionId,
    ...(purpose && { purpose }),
    boundaryToolCallId: callId,
    boundaryEntryId: `${callId}-call`,
  };
}

function squashEnd(transactionId: string, callId: string, result: string, carryforward?: string): TransactionEndEvent {
  return {
    version: 1,
    kind: 'end',
    transactionId,
    disposition: 'squash',
    result,
    ...(carryforward && { carryforward }),
    boundaryToolCallId: callId,
    boundaryEntryId: `${callId}-call`,
  };
}

// Mirrors pi's append order during tool execution (see extension.test.ts):
// the assistant message holding the boundary call, then the custom entry the
// tool appends while executing, then the boundary's tool result.
function squashedTransaction(transactionId: string, bodyText: string, result: string): SessionEntry[] {
  return [
    boundaryCallEntry('transaction_begin', `${transactionId}-b`),
    transactionEntry(`${transactionId}-begin-entry`, begin(transactionId, `${transactionId}-b`, `explore ${transactionId}`)),
    boundaryResultEntry('transaction_begin', `${transactionId}-b`),
    assistantEntry(`${transactionId}-body`, bodyText),
    boundaryCallEntry('transaction_end', `${transactionId}-e`),
    transactionEntry(`${transactionId}-end-entry`, squashEnd(transactionId, `${transactionId}-e`, result)),
    boundaryResultEntry('transaction_end', `${transactionId}-e`),
  ];
}

function header(id: string): string {
  const value: SessionHeader = {
    type: 'session',
    version: 3,
    id,
    timestamp: new Date(clock++).toISOString(),
    cwd: '/tmp/project',
  };
  return JSON.stringify(value);
}

function writeSessionFile(name: string, sessionId: string, entries: SessionEntry[]): string {
  const filePath = join(dir, name);
  writeFileSync(
    filePath,
    [header(sessionId), ...entries.map((entry) => JSON.stringify(entry))].map((line) => `${line}\n`).join(''),
  );
  return filePath;
}

function fakeCtx(sessionId: string, entries: SessionEntry[], branch?: SessionEntry[]): ExtensionContext {
  return {
    sessionManager: {
      getSessionDir: () => dir,
      getSessionId: () => sessionId,
      getEntries: () => entries,
      getBranch: () => branch ?? entries,
    },
  } as unknown as ExtensionContext;
}

function resultText(result: AgentToolResult<unknown>): string {
  return result.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n');
}

interface SearchParams {
  query: string;
  layer?: 'takeaways' | 'full';
  scope?: 'branch' | 'session' | 'project';
}

interface RecallParams {
  entryId?: string;
  transactionId?: string;
  sessionId?: string;
}

async function search(ctx: ExtensionContext, params: SearchParams): Promise<string> {
  const result = await contextSearchTool.execute('search-call', params, undefined, undefined, ctx);
  return resultText(result);
}

async function recall(ctx: ExtensionContext, params: RecallParams): Promise<string> {
  const result = await contextRecallTool.execute('recall-call', params, undefined, undefined, ctx);
  return resultText(result);
}

function squashedBranch(): SessionEntry[] {
  return [
    userEntry('u1', 'the zebra message stays visible'),
    ...squashedTransaction('tx', 'xylophone exploration dead end', 'quokka squash result reached'),
    userEntry('u2', 'work continues after the squash'),
  ];
}

describe('context_search', () => {
  it('finds a squashed-away body via layer full and marks visibility', async () => {
    const ctx = fakeCtx('sess', squashedBranch());

    const forgotten = await search(ctx, { query: 'xylophone', layer: 'full', scope: 'branch' });
    expect(forgotten).toContain('entry (forgotten)');
    expect(forgotten).toContain('xylophone');
    expect(forgotten).toContain('entryId=tx-body');

    const visible = await search(ctx, { query: 'zebra', layer: 'full', scope: 'branch' });
    expect(visible).toContain('entry (visible)');
    expect(visible).toContain('entryId=u1');
  });

  it('finds the squash result on the default takeaways layer and branch scope', async () => {
    const ctx = fakeCtx('sess', squashedBranch());

    const text = await search(ctx, { query: 'quokka' });
    expect(text).toContain('takeaway (squash)');
    expect(text).toContain('quokka squash result reached');
    expect(text).toContain('transactionId=tx');
  });

  it('excludes another session from branch scope but reaches it via project scope', async () => {
    const seeded = openIndexDb(dir);
    syncEntries(seeded, asSessionId('sess-other'), [userEntry('f1', 'flamingo fact from elsewhere')]);
    closeIndexDb(seeded);
    const ctx = fakeCtx('sess', [userEntry('u1', 'local trunk message')]);

    const branchScoped = await search(ctx, { query: 'flamingo', layer: 'full', scope: 'branch' });
    expect(branchScoped).toContain('No matches');

    const projectScoped = await search(ctx, { query: 'flamingo', layer: 'full', scope: 'project' });
    expect(projectScoped).toContain('entry (other session)');
    expect(projectScoped).toContain('session=sess-other');
    expect(projectScoped).toContain('sessionId=sess-other');
  });

  it('includes an off-branch entry at session scope that branch scope excludes', async () => {
    const trunk = userEntry('u1', 'shared trunk message');
    const abandoned = userEntry('uA', 'abandoned kraken side quest', 'u1');
    const active = userEntry('uB', 'the active path continues', 'u1');
    const ctx = fakeCtx('sess', [trunk, abandoned, active], [trunk, active]);

    const branchScoped = await search(ctx, { query: 'kraken', layer: 'full', scope: 'branch' });
    expect(branchScoped).toContain('No matches');

    const sessionScoped = await search(ctx, { query: 'kraken', layer: 'full', scope: 'session' });
    expect(sessionScoped).toContain('entry (forgotten)');
    expect(sessionScoped).toContain('entryId=uA');
  });

  it('syncs sibling session files at project scope and records their file_path', async () => {
    const filePath = writeSessionFile('other.jsonl', 'sess-far', [userEntry('f1', 'porcupine file content')]);
    const ctx = fakeCtx('sess', [userEntry('u1', 'local message')]);

    const text = await search(ctx, { query: 'porcupine', layer: 'full', scope: 'project' });
    expect(text).toContain('entry (other session)');
    expect(text).toContain('entryId=f1 sessionId=sess-far');

    closeSearchDbs();
    const db = openIndexDb(dir);
    expect(db.statements.getSyncState.get('sess-far')?.file_path).toBe(filePath);
    closeIndexDb(db);
  });

  it('suggests the escalation path on an empty result', async () => {
    const ctx = fakeCtx('sess', [userEntry('u1', 'nothing relevant here')]);

    const text = await search(ctx, { query: 'zzznotfound' });
    expect(text).toContain('No matches');
    expect(text).toContain("layer 'full'");
    expect(text).toContain("scope 'session'");
    expect(text).toContain("scope 'project'");
    expect(text).toContain('trigram');
  });
});

describe('context_recall', () => {
  it('recalls the full text of an entry by entryId', async () => {
    const longText = 'the complete saga of the frobnicator across many lines of detail';
    const ctx = fakeCtx('sess', [userEntry('u1', longText)]);

    const text = await recall(ctx, { entryId: 'u1' });
    expect(text).toContain('Entry u1 (session sess, user @');
    expect(text).toContain(longText);
  });

  it('recalls a transaction body between its boundaries with a takeaway header', async () => {
    const ctx = fakeCtx('sess', squashedBranch());

    const text = await recall(ctx, { transactionId: 'tx' });
    expect(text).toContain('Transaction tx (session sess)');
    expect(text).toContain('Purpose: explore tx');
    expect(text).toContain('Disposition: squash');
    expect(text).toContain('Takeaway: quokka squash result reached');
    expect(text).toContain('[assistant] xylophone exploration dead end');
    expect(text).toContain('--- body (1 entries) ---');
    // The boundary tool machinery around each custom entry (begin result,
    // end call, end result) is noise, not body.
    expect(text).not.toContain('transaction_begin');
    expect(text).not.toContain('transaction_end');
    expect(text).not.toContain('[toolResult] ok');
    expect(text).not.toContain('zebra');
    expect(text).not.toContain('work continues after the squash');
  });

  it('recalls a foreign transaction body through the recorded file_path', async () => {
    writeSessionFile('far.jsonl', 'sess-far', [
      userEntry('f0', 'outside before the transaction'),
      transactionEntry('ftx-begin-entry', begin('ftx', 'ftx-b', 'chase the walrus')),
      userEntry('f1', 'walrus hidden body in another session'),
      transactionEntry('ftx-end-entry', squashEnd('ftx', 'ftx-e', 'walrus was a red herring')),
      userEntry('f2', 'outside after the transaction'),
    ]);
    const ctx = fakeCtx('sess', [userEntry('u1', 'local message')]);
    await search(ctx, { query: 'walrus', scope: 'project' });

    const text = await recall(ctx, { transactionId: 'ftx', sessionId: 'sess-far' });
    expect(text).toContain('Transaction ftx (session sess-far)');
    expect(text).toContain('[user] walrus hidden body in another session');
    expect(text).not.toContain('outside before');
    expect(text).not.toContain('outside after');
  });

  it('requires exactly one of entryId and transactionId', async () => {
    const ctx = fakeCtx('sess', [userEntry('u1', 'anything')]);

    await expect(recall(ctx, {})).rejects.toThrow('exactly one of entryId or transactionId');
    await expect(recall(ctx, { entryId: 'u1', transactionId: 'tx' })).rejects.toThrow(
      'exactly one of entryId or transactionId',
    );
  });

  it('rejects missing ids and an unlocatable foreign session clearly', async () => {
    const ctx = fakeCtx('sess', [userEntry('u1', 'anything')]);

    await expect(recall(ctx, { entryId: 'nope' })).rejects.toThrow('no indexed entry nope in session sess');
    await expect(recall(ctx, { transactionId: 'nope' })).rejects.toThrow(
      'no indexed transaction nope in session sess',
    );

    const seeded = openIndexDb(dir);
    syncEntries(seeded, asSessionId('sess-mem'), [
      transactionEntry('mtx-begin-entry', begin('mtx', 'mtx-b')),
      transactionEntry('mtx-end-entry', squashEnd('mtx', 'mtx-e', 'memory-only takeaway')),
    ]);
    closeIndexDb(seeded);
    await expect(recall(ctx, { transactionId: 'mtx', sessionId: 'sess-mem' })).rejects.toThrow(
      'no recorded session file',
    );
  });
});
