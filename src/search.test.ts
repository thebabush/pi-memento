import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { asEntryId, asSessionId } from './ids.js';
import { openIndexDb, type IndexDb } from './search-db.js';
import { syncEntries } from './search-index.js';
import { countClosedTakeaways, isFts5QueryError, runMatchQuery, searchIndex, type SearchHit } from './search.js';
import { TRANSACTION_ENTRY_TYPE, type TransactionBeginEvent, type TransactionEndEvent } from './types.js';

let clock = 0;
let dir: string;
let db: IndexDb;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'memento-search-query-'));
  db = openIndexDb(dir);
});

afterEach(() => {
  db.database.close();
  rmSync(dir, { recursive: true, force: true });
});

function userEntry(id: string, text: string): SessionEntry {
  return {
    type: 'message',
    id,
    parentId: null,
    timestamp: new Date(clock++).toISOString(),
    message: { role: 'user', content: text, timestamp: clock++ },
  };
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

function begin(transactionId: string, entryId: string, purpose?: string): TransactionBeginEvent {
  return {
    version: 1,
    kind: 'begin',
    transactionId,
    ...(purpose && { purpose }),
    boundaryToolCallId: `${transactionId}-begin-call`,
    boundaryEntryId: entryId,
  };
}

function squashEnd(
  transactionId: string,
  entryId: string,
  result: string,
  extra: { carryforward?: string; next?: string } = {},
): TransactionEndEvent {
  return {
    version: 1,
    kind: 'end',
    transactionId,
    disposition: 'squash',
    result,
    ...(extra.carryforward && { carryforward: extra.carryforward }),
    ...(extra.next && { next: extra.next }),
    boundaryToolCallId: `${transactionId}-end-call`,
    boundaryEntryId: entryId,
  };
}

function transactionEntries(
  transactionId: string,
  fields: { purpose?: string; result?: string; carryforward?: string; next?: string },
): SessionEntry[] {
  const entries = [
    transactionEntry(`${transactionId}-begin`, begin(transactionId, `${transactionId}-begin`, fields.purpose)),
  ];
  if (fields.result) {
    entries.push(
      transactionEntry(`${transactionId}-end`, squashEnd(transactionId, `${transactionId}-end`, fields.result, fields)),
    );
  }
  return entries;
}

function kinds(hits: SearchHit[]): Set<string> {
  return new Set(hits.map((hit) => hit.kind));
}

function transactionIds(hits: SearchHit[]): string[] {
  return hits.filter((hit) => hit.kind === 'takeaway').map((hit) => hit.transactionId);
}

function entryIds(hits: SearchHit[]): string[] {
  return hits.filter((hit) => hit.kind === 'entry').map((hit) => hit.entryId);
}

describe('searchIndex takeaways layer', () => {
  beforeEach(() => {
    syncEntries(db, asSessionId('sess'), [
      ...transactionEntries('tx-1', {
        purpose: 'zebra migration research',
        result: 'quokka conclusion reached',
        carryforward: 'pangolin lesson learned',
        next: 'wallaby follow-up planned',
      }),
    ]);
  });

  it('finds a takeaway by purpose', () => {
    const { hits } = searchIndex(db, { query: 'zebra', layer: 'takeaways' });

    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      kind: 'takeaway',
      sessionId: 'sess',
      transactionId: 'tx-1',
      purpose: 'zebra migration research',
      disposition: 'squash',
      takeaway: 'quokka conclusion reached',
      carryforward: 'pangolin lesson learned',
      next: 'wallaby follow-up planned',
    });
    expect(hits[0]?.score).toBeGreaterThan(0);
  });

  it('finds a takeaway by next action', () => {
    const { hits } = searchIndex(db, { query: 'wallaby', layer: 'takeaways' });

    expect(transactionIds(hits)).toEqual(['tx-1']);
  });

  it('finds a takeaway by its result text', () => {
    const { hits } = searchIndex(db, { query: 'quokka', layer: 'takeaways' });

    expect(transactionIds(hits)).toEqual(['tx-1']);
  });

  it('finds a takeaway by carryforward', () => {
    const { hits } = searchIndex(db, { query: 'pangolin', layer: 'takeaways' });

    expect(transactionIds(hits)).toEqual(['tx-1']);
  });

  it('ranks a takeaway-column match at least as high as a purpose-only match', () => {
    syncEntries(db, asSessionId('ranked'), [
      ...transactionEntries('tx-purpose', { purpose: 'flamingo in the lake' }),
      ...transactionEntries('tx-takeaway', { result: 'flamingo in the pond' }),
    ]);

    const { hits } = searchIndex(db, {
      query: 'flamingo',
      layer: 'takeaways',
      sessionId: asSessionId('ranked'),
    });

    expect(transactionIds(hits)).toEqual(['tx-takeaway', 'tx-purpose']);
  });
});

