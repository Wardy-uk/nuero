// One Next steps row (7 Nov 2026, audit F7/F8/D) — the SAME component on NEURO
// desktop's Next steps page and SAiM's Next steps tab, so the two cannot drift.
//
// Every button does what it says, here, and says what happened:
//   • a task's Start starts a focus session on THAT task (another one running is
//     parked straight away, with "Resume it" beside it); Done ticks it and shows
//     NEURO's own answer (repeats, Microsoft, refused);
//   • Book proposes a slot in place, and one press prepares + sends the invite
//     through the governed path (intent grant, same as everywhere else);
//   • the drafts row opens to the waiting drafts, each with its own Send;
//   • Not today asks why, in the ONE wording every surface uses.
//
// The shell supplies the transport (`call` → {status, body}), where "Open" goes,
// and the calendar form. Nothing here ranks or decides who may send — the
// server re-reads everything by id and checks every grant.

import { useEffect, useRef, useState } from 'react';
import { NOT_TODAY_REASONS } from './notTodayReasons.mjs';
import { sendPrepared, sendOutcome } from './sendPrepared.mjs';
import { startTaskSession, resumeParked as resumeParkedTask, parkedLine, startSmallestStep } from './startTask.mjs';
import './NextStepRow.css';

export const KIND_LABEL = Object.freeze({
  email: 'EMAIL', report: 'REPORT', drafts: 'DRAFTS', task: 'TASK', people: 'PEOPLE', calendar: 'CALENDAR',
  decision: 'DECISION', family: 'FAMILY', letter: 'LETTER', garden: 'GARDEN',
});

export const SNOOZES = Object.freeze([
  { label: '1 hour', minutes: 60 },
  { label: '3 hours', minutes: 180 },
  { label: 'Tomorrow', notToday: true },
  { label: 'Next week', minutes: 7 * 24 * 60 },
]);

export function untilLabel(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  return new Date(t).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
}

/** PURE. A stored snooze reason in the shared words, never the raw key. */
export function snoozeReasonWords(key) {
  if (!key || key === 'not-now' || key === 'unspecified') return null;
  const r = NOT_TODAY_REASONS.find((x) => x.key === key);
  return r ? r.label.toLowerCase() : String(key).replace(/-/g, ' ');
}

/** PURE. "Thu 12 Nov, 14:00–14:30" from a proposal's wall-clock start/end (sliced, never parsed into a Date). */
export function slotLine(p) {
  if (!p || !p.start) return '';
  const date = String(p.date || p.start).slice(0, 10);
  const [y, m, d] = date.split('-').map(Number);
  let day = date;
  if (y && m && d) {
    // A calendar date only: noon UTC can never slip a day in any zone.
    day = new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  }
  const t = (s) => String(s || '').slice(11, 16);
  return `${day}, ${t(p.start)}${p.end ? `–${t(p.end)}` : ''}`;
}

/**
 * PURE. What POST /api/tasks/:id/complete actually did, in one honest line.
 * `keep` = the row should stay (nothing closed, or it repeats).
 */
export function doneOutcome(r) {
  const status = r && r.status;
  const b = (r && r.body) || {};
  if (!r) return { tone: 'bad', text: 'NEURO didn’t answer — nothing was ticked.', keep: true };
  if (status === 404) return { tone: 'bad', text: 'That task isn’t in NEURO any more — nothing was ticked.', keep: true };
  if (status >= 400 || b.ok === false || b.error) return { tone: 'bad', text: `Not ticked — ${b.error || `NEURO answered ${status}`}`, keep: true };
  if (b.recurred) {
    const rc = b.recurred;
    return { tone: 'ok', text: rc.notice || `Done — it repeats${rc.nextDue ? `; next due ${rc.nextDue}` : ''}.`, keep: true };
  }
  const task = b.task || {};
  if (task.status && task.status !== 'done') return { tone: 'warn', text: `NEURO has it as ${task.status}, not done.`, keep: true };
  const ms = b.msPush;
  if (ms && !ms.completed) {
    return { tone: 'warn', text: `Done in NEURO. Microsoft didn’t take it${ms.reason ? ` (${ms.reason})` : ''}${ms.held ? ' — NEURO will keep trying' : ''}.`, keep: false };
  }
  if (ms && ms.completed) return { tone: 'ok', text: 'Done — ticked in Microsoft too.', keep: false };
  return { tone: 'ok', text: 'Done — ticked off.', keep: false };
}

