import { render } from 'preact';
import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';
import type {
  Disposition,
  ForkItem,
  Item,
  ProjectGroup,
  SessionSummary,
  SessionView,
  ToolItem,
  TransactionItem,
} from '../../src/dash/model.js';
import { Markdown } from './markdown.js';
import './design.css';
import './app.css';

const DISPOSITION_LABEL: Record<Disposition, string> = {
  compact: 'Compacted',
  revert: 'Reverted',
  squash: 'Squashed',
  commit: 'Committed',
  open: 'In progress',
};

const RUNNING_POLL_MS = 2000;
const IDLE_POLL_MS = 15000;

function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function formatWhen(ms: number): string {
  const date = new Date(ms);
  const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const today = new Date();
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return `Today ${time}`;
  if (date.toDateString() === yesterday.toDateString()) return `Yesterday ${time}`;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Every transaction in the view, on every branch, for Expand all. */
function allTransactions(items: readonly Item[], out: TransactionItem[] = []): TransactionItem[] {
  for (const item of items) {
    if (item.kind === 'transaction') {
      out.push(item);
      allTransactions(item.children, out);
    }
    if (item.kind === 'fork') for (const lane of item.lanes) allTransactions(lane.items, out);
  }
  return out;
}

function pathFromHash(): string {
  return decodeURIComponent(location.hash.slice(1));
}

async function getJson<T>(url: string, etag?: string): Promise<{ body?: T; etag?: string }> {
  const response = await fetch(url, etag ? { headers: { 'if-none-match': etag } } : undefined);
  if (response.status === 304) return { etag };
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  const body: T = await response.json();
  return { body, etag: response.headers.get('etag') ?? undefined };
}

interface UiState {
  expanded: Record<string, boolean>;
  tools: Record<string, boolean>;
  lanes: Record<string, string>;
}

interface Ui extends UiState {
  toggleCard(item: TransactionItem): void;
  toggleTool(id: string): void;
  pickLane(fork: string, lane: string): void;
}

function isCardOpen(ui: UiState, item: TransactionItem): boolean {
  return ui.expanded[item.id] ?? item.disposition === 'open';
}

function Tool({ item, ui }: { item: ToolItem; ui: Ui }) {
  const open = !!ui.tools[item.id];
  return (
    <div class={item.isError ? 'tool err' : 'tool'}>
      <button class="tool-head" aria-expanded={open} onClick={() => ui.toggleTool(item.id)}>
        <span class="chev" aria-hidden="true">{open ? '▾' : '▸'}</span>
        <span class="tname">{item.name}</span>
        <span class="cmd mono">{item.summary}</span>
        {item.running ? <span class="run">Running</span> : <span />}
        <span class="tok">{item.running ? '' : formatTokens(item.tokens)}</span>
      </button>
      {open && <pre class="out mono">{item.output || (item.running ? 'Waiting for the result…' : '(no output)')}</pre>}
    </div>
  );
}

function Transaction({ item, ui }: { item: TransactionItem; ui: Ui }) {
  const open = isCardOpen(ui, item);
  return (
    <section class={`card c-${item.disposition}`}>
      <button class="card-head" aria-expanded={open} onClick={() => ui.toggleCard(item)}>
        <span class="chev" aria-hidden="true">{open ? '▾' : '▸'}</span>
        <span class="card-title">{item.purpose || `Transaction ${item.transactionId}`}</span>
        <span class={`tag t-${item.disposition}`}>{DISPOSITION_LABEL[item.disposition]}</span>
        <span class="card-meta">
          {plural(item.steps, 'step')} · {formatTokens(item.tokens)} tokens
        </span>
      </button>
      {open && (
        <div class="card-body">
          <Items items={item.children} ui={ui} />
        </div>
      )}
      {item.split && <div class="note">This transaction continues past a branch point; each branch closes it on its own.</div>}
      {item.takeaway && (
        <div class="sum">
          <span class="sum-label">Takeaway</span>
          <Markdown class="sum-text" text={item.takeaway} />
        </div>
      )}
    </section>
  );
}

function Fork({ item, ui }: { item: ForkItem; ui: Ui }) {
  const chosen = ui.lanes[item.id] ?? item.lanes.find((lane) => lane.current)?.id ?? item.lanes[0]?.id;
  const lane = item.lanes.find((candidate) => candidate.id === chosen) ?? item.lanes[0];
  return (
    <div class="fork">
      <div class="fork-head">
        <span class="fork-label">Branched here</span>
        <div class="tabs" role="group" aria-label="Branch lines">
          {item.lanes.map((candidate) => (
            <button
              key={candidate.id}
              class={candidate.id === lane?.id ? 'tab on' : 'tab'}
              aria-pressed={candidate.id === lane?.id}
              onClick={() => ui.pickLane(item.id, candidate.id)}
            >
              {candidate.label}
              {candidate.running ? ' · running' : candidate.current ? ' · current' : ''}
            </button>
          ))}
        </div>
      </div>
      {lane && (
        <div class="lane">
          <Items items={lane.items} ui={ui} />
        </div>
      )}
    </div>
  );
}

function ItemView({ item, ui }: { item: Item; ui: Ui }) {
  switch (item.kind) {
    case 'user':
      return (
        <div class="user-row">
          <div class="bubble">{item.text}</div>
        </div>
      );
    case 'assistant':
      return <Markdown class="say" text={item.text} />;
    case 'tool':
      return <Tool item={item} ui={ui} />;
    case 'transaction':
      return <Transaction item={item} ui={ui} />;
    case 'fork':
      return <Fork item={item} ui={ui} />;
    case 'note':
      return (
        <div class="notebox">
          <div class="notebox-label">{item.label}</div>
          {item.text && <Markdown class="notebox-text" text={item.text} />}
        </div>
      );
  }
}

function Items({ items, ui }: { items: readonly Item[]; ui: Ui }) {
  return (
    <>
      {items.map((item) => (
        <ItemView key={item.id} item={item} ui={ui} />
      ))}
    </>
  );
}

function SidebarIcon({ open }: { open: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <line x1="9" y1="4" x2="9" y2="20" />
      <polyline points={open ? '15 10 13 12 15 14' : '13 10 15 12 13 14'} />
    </svg>
  );
}

function Sidebar(props: { groups: ProjectGroup[]; selected: string; onPick(path: string): void; onClose(): void }) {
  return (
    <nav aria-label="Sessions" class="side">
      <div class="side-head">
        <button class="icon" aria-label="Close sessions sidebar" onClick={props.onClose}>
          <SidebarIcon open />
        </button>
        <span class="side-title">Sessions</span>
      </div>
      {props.groups.map((group) => (
        <div key={group.cwd}>
          <div class="sgroup" title={group.cwd}>
            {group.name}
          </div>
          {group.sessions.map((session: SessionSummary) => (
            <button
              key={session.path}
              class={session.path === props.selected ? 'sitem on' : 'sitem'}
              aria-current={session.path === props.selected ? 'page' : undefined}
              onClick={() => props.onPick(session.path)}
            >
              <span class={session.running ? 'dot' : 'dot off'} />
              <span class="stitle">{session.title}</span>
              <span class="smeta">
                {session.running ? 'Running' : formatWhen(session.modified)} · {plural(session.entries, 'entry', 'entries')}
              </span>
            </button>
          ))}
        </div>
      ))}
    </nav>
  );
}

function App() {
  const [groups, setGroups] = useState<ProjectGroup[]>([]);
  const [selected, setSelected] = useState(pathFromHash);
  const [view, setView] = useState<SessionView | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [sideOpen, setSideOpen] = useState(true);
  const [uiState, setUiState] = useState<UiState>({ expanded: {}, tools: {}, lanes: {} });

  useEffect(() => {
    let stopped = false;
    const load = () =>
      getJson<ProjectGroup[]>('/api/sessions').then(
        ({ body }) => {
          if (stopped || !body) return;
          setGroups(body);
          // Open the most recent session when nothing is chosen yet.
          const first = body[0]?.sessions[0];
          if (!pathFromHash() && first) location.hash = encodeURIComponent(first.path);
        },
        (reason: unknown) => setError(String(reason)),
      );
    void load();
    const timer = setInterval(load, IDLE_POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    const onHash = () => setSelected(pathFromHash());
    addEventListener('hashchange', onHash);
    return () => removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    if (!selected) return;
    let stopped = false;
    let etag: string | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setView(undefined);
    setUiState({ expanded: {}, tools: {}, lanes: {} });
    const load = async () => {
      try {
        const result = await getJson<SessionView>(`/api/session?path=${encodeURIComponent(selected)}`, etag);
        if (stopped) return;
        etag = result.etag;
        if (result.body) setView(result.body);
        setError(undefined);
        timer = setTimeout(load, result.body?.running === false ? IDLE_POLL_MS : RUNNING_POLL_MS);
      } catch (reason) {
        if (stopped) return;
        setError(String(reason));
        timer = setTimeout(load, IDLE_POLL_MS);
      }
    };
    void load();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [selected]);

  const ui: Ui = useMemo(
    () => ({
      ...uiState,
      toggleCard: (item) =>
        setUiState((s) => ({ ...s, expanded: { ...s.expanded, [item.id]: !isCardOpen(s, item) } })),
      toggleTool: (id) => setUiState((s) => ({ ...s, tools: { ...s.tools, [id]: !s.tools[id] } })),
      pickLane: (fork, lane) => setUiState((s) => ({ ...s, lanes: { ...s.lanes, [fork]: lane } })),
    }),
    [uiState],
  );

  const cards = useMemo(() => (view ? allTransactions(view.items) : []), [view]);
  const anyClosed = cards.some((card) => !isCardOpen(uiState, card));
  const toggleAll = useCallback(() => {
    const expanded: Record<string, boolean> = {};
    for (const card of cards) expanded[card.id] = anyClosed;
    setUiState((s) => ({ ...s, expanded }));
  }, [cards, anyClosed]);

  return (
    <div class="shell">
      {sideOpen ? (
        <Sidebar
          groups={groups}
          selected={selected}
          onPick={(path) => (location.hash = encodeURIComponent(path))}
          onClose={() => setSideOpen(false)}
        />
      ) : (
        <div class="rail">
          <button class="icon" aria-label="Open sessions sidebar" onClick={() => setSideOpen(true)}>
            <SidebarIcon open={false} />
          </button>
        </div>
      )}
      <div class="main">
        <div class="page">
          {error && <div class="error">Could not load from pim dashboard: {error}</div>}
          {view ? (
            <>
              <header class="top">
                <h1>{view.title}</h1>
                <span class="where" title={view.cwd}>
                  pim · {view.project}
                </span>
                <div class="facts">
                  <span class={view.running ? 'status on' : 'status'}>
                    <span class={view.running ? 'dot' : 'dot off'} />
                    {view.running ? 'Running' : 'Finished'}
                  </span>
                  <span>
                    {plural(view.entries, 'entry', 'entries')} · {plural(view.transactions, 'transaction')} ·{' '}
                    {formatTokens(view.tokens)} tokens
                  </span>
                  <span class="grow" />
                  {cards.length > 0 && (
                    <button class="ghost" onClick={toggleAll}>
                      {anyClosed ? 'Expand all' : 'Collapse all'}
                    </button>
                  )}
                </div>
              </header>
              <div class="stream">
                <Items items={view.items} ui={ui} />
              </div>
            </>
          ) : (
            !error && <div class="empty">{selected ? 'Loading session…' : 'Pick a session on the left.'}</div>
          )}
        </div>
      </div>
    </div>
  );
}

const mount = document.getElementById('app');
if (mount) render(<App />, mount);