describe('searchIndex full layer', () => {
  it('merges entry and takeaway hits and respects the limit', () => {
    syncEntries(db, asSessionId('sess'), [
      userEntry('u1', 'the walrus subsystem crashed on startup'),
      ...transactionEntries('tx-w', { purpose: 'walrus subsystem inquiry' }),
    ]);

    const { hits } = searchIndex(db, { query: 'walrus', layer: 'full' });
    expect(kinds(hits)).toEqual(new Set(['entry', 'takeaway']));
    expect(hits).toHaveLength(2);

    const limited = searchIndex(db, { query: 'walrus', layer: 'full', limit: 1 });
    expect(limited.hits).toHaveLength(1);
  });

  it('restricts hits to one session', () => {
    syncEntries(db, asSessionId('one'), [
      userEntry('u1', 'shared narwhal sighting'),
      ...transactionEntries('tx-one', { purpose: 'narwhal tracking' }),
    ]);
    syncEntries(db, asSessionId('two'), [
      userEntry('u1', 'shared narwhal sighting'),
      ...transactionEntries('tx-two', { purpose: 'narwhal tracking' }),
    ]);

    const { hits } = searchIndex(db, { query: 'narwhal', layer: 'full', sessionId: asSessionId('one') });

    expect(hits).toHaveLength(2);
    expect(hits.every((hit) => hit.sessionId === asSessionId('one'))).toBe(true);
  });

  it('applies entryIdFilter to entry hits and takeaway boundaries', () => {
    syncEntries(db, asSessionId('sess'), [
      userEntry('e1', 'giraffe on the active branch'),
      userEntry('e2', 'giraffe on an abandoned branch'),
      ...transactionEntries('tx-keep', { purpose: 'giraffe census kept' }),
      ...transactionEntries('tx-drop', { purpose: 'giraffe census drop', result: 'giraffe counted' }),
    ]);

    // tx-keep has only a begin so far and it is on the branch; tx-drop has
    // both boundaries and neither is on the branch.
    const filter = new Set([asEntryId('e1'), asEntryId('tx-keep-begin')]);
    const { hits } = searchIndex(db, { query: 'giraffe', layer: 'full', entryIdFilter: filter });

    expect(entryIds(hits)).toEqual(['e1']);
    expect(transactionIds(hits)).toEqual(['tx-keep']);
  });

  it('keeps a filtered takeaway when only its end boundary is on the branch', () => {
    syncEntries(db, asSessionId('sess'), [
      ...transactionEntries('tx-end-on', { purpose: 'ocelot survey', result: 'ocelot found' }),
    ]);

    const { hits } = searchIndex(db, {
      query: 'ocelot',
      layer: 'takeaways',
      entryIdFilter: new Set([asEntryId('tx-end-on-end')]),
    });

    expect(transactionIds(hits)).toEqual(['tx-end-on']);
  });

  it('marks matched text in entry snippets', () => {
    syncEntries(db, asSessionId('sess'), [userEntry('u1', 'a very long report about the aardvark burrow depth')]);

    const { hits } = searchIndex(db, { query: 'aardvark', layer: 'full' });

    expect(hits).toHaveLength(1);
    const [hit] = hits;
    if (hit?.kind !== 'entry') throw new Error('expected an entry hit');
    expect(hit.snippet).toContain('<<');
    expect(hit.snippet).toContain('>>');
    expect(hit.snippet).toContain('aardvark');
  });
});

describe('countClosedTakeaways', () => {
  it('counts closed takeaways within the session and branch filters', () => {
    syncEntries(db, asSessionId('sess'), [
      ...transactionEntries('tx-open', { purpose: 'still running' }),
      ...transactionEntries('tx-closed', { purpose: 'finished', result: 'done' }),
    ]);
    syncEntries(db, asSessionId('other'), [...transactionEntries('tx-other', { result: 'done elsewhere' })]);

    expect(countClosedTakeaways(db, {})).toBe(2);
    expect(countClosedTakeaways(db, { sessionId: asSessionId('sess') })).toBe(1);
    expect(
      countClosedTakeaways(db, {
        sessionId: asSessionId('sess'),
        entryIdFilter: new Set([asEntryId('tx-closed-end')]),
      }),
    ).toBe(1);
    expect(
      countClosedTakeaways(db, {
        sessionId: asSessionId('sess'),
        entryIdFilter: new Set([asEntryId('tx-open-begin')]),
      }),
    ).toBe(0);
  });

  it('returns zero when only open transactions exist', () => {
    syncEntries(db, asSessionId('sess'), [...transactionEntries('tx-open', { purpose: 'still running' })]);

    expect(countClosedTakeaways(db, {})).toBe(0);
  });
});