/** PURE. The focus line after a start. */
export function startedLine(session, text, already = false) {
  if (already) return `You’re already on “${text}” — the focus clock is running.`;
  const mins = session && session.plannedMinutes;
  const size = mins ? ` — ${mins} min${session.plannedAssumed ? ' (assumed)' : ''}` : '';
  return `Focus started on “${text}”${size}.`;
}

const _safe = async (call, path, opts) => {
  if (!call) return { status: 0, body: { ok: false, error: 'This screen can’t reach NEURO.' } };
  try { return await call(path, opts); } catch { return { status: 0, body: { ok: false, error: 'No answer from NEURO.' } }; }
};

/**
 * Start a focus session on a task. Another session running is parked straight
 * away by startTaskSession (no question — 7 Nov 2026) and named, so "Resume it"
 * can put it back. `resume` = the parked task going back in focus.
 * → { ok, already?, session?, parked: {taskId, text, elapsedMinutes} | null, error? }
 */
export async function startOnTask(call, target, { resume = false } = {}) {
  const r = resume
    ? await resumeParkedTask(call, target, { source: 'manual' })
    : await startTaskSession(call, { taskId: target.taskId, text: target.text, source: 'manual' });
  if (!r || !r.ok) return { ok: false, parked: null, error: (r && r.error) || 'No focus session was started.' };
  return { ok: true, already: !!r.already, session: r.session || null, parked: r.parked || null };
}

/** "It's too big": 15 minutes on the smallest first step he names. → { ok, text, tone, parked } */
export async function startSmallest(call, { taskId, text, step }) {
  const r = await startSmallestStep(call, { taskId, text, step, source: 'manual' });
  if (!r || !r.ok) return { ok: false, tone: 'bad', text: (r && r.error) || 'Nothing was started.', parked: null };
  if (r.error) return { ok: true, tone: 'warn', text: r.error, parked: r.parked || null };
  return { ok: true, tone: 'ok', text: `15 minutes on “${r.step}” — started.`, parked: r.parked || null };
}

/**
 * Prepare the 1-2-1 invite through the governed path (POST /api/1to1/book) and
 * send it with one press (sendPrepared). → { sent, tone, text }
 */
export async function bookAndSend(call, { person, proposal, surface = 'neuro-web' }) {
  const p = proposal || {};
  if (!p.attendee || !p.attendee.email) return { sent: false, tone: 'bad', text: `No email address for ${person} — add it to their People note. Nothing was sent.` };
  const r = await _safe(call, '/api/1to1/book', { method: 'POST', body: { person, start: p.start, end: p.end, email: p.attendee.email, subject: p.subject, durationMinutes: p.durationMinutes } });
  const b = (r && r.body) || {};
  if (!b.ok || !b.action) return { sent: false, tone: 'bad', text: `Not booked — ${b.error || 'nothing was prepared'}` };
  const x = await sendPrepared(call, b.action, { surface });
  const o = sendOutcome(x);
  const sent = !!(x.ok && (x.executed || x.status === 'verified' || x.status === 'executed'));
  return { sent, tone: o.tone, text: sent ? `Invite sent for ${slotLine(p)}. ${o.text}` : o.text };
}

/** Send one waiting draft. → { sent, tone, text } */
export async function sendDraftNow(call, draft, surface = 'neuro-web') {
  const x = await sendPrepared(call, draft, { surface });
  const o = sendOutcome(x);
  return { sent: !!(x.ok && (x.executed || x.status === 'verified' || x.status === 'executed')), tone: o.tone, text: o.text };
}

