/**
 * The JSON the dashboard server sends and the browser client renders. The
 * server does all the interpretation (pairing tool calls with results, nesting
 * transactions, splitting branches); the client only draws this tree.
 */

import type { TransactionId } from '../ids.js';

export type Disposition = 'commit' | 'compact' | 'squash' | 'revert' | 'open';

export interface SessionSummary {
  /** Path relative to the sessions directory; the key the client asks for. */
  path: string;
  id: string;
  title: string;
  /** Last modification time of the session file, in ms since the epoch. */
  modified: number;
  entries: number;
  running: boolean;
}

export interface ProjectGroup {
  /** Short project name (the cwd's last path segment). */
  name: string;
  cwd: string;
  sessions: SessionSummary[];
}

export interface UserItem {
  kind: 'user';
  id: string;
  text: string;
}

export interface AssistantItem {
  kind: 'assistant';
  id: string;
  text: string;
}

export interface ToolItem {
  kind: 'tool';
  id: string;
  name: string;
  /** One line describing the call: a command, a path, or compact arguments. */
  summary: string;
  output: string;
  isError: boolean;
  /** Rough size of the result in tokens (characters / 4). */
  tokens: number;
  /** The call has no result yet and the session is still being written. */
  running: boolean;
}

export interface TransactionItem {
  kind: 'transaction';
  id: string;
  transactionId: TransactionId;
  purpose: string;
  disposition: Disposition;
  /** What the closed transaction left in context: summary or result, carryforward, next action. */
  takeaway: string;
  /** The transaction continues past a branch point, so it closes (or not) per branch. */
  split: boolean;
  children: Item[];
  steps: number;
  tokens: number;
}

export interface Lane {
  id: string;
  label: string;
  /** The lane holding the most recent entry: the one pi is on now. */
  current: boolean;
  running: boolean;
  items: Item[];
}

export interface ForkItem {
  kind: 'fork';
  id: string;
  lanes: Lane[];
}

export interface NoteItem {
  kind: 'note';
  id: string;
  label: string;
  text: string;
}

export type Item = UserItem | AssistantItem | ToolItem | TransactionItem | ForkItem | NoteItem;

export interface SessionView {
  path: string;
  id: string;
  title: string;
  project: string;
  cwd: string;
  modified: number;
  running: boolean;
  entries: number;
  transactions: number;
  tokens: number;
  items: Item[];
}
