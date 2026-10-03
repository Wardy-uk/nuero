import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../api';
import { completeTask } from '../completeTask';
import { msPlanBadge } from '../../../../shared/ms-task.cjs';
import { domainBadge } from '../../../../shared/task-domain.cjs';
import { Lit } from '../../../shared-ui/Lit.jsx';

import './Tasks.css';

// Tasks = the list you can actually work from on the phone.
//
// Capture was one-way before this existed: four routes fired tasks INTO the
// system and the only way to tick one off on mobile was to happen to arrive via
// a notification. A capture tool you can't close the loop on stops being trusted.
//
// Scored and ordered by the brain (/api/todos/focus) — same ranking as Focus, so
// the top of this list is the same top the rest of NEURO agrees on.
const FILTERS = [
  { id: 'overdue', label: 'Overdue' },
  { id: 'today', label: 'Today' },
  { id: 'all', label: 'All' },
];

// The reasons are the product, not decoration: friction reads them back as
// evidence about the WORK, so "Not today" opens these rather than snoozing
// straight off, and there is no skip-it. Keys are the server's DEFER_REASONS —
// anything else is refused there, not stored as "unspecified".
const NOT_TODAY_REASONS = [
  { key: 'too-big', label: "It's too big" },
  { key: 'waiting-on-someone', label: "I'm blocked" },
  { key: 'no-context', label: 'Wrong context' },
  { key: 'not-now', label: 'Just not today' },
];

// The same vocabulary read back — a held row showing `too-big` would be NEURO
// quoting its own enum at him.
const HELD_REASON_LABELS = {
  'too-big': 'too big',
  'waiting-on-someone': 'blocked on someone',
  'no-context': 'wrong context',
  'not-now': 'not today',
  unspecified: 'no reason given',
};

/**
 * Who owns a row, as one stable key. Same owner order as completeTask:
 * task_id, then ms_id, then the vault line.
 *
 * ⚠ Never `item.id` — that is a display counter, not an identity, and it is
 * numbered separately by every route. This key is what joins a /focus row to
 * the lane payload and to the task store, and what an open editor's draft is
 * reset on — a background refresh never changes it, so it never wipes a draft.
 */
function ownerKey(item) {
  if (!item) return null;
  if (item.task_id) return `task:${item.task_id}`;
  if (item.ms_id) return `ms:${item.ms_id}`;
  if (item.filePath && item.lineNumber != null) return `file:${item.filePath}#${item.lineNumber}`;
  return null;
}

// apiFetch flattens a non-2xx into "400 Bad Request — {json}". The server's own
// words are the useful half, so read them back out when they are there.
function errorText(e) {
  const msg = e?.message || String(e);
  const i = msg.indexOf(' — ');
  if (i === -1) return msg;
  try {
    const body = JSON.parse(msg.slice(i + 3));
    return body.error || msg;
  } catch {
    return msg;
  }
}

// Local getters throughout — the server stamps an instant, Nick reads a wall clock.
function describeUntil(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const now = new Date();
  const dayOf = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((dayOf(d) - dayOf(now)) / 86400000);
  if (days <= 0) return `until ${hhmm}`;
  if (days === 1) return `until tomorrow ${hhmm}`;
  return `until ${d.toLocaleDateString(undefined, { weekday: 'short' })} ${hhmm}`;
}

function heldLine(row) {
  const reason = HELD_REASON_LABELS[row.snoozeReason] || row.snoozeReason || 'no reason given';
  const until = describeUntil(row.snoozedUntil);
  return until ? `${reason}, ${until}` : reason;
}

/**
 * The open row. SAiM's half of a task is deliberately small (Build 10H): tick,
 * "working on it" for a NEURO task, and "not today". Triage fields and any
 * write to Planner / To Do belong to NEURO and are handed off by name. The lane's "not today" is
 * about the lane, not the owner, so any lane row gets it.
 */