export default function NextStepRow({
  item,
  highlighted = false,
  snoozed = false,
  call = null,
  surface = 'neuro-web',
  onOpen = () => {},
  onOpenTask = null,
  onChanged = () => {},
  renderCalendar = null,
}) {
  const [menu, setMenu] = useState(null); // snooze | nottoday | calendar | book | drafts
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [note, setNote] = useState(null); // { tone, text }
  const [parked, setParked] = useState(null); // { taskId, text } — the session a Start pushed aside
  const [focusOn, setFocusOn] = useState(null); // taskId the last start put the clock on
  const [book, setBook] = useState(null); // { loading } | { proposal } | { error }
  const [draftNote, setDraftNote] = useState({}); // actionId → { tone, text }
  const [sentIds, setSentIds] = useState(() => new Set());
  const [openPreview, setOpenPreview] = useState(null);
  const [stepText, setStepText] = useState(''); // "It's too big" → the smallest first step
  const later = useRef(null);
  useEffect(() => () => { if (later.current) clearTimeout(later.current); }, []);

  const start = item.start || {};
  const task = item.task || null;
  const refreshSoon = (ms = 2200) => {
    if (later.current) clearTimeout(later.current);
    later.current = setTimeout(() => { later.current = null; onChanged(); }, ms);
  };

  const post = async (path, body) => {
    if (!call) return { status: 0, body: { ok: false, error: 'This screen can’t reach NEURO.' } };
    try { return await call(path, { method: 'POST', body }); } catch { return { status: 0, body: { ok: false, error: 'No answer from NEURO.' } }; }
  };

  const nextStepsCall = async (path, body, fallback) => {
    setBusy(true); setErr('');
    const r = await post(path, { id: item.id, ...body });
    setBusy(false); setMenu(null);
    if (r.body && r.body.ok) onChanged(); else setErr((r.body && r.body.error) || fallback);
  };

  // ── Start: a focus session on this task ────────────────────────────────────
  const startFocus = async (target, opts) => {
    setBusy(true); setErr(''); setNote(null);
    const r = await startOnTask(call, target, opts);
    setBusy(false);
    if (!r.ok) { setErr(r.error); return; }
    setFocusOn(target.taskId);
    setParked(r.parked);
    setNote({ tone: 'ok', text: startedLine(r.session, target.text, r.already) });
  };

  const resumeParked = () => {
    const back = parked;
    if (!back) return;
    // The row's own task becomes the parked one, so the way back is still here.
    startFocus(back, { resume: true });
  };

  // ── Too big: start the smallest first step instead of hiding the task ──────
  const startStep = async () => {
    setBusy(true); setErr(''); setNote(null);
    const r = await startSmallest(call, { taskId: task.taskId, text: task.text || item.title, step: stepText });
    setBusy(false);
    if (!r.ok) { setErr(r.text); return; }
    setMenu(null); setStepText('');
    setFocusOn(task.taskId);
    setParked(r.parked);
    setNote({ tone: r.tone, text: r.text });
  };

  // ── Done: tick the NEURO task ──────────────────────────────────────────────
  const done = async () => {
    if (!task || !task.taskId) return;
    setBusy(true); setErr(''); setNote(null);
    const r = await post(`/api/tasks/${encodeURIComponent(task.taskId)}/complete`, {});
    setBusy(false);
    const o = doneOutcome(r);
    setNote(o);
    if (o.tone !== 'bad') refreshSoon();
  };

  // ── Book: propose in place, one press sends ────────────────────────────────
  const person = item.oneToOne && item.oneToOne.person;
  const openBook = async () => {
    if (menu === 'book') { setMenu(null); return; }
    setMenu('book');
    if (!person) { setBook({ error: 'This row doesn’t say who the 1-2-1 is with.' }); return; }
    setBook({ loading: true });
    const r = await post('/api/1to1/propose', { person });
    const b = r.body || {};
    if (b.ok) setBook({ proposal: b });
    else setBook({ error: b.error || 'NEURO couldn’t find a slot.' });
  };
  const confirmBook = async () => {
    const p = book && book.proposal;
    if (!p) return;
    setBusy(true);
    const r = await bookAndSend(call, { person, proposal: p, surface });
    setBusy(false);
    setBook({ ...book, sent: r.sent, sendNote: { tone: r.tone, text: r.text } });
    if (r.sent) refreshSoon(3500);
  };

  // ── Drafts: send each in place ─────────────────────────────────────────────
  const drafts = Array.isArray(item.drafts) ? item.drafts : [];
  const sendDraft = async (d) => {
    setBusy(true);
    const r = await sendDraftNow(call, d, surface);
    setBusy(false);
    setDraftNote((n) => ({ ...n, [d.actionId]: { tone: r.tone, text: r.text } }));
    if (r.sent) {
      const nextSent = new Set(sentIds); nextSent.add(d.actionId); setSentIds(nextSent);
      if (drafts.filter((y) => y.canSend).every((y) => nextSent.has(y.actionId))) refreshSoon(3500);
    }
  };

  // ── The primary button ─────────────────────────────────────────────────────
  const primary = () => {
    const a = start.action;
    if (a === 'focus' && task) { startFocus({ taskId: task.taskId, text: task.text || item.title }); return; }
    if (a === 'book-121') { openBook(); return; }
    if (a === 'drafts') { setMenu(menu === 'drafts' ? null : 'drafts'); return; }
    if (a === 'add-to-calendar') { setMenu(menu === 'calendar' ? null : 'calendar'); return; }
    if (a === 'caught-up' || a === 'done-for-now') { nextStepsCall('/api/next-steps/act', { action: a }, 'NEURO did not take that.'); return; }
    onOpen(item);
  };

  const reasonWords = snoozeReasonWords(item.snoozeReason);
  const openActions = () => onOpen({ ...item, start: { label: 'Open in Actions', view: 'actions', context: null } });

  return (
    <li className={`ns-row${highlighted ? ' is-highlighted' : ''}${item.group === 'now' && !snoozed ? ' is-now' : ''}`} id={`ns-${item.id}`} data-item-id={item.id}>
      <div className="ns-row-main">
        <div className="ns-row-head">
          <span className={`ns-kind ns-kind-${item.kind}`}>{KIND_LABEL[item.kind] || String(item.kind || '').toUpperCase()}</span>
          {item.minutes != null && !snoozed && <span className="ns-mins">{item.minutes} min</span>}
        </div>
        <div className="ns-text">
          <span className="ns-title">{item.title}</span>
          <span className="ns-why">
            {snoozed ? `Snoozed until ${untilLabel(item.snoozedUntil)}${reasonWords ? ` · ${reasonWords}` : ''}` : item.why}
          </span>
        </div>
        <div className="ns-actions">
          {snoozed ? (
            <button type="button" className="ns-btn ns-btn-secondary" disabled={busy} onClick={() => nextStepsCall('/api/next-steps/undefer', {}, 'Could not bring it back.')}>{busy ? '…' : 'Bring it back'}</button>
          ) : (
            <>
              <button type="button" className="ns-btn ns-btn-primary" disabled={busy} aria-expanded={['book', 'drafts', 'calendar'].includes(menu) ? true : undefined} onClick={primary}>
                {busy && start.action === 'focus' ? 'Starting…' : (start.label || 'Start')}
              </button>
              {task && task.canComplete && (
                <button type="button" className="ns-btn ns-btn-secondary" disabled={busy} onClick={done}>Done</button>
              )}
              {start.secondary === 'done-for-now' && (
                <button type="button" className="ns-btn ns-btn-secondary" disabled={busy} onClick={() => nextStepsCall('/api/next-steps/act', { action: 'done-for-now' }, 'Not done.')}>Done for now</button>
              )}
              <button type="button" className="ns-btn ns-btn-secondary" aria-expanded={menu === 'snooze'} disabled={busy} onClick={() => setMenu(menu === 'snooze' ? null : 'snooze')}>Snooze ▾</button>
              <button type="button" className="ns-btn ns-btn-quiet" aria-expanded={menu === 'nottoday'} disabled={busy} onClick={() => setMenu(menu === 'nottoday' ? null : 'nottoday')}>Not today</button>
              {task && start.view && (
                <button type="button" className="ns-btn ns-btn-quiet" disabled={busy} onClick={() => onOpen(item)}>Open</button>
              )}
            </>
          )}
        </div>
      </div>

      {note && (
        <div className={`ns-note ns-note--${note.tone}`} role="status">
          {note.text}
          {focusOn != null && onOpenTask && note.tone === 'ok' && start.action === 'focus' && (
            <button type="button" className="ns-chip" onClick={() => onOpenTask(focusOn)}>Open the task</button>
          )}
        </div>
      )}
      {parked && (
        <div className="ns-note ns-note--parked" role="status">
          {parkedLine(parked)}
          <button type="button" className="ns-chip" disabled={busy} onClick={resumeParked}>Resume it</button>
        </div>
      )}

      {menu === 'calendar' && (renderCalendar
        ? renderCalendar({ item, onClose: () => { setMenu(null); onChanged(); }, onAdded: onChanged })
        : <div className="ns-err">This screen can’t add to a calendar.</div>)}

      {menu === 'book' && book && (
        <div className="ns-panel" aria-label={`Book ${person || ''}'s 1-2-1`}>
          {book.loading && <span className="ns-why">Finding a free slot…</span>}
          {book.error && (
            <div className="ns-panel-row">
              <span className="ns-note ns-note--bad">No slot found — {book.error}</span>
              <button type="button" className="ns-chip" onClick={() => onOpen(item)}>Book it from People</button>
            </div>
          )}
          {book.proposal && (
            <>
              <div className="ns-panel-row">
                <span className="ns-slot">{slotLine(book.proposal)} with {person}</span>
                {!book.sent && (
                  <button type="button" className="ns-btn ns-btn-primary" disabled={busy} onClick={confirmBook}>{busy ? 'Sending…' : 'Book and send the invite'}</button>
                )}
              </div>
              {book.proposal.awayCheck === 'unknown' && <span className="ns-why">{book.proposal.awayNote || 'Leave not checked for this date.'}</span>}
              {book.proposal.attendee && !book.proposal.attendee.email && (
                <span className="ns-note ns-note--bad">No email address for {person} — add it to their People note first.</span>
              )}
              {book.sendNote && <span className={`ns-note ns-note--${book.sendNote.tone}`}>{book.sendNote.text}</span>}
              {!book.sent && <button type="button" className="ns-chip" onClick={() => onOpen(item)}>Pick another time in People</button>}
            </>
          )}
        </div>
      )}

      {menu === 'drafts' && (
        <div className="ns-panel" aria-label="Drafts waiting">
          {drafts.length === 0 && <span className="ns-why">NEURO couldn’t list them here.</span>}
          <ul className="ns-drafts">
            {drafts.map((d) => {
              const dn = draftNote[d.actionId];
              const sent = sentIds.has(d.actionId);
              return (
                <li key={d.actionId} className="ns-draft">
                  <div className="ns-draft-text">
                    <span className="ns-draft-subject">{d.subject}</span>
                    <span className="ns-why">
                      {[d.to && d.to.length ? `To ${d.to.join(', ')}${d.toMore ? ` +${d.toMore}` : ''}` : null, d.when, d.from ? `from ${d.from}` : null].filter(Boolean).join(' · ')}
                    </span>
                    {openPreview === d.actionId && d.preview && <span className="ns-draft-preview">{d.preview}</span>}
                  </div>
                  <div className="ns-draft-actions">
                    {d.preview && (
                      <button type="button" className="ns-chip" onClick={() => setOpenPreview(openPreview === d.actionId ? null : d.actionId)}>
                        {openPreview === d.actionId ? 'Hide' : 'Read it'}
                      </button>
                    )}
                    {d.canSend && !sent && (
                      <button type="button" className="ns-btn ns-btn-primary" disabled={busy} onClick={() => sendDraft(d)}>Send</button>
                    )}
                    {!d.canSend && <span className="ns-why">{d.status === 'execution_uncertain' ? 'Not sure it went — check it in Actions.' : d.status === 'failed' ? 'Failed — retry it in Actions.' : 'Needs Actions.'}</span>}
                  </div>
                  {dn && <span className={`ns-note ns-note--${dn.tone}`}>{dn.text}</span>}
                </li>
              );
            })}
          </ul>
          {item.draftsMore > 0 && <span className="ns-why">{item.draftsMore} more in Actions.</span>}
          <button type="button" className="ns-chip" onClick={openActions}>Open in Actions</button>
        </div>
      )}

      {menu === 'snooze' && (
        <div className="ns-menu" role="group" aria-label="Snooze for">
          {SNOOZES.map((s) => (
            <button type="button" key={s.label} className="ns-chip" disabled={busy}
              onClick={() => nextStepsCall('/api/next-steps/defer', s.notToday ? { notToday: true } : { minutes: s.minutes }, 'Not snoozed.')}>{s.label}</button>
          ))}
        </div>
      )}
      {menu === 'nottoday' && (
        <div className="ns-menu" role="group" aria-label="Why not today">
          <span className="ns-menu-label">Why? It comes back tomorrow morning.</span>
          {NOT_TODAY_REASONS.map((r) => (
            <button type="button" key={r.key} className="ns-chip" title={r.desc} disabled={busy}
              onClick={() => (r.key === 'too-big' && task
                ? setMenu('toobig')
                : nextStepsCall('/api/next-steps/defer', { notToday: true, reason: r.key }, 'Not snoozed.'))}>{r.label}</button>
          ))}
        </div>
      )}
      {menu === 'toobig' && task && (
        <div className="ns-panel" aria-label="Smallest first step">
          <label className="ns-menu-label" htmlFor={`ns-step-${item.id}`}>What’s the smallest first step? NEURO starts 15 minutes on just that.</label>
          <div className="ns-panel-row">
            <input id={`ns-step-${item.id}`} className="ns-step-input" value={stepText} maxLength={200}
              placeholder="e.g. open the file and write the first line"
              onChange={(e) => setStepText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && stepText.trim()) startStep(); }} />
            <button type="button" className="ns-btn ns-btn-primary" disabled={busy || !stepText.trim()} onClick={startStep}>Start 15 min</button>
          </div>
          <button type="button" className="ns-chip" disabled={busy}
            onClick={() => nextStepsCall('/api/next-steps/defer', { notToday: true, reason: 'too-big' }, 'Not snoozed.')}>Not today anyway</button>
        </div>
      )}
      {err && <div className="ns-err">{err}</div>}
    </li>
  );
}
