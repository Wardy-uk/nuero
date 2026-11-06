import { useState } from 'react';
import actionSurfaces from '../../shared/action-surfaces.cjs';
import dueDates from '../../shared/due-dates.cjs';
import './AttentionCard.css';

const { resolveNueroNavigation } = actionSurfaces;
const { duePresets, toDateStr } = dueDates;

/**
 * One canonical attention card, with the exact action semantics.
 *
 * ⚠ ONE CARD ON EVERY SURFACE (6 Nov 2026). It was NEURO desktop's alone, and
 * SAiM's phone, kiosk and Electron window drew their own smaller version with
 * different buttons ("That's done / Not now → An hour…") — Nick: "the desktop
 * version is the most useful, so all others should follow". It lives here now
 * and every shell mounts it; what differs is only what the SHELL can do:
 *   * `onOpen(card, destination)` — the shell's navigation (NEURO views on the
 *     desktop, SAiM tabs on the phone). Absent → no open button.
 *   * `onAct(card, action, opts)` — the attention lifecycle. Absent → no
 *     lifecycle buttons (a wall with nothing behind it).
 *   * `call` ({status, body} over NEURO's fetch) — starting a focus session and
 *     moving a due date. Absent (the kiosk) → neither is offered.
 *
 * The wording, the destination and the permitted action set all come off the
 * record; nothing here reranks, rephrases or decides urgency.
 *
 * ── The semantics, each one a bug that has actually happened ────────────────
 *
 * **Open context** navigates, and calls NOTHING. Briefing's "Do it" once
 * POSTed `/api/focus/action-done`, which logged an outcome and dismissed the
 * item — so opening a thing recorded it as finished before any work was done.
 *
 * **Start this** starts a focus session and leaves the record exactly where it
 * was. The record is told (`start`) only so the friction read has the evidence.
 *
 * **Done** is Nick saying so, and is the ONLY path that resolves. It SAYS which
 * of the outcomes happened.
 *
 * **Not now** / **Waiting on someone** defer with the reason recorded.
 *
 * **Move due date** (6 Nov 2026) re-dates the TASK the card is about, through
 * the task's own edit route — the same write as editing it in Tasks, so the
 * re-date is counted where re-dates are counted. It is offered only where the
 * card names exactly one task by id; a summary card names none.
 *
 * **Not relevant** dismisses: it teaches suppression and touches no work.
 *
 * **Seen it** acknowledges: the card STAYS on screen and stops notifying.
 *
 * Nothing here auto-completes, auto-defers, auto-dismisses, auto-starts or
 * sends anything on Nick's behalf. Every one of these is a click.
 */

// Where "Open context" actually goes, in words.
// ⚠ IT IS NOT `card.actionHint`, deliberately: those strings are prose written
// for SAiM's sentence-shaped surface and several are not navigations ("Start
// here, then review the rest" beside a "Start this" that really does start a
// session). The verb stays ours; only the destination comes from the resolver.
// ⚠ An unmapped view falls back to the generic label rather than guessing.
const VIEW_LABELS = {
  dashboard: 'Open queue',
  'meeting-prep': 'Open prep',
  todos: 'Open tasks',
  standup: 'Open standup',
  inbox: 'Open inbox',
  imports: 'Open imports',
  // Briefing merged into Now (Build 10E); a card routed there opens Now.
  today: 'Open Now',
  chat: 'Open chat',
};

const LABELS = {
  open: 'Open context',
  acknowledge: 'Seen it',
  start: 'Start this',
  complete: 'Done',
  dismiss: 'Not relevant',
  due: 'Move due date',
};

// How long each deferral lasts — a deferral with no end is a dismissal in disguise.
const NOT_NOW_MINUTES = 120;
const WAITING_MINUTES = 24 * 60;

/**
 * "Open" on a card about ONE task opens THAT task, not the list (Nick, 2 Oct
 * 2026). Returns null when there is nothing to pin. PURE.
 */
