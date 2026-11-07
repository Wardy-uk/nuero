import { useCallback, useEffect, useState } from 'react';
import { apiFetch, apiUrl, authHeaders } from '../api';
import { makeCall } from '../preparedMove.mjs';
import TaskAgent from '../../../shared-ui/TaskAgent.jsx';
import { DoneEvidenceRow } from '../../../shared-ui/DoneEvidence.jsx';
import PreparedMove from '../components/PreparedMove.jsx';
import { platformNow } from '../../../shared-ui/presentation/platform.mjs';
import { completeTaskOutcome } from '../completeTask';
import { wentDone, jiraHint } from '../../../shared-ui/completeTask.mjs';
import NotToday from '../../../shared-ui/NotToday.jsx';
import SimilarTask from '../../../shared-ui/SimilarTask.jsx';
import { reasonWords } from '../../../shared-ui/notTodayReasons.mjs';
import { TickOutcome, StartFocus, JiraHint } from '../../../shared-ui/TaskActions.jsx';
import DelegateTasks, { setDelegatePool } from '../../../shared-ui/DelegateTasks.jsx';
import { msPlanBadge } from '../../../../shared/ms-task.cjs';
import { domainBadge } from '../../../../shared/task-domain.cjs';
import { Lit } from '../../../shared-ui/Lit.jsx';
import ProposalChips from '../../../shared-ui/ProposalChips.jsx';
import TaskDue from '../../../shared-ui/TaskDue.jsx';

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
// evidence about the WORK, so "Not today" opens them rather than snoozing
// straight off. ONE vocabulary on every surface (7 Nov 2026):
// saim/shared-ui/notTodayReasons.mjs, offered by the shared NotToday picker,
// where "It's too big" asks for the smallest first step and starts 15 minutes
// on it instead of hiding the task. Keys: 'too-big', 'waiting-on-someone',
// 'no-context', 'not-now' (the server's DEFER_REASONS).

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
  // Read back in words — never NEURO quoting its own enum at him.
  const reason = reasonWords(row.snoozeReason) || 'no reason given';
  const until = describeUntil(row.snoozedUntil);
  return until ? `${reason}, ${until}` : reason;
}

/**
 * The open row (7 Nov 2026 — the Build 10H boundary is lifted, audit F16/G):
 * Start, "working on it", "not today" (lane rows), triage — MoSCoW, priority,
 * estimate — for NEURO and Microsoft tasks through the SAME routes the desktop
 * uses (PATCH /api/tasks/:id; PATCH /api/todos/ms/:msId/local, which never
 * reaches Microsoft), progress on a Microsoft task (POST /api/todos/wip-ms),
 * the due date, and Delegate. Nothing here is a second editor: each control is
 * one PATCH of the field it names.
 */
// The raw {status, body} transport the shared TaskAgent speaks.
const agentCall = makeCall({ fetchImpl: (...a) => fetch(...a), apiUrl, authHeaders });

