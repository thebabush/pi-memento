import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import { asEntryId, type EntryId } from './ids.js';
import { projectMessages } from './project.js';
import { replayTransactions } from './replay.js';
import { transactionEvents } from './session.js';

function compactionCutIndex(branch: readonly SessionEntry[]): number {
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (!entry || entry.type !== 'compaction') continue;
    const keptIndex = branch.findIndex((candidate) => candidate.id === entry.firstKeptEntryId);
    // An unknown firstKeptEntryId keeps the whole branch rather than guessing at a cut.
    return keptIndex >= 0 ? keptIndex : 0;
  }
  return 0;
}

/**
 * Computes the ids of `message` entries on the active branch whose messages
 * survive into the model-visible context: the entries kept by the latest
 * compaction cut, filtered through the transaction projection.
 *
 * Conservative by construction: an unrecognized compaction cut keeps the
 * whole branch as candidates, and an unsafe projection keeps every candidate
 * (mirroring the extension, which passes context through unmodified on
 * diagnostics).
 */
export function computeVisibleEntryIds(branch: readonly SessionEntry[]): Set<EntryId> {
  const candidates = branch.slice(compactionCutIndex(branch));

  const messages: AgentMessage[] = [];
  const entryIdByMessage = new Map<AgentMessage, EntryId>();
  for (const entry of candidates) {
    if (entry.type !== 'message') continue;
    messages.push(entry.message);
    entryIdByMessage.set(entry.message, asEntryId(entry.id));
  }

  // Replay events from the WHOLE branch so nesting and LIFO order stay
  // consistent even when the cut hides earlier boundaries. A closed
  // transaction whose boundary messages all fall before the cut is skipped by
  // projectMessages without a diagnostic, so it cannot disable projection for
  // the tail; a boundary the cut bisected surfaces as a diagnostic and fails
  // open below.
  const replay = replayTransactions(transactionEvents(branch));
  const projected = projectMessages(messages, replay);

  const visible = new Set<EntryId>();
  if (!projected.safe) {
    for (const entryId of entryIdByMessage.values()) visible.add(entryId);
    return visible;
  }

  // projectMessages returns slices of its input plus synthetic messages, so a
  // candidate survives iff the same object reference appears in the output.
  for (const message of projected.messages) {
    const entryId = entryIdByMessage.get(message);
    if (entryId !== undefined) visible.add(entryId);
  }
  return visible;
}
