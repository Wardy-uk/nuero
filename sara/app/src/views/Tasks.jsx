import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../api';
import { completeTask } from '../completeTask';
import DueControl from '../components/DueControl';
import { msPlanBadge } from '../../../../shared/ms-task.cjs';
import { domainBadge } from '../../../../shared/task-domain.cjs';
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

const MOSCOW_OPTIONS = [
  { key: 'must', label: 'Must' },
  { key: 'should', label: 'Should' },
  { key: 'could', label: 'Could' },
  { key: 'wont', label: "Won't" },
];

// Numeric on the wire: 3 is the most pressing (task-store's normPriority).
const PRIORITY_OPTIONS = [3, 2, 1];

// Presets snap to the task store's buckets anyway, so they go without
// `estimateExact`. Only a number Nick TYPES is sent as exact — snapping that
// would be the store disagreeing with him about his own work.
const ESTIMATE_PRESETS = [5, 15, 30, 60, 120, 240];

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

function formatMinutes(m) {
  if (m == null) return 'none';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${h}h ${rest}m` : `${h}h`;
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

// Drafted under the PATCH field names, never the row's display names — drafting
// under a display name is how the wrong key gets sent and silently dropped.
function neuroSnapshot(row) {
  return {
    moscow: row?.moscow || null,
    priority: row?.priority || null,
    estimateMinutes: row?.estimate_minutes == null ? null : row.estimate_minutes,
  };
}

function describeChange(key, value, exact) {
  if (key === 'moscow') return `MoSCoW → ${value ? (MOSCOW_OPTIONS.find((o) => o.key === value)?.label || value) : 'none'}`;
  if (key === 'priority') return `priority → ${value ? `P${value}` : 'none'}`;
  if (key === 'estimateMinutes') return `estimate → ${formatMinutes(value)}${exact && value != null ? ' (exact)' : ''}`;
  return key;
}

/**
 * The open row. Everything here is gated on what the row's OWNER can accept:
 * NEURO tasks take status and triage fields, Microsoft takes progress (and
 * nothing else from here), a vault line takes neither. The lane's "not today" is
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

  // Microsoft's started-ness is Planner's percentComplete, which only the lane
  // payload reads back (server-side, from the marker NEURO writes). Offered only
  // where it is known AND is a value this button could have set (0 or 50):
  // anything else came from someone setting the number on a board the team
  // reads, and overwriting it throws away real progress.
  const pct = laneRow ? laneRow.percentComplete : undefined;
  const msProgressKnown = isMs && laneRow != null;
  const msProgressIsOurs = pct == null || pct === 0 || pct === 50;
  const msStarted = pct != null && pct > 0;
  const boardName = String(item.source || '').includes('Planner') ? 'Planner' : 'Microsoft To Do';
  const setMsWip = (starting) => act(async () => {
    await apiFetch('/api/todos/wip-ms', {
      method: 'POST',
      body: JSON.stringify({
        msId: item.ms_id,
        source: item.source,
        started: starting,
        // Lets the server repaint the mirror line the list reads from, or the
        // push lands and the screen does not change for an hour.
        filePath: item.filePath,
        lineNumber: item.lineNumber,
      }),
    });
  });

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
      {isMs && msProgressKnown && (
        <div className="tasks__group">
          <span className="tasks__label">{boardName}</span>
          {msProgressIsOurs ? (
            <>
              <button type="button" className={`tasks__btn${msStarted ? ' tasks__btn--on' : ''}`} disabled={acting} onClick={() => setMsWip(!msStarted)}>
                {msStarted ? 'Mark not started' : 'Mark in progress'}
              </button>
              <span className="tasks__note">
                {boardName === 'Planner'
                  ? 'Writes to the Planner board — your team sees this.'
                  : 'Writes to Microsoft To Do.'}
              </span>
            </>
          ) : (
            <span className="tasks__note">{boardName} says {pct}% — change it there.</span>
          )}
        </div>
      )}

      {isNeuro && (
        taskRow
          ? <TaskFieldEditor taskId={item.task_id} row={taskRow} ranked={item} onSaved={onChanged} />
          : null
      )}

      {error && <div className="tasks__rowerr">{error}</div>}
    </div>
  );
}

/**
 * MoSCoW, priority and estimate — a DRAFT until Save, written in ONE PATCH.
 *
 * Each click writing on its own re-ranks the list, so the card moved out from
 * under the next tap. The draft is reset on the row's IDENTITY (the component is
 * keyed on it), never on its values: the list refetches after every write
 * elsewhere, and a reset keyed on `row.moscow` would wipe half-finished edits
 * whenever that landed. A failed save keeps the draft exactly as it was.
 */
function TaskFieldEditor({ taskId, row, ranked, onSaved }) {
  const [baseline, setBaseline] = useState(() => neuroSnapshot(row));
  const [draft, setDraft] = useState(() => neuroSnapshot(row));
  const [exact, setExact] = useState(false);
  const [custom, setCustom] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const changed = {};
  for (const key of Object.keys(baseline)) {
    if (draft[key] !== baseline[key]) changed[key] = draft[key];
  }
  const dirtyKeys = Object.keys(changed);
  const edit = (fields) => setDraft((d) => ({ ...d, ...fields }));

  function setPreset(minutes) {
    setExact(false);
    setCustom('');
    edit({ estimateMinutes: draft.estimateMinutes === minutes ? null : minutes });
  }

  function typeMinutes(value) {
    setCustom(value);
    const n = Number(value);
    if (value.trim() === '') return;
    if (Number.isFinite(n) && n > 0) {
      setExact(true);
      edit({ estimateMinutes: Math.ceil(n) });
    }
  }

  async function save() {
    if (!dirtyKeys.length || saving) return;
    setSaving(true);
    setError(null);
    const body = { ...changed };
    if ('estimateMinutes' in body && exact && body.estimateMinutes != null) body.estimateExact = true;
    try {
      const res = await apiFetch(`/api/tasks/${taskId}`, { method: 'PATCH', body: JSON.stringify(body) });
      // What the store actually kept — an estimate may have snapped to a bucket —
      // rather than what was typed.
      const next = res?.task ? neuroSnapshot(res.task) : draft;
      setBaseline(next);
      setDraft(next);
      setExact(false);
      setCustom('');
      onSaved();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  }

  function discard() {
    setDraft(baseline);
    setExact(false);
    setCustom('');
    setError(null);
  }

  return (
    <div className="tasks__editor">
      {/* ⚠ The badge on the row is the RANKED MoSCoW (overdue or due today
          promotes a task), while these buttons are the call stored on the task.
          Verified on a live row: stored Should, badge MUST, because it was a day
          late — the two disagreeing with no explanation read as a broken editor. */}
      {ranked?.moscow && baseline.moscow && ranked.moscow !== baseline.moscow && (
        <p className="tasks__note">
          Ranked {String(ranked.moscow).toUpperCase()} {ranked.overdue ? 'because it’s overdue' : ranked.dueToday ? 'because it’s due today' : 'by NEURO'} — your own call is {MOSCOW_OPTIONS.find((o) => o.key === baseline.moscow)?.label || baseline.moscow}.
        </p>
      )}
      <div className="tasks__group">
        <span className="tasks__label">{row.moscow_proposed ? 'MoSCoW?' : 'MoSCoW'}</span>
        {MOSCOW_OPTIONS.map((o) => (
          <button
            key={o.key}
            type="button"
            className={`tasks__btn${draft.moscow === o.key ? ' tasks__btn--on' : ''}`}
            disabled={saving}
            onClick={() => edit({ moscow: draft.moscow === o.key ? null : o.key })}
          >{o.label}</button>
        ))}
      </div>

      <div className="tasks__group">
        <span className="tasks__label">Priority</span>
        {PRIORITY_OPTIONS.map((p) => (
          <button
            key={p}
            type="button"
            className={`tasks__btn${draft.priority === p ? ' tasks__btn--on' : ''}`}
            disabled={saving}
            title={p === 3 ? 'Most pressing' : p === 1 ? 'Least pressing' : 'Middle'}
            onClick={() => edit({ priority: draft.priority === p ? null : p })}
          >P{p}</button>
        ))}
      </div>

      <div className="tasks__group">
        <span className="tasks__label">Estimate</span>
        {ESTIMATE_PRESETS.map((m) => (
          <button
            key={m}
            type="button"
            className={`tasks__btn${draft.estimateMinutes === m && !exact ? ' tasks__btn--on' : ''}`}
            disabled={saving}
            onClick={() => setPreset(m)}
          >{formatMinutes(m)}</button>
        ))}
        <input
          className="tasks__mins"
          type="number"
          inputMode="numeric"
          min="1"
          placeholder="mins"
          aria-label="Exact estimate in minutes"
          value={custom}
          disabled={saving}
          onChange={(e) => typeMinutes(e.target.value)}
        />
        {draft.estimateMinutes != null && (
          <button type="button" className="tasks__btn tasks__btn--quiet" disabled={saving} onClick={() => { setExact(false); setCustom(''); edit({ estimateMinutes: null }); }}>Clear</button>
        )}
      </div>

      {dirtyKeys.length > 0 && (
        <div className="tasks__save">
          <span className="tasks__note">Unsaved: {dirtyKeys.map((k) => describeChange(k, changed[k], exact)).join(', ')}</span>
          <button type="button" className="tasks__btn tasks__btn--on" disabled={saving} onClick={save}>{saving ? 'Saving…' : 'Save'}</button>
          <button type="button" className="tasks__btn tasks__btn--quiet" disabled={saving} onClick={discard}>Discard</button>
        </div>
      )}
      {error && <div className="tasks__rowerr">Not saved — {error}</div>}
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
        body: JSON.stringify({ text, source: 'sara-tasks' }),
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
        <div className={`card tasks__addnote tasks__addnote--${addNote.tone}`}>
          <span>{addNote.text}</span>
          <button type="button" className="tasks__btn tasks__btn--quiet" onClick={() => setAddNote(null)} aria-label="Dismiss">✕</button>
        </div>
      )}

      {/*
        What the day now comes to, shown the moment a task closes rather than in
        a panel. Stays put once it appears — it is the running total, not a
        toast, and something that flashes past is something Nick will miss while
        looking at the row he just ticked. Plain statement of fact, no
        celebration: the voice spec rejects that register and an empty day gets
        no line at all rather than an encouraging one.
      */}
      {headline && <div className="card tasks__headline">{headline}</div>}

      {/* Held back, never silently dropped — a lane that is simply shorter is
          indistinguishable from one that found less work. */}
      {lane.held.length > 0 && (
        <div className="card tasks__held">
          <div className="tasks__label">Not today ({lane.held.length})</div>
          {lane.held.map((row) => (
            <div className="tasks__heldrow" key={ownerKey(row) || row.text}>
              <span className="tasks__heldtext">{row.text} <span className="tasks__note">— {heldLine(row)}</span></span>
              <button type="button" className="tasks__btn" onClick={() => bringBack(row)}>Bring it back</button>
            </div>
          ))}
        </div>
      )}
      {lane.gaps.length > 0 && (
        <div className="tasks__hint">Couldn't check what you've put off, so nothing is being held back.</div>
      )}

      {loading && <div className="card">Asking the brain…</div>}

      {error && (
        <div className="card err">
          {error}
          <div className="tasks__hint">Check you're on Tailscale and the PIN is right, or that the NEURO backend is up.</div>
        </div>
      )}

      {data && items.length === 0 && (
        <div className="card tasks__clear">
          {filter === 'overdue' ? 'Nothing overdue.' : filter === 'today' ? 'Nothing due today.' : 'No open tasks.'}
        </div>
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
        <div className={`card tasks__item${done[item.id] ? ' tasks__item--done' : ''}`} key={item.id}>
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
                {/* Dating a task is the cheapest way to stop it rotting undated,
                    so it lives inline on the row rather than behind an edit view. */}
                <DueControl task={item} onChanged={load} />
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
        </div>
        );
      })}

      {data && data.hidden > 0 && (
        <div className="tasks__hidden">{data.hidden} more not shown — the brain ranked these first.</div>
      )}
    </section>
  );
}