function TaskPanel({ item, taskRow, taskRowsKnown, laneRow, heldRow, laneKnown, onChanged }) {
  const [acting, setActing] = useState(false);
  const [error, setError] = useState(null);

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
  // Returned to the shared picker, which says a refusal where it was pressed.
  const deferWith = async (reason) => {
    try {
      const res = await apiFetch('/api/todos/lane/defer', {
        method: 'POST',
        body: JSON.stringify({ text: item.text, reason }),
      });
      if (!res?.ok) return { ok: false, error: res?.error || 'NEURO did not confirm that' };
      onChanged();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: errorText(e) };
    }
  };

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

  const boardName = String(item.source || '').includes('Planner') ? 'Planner' : 'Microsoft To Do';

  // ── Triage (MoSCoW / priority / estimate) ───────────────────────────────
  // A NEURO task PATCHes its own row; a Microsoft task writes NEURO's private
  // annotation (ms/:msId/local) — the same two routes the desktop's triage uses.
  const triage = (fields) => act(async () => {
    const path = isNeuro ? `/api/tasks/${item.task_id}` : `/api/todos/ms/${encodeURIComponent(item.ms_id)}/local`;
    const res = await apiFetch(path, { method: 'PATCH', body: JSON.stringify(fields) });
    if (res && res.ok === false) throw new Error(res.error || 'NEURO did not confirm that');
  });
  const curMoscow = item.moscow || null;
  const curPriority = (taskRow && taskRow.priority) || item.taskPriority || null;
  const curEstimate = (taskRow && taskRow.estimateMinutes) ?? item.estimateMinutes ?? null;

  // ── Progress on a Microsoft task ─────────────────────────────────────────
  // Planner's own in-progress state (0 / 50), visible to the team — the desktop's
  // "I'm working on it" for a Microsoft row. A value someone else set (25, 75)
  // is shown, never overwritten.
  const pct = laneRow ? laneRow.percentComplete : item.percentComplete;
  const msProgressIsOurs = pct == null || pct === 0 || pct === 50;
  const msStarted = pct != null && pct > 0 && pct < 100;
  const setMsWip = (starting) => act(async () => {
    const res = await apiFetch('/api/todos/wip-ms', {
      method: 'POST',
      body: JSON.stringify({ msId: item.ms_id, source: item.source, started: starting, filePath: item.filePath, lineNumber: item.lineNumber }),
    });
    if (res && res.ok === false) throw new Error(res.error || 'Microsoft did not take it');
  });
  const readOnly = platformNow() === 'kiosk';

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
          <NotToday
            onDefer={deferWith}
            call={readOnly ? null : agentCall}
            taskId={item.task_id || null}
            text={item.text}
            busy={acting}
            onStarted={onChanged}
            label="Not today…"
            classes={{ btn: 'tasks__btn', reason: 'tasks__btn', wrap: 'tasks__group' }}
          />
        </div>
      ) : !laneKnown ? (
        <div className="tasks__note">Couldn't read today's lane, so "not today" isn't offered here.</div>
      ) : null}

      {/* ONE Start (shared): a running session is parked without asking. */}
      {!readOnly && (
        <div className="tasks__group">
          <span className="tasks__label">Focus</span>
          <StartFocus
            call={agentCall}
            taskId={item.task_id || null}
            text={item.text}
            minutes={curEstimate}
            className="tasks__btn tasks__btn--on"
            noteClass="tasks__note"
            onStarted={onChanged}
          />
        </div>
      )}

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
          {msProgressIsOurs && !readOnly ? (
            <button type="button" className={`tasks__btn${msStarted ? ' tasks__btn--on' : ''}`} disabled={acting} onClick={() => setMsWip(!msStarted)}
              title={`Sets ${boardName}'s own progress — your team sees it`}>
              {msStarted ? 'In progress — put it back' : "I'm working on it"}
            </button>
          ) : (
            <span className="tasks__note">{pct != null ? `${pct}% in ${boardName} — set there by someone, so it is left alone.` : `Progress lives in ${boardName}.`}</span>
          )}
        </div>
      )}

      {/* Triage — one tap each, the same writes as the desktop's Tasks screen. */}
      {(isNeuro || isMs) && !readOnly && (
        <>
          <div className="tasks__group">
            <span className="tasks__label">MoSCoW</span>
            {['must', 'should', 'could', 'wont'].map((m) => (
              <button key={m} type="button" className={`tasks__btn${curMoscow === m && !item.moscowProposed ? ' tasks__btn--on' : ''}`} disabled={acting}
                onClick={() => triage({ moscow: curMoscow === m ? null : m })}>{m === 'wont' ? "Won't" : m[0].toUpperCase() + m.slice(1)}</button>
            ))}
          </div>
          <div className="tasks__group">
            <span className="tasks__label">Priority</span>
            {[3, 2, 1].map((pr) => (
              <button key={pr} type="button" className={`tasks__btn${Number(curPriority) === pr ? ' tasks__btn--on' : ''}`} disabled={acting}
                title={pr === 3 ? 'Most pressing' : pr === 1 ? 'Least pressing' : 'Middle'}
                onClick={() => triage({ priority: Number(curPriority) === pr ? null : pr })}>P{pr}</button>
            ))}
          </div>
          <div className="tasks__group">
            <span className="tasks__label">Estimate</span>
            {[15, 30, 60, 120, 240].map((m) => (
              <button key={m} type="button" className={`tasks__btn${Number(curEstimate) === m ? ' tasks__btn--on' : ''}`} disabled={acting}
                onClick={() => triage({ estimateMinutes: Number(curEstimate) === m ? null : m })}>{m < 60 ? `${m}m` : `${m / 60}h`}</button>
            ))}
          </div>
        </>
      )}

      {/* The due date, changeable wherever a task opens (Nick, 6 Nov 2026) — the
          task's own edit route, the same write as NEURO's Tasks screen. */}
      {(isNeuro || isMs) && (
        <div className="tasks__group">
          <span className="tasks__label">Due</span>
          <TaskDue
            target={isNeuro ? { kind: 'neuro', taskId: item.task_id } : { kind: 'microsoft', msId: item.ms_id }}
            due={item.due_date ? String(item.due_date).slice(0, 10) : null}
            call={agentCall}
            readOnly={platformNow() === 'kiosk'}
            onChanged={onChanged}
          />
        </div>
      )}
      {/* Delegate — the SAME panel as the desktop card (shared since 7 Nov 2026). */}
      {(isNeuro || isMs) && !readOnly && <DelegateTasks todo={item} call={agentCall} onDone={onChanged} />}

      {/* "Do this" (23 Oct 2026): on Nick's own SAiM — the phone app AND the desktop
          Electron window, which loads this same app and calls NEURO directly with his
          PIN. Only the kiosk build (declarePlatform('kiosk')) is read-only, and the
          server refuses its credential anyway (task-context.viewerOf). */}
      {isNeuro && (
        <TaskAgent
          taskId={item.task_id}
          call={agentCall}
          readOnly={platformNow() === 'kiosk'}
          renderSave={(recordId, done) => <PreparedMove call={agentCall} recordId={recordId} embedded onChanged={done} />}
        />
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
  // What each tick actually did — repeated / rolled / held / refused — by row id.
  const [outcomes, setOutcomes] = useState({});
  const [headline, setHeadline] = useState(null);
  // Spotted — tasks NEURO found in notes and email, waiting on add / dismiss.
  const [spotted, setSpotted] = useState({ known: false, items: [], total: 0 });
  const [spottedBusy, setSpottedBusy] = useState({});
  const [spottedNote, setSpottedNote] = useState(null);
  const [adding, setAdding] = useState('');
  const [addBusy, setAddBusy] = useState(false);
  const [addNote, setAddNote] = useState(null);
  const [similarPair, setSimilarPair] = useState(null);
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
      setSpotted({ known: true, items: todos.value?.suggested || [], total: todos.value?.suggestedTotal ?? (todos.value?.suggested || []).length });
    } else {
      setLane({ known: false, rows: new Map(), held: [], gaps: [] });
      setSpotted({ known: false, items: [], total: 0 });
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
    // The ONE shared completion helper (saim/shared-ui/completeTask.mjs) says what
    // happened: done, repeated (back at its next date), rolled (Microsoft rolled a
    // recurrence forward), held, or refused — with the server's own words (a
    // Jira-linked task names the ticket that closes it). It also carries what the
    // day now comes to (the wins headline), only when something closed.
    const outcome = await completeTaskOutcome(item);
    setOutcomes((o) => ({ ...o, [item.id]: outcome }));
    if (outcome.headline) setHeadline(outcome.headline);
    if (wentDone(outcome)) {
      // Strike it through rather than yanking it out — on a phone, a row that
      // vanishes under your thumb reads as "did that work?".
      setDone((d) => ({ ...d, [item.id]: true }));
      setTimeout(() => {
        setState((s) => (s.data
          ? { ...s, data: { ...s.data, items: s.data.items.filter((i) => i.id !== item.id) } }
          : s));
      }, 900);
    }
    // A repeating / rolled task is NOT painted done — it is still open at its
    // next date, and the row says so. A refusal stays on its row, not the page.
    setBusy((b) => ({ ...b, [item.id]: false }));
  }

  // Spotted: the BOUNDED intake routes — the server refuses anything that is not
  // a pending task suggestion, so these can never approve an email.
  async function decideSpotted(s, verb) {
    if (spottedBusy[s.id]) return;
    setSpottedBusy((b) => ({ ...b, [s.id]: verb }));
    setSpottedNote(null);
    try {
      const ids = [s.id, ...(s.duplicateIds || [])];
      for (let i = 0; i < ids.length; i += 1) {
        const v = i === 0 ? verb : 'dismiss';
        const res = await apiFetch(`/api/todos/suggestions/${ids[i]}/${v}`, { method: 'POST' });
        if (res && res.ok === false) throw new Error(res.error || 'NEURO did not confirm that');
      }
      setSpotted((sp) => ({ ...sp, items: sp.items.filter((x) => x.id !== s.id), total: Math.max(0, sp.total - 1) }));
      if (verb === 'add') load();
    } catch (e) {
      setSpottedNote(`Couldn't ${verb} "${s.text.slice(0, 60)}" — ${errorText(e)}`);
    } finally {
      setSpottedBusy((b) => ({ ...b, [s.id]: false }));
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
        // Answered in place (7 Nov 2026): Merge or Keep both, right here.
        setSimilarPair({ newId: res.taskId, similar: res.similar });
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
  // The pool a Delegate panel offers "add another task" from.
  setDelegatePool(items);
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

      {similarPair && (
        <SimilarTask newId={similarPair.newId} similar={similarPair.similar} call={agentCall}
          onAnswered={() => { load(); setTimeout(() => setSimilarPair(null), 4000); }} />
      )}

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

      {/* Spotted, waiting on you — the same queue as the desktop's Tasks screen. */}
      {spotted.items.length > 0 && (
        <Lit tone="statement" className="tasks__held tasks__spotted">
          <div className="tasks__label">Spotted, waiting on you ({spotted.total})</div>
          {spotted.items.map((s) => (
            <div className="tasks__heldrow" key={s.id}>
              <span className="tasks__heldtext">
                {s.text}
                {s.provenance && s.provenance.label && <span className="tasks__note" title={s.provenance.ref || undefined}> — {s.provenance.label}</span>}
              </span>
              {platformNow() !== 'kiosk' && (
                <span className="tasks__spotted-acts">
                  <button type="button" className="tasks__btn tasks__btn--on" disabled={Boolean(spottedBusy[s.id])} onClick={() => decideSpotted(s, 'add')}>{spottedBusy[s.id] === 'add' ? '…' : 'Add'}</button>
                  <button type="button" className="tasks__btn tasks__btn--quiet" disabled={Boolean(spottedBusy[s.id])} onClick={() => decideSpotted(s, 'dismiss')}>{spottedBusy[s.id] === 'dismiss' ? '…' : 'Dismiss'}</button>
                </span>
              )}
            </div>
          ))}
          {spotted.total > spotted.items.length && <div className="tasks__note">Showing {spotted.items.length} of {spotted.total}.</div>}
          {spottedNote && <div className="tasks__rowerr">{spottedNote}</div>}
        </Lit>
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
        const hasPanel = Boolean(identity) && Boolean(item.task_id || item.ms_id || laneRow || heldRow || item.text);
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
              title={jiraHint(item) || 'Mark done'}
            >{done[item.id] ? '✓' : busy[item.id] ? '…' : ''}</button>
            <div className="tasks__body">
              <div className="tasks__text">{item.text}</div>
              {/* What the tick did, on THIS row (never the page): a repeating task
                  says where it went, a refusal says why. */}
              <TickOutcome outcome={outcomes[item.id]} call={agentCall} onUndone={() => load()} />
              {!outcomes[item.id] && <JiraHint item={item} className="tasks__note" />}
              {/* "Looks done": NEURO's evidence this is already done. It offers; Nick closes. */}
              {item.task_id && !done[item.id] && (
                <DoneEvidenceRow taskId={item.task_id} call={agentCall} readOnly={platformNow() === 'kiosk'} onClosed={() => load()} />
              )}
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
                {/* NEURO's suggestions for a missing MoSCoW / estimate / due —
                    "?" and one tap to confirm; read-only on the kiosk. */}
                {item.task_id && !done[item.id] && (
                  <ProposalChips
                    proposals={item.proposals}
                    readOnly={platformNow() === 'kiosk'}
                    onConfirm={async (body) => {
                      const res = await apiFetch(`/api/tasks/${item.task_id}`, { method: 'PATCH', body: JSON.stringify(body) });
                      if (res && res.ok === false) throw new Error(res.error || 'NEURO did not confirm that');
                      load();
                    }}
                  />
                )}
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
