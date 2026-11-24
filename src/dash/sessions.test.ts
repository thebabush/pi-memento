import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSessionStore } from './sessions.js';

let root: string;

function writeSession(dir: string, name: string, cwd: string, lines: object[], mtimeSeconds: number): string {
  mkdirSync(join(root, dir), { recursive: true });
  const file = join(root, dir, name);
  const header = { type: 'session', version: 3, id: name.replace('.jsonl', ''), timestamp: '2026-01-01T00:00:00Z', cwd };
  writeFileSync(file, [header, ...lines].map((line) => JSON.stringify(line)).join('\n') + '\n');
  utimesSync(file, mtimeSeconds, mtimeSeconds);
  return file;
}

function userLine(id: string, parentId: string | null, text: string) {
  return { type: 'message', id, parentId, timestamp: '2026-01-01T00:00:01Z', message: { role: 'user', content: text, timestamp: 1 } };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pim-dash-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('createSessionStore', () => {
  it('groups sessions by project, newest first, with titles and entry counts', () => {
    writeSession('--a--', 'old.jsonl', '/w/alpha', [userLine('u1', null, 'old work')], 1000);
    writeSession('--a--', 'new.jsonl', '/w/alpha', [userLine('u1', null, 'new work'), userLine('u2', 'u1', 'more')], 3000);
    writeSession('--b--', 'b.jsonl', '/w/beta', [userLine('u1', null, 'beta work')], 2000);
    writeFileSync(join(root, '--b--', 'notes.txt'), 'ignored');

    const groups = createSessionStore(root, () => 3000 * 1000 + 10_000).list();
    expect(groups.map((group) => group.name)).toEqual(['alpha', 'beta']);
    expect(groups[0]?.sessions.map((session) => [session.title, session.entries, session.running])).toEqual([
      ['new work', 2, true],
      ['old work', 1, false],
    ]);
  });

  it('builds a view for a session path and refuses paths outside the sessions directory', () => {
    writeSession('--a--', 's.jsonl', '/w/alpha', [userLine('u1', null, 'hello')], 1000);
    const store = createSessionStore(root, () => 0);
    expect(store.view(join('--a--', 's.jsonl'))?.view).toMatchObject({ title: 'hello', project: 'alpha', entries: 1 });
    expect(store.etag(join('--a--', 's.jsonl'))).toMatch(/^"\d+(\.\d+)?-\d+"$/);
    for (const bad of ['../outside.jsonl', '/etc/passwd', '--a--/s.txt', '--a--/missing.jsonl']) {
      expect(store.view(bad)).toBeUndefined();
    }
    expect(store.etag('../outside.jsonl')).toBeUndefined();
  });

  it('skips files that are not pi sessions', () => {
    mkdirSync(join(root, '--c--'));
    writeFileSync(join(root, '--c--', 'junk.jsonl'), 'not json\n');
    expect(createSessionStore(root).list()).toEqual([]);
  });
});