export function taskDestination(card) {
  const meta = (card && card.meta) || {};
  if (card.type === 'todo' && meta.owner) {
    const ctx = { taskText: card.title || null };
    if (meta.owner.taskId != null) ctx.taskId = meta.owner.taskId;
    if (meta.owner.msId != null) ctx.msId = meta.owner.msId;
    return { view: 'todos', context: ctx, label: 'Open task' };
  }
  // A capacity card about ONE task opens that task's workflow screen — its wording, source,
  // context and "Do this" — not State of Play, which is another list (6 Nov 2026).
  if (card.type === 'capacity' && meta.taskId != null) {
    return { view: 'task', context: { taskId: meta.taskId }, label: 'Open task' };
  }
  if (card.type === 'meeting' && Array.isArray(meta.blockTaskIds) && meta.blockTaskIds.length) {
    return { view: 'todos', context: { taskId: meta.blockTaskIds[0] }, label: 'Open task' };
  }
  return null;
}

/** Where a card goes, and what its button says. PURE. */
export function cardDestination(card) {
  if (!card) return null;
  return taskDestination(card)
    || resolveNueroNavigation({ type: card.type, meta: card.meta, id: card.id })
    || (card.tab ? { view: card.tab } : null);
}

export function openLabelFor(destination) {
  return (destination && destination.label) || (destination && VIEW_LABELS[destination.view]) || LABELS.open;
}

/**
 * The ONE task whose due date this card may move, or null. PURE.
 * Only an id the server gave: a todo card's owner, or a capacity card's
 * `meta.taskId`. A summary card ("3 tasks with no date") names none.
 */
export function dueTargetOf(card) {
  const meta = (card && card.meta) || {};
  const owner = meta.owner || null;
  if (owner && owner.taskId != null) return { kind: 'neuro', taskId: Number(owner.taskId) };
  if (owner && owner.msId) return { kind: 'microsoft', msId: String(owner.msId) };
  if (card && card.type === 'capacity' && meta.taskId != null && Number.isFinite(Number(meta.taskId))) {
    return { kind: 'neuro', taskId: Number(meta.taskId) };
  }
  return null;
}

/** "Mon 9 Nov" from a YYYY-MM-DD key — sliced, never shifted a day by a zone. */
export function dueLabel(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''));
  if (!m) return String(dateStr || '');
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}

/** Write the new due date through the task's own edit route. Returns {ok, why}. */
export async function moveDue(call, target, dateStr) {
  if (!call || !target) return { ok: false, why: 'This screen can’t move a due date.' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr || ''))) return { ok: false, why: 'Pick a date first.' };
  const r = target.kind === 'neuro'
    ? await call(`/api/tasks/${target.taskId}`, { method: 'PATCH', body: { due_date: dateStr } })
    : await call(`/api/todos/ms/${encodeURIComponent(target.msId)}`, { method: 'PATCH', body: { dueDate: dateStr } });
  if (r && r.status >= 200 && r.status < 300 && !(r.body && r.body.ok === false)) return { ok: true };
  return { ok: false, why: (r && r.body && (r.body.error || r.body.why)) || `NEURO refused it (${r ? r.status : 'no answer'}).` };
}

/** The due-date choices (presets + a day picker). Shared by the card and the Needs-you row. */
function DuePicker({ disabled, onPick }) {
  const presets = duePresets(new Date());
  return (
    <div className="att-card__due" role="group" aria-label="Move the due date">
      <span className="att-card__due-label">Due</span>
      {presets.map((p) => (
        <button key={p.id} type="button" className="att-card__btn" disabled={disabled} onClick={() => onPick(p.date)}>
          {p.label} <span className="att-card__btn--quiet">· {dueLabel(p.date)}</span>
        </button>
      ))}
      <input
        type="date"
        className="att-card__due-pick"
        min={toDateStr(new Date())}
        aria-label="Pick a day"
        disabled={disabled}
        onChange={(e) => { if (e.target.value) onPick(e.target.value); }}
      />
    </div>
  );
}