function TaskPanel({ item, taskRow, taskRowsKnown, laneRow, heldRow, laneKnown, onChanged }) {
  const [acting, setActing] = useState(false);
  const [error, setError] = useState(null);
  const [askingWhy, setAskingWhy] = useState(false);

  const isNeuro = Boolean(item.task_id);
  const isMs = !isNeuro && Boolean(item.ms_id);

  async function act(fn) {
    if (acting) return;
    setActing(true);
    setError(null);
    try {
      await fn();
      onChanged();
    } catch (e) {
      // Said, never swallowed: a button that silently did nothing reads as dead.
      setError(errorText(e));
    } finally {
      setActing(false);
    }
  }

  // ── "Not today" ──────────────────────────────────────────────────────────
  // Keyed on the TEXT, verbatim, because that is what the attention record's
  // key is built from — the same statement as deferring it on the Now page.
  const deferWith = (reason) => act(async () => {
    const res = await apiFetch('/api/todos/lane/defer', {
      method: 'POST',
      body: JSON.stringify({ text: item.text, reason }),
    });
    if (!res?.ok) throw new Error(res?.error || 'NEURO did not confirm that');
    setAskingWhy(false);
  });

  const undefer = () => act(async () => {
    const res = await apiFetch('/api/todos/lane/undefer', {
      method: 'POST',
      body: JSON.stringify({ text: heldRow?.text || item.text }),
    });
    if (!res?.ok) throw new Error(res?.error || 'NEURO did not confirm that');
  });

  // ── Working on it ────────────────────────────────────────────────────────
  const neuroStarted = taskRow?.status === 'in-progress';
  const setNeuroWip = (starting) => act(async () => {
    await apiFetch(`/api/tasks/${item.task_id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: starting ? 'in-progress' : 'open' }),
    });
  });

  // ⚠ Build 10H: SAiM no longer writes to Planner or To Do. Marking a Planner
  // card in progress is visible to the whole team, and that kind of change
  // belongs in NEURO, where its consequence is shown beside it.
  const boardName = String(item.source || '').includes('Planner') ? 'Planner' : 'Microsoft To Do';

  return (
    <div className="tasks__panel">
      {/* Lane */}
      {heldRow ? (
        <div className="tasks__group">
          <span className="tasks__label">Not today</span>
          <span className="tasks__note">Put off — {heldLine(heldRow)}.</span>
          <button type="button" className="tasks__btn" disabled={acting} onClick={undefer}>Bring it back</button>
        </div>
      ) : laneRow ? (
        <div className="tasks__group">
          <span className="tasks__label">Must move today</span>
          {!askingWhy ? (
            <button type="button" className="tasks__btn" disabled={acting} onClick={() => setAskingWhy(true)}>Not today…</button>
          ) : (
            <>
              <span className="tasks__note">Why not today?</span>
              {NOT_TODAY_REASONS.map((r) => (
                <button key={r.key} type="button" className="tasks__btn" disabled={acting} onClick={() => deferWith(r.key)}>{r.label}</button>
              ))}
              <button type="button" className="tasks__btn tasks__btn--quiet" disabled={acting} onClick={() => setAskingWhy(false)}>Cancel</button>
            </>
          )}
        </div>
      ) : !laneKnown ? (
        <div className="tasks__note">Couldn't read today's lane, so "not today" isn't offered here.</div>
      ) : null}

      {/* Working on it */}
      {isNeuro && (
        <div className="tasks__group">
          <span className="tasks__label">Status</span>
          {taskRow ? (
            <button type="button" className={`tasks__btn${neuroStarted ? ' tasks__btn--on' : ''}`} disabled={acting} onClick={() => setNeuroWip(!neuroStarted)}>
              {neuroStarted ? 'Working on it — put it back' : "I'm working on it"}
            </button>
          ) : (
            <span className="tasks__note">{taskRowsKnown ? "NEURO has no row for this task." : "Couldn't read whether this is started."}</span>
          )}
        </div>
      )}
      {isMs && (
        <div className="tasks__group">
          <span className="tasks__label">{boardName}</span>
          <span className="tasks__note">Progress on a {boardName} item is changed in NEURO (Tasks), not here.</span>
        </div>
      )}

      {/* Build 10H — SAiM is not the place for task administration. MoSCoW,
          priority, estimate and due date are edited in NEURO's Tasks screen;
          SAiM ticks, puts things off and hands off. */}
      {isNeuro && (
        <div className="tasks__group">
          <span className="tasks__note">To change MoSCoW, priority, estimate or due date, open Tasks in NEURO.</span>
        </div>
      )}

      {error && <div className="tasks__rowerr">{error}</div>}
    </div>
  );
}

export default function Tasks() {
  const [filter, setFilter] = useState('overdue');
  const [state, setState] = useState({ loading: true, error: null, data: null });
  const [busy, setBusy] = useState({});
  const [done, setDone] = useState({});
  const [headline, setHeadline] = useState(null);
  const [adding, setAdding] = useState('');
  const [addBusy, setAddBusy] = useState(false);
  const [addNote, setAddNote] = useState(null);
  const [open, setOpen] = useState(null);
  // The lane (what "not today" applies to, and what is held back) and the task
  // store's own rows (status + triage fields, which /focus does not carry).
  // Both are supporting reads: failing one costs its controls, never the list.
  const [lane, setLane] = useState({ known: false, rows: new Map(), held: [], gaps: [] });
  const [taskRows, setTaskRows] = useState({ known: false, byId: new Map() });

  const load = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }));
    const [focus, todos, tasks] = await Promise.allSettled([
      apiFetch(`/api/todos/focus?filter=${filter}&limit=30`),
      apiFetch('/api/todos'),
      // status=all: `open` is a literal column match and would miss in-progress rows.
      apiFetch('/api/tasks?status=all'),
    ]);
    if (focus.status === 'fulfilled') setState({ loading: false, error: null, data: focus.value });
    else setState({ loading: false, error: focus.reason?.message || 'Could not load tasks', data: null });

    if (todos.status === 'fulfilled') {
      const rows = new Map();
      for (const row of todos.value?.todayLane || []) {
        const key = ownerKey(row);
        if (key) rows.set(key, row);
      }
      setLane({ known: true, rows, held: todos.value?.laneHeld || [], gaps: todos.value?.laneGaps || [] });
    } else {
      setLane({ known: false, rows: new Map(), held: [], gaps: [] });
    }

    if (tasks.status === 'fulfilled') {
      const byId = new Map();
      for (const row of tasks.value?.tasks || []) byId.set(row.id, row);
      setTaskRows({ known: true, byId });
    } else {
      setTaskRows({ known: false, byId: new Map() });
    }
  }, [filter]);

  useEffect(() => { load(); }, [load]);

  async function tick(item) {
    if (busy[item.id]) return;
    setBusy((b) => ({ ...b, [item.id]: true }));
    try {
      // completeTask returns what the day now comes to. This is the immediacy
      // half of the wins ledger: the count was already true, but it lived in a
      // panel Nick had to remember to open, and a reward that arrives an hour
      // later is a scoreboard rather than a reward. Null on an empty day, and
      // null if the ledger could not be reached — never a fabricated number.
      const line = await completeTask(item);
      if (line) setHeadline(line);
      // Strike it through rather than yanking it out — on a phone, a row that
      // vanishes under your thumb reads as "did that work?".
      setDone((d) => ({ ...d, [item.id]: true }));
      setTimeout(() => {
        setState((s) => (s.data
          ? { ...s, data: { ...s.data, items: s.data.items.filter((i) => i.id !== item.id) } }
          : s));
      }, 900);
    } catch (error) {
      setState((s) => ({ ...s, error: error.message }));
    } finally {
      setBusy((b) => ({ ...b, [item.id]: false }));
    }
  }

  async function add(e) {
    e.preventDefault();
    const text = adding.trim();
    if (!text || addBusy) return;
    setAddBusy(true);
    setAddNote(null);
    try {
      const res = await apiFetch('/api/capture/todo', {
        method: 'POST',
        body: JSON.stringify({ text, source: 'saim-tasks' }),
      });
      setAdding('');
      // A 207 is a 2xx: the words are safe in the vault, the task row is not.
      // Saying "failed" there sends Nick to retype something already saved.
      if (res && res.success === false && res.partial) {
        setAddNote({ tone: 'warn', text: `Saved to the vault, but not on your task list yet — ${res.error || 'the task row failed'}.` });
      } else if (res && res.created === false) {
        setAddNote({ tone: 'info', text: `That's already on your list (#${res.taskId}) — folded into it, not added twice.` });
      } else if (res?.similar) {
        // REPORTED, never enforced. The task IS created; a wrong merge would
        // silently lose a commitment, a missed one only leaves a visible pair.
        const s = res.similar;
        setAddNote({
          tone: 'warn',
          text: `Added. It reads like #${s.id} "${s.text}", which you already have — both are on the list now. If they're the same job, merge them from Tasks on the desktop.`,
        });
      }
      load();
    } catch (error) {
      setState((s) => ({ ...s, error: error.message }));
    } finally {
      setAddBusy(false);
    }
  }

  async function bringBack(row) {
    try {
      const res = await apiFetch('/api/todos/lane/undefer', {
        method: 'POST',
        body: JSON.stringify({ text: row.text }),
      });
      if (!res?.ok) throw new Error(res?.error || 'NEURO did not confirm that');
      load();
    } catch (e) {
      setState((s) => ({ ...s, error: `Couldn't bring "${row.text}" back: ${errorText(e)}` }));
    }
  }

  const { loading, error, data } = state;
  const items = data?.items || [];
  const heldByKey = new Map();
  for (const row of lane.held) {
    const key = ownerKey(row);
    if (key) heldByKey.set(key, row);
  }

  return (
    <section>
      <div className="tasks__head">
        <div>
          <h1 className="view__title">Tasks</h1>
          <p className="view__lede">What's outstanding. Tick it off here.</p>
        </div>
        <button className="tasks__refresh" type="button" onClick={load} aria-label="Refresh" title="Refresh">↻</button>
      </div>

      <div className="tasks__filters" role="tablist">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            role="tab"
            aria-selected={filter === f.id}
            className={`tasks__filter${filter === f.id ? ' tasks__filter--on' : ''}`}
            onClick={() => setFilter(f.id)}
          >{f.label}</button>
        ))}
      </div>

      <form className="tasks__add" onSubmit={add}>
        <input
          className="tasks__add-input"
          value={adding}
          onChange={(e) => setAdding(e.target.value)}
          placeholder="Add a task…"
          aria-label="Add a task"
        />
        <button className="tasks__add-btn" type="submit" disabled={addBusy || !adding.trim()}>
          {addBusy ? '…' : '+'}
        </button>
      </form>

      {addNote && (
        <Lit tone="statement" className={`tasks__addnote tasks__addnote--${addNote.tone}`}>
          <span>{addNote.text}</span>
          <button type="button" className="tasks__btn tasks__btn--quiet" onClick={() => setAddNote(null)} aria-label="Dismiss">✕</button>
        </Lit>
      )}

      {/*
        What the day now comes to, shown the moment a task closes rather than in
        a panel. Stays put once it appears — it is the running total, not a
        toast, and something that flashes past is something Nick will miss while
        looking at the row he just ticked. Plain statement of fact, no
        celebration: the voice spec rejects that register and an empty day gets
        no line at all rather than an encouraging one.
      */}
      {headline && <Lit tone="statement" className="tasks__headline">{headline}</Lit>}

      {/* Held back, never silently dropped — a lane that is simply shorter is
          indistinguishable from one that found less work. */}
      {lane.held.length > 0 && (
        <Lit tone="statement" className="tasks__held">
          <div className="tasks__label">Not today ({lane.held.length})</div>
          {lane.held.map((row) => (
            <div className="tasks__heldrow" key={ownerKey(row) || row.text}>
              <span className="tasks__heldtext">{row.text} <span className="tasks__note">— {heldLine(row)}</span></span>
              <button type="button" className="tasks__btn" onClick={() => bringBack(row)}>Bring it back</button>
            </div>
          ))}
        </Lit>
      )}
      {lane.gaps.length > 0 && (
        <div className="tasks__hint">Couldn't check what you've put off, so nothing is being held back.</div>
      )}

      {loading && <Lit tone="statement">Asking the brain…</Lit>}

      {error && (
        /* ⚠ THE ONE THING ON THIS SCREEN THAT IS A FAULT. Everything else — an
            empty filter, a held-back row, "asking the brain" — is a statement,
            and only something genuinely broken gets the alarm treatment. That
            separation is the whole reason a named gap is never painted like an
            error. */
        <Lit className="tasks__fault err">
          {error}
          <div className="tasks__hint">Check you're on Tailscale and the PIN is right, or that the NEURO backend is up.</div>
        </Lit>
      )}

      {data && items.length === 0 && (
        <Lit tone="statement" className="tasks__clear">
          {filter === 'overdue' ? 'Nothing overdue.' : filter === 'today' ? 'Nothing due today.' : 'No open tasks.'}
        </Lit>
      )}

      {items.map((item) => {
        // The source badge beside it already reads "MS Planner"/"MS ToDo" on a
        // file-backed mirror; a linked NEURO row's reads "NEURO" and needs it.
        const plan = msPlanBadge(item, { withSystem: !String(item.source || '').startsWith('MS ') });
        const identity = ownerKey(item);
        const laneRow = identity ? lane.rows.get(identity) : null;
        const heldRow = identity ? heldByKey.get(identity) : null;
        const taskRow = item.task_id ? taskRows.byId.get(item.task_id) : null;
        const started = item.task_id
          ? taskRow?.status === 'in-progress'
          : Boolean(laneRow && laneRow.percentComplete > 0 && laneRow.percentComplete < 100);
        // Only a row whose owner can take something from the panel gets one.
        // A plain vault line outside the lane has nothing to offer, and a
        // button that opens an empty panel is worse than no button.
        const hasPanel = Boolean(identity) && Boolean(item.task_id || item.ms_id || laneRow || heldRow);
        const isOpen = open === identity && hasPanel;
        return (
        /* ⚠ `row`, NOT `normal`, and NOT `lead` on any of them. A card is a
           thing you pick up and one glow says so; sixty of them down a task list
           is haze rather than hierarchy. MANIFESTATION.md: a list is a list —
           its job is to be scanned, and a hero on it just makes one row
           arbitrarily loud. This screen spends NO lead at all, which is the
           direct counterpart of Now spending exactly one. */
        <Lit
          tone="row"
          className={`tasks__item${done[item.id] ? ' tasks__item--done' : ''}`}
          key={item.id}
        >
          <div className="tasks__row">
            <button
              className="tasks__tick"
              type="button"
              onClick={() => tick(item)}
              disabled={busy[item.id] || done[item.id]}
              aria-label={`Complete: ${item.text}`}
            >{done[item.id] ? '✓' : busy[item.id] ? '…' : ''}</button>
            <div className="tasks__body">
              <div className="tasks__text">{item.text}</div>
              <div className="tasks__meta">
                {item.moscow && <span className={`tasks__moscow tasks__moscow--${item.moscow}`}>{item.moscow}</span>}
                {started && <span className="tasks__wip">Working on it</span>}
                {heldRow && <span className="tasks__lane">Not today</span>}
                {!heldRow && laneRow && <span className="tasks__lane">Must move today</span>}
                {/* Only PERSONAL is marked. Nearly every task is work, so a "Work"
                    chip on all of them is a label every row shares — it sorts
                    nothing and reads as noise. domainBadge owns that rule, so this
                    view, the desktop panel and the capture screen cannot disagree
                    about when to show it. */}
                {domainBadge(item) && <span className="tasks__domain">{domainBadge(item)}</span>}
                {item.source && <span className="tasks__source">{item.source}</span>}
                {/* Which Planner board / To Do list. Absent when NEURO could not
                    read it, rather than naming a board the task may not be on. */}
                {plan && <span className="tasks__plan">{plan}</span>}
              </div>
            </div>
            {hasPanel && (
              <button
                type="button"
                className="tasks__more"
                aria-expanded={isOpen}
                aria-label={isOpen ? `Close: ${item.text}` : `More for: ${item.text}`}
                onClick={() => setOpen(isOpen ? null : identity)}
              >{isOpen ? '▴' : '⋯'}</button>
            )}
          </div>
          {isOpen && (
            <TaskPanel
              key={identity}
              item={item}
              taskRow={taskRow}
              taskRowsKnown={taskRows.known}
              laneRow={laneRow}
              heldRow={heldRow}
              laneKnown={lane.known}
              onChanged={load}
            />
          )}
        </Lit>
        );
      })}

      {data && data.hidden > 0 && (
        <div className="tasks__hidden">{data.hidden} more not shown — the brain ranked these first.</div>
      )}
    </section>
  );
}
