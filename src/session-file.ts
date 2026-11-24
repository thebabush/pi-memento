import { readFileSync } from 'node:fs';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import { asSessionId, type SessionId } from './ids.js';

/**
 * Reading pi's session JSONL files from disk, shared by the search index and
 * the dashboard. Kept free of node:sqlite so the dashboard does not load it.
 */

function parseJsonObject(line: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(line);
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    // Torn or corrupt line; the caller stops at it.
  }
  return undefined;
}

/** Shallow shape check at the file boundary; entry bodies stay as pi wrote them. */
function isSessionEntryLike(value: Record<string, unknown>): value is Record<string, unknown> & SessionEntry {
  return (
    typeof value.type === 'string' &&
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    typeof value.timestamp === 'string' &&
    (value.parentId === null || value.parentId === undefined || typeof value.parentId === 'string')
  );
}

export interface ParsedSessionFile {
  sessionId: SessionId;
  fileSize: number;
  entries: SessionEntry[];
}

export function readSessionFileEntries(filePath: string): ParsedSessionFile | undefined {
  let buffer: Buffer;
  try {
    buffer = readFileSync(filePath);
  } catch {
    return undefined;
  }
  const fileSize = buffer.length;
  const content = buffer.toString('utf8');

  const headerEnd = content.indexOf('\n');
  const header = parseJsonObject(headerEnd < 0 ? content : content.slice(0, headerEnd));
  if (
    !header ||
    header.type !== 'session' ||
    typeof header.id !== 'string' ||
    header.id.length === 0 ||
    typeof header.cwd !== 'string'
  ) {
    return undefined;
  }

  const entries: SessionEntry[] = [];
  const lines = headerEnd < 0 ? [] : content.slice(headerEnd + 1).split('\n');
  for (const line of lines) {
    if (line === '') continue;
    const parsed = parseJsonObject(line);
    // A torn last line from a concurrent writer (or a corrupt line) stops the
    // scan without advancing the high-water mark past it.
    if (!parsed || !isSessionEntryLike(parsed)) break;
    entries.push(parsed);
  }

  return { sessionId: asSessionId(header.id), fileSize, entries };
}