/**
 * The Needs-you row's own answers — open it, and ONE way to answer it ("Done"
 * where it is a task, "Seen it" otherwise). The same on every surface.
 * With `call`, a row naming ONE task also offers "Move due date" (6 Nov 2026,
 * Nick: an overdue task on Needs you could not be re-dated where it was shown).
 */
export function NeedsYouActs({ card, onOpen = null, onAct = null, call = null, onChanged = null }) {
  const [note, setNote] = useState(null);
  const [busy, setBusy] = useState(false);
  const [dueOpen, setDueOpen] = useState(false);
  if (!card) return null;
  const acts = card.actions || [];
  const done = card.type === 'todo' && acts.includes('complete');
  const answer = !onAct ? null : done ? 'complete' : acts.includes('acknowledge') && card.state !== 'acknowledged' ? 'acknowledge' : null;
  const destination = cardDestination(card);
  const dueTarget = call ? dueTargetOf(card) : null;
  if (!onOpen && !answer && !dueTarget) return null;
  const press = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await onAct(card, answer);
      if (r && r.ok === false) setNote({ error: true, text: r.why || r.error || 'That did not go through.' });
      else setNote(null);
    } catch (e) { setNote({ error: true, text: e.message }); }
    setBusy(false);
  };
  const redate = async (dateStr) => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await moveDue(call, dueTarget, dateStr);
      if (!r.ok) setNote({ error: true, text: r.why });
      else {
        setDueOpen(false);
        setNote({ error: false, text: `Due date moved to ${dueLabel(dateStr)}.` });
        onChanged?.(card);
      }
    } catch (e) { setNote({ error: true, text: e.message }); }
    setBusy(false);
  };
  return (
    <>
      <div className="att-needs">
        {onOpen && (
          <button type="button" className="att-card__btn" onClick={() => { if (onOpen(card, destination) === false) setNote({ error: true, text: 'Nothing to open for this one.' }); }}>
            {openLabelFor(destination)}
          </button>
        )}
        {answer && (
          <button type="button" className={`att-card__btn${done ? ' att-card__btn--do' : ''}`} disabled={busy} onClick={press}>
            {busy ? '…' : done ? LABELS.complete : LABELS.acknowledge}
          </button>
        )}
        {dueTarget && (
          <button type="button" className="att-card__btn" aria-expanded={dueOpen} onClick={() => setDueOpen(!dueOpen)}>
            {LABELS.due}
          </button>
        )}
      </div>
      {dueTarget && dueOpen && <DuePicker disabled={busy} onPick={redate} />}
      {note && <p className={`att-needs__note${note.error ? ' att-needs__note--error' : ''}`}>{note.text}</p>}
    </>
  );
}