describe('searchIndex query safety', () => {
  it('falls back to a phrase on invalid MATCH syntax', () => {
    syncEntries(db, asSessionId('sess'), [userEntry('u1', 'the reconnect (loop was missing jitter')]);

    expect(() => searchIndex(db, { query: 'foo"bar', layer: 'full' })).not.toThrow();
    expect(() => searchIndex(db, { query: '(unbalanced', layer: 'full' })).not.toThrow();

    // Only valid as a phrase; the raw form is an FTS5 syntax error.
    const { hits } = searchIndex(db, { query: 'reconnect (loop', layer: 'full' });
    expect(entryIds(hits)).toEqual(['u1']);
  });

  it('returns empty for a query below the trigram length without throwing', () => {
    syncEntries(db, asSessionId('sess'), [userEntry('u1', 'ab initio calculations')]);

    expect(searchIndex(db, { query: 'ab', layer: 'full' })).toEqual({ hits: [], scanExhausted: true });
    expect(searchIndex(db, { query: '', layer: 'full' })).toEqual({ hits: [], scanExhausted: true });
  });

  it('propagates a broken-statement error instead of reporting no results', () => {
    syncEntries(db, asSessionId('sess'), [
      ...transactionEntries('tx-1', { purpose: 'anything indexed at all' }),
    ]);
    db.database.exec('DROP TABLE takeaways_fts');

    expect(() => searchIndex(db, { query: 'anything', layer: 'takeaways' })).toThrow(
      /no such table/,
    );
  });
});

describe('searchIndex branch-scope scanning', () => {
  it('finds a filtered hit ranked beyond the first scan batch', () => {
    // 600 short decoys with a high term frequency outrank the one on-branch
    // target (a single mention in a long entry), pushing it past both the
    // first 200-row batch and the old 500-row scan cap.
    const entries: SessionEntry[] = [];
    for (let index = 0; index < 600; index += 1) {
      entries.push(userEntry(`decoy-${index}`, 'wombat wombat wombat'));
    }
    entries.push(
      userEntry(
        'target',
        'a single wombat mention diluted by a great many other words about entirely unrelated topics',
      ),
    );
    syncEntries(db, asSessionId('sess'), entries);

    const result = searchIndex(db, {
      query: 'wombat',
      layer: 'full',
      entryIdFilter: new Set([asEntryId('target')]),
    });

    expect(entryIds(result.hits)).toEqual(['target']);
    expect(result.scanExhausted).toBe(true);
  });

  it('reports a non-exhausted scan when the budget cuts the search short', () => {
    const entries: SessionEntry[] = [];
    for (let index = 0; index < 5200; index += 1) {
      entries.push(userEntry(`bulk-${index}`, `capybara filler message ${index}`));
    }
    syncEntries(db, asSessionId('sess'), entries);

    const result = searchIndex(db, {
      query: 'capybara',
      layer: 'full',
      entryIdFilter: new Set([asEntryId('not-in-the-index')]),
    });

    expect(result.hits).toEqual([]);
    expect(result.scanExhausted).toBe(false);
  });
});

describe('runMatchQuery', () => {
  it('retries with a phrase that doubles embedded quotes', () => {
    const attempts: string[] = [];
    const result = runMatchQuery('say "hi" now', (match) => {
      attempts.push(match);
      if (attempts.length === 1) throw new Error('fts5: syntax error');
      return ['row'];
    });

    expect(result).toEqual(['row']);
    expect(attempts).toEqual(['say "hi" now', '"say ""hi"" now"']);
  });

  it('returns no rows when even the phrase form fails as query syntax', () => {
    expect(
      runMatchQuery('anything', () => {
        throw new Error('fts5: syntax error');
      }),
    ).toEqual([]);
  });

  it('propagates a non-query error from the first attempt', () => {
    let attempts = 0;
    expect(() =>
      runMatchQuery('anything', () => {
        attempts += 1;
        throw new Error('no such table: entries_fts');
      }),
    ).toThrow('no such table: entries_fts');
    expect(attempts).toBe(1);
  });

  it('propagates a non-query error from the phrase attempt', () => {
    let attempts = 0;
    expect(() =>
      runMatchQuery('anything', () => {
        attempts += 1;
        if (attempts === 1) throw new Error('fts5: syntax error near ""');
        throw new Error('database is not open');
      }),
    ).toThrow('database is not open');
    expect(attempts).toBe(2);
  });
});

describe('isFts5QueryError', () => {
  it('recognizes the observed FTS5 MATCH error shapes', () => {
    expect(isFts5QueryError(new Error('fts5: syntax error near ")"'))).toBe(true);
    expect(isFts5QueryError(new Error('unterminated string'))).toBe(true);
    expect(isFts5QueryError(new Error('unknown special query: foo'))).toBe(true);
    expect(isFts5QueryError(new Error('no such column: col'))).toBe(true);
  });

  it('rejects everything else', () => {
    expect(isFts5QueryError(new Error('no such table: entries_fts'))).toBe(false);
    expect(isFts5QueryError(new Error('database is not open'))).toBe(false);
    expect(isFts5QueryError(new Error('database disk image is malformed'))).toBe(false);
    expect(isFts5QueryError('fts5: syntax error')).toBe(false);
    expect(isFts5QueryError(undefined)).toBe(false);
  });
});
