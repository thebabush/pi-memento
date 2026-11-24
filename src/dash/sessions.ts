import { closeSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { readSessionFileEntries } from '../session-file.js';
import type { ProjectGroup, SessionSummary, SessionView } from './model.js';
import { buildSessionView, projectName } from './view.js';

/** A session file written to within this window counts as running. */
const RUNNING_WINDOW_MS = 90_000;
const HEAD_BYTES = 256 * 1024;
const CHUNK_BYTES = 1024 * 1024;

interface FileFacts {
  mtimeMs: number;
  size: number;
  id: string;
  cwd: string;
  title: string;
  entries: number;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function parseLine(line: string): Record<string, unknown> | undefined {
  try {
    return record(JSON.parse(line));
  } catch {
    // A torn line from a concurrent writer; callers skip it.
    return undefined;
  }
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part: unknown) => {
      const fields = record(part);
      return fields?.type === 'text' && typeof fields.text === 'string' ? fields.text : '';
    })
    .join('\n');
}

function readHead(file: string): string {
  const fd = openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(HEAD_BYTES);
    const read = readSync(fd, buffer, 0, HEAD_BYTES, 0);
    return buffer.subarray(0, read).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

function countLines(file: string): number {
  const fd = openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(CHUNK_BYTES);
    let lines = 0;
    let position = 0;
    for (;;) {
      const read = readSync(fd, buffer, 0, CHUNK_BYTES, position);
      if (read === 0) return lines;
      position += read;
      for (let at = buffer.indexOf(10); at >= 0 && at < read; at = buffer.indexOf(10, at + 1)) lines += 1;
    }
  } finally {
    closeSync(fd);
  }
}

/** Header, title and entry count, read without parsing the whole file. */
function readFacts(file: string, mtimeMs: number, size: number): FileFacts | undefined {
  const head = readHead(file);
  const lines = head.split('\n');
  // The last line may be cut off by the head window.
  if (head.length >= HEAD_BYTES) lines.pop();
  const header = parseLine(lines[0] ?? '');
  if (header?.type !== 'session' || typeof header.id !== 'string' || typeof header.cwd !== 'string') return undefined;

  let name: string | undefined;
  let firstUser: string | undefined;
  for (const line of lines.slice(1)) {
    const entry = parseLine(line);
    if (!entry) continue;
    if (entry.type === 'session_info' && typeof entry.name === 'string' && entry.name.trim()) name = entry.name.trim();
    const message = record(entry.message);
    if (!firstUser && entry.type === 'message' && message?.role === 'user') {
      const text = textOf(message.content).trim();
      if (text) firstUser = text.split('\n', 1)[0];
    }
  }
  const title = name ?? firstUser ?? 'Untitled session';
  return {
    mtimeMs,
    size,
    id: header.id,
    cwd: header.cwd,
    title: title.length > 80 ? `${title.slice(0, 80)}…` : title,
    entries: Math.max(0, countLines(file) - 1),
  };
}

export interface SessionStore {
  list(): ProjectGroup[];
  /** Undefined when the path is not a session file under the sessions directory. */
  view(path: string): { view: SessionView; etag: string } | undefined;
  /** Cheap freshness tag for a session file, for conditional requests. */
  etag(path: string): string | undefined;
}

export function createSessionStore(sessionsDir: string, now: () => number = Date.now): SessionStore {
  const root = resolve(sessionsDir);
  const cache = new Map<string, FileFacts>();

  function resolveSessionPath(path: string): string | undefined {
    const absolute = resolve(root, path);
    if (!absolute.startsWith(root + sep) || !absolute.endsWith('.jsonl')) return undefined;
    return absolute;
  }

  function facts(file: string): FileFacts | undefined {
    let stats;
    try {
      stats = statSync(file);
    } catch {
      cache.delete(file);
      return undefined;
    }
    const cached = cache.get(file);
    if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) return cached;
    const fresh = readFacts(file, stats.mtimeMs, stats.size);
    if (fresh) cache.set(file, fresh);
    else cache.delete(file);
    return fresh;
  }

  function sessionFiles(): string[] {
    let dirs;
    try {
      dirs = readdirSync(root, { withFileTypes: true });
    } catch {
      return [];
    }
    return dirs
      .filter((dir) => dir.isDirectory())
      .flatMap((dir) => {
        try {
          return readdirSync(join(root, dir.name))
            .filter((name) => name.endsWith('.jsonl'))
            .map((name) => join(root, dir.name, name));
        } catch {
          // The directory vanished between listings.
          return [];
        }
      });
  }

  return {
    list() {
      const groups = new Map<string, ProjectGroup>();
      const time = now();
      for (const file of sessionFiles()) {
        const fileFacts = facts(file);
        if (!fileFacts) continue;
        const summary: SessionSummary = {
          path: relative(root, file),
          id: fileFacts.id,
          title: fileFacts.title,
          modified: fileFacts.mtimeMs,
          entries: fileFacts.entries,
          running: time - fileFacts.mtimeMs < RUNNING_WINDOW_MS,
        };
        const group = groups.get(fileFacts.cwd);
        if (group) group.sessions.push(summary);
        else groups.set(fileFacts.cwd, { name: projectName(fileFacts.cwd), cwd: fileFacts.cwd, sessions: [summary] });
      }
      const latest = (group: ProjectGroup) => Math.max(...group.sessions.map((session) => session.modified));
      for (const group of groups.values()) group.sessions.sort((a, b) => b.modified - a.modified);
      return [...groups.values()].sort((a, b) => latest(b) - latest(a));
    },

    etag(path) {
      const file = resolveSessionPath(path);
      if (!file) return undefined;
      try {
        const stats = statSync(file);
        return `"${stats.mtimeMs}-${stats.size}"`;
      } catch {
        return undefined;
      }
    },

    view(path) {
      const file = resolveSessionPath(path);
      const fileFacts = file && facts(file);
      if (!file || !fileFacts) return undefined;
      const parsed = readSessionFileEntries(file);
      if (!parsed) return undefined;
      const view = buildSessionView(parsed.entries, {
        path: relative(root, file),
        id: fileFacts.id,
        cwd: fileFacts.cwd,
        modified: fileFacts.mtimeMs,
        running: now() - fileFacts.mtimeMs < RUNNING_WINDOW_MS,
      });
      return { view, etag: `"${fileFacts.mtimeMs}-${fileFacts.size}"` };
    },
  };
}