export default function AttentionCard({
  card,
  onOpen = null,
  onAct = null,
  call = null,
  onStarted = null,
  onChanged = null,
  compact = false,
  showEvidence = true,
}) {
  const [busy, setBusy] = useState(null);
  const [rawOutcome, setRawOutcome] = useState(null);
  const [rawDue, setRawDue] = useState(null);

  if (!card) return null;

  // A message belongs to the card it was about. React reuses this component when
  // the next item takes the slot, so an unscoped message carried over onto the
  // new card until a refresh (23 Oct 2026).
  const cardKey = card.recordId || card.id || card.title;
  const outcome = rawOutcome && rawOutcome.cardKey === cardKey ? rawOutcome : null;
  const setOutcome = (o) => setRawOutcome(o ? { ...o, cardKey } : null);
  const dueOpen = rawDue && rawDue.cardKey === cardKey;
  const setDueOpen = (v) => setRawDue(v ? { cardKey, pick: '' } : null);

  const actions = Array.isArray(card.actions) ? card.actions : [];
  // A card with no record has no canonical action set; it gets the ones that
  // need no record (and onAct refuses the rest in words).
  const permitted = card.recordId ? actions : ['open', 'dismiss', 'defer'];
  const canAct = Boolean(onAct);
  const dueTarget = call ? dueTargetOf(card) : null;

  const run = async (key, fn) => {
    if (busy) return;
    setBusy(key);
    try {
      const result = await fn();
      if (result && result.ok === false) {
        setOutcome({ kind: 'error', text: result.why || result.error || 'That did not go through.' });
      } else if (result && result.text) {
        setOutcome({ kind: 'ok', text: result.text });
      } else {
        setOutcome(null);
      }
    } catch (e) {
      setOutcome({ kind: 'error', text: e.message });
    }
    setBusy(null);
  };

  // Where this card goes, resolved once so the LABEL and the click cannot
  // disagree about it.
  const destination = cardDestination(card);
  const openLabel = openLabelFor(destination);

  // Navigation only. No request, by design — see the header.
  const open = () => {
    if (onOpen?.(card, destination) === false) setOutcome({ kind: 'error', text: 'Nothing to open for this one.' });
  };

  const start = () => run('start', async () => {
    const body = { text: card.title, source: 'attention' };
    const res = await call('/api/session/start', { method: 'POST', body });
    // 409 is "you're already on something" — a question, not a failure. Nothing
    // is switched without Nick saying so.
    if (res.status === 409 && res.body && res.body.session) {
      const s = res.body.session;
      const ok = typeof window !== 'undefined' && window.confirm(
        `You're ${s.elapsedMinutes} minutes into "${s.text}".\n\nPark it and start this instead?`
      );
      if (!ok) return { ok: true, text: null };
      const forced = await call('/api/session/start', { method: 'POST', body: { ...body, force: true } });
      if (!(forced.status >= 200 && forced.status < 300)) return { ok: false, why: 'Could not start that session.' };
    } else if (!(res.status >= 200 && res.status < 300)) {
      return { ok: false, why: (res.body && res.body.error) || 'Could not start that session.' };
    }
    // Told, not moved: the record stays where it was.
    if (card.recordId) await onAct?.(card, 'start');
    onStarted?.(card);
    return { ok: true, text: 'Session started. The record is untouched.' };
  });

  const done = () => run('complete', async () => {
    const result = await onAct?.(card, 'complete');
    if (!result || result.ok === false) return result || { ok: false, why: 'Nothing handled that.' };
    // ⚠ Three outcomes, not two. If the work is still open, say so — the honest
    // sentence is what stops Nick pressing it a fifth time (7 Sep 2026: four
    // resolved records for one Microsoft task in three days).
    const text = result.taskCompleted === true
      ? `Done. ${result.taskWhy || 'Task closed too.'}`
      : result.handled === true
        ? `Done — ${result.taskWhy || 'off your list'}.`
        : `Nothing was closed — ${result.taskWhy || 'no task matched this card'}. It will come back until the work is closed where it lives.`;
    return { ok: true, text };
  });

  const defer = (reason, minutes, label) => run(reason, async () => {
    const result = await onAct?.(card, 'defer', { reason, minutes });
    if (!result || result.ok === false) return result || { ok: false, why: 'Nothing handled that.' };
    return { ok: true, text: label };
  });

  const acknowledge = () => run('acknowledge', async () => {
    const result = await onAct?.(card, 'acknowledge');
    if (!result || result.ok === false) return result || { ok: false, why: 'Nothing handled that.' };
    return { ok: true, text: 'Noted. It stays here, but it will not interrupt again.' };
  });

  const dismiss = () => run('dismiss', async () => {
    const result = await onAct?.(card, 'dismiss');
    if (!result || result.ok === false) return result || { ok: false, why: 'Nothing handled that.' };
    return { ok: true, text: 'Marked not relevant. The work itself is untouched.' };
  });

  const redate = (dateStr) => run('due', async () => {
    const r = await moveDue(call, dueTarget, dateStr);
    if (!r.ok) return r;
    setDueOpen(false);
    onChanged?.(card);
    return { ok: true, text: `Due date moved to ${dueLabel(dateStr)}.` };
  });

  return (
    <article className={`att-card att-card--${card.urgency || 'none'}${compact ? ' att-card--compact' : ''}`}>
      <header className="att-card__head">
        <span className="att-card__type">{String(card.type || 'item').replace(/_/g, ' ')}</span>
        {card.state && card.state !== 'active' && (
          /* The lifecycle state is rendered, never re-derived. */
          <span className={`att-card__state att-card__state--${card.state}`}>{card.state}</span>
        )}
        {!card.recordId && (
          <span className="att-card__state att-card__state--nolifecycle" title="No canonical attention record — this card cannot be acted on">
            no record
          </span>
        )}
      </header>

      <h3 className="att-card__title">{card.title}</h3>
      {/* `say` is SAiM's sentence, composed server-side; `reason` the fallback. */}
      <p className="att-card__say">{card.say || card.reason}</p>

      {/* What the task IS, why, and where it came from — composed server-side (6 Nov 2026). */}
      {Array.isArray(card.meta && card.meta.detail) && card.meta.detail.length > 0 && (
        <details className="att-card__detail">
          <summary>What this is</summary>
          <dl>
            {card.meta.detail.map((d) => (
              <div key={d.label} className="att-card__detail-row"><dt>{d.label}</dt><dd>{d.text}</dd></div>
            ))}
          </dl>
        </details>
      )}

      {showEvidence && Array.isArray(card.evidence) && card.evidence.length > 0 && (
        <ul className="att-card__evidence">
          {card.evidence.slice(0, 3).map((e, i) => (
            <li key={i}>
              <span className="att-card__evsrc">{e.source}</span>
              <span className="att-card__evref">{e.ref}</span>
              {e.detail && <span className="att-card__evdetail">{e.detail}</span>}
            </li>
          ))}
        </ul>
      )}

      {outcome && (
        <p className={`att-card__outcome att-card__outcome--${outcome.kind}`}>{outcome.text}</p>
      )}

      {/* Already being worked on — and what it was cut down to. */}
      {card.session && (
        <p className="att-card__session">
          In progress — {card.session.elapsedMinutes} min
          {card.session.nextStep ? <> · on “{card.session.nextStep}”</> : null}
          {card.session.status !== 'active' ? ` · ${card.session.status}` : ''}
        </p>
      )}

      <div className="att-card__actions">
        {onOpen && permitted.includes('open') && (
          <button className="att-card__btn" type="button" onClick={open}>{openLabel}</button>
        )}
        {canAct && permitted.includes('acknowledge') && card.state !== 'acknowledged' && (
          <button className="att-card__btn" type="button" disabled={busy === 'acknowledge'} onClick={acknowledge}>
            {busy === 'acknowledge' ? '…' : LABELS.acknowledge}
          </button>
        )}
        {canAct && call && permitted.includes('start') && (
          <button className="att-card__btn att-card__btn--do" type="button" disabled={busy === 'start'} onClick={start}>
            {busy === 'start' ? '…' : LABELS.start}
          </button>
        )}
        {canAct && permitted.includes('complete') && (
          <button className="att-card__btn att-card__btn--do" type="button" disabled={busy === 'complete'} onClick={done}>
            {busy === 'complete' ? '…' : LABELS.complete}
          </button>
        )}
        {canAct && permitted.includes('defer') && (
          <>
            <button className="att-card__btn" type="button" disabled={busy === 'not-now'} onClick={() => defer('not-now', NOT_NOW_MINUTES, 'Put off for now.')}>
              Not now
            </button>
            <button className="att-card__btn" type="button" disabled={busy === 'waiting-on-someone'} onClick={() => defer('waiting-on-someone', WAITING_MINUTES, 'Noted as waiting on someone else.')}>
              Waiting on someone
            </button>
          </>
        )}
        {dueTarget && (
          <button className="att-card__btn" type="button" aria-expanded={dueOpen} onClick={() => setDueOpen(!dueOpen)}>
            {LABELS.due}
          </button>
        )}
        {canAct && permitted.includes('dismiss') && (
          <button className="att-card__btn att-card__btn--quiet" type="button" disabled={busy === 'dismiss'} onClick={dismiss}>
            {LABELS.dismiss}
          </button>
        )}
      </div>

      {dueTarget && dueOpen && <DuePicker disabled={busy === 'due'} onPick={redate} />}
    </article>
  );
}
