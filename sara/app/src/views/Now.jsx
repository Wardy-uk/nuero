import { useCallback, useEffect, useState } from 'react';
import { useNickNow, stampFor } from '../mobile/useNickNow';
import { apiFetch } from '../api';
import Readiness from '../../../shared-ui/Readiness.jsx';
import { enqueue, flush, outcomeFor, pending as pendingOps, subscribe } from '../mobile/outbox';
import Freshness from '../components/Freshness';
import './Now.css';

// NOW — one current action and the next transition.
//
// Everything on this screen is sourced and timestamped, because the whole screen
// may be a cached copy of a morning that has since moved on. The rules it holds
// to, all of them borrowed rather than reinvented:
//
//  • A section NEURO could not read says so. It is never rendered as empty.
//  • "The pool was unavailable" is NOT an all-clear, and gets those words.
//  • A quiet day is a correct answer, and reads as calm rather than broken.
//  • Nothing here re-derives what the brain already decided — `say`, the tab a
//    card routes to, the agenda's `scope` — because three surfaces phrasing one
//    fact three ways is how they drift.

// The words for a session write NEURO answered but declined. Several session
// routes refuse with `200 { ok:false, reason }` rather than an error status, so
// a bare apiFetch reads the refusal as success and the card goes on showing a
// session that no longer exists — a control that silently did nothing.
const SESSION_REFUSALS = {
  'no-session': 'There is no session running any more — it may have been closed from another screen.',
  'not-running': 'That session is not running, so there is nothing to check in on.',
  'session-closed': 'That session has already been closed.',
};

/** POST a session write; a refusal comes back as a thrown error, in words. */
async function sessionPost(path, body) {
  const result = await apiFetch(path, { method: 'POST', body: JSON.stringify(body || {}) });
  if (result && result.ok === false) {
    throw new Error(SESSION_REFUSALS[result.reason] || `NEURO did not do that (${result.reason || 'no reason given'}).`);
  }
  return result;
}

/**
 * The live focus session, with the controls that matter on a phone.
 *
 * ⚠ "Make it smaller" is the point of this card. Every other control answers
 * WHEN — pause, done, let it go — and Nick's difficulty is INITIATION, not
 * timing: anything that raises awareness without lowering the barrier is the
 * wrong shape. Shrinking is the only one here that lowers it, so it is the
 * first button and it is never phrased as giving up.
 *
 * Nothing on this card is scored. A session shrunk three times shows what it
 * shows; it is a finding about the work, not a mark against him.
 *
 * ⚠ Online-only, deliberately. These are not captures — they are edits to a
 * live session, and queueing them would mean replaying "shrink to X" against a
 * session that has since ended. The outbox is for things whose identity
 * survives sitting in a queue; this is not one of them.
 */
function SessionCard({ session, onChanged, onFinished }) {
  const [busy, setBusy] = useState(false);
  // 'shrink' | 'finish' | null — which follow-up box is open.
  const [asking, setAsking] = useState(null);
  const [step, setStep] = useState('');
  const [error, setError] = useState(null);

  async function post(path, body, after) {
    setBusy(true);
    setError(null);
    try {
      const result = await sessionPost(path, body);
      setAsking(null);
      setStep('');
      after?.(result);
      await onChanged?.();
    } catch (e) {
      // Say what failed and leave the card exactly as it was. A control that
      // silently does nothing is worse than one that refuses out loud.
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  const stuck = session.status === 'needs-smaller';
  const banked = session.status === 'paused' || session.status === 'interrupted' || stuck;

  return (
    <div className="card now__focus">
      <div className="now__focus-label">
        {stuck
          ? 'Stuck on how big this is'
          : session.status === 'interrupted'
            ? 'You were pulled off this'
            : session.status === 'paused'
              ? 'Paused'
              : 'In a focus session'}
        {session.stale ? ' — this one ran away, worth settling' : ''}
      </div>

      <div className="now__focus-text">{session.text || 'Untitled session'}</div>

      {/* The concrete physical step. This is what makes coming back thinkable:
          "the task" is a wall, a named action is a decision. */}
      {session.nextStep && <div className="now__next">Next: {session.nextStep}</div>}

      <div className="now__meta">
        {session.elapsedMinutes != null && `${session.elapsedMinutes}m in`}
        {session.plannedMinutes != null && ` of ${session.plannedMinutes}m`}
        {/* #87's rule: an assumed length must say it is assumed, every time —
            and saying so is now also the way to replace it. Offered AFTER
            starting only: a "how long?" in front of the clock is friction at
            exactly the moment starting is hardest. */}
        {asking !== 'estimate' && (
          <button
            type="button"
            className="now__est-link"
            disabled={busy}
            onClick={() => { setStep(''); setAsking('estimate'); }}
          >
            {session.plannedAssumed ? ' (assumed — set yours)' : ' · change'}
          </button>
        )}
        {/* Stated plainly, with no verdict attached. */}
        {session.shrinks > 0 && ` · made smaller ${session.shrinks}x`}
      </div>

      {asking === 'estimate' && (
        <div className="now__sess-shrink">
          <span className="now__sess-label">How long, all in?</span>
          <div className="now__sess-acts">
            {[15, 30, 45, 60, 90].map((m) => (
              <button
                key={m}
                type="button"
                className="now__sess-btn"
                aria-pressed={!session.plannedAssumed && session.plannedMinutes === m}
                disabled={busy}
                onClick={() => post('/api/session/estimate', { minutes: m })}
              >
                {m}m
              </button>
            ))}
          </div>
          <div className="now__sess-acts">
            <input
              className="now__sess-input now__est-input"
              type="number"
              min="1"
              inputMode="numeric"
              placeholder="or minutes"
              aria-label="Custom estimate in minutes"
              value={step}
              onChange={(e) => setStep(e.target.value)}
            />
            <button
              type="button"
              className="now__sess-btn now__sess-btn--go"
              disabled={busy || !(Number(step) > 0)}
              onClick={() => post('/api/session/estimate', { minutes: Number(step) })}
            >
              Set
            </button>
            <button type="button" className="now__sess-btn" disabled={busy} onClick={() => setAsking(null)}>
              Cancel
            </button>
          </div>
          {/* Said before he picks: this far in it is a reading, not a forecast. */}
          {session.elapsedMinutes > 5 && (
            <div className="now__meta">
              {session.elapsedMinutes}m in, so it’ll run the clock but won’t count as a forecast.
            </div>
          )}
        </div>
      )}

      {error && <div className="now__sess-err">{error}</div>}

      {/* ── The private body-double ─────────────────────────────────────────
          Shown only when it is actually due, and only on a RUNNING session.
          ⚠ It is a PULL: nothing pushed this, it is here because Nick already
          opened the screen. Saying "still here" records presence and touches
          nothing else — moving the estimate because he said hello would make
          the one honest number on this card dishonest. */}
      {session.dueCheckIn && !asking && (
        <div className="now__sess-checkin">
          <span className="now__sess-label">Still on this one?</span>
          <button
            type="button"
            className="now__sess-btn now__sess-btn--go"
            disabled={busy}
            onClick={() => post('/api/session/check-in')}
          >
            Still here
          </button>
        </div>
      )}

      {asking === 'finish' ? (
        <div className="now__sess-shrink">
          <label className="now__sess-label" htmlFor="now-reflect">
            Anything worth remembering about that? (optional)
          </label>
          <input
            id="now-reflect"
            className="now__sess-input"
            value={step}
            onChange={(e) => setStep(e.target.value)}
            placeholder="what made it easier, or harder"
            autoFocus
          />
          <div className="now__sess-acts">
            {/* ⚠ Finishing NEVER depends on the box. A field you have to fill in
                to close a session is a reason not to close sessions. */}
            <button
              type="button"
              className="now__sess-btn now__sess-btn--go"
              disabled={busy}
              onClick={() => post('/api/session/finish', { reflection: step.trim() || null }, onFinished)}
            >
              Finish
            </button>
            <button type="button" className="now__sess-btn" disabled={busy} onClick={() => setAsking(null)}>
              Cancel
            </button>
          </div>
        </div>
      ) : asking === 'shrink' ? (
        <div className="now__sess-shrink">
          <label className="now__sess-label" htmlFor="now-step">
            {stuck ? 'What is the smallest next bit of it?' : 'What is the smaller version?'}
          </label>
          <input
            id="now-step"
            className="now__sess-input"
            value={step}
            onChange={(e) => setStep(e.target.value)}
            placeholder="e.g. open the doc and write the first heading"
            autoFocus
          />
          <div className="now__sess-acts">
            <button
              type="button"
              className="now__sess-btn now__sess-btn--go"
              disabled={busy || !step.trim()}
              onClick={() => post('/api/session/shrink', { step: step.trim() })}
            >
              That is the step
            </button>
            <button type="button" className="now__sess-btn" disabled={busy} onClick={() => setAsking(null)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="now__sess-acts">
          {/* First, and first on purpose. */}
          <button type="button" className="now__sess-btn now__sess-btn--go" disabled={busy} onClick={() => { setStep(''); setAsking('shrink'); }}>
            Make it smaller
          </button>
          {banked ? (
            <button type="button" className="now__sess-btn" disabled={busy} onClick={() => post('/api/session/resume')}>
              Back to it
            </button>
          ) : (
            <>
              <button type="button" className="now__sess-btn" disabled={busy} onClick={() => post('/api/session/step-away')}>
                Stepping away
              </button>
              {/* ⚠ Not the same fact as stepping away. That one says he was
                  pulled off it; this one says "not now", which he chose. The
                  return prompt words the two differently, so they stay two
                  buttons rather than one "stop" that NEURO has to guess about. */}
              <button type="button" className="now__sess-btn" disabled={busy} onClick={() => post('/api/session/pause')}>
                Pause
              </button>
            </>
          )}
          <button type="button" className="now__sess-btn" disabled={busy} onClick={() => { setStep(''); setAsking('finish'); }}>
            Done
          </button>
          {/* Offered without ceremony. Letting something go is a legitimate
              outcome, and dressing it up as failure is how it stops being used. */}
          <button type="button" className="now__sess-btn" disabled={busy} onClick={() => post('/api/session/abandon')}>
            Let it go
          </button>
        </div>
      )}
      {/* Only offered where it is the honest answer: he has said it is too big
          and has not yet named the smaller thing. */}
      {stuck && !asking && (
        <div className="now__meta">No smaller step named yet — that is fine, it is the next thing to work out.</div>
      )}
    </div>
  );
}

/**
 * The way back (#89) — `recovery` from GET /api/session, rendered verbatim.
 *
 * The prompt and question are composed by `focus-session.recovery()`, not here:
 * the Surface, the desktop Now page and this screen must not phrase "you were
 * twenty minutes into X" three different ways.
 *
 * ⚠ "Make it smaller" is the FIRST option on every shape of this card, including
 * `settle`, whose server options do not list it. The moment he is looking at a
 * thing he walked away from is exactly when "this is too big" is the true
 * answer, and a menu without it pushes him to let it go instead.
 */
function ReturnCard({ recovery, onChanged, onFinished }) {
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(null); // 'shrink' | 'finish' | null
  const [text, setText] = useState('');
  const [error, setError] = useState(null);
  const session = recovery.session || {};
  const settle = recovery.kind === 'settle';

  async function post(path, body, after) {
    setBusy(true);
    setError(null);
    try {
      const result = await sessionPost(path, body);
      setAsking(null);
      setText('');
      after?.(result);
      await onChanged?.();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  // ⚠ On a `settle` prompt the session has run away or crossed midnight, and
  // shrinking it in place would leave it just as stale — the same prompt would
  // come straight back, a button that appears to work and does not. So the
  // smaller step starts it AFRESH (start closes the stale one into history as
  // expired, no `force` needed) with that step named. No `minutes` are sent: a
  // restart is not a new statement about how long it takes.
  function shrinkTo(step) {
    if (settle) {
      return post('/api/session/start', { taskId: session.taskId ?? null, text: session.text || '', nextStep: step });
    }
    return post('/api/session/shrink', { step });
  }

  return (
    <div className="card now__focus now__return">
      <div className="now__focus-label">
        {settle ? 'Left open' : recovery.kind === 'shrink' ? 'Stuck on how big this is' : 'Coming back to this'}
      </div>
      <div className="now__focus-text">{recovery.prompt}</div>
      {recovery.nextStep && <div className="now__next">Next: {recovery.nextStep}</div>}
      {recovery.question && <div className="now__meta">{recovery.question}</div>}
      {session.shrinks > 0 && <div className="now__meta">Made smaller {session.shrinks}x so far.</div>}

      {error && <div className="now__sess-err">{error}</div>}

      {asking === 'shrink' ? (
        <div className="now__sess-shrink">
          <label className="now__sess-label" htmlFor="now-return-step">What is the smallest next bit of it?</label>
          <input
            id="now-return-step"
            className="now__sess-input"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="e.g. open the doc and write the first heading"
            autoFocus
          />
          <div className="now__sess-acts">
            <button
              type="button"
              className="now__sess-btn now__sess-btn--go"
              disabled={busy || !text.trim()}
              onClick={() => shrinkTo(text.trim())}
            >
              {settle ? 'Start again from that step' : 'That is the step'}
            </button>
            <button type="button" className="now__sess-btn" disabled={busy} onClick={() => setAsking(null)}>Cancel</button>
          </div>
        </div>
      ) : asking === 'finish' ? (
        <div className="now__sess-shrink">
          <label className="now__sess-label" htmlFor="now-return-reflect">
            Anything worth remembering about that? (optional)
          </label>
          <input
            id="now-return-reflect"
            className="now__sess-input"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="what made it easier, or harder"
            autoFocus
          />
          <div className="now__sess-acts">
            <button
              type="button"
              className="now__sess-btn now__sess-btn--go"
              disabled={busy}
              onClick={() => post('/api/session/finish', { reflection: text.trim() || null }, onFinished)}
            >
              Finish
            </button>
            <button type="button" className="now__sess-btn" disabled={busy} onClick={() => setAsking(null)}>Cancel</button>
          </div>
        </div>
      ) : (
        <div className="now__sess-acts">
          <button type="button" className="now__sess-btn now__sess-btn--go" disabled={busy} onClick={() => { setText(''); setAsking('shrink'); }}>
            Make it smaller
          </button>
          {settle ? (
            <>
              <button type="button" className="now__sess-btn" disabled={busy} onClick={() => { setText(''); setAsking('finish'); }}>
                It got done
              </button>
              {/* Picks the same thing up again without a length — see shrinkTo. */}
              <button
                type="button"
                className="now__sess-btn"
                disabled={busy}
                onClick={() => post('/api/session/start', { taskId: session.taskId ?? null, text: session.text || '' })}
              >
                Start it again
              </button>
            </>
          ) : (
            <>
              <button type="button" className="now__sess-btn" disabled={busy} onClick={() => post('/api/session/resume')}>
                Back to it
              </button>
              {recovery.kind !== 'shrink' && (
                <button type="button" className="now__sess-btn" disabled={busy} onClick={() => { setText(''); setAsking('finish'); }}>
                  Done
                </button>
              )}
            </>
          )}
          <button type="button" className="now__sess-btn" disabled={busy} onClick={() => post('/api/session/abandon')}>
            Let it go
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Start the one thing, when nothing is running.
 *
 * ⚠ A length is OPTIONAL and, when none is picked, NOT SENT. The backend then
 * uses the task's own estimate or its assumed half hour and flags it as assumed.
 * Filling in a default here would launder NEURO's assumption into something Nick
 * appeared to state, and the close-out would then grade him against it.
 *
 * ⚠ A session already running is answered, never overwritten: the route returns
 * 409, and the card names the running session and asks. Switching closes that
 * session into history — it cannot be picked back up — and the button says so.
 */
const START_LENGTHS = [15, 30, 60];

function StartCard({ tasks, assumedMinutes, onStarted }) {
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState(null); // { taskId, text } from the list
  const [other, setOther] = useState('');
  const [minutes, setMinutes] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [running, setRunning] = useState(null); // the session a 409 named

  const picked = choice || (other.trim() ? { taskId: null, text: other.trim() } : null);

  function reset() {
    setOpen(false);
    setChoice(null);
    setOther('');
    setMinutes(null);
    setRunning(null);
    setError(null);
  }

  async function begin(force) {
    if (!picked) return;
    setBusy(true);
    setError(null);
    const body = picked.taskId != null ? { taskId: picked.taskId, text: picked.text } : { text: picked.text };
    if (minutes != null) body.minutes = minutes;
    if (force) body.force = true;
    try {
      await sessionPost('/api/session/start', body);
      reset();
      await onStarted?.();
    } catch (e) {
      if (/^409\b/.test(e.message)) {
        // apiFetch flattens the 409 body into a message, so the running session
        // is read back live rather than parsed out of a truncated string.
        try {
          const live = await apiFetch('/api/session');
          if (live && live.session) setRunning(live.session);
          else setError('NEURO said a session was already running, but none is now. Try again.');
        } catch (readErr) {
          setError(`A session is already running, and I couldn't read which one: ${readErr.message}`);
        }
      } else {
        setError(e.message);
      }
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <div className="now__start">
        <button type="button" className="now__sess-btn now__sess-btn--go" onClick={() => setOpen(true)}>
          Start a focus session
        </button>
      </div>
    );
  }

  return (
    <div className="card now__focus now__start">
      <div className="now__focus-label">Start one thing</div>

      {tasks === null ? (
        <div className="now__meta">I couldn&rsquo;t read your tasks — name it below instead.</div>
      ) : tasks.map((t) => (
        <button
          key={t.id}
          type="button"
          className="now__start-opt"
          aria-pressed={choice?.taskId === t.taskId}
          onClick={() => { setChoice({ taskId: t.taskId, text: t.text }); setOther(''); }}
        >
          <span className="now__task-text">{t.text}</span>
          {/* Null is "no estimate", never a zero-minute task. */}
          <span className="now__meta">{t.estimateMinutes != null ? `${t.estimateMinutes}m estimated` : 'no estimate'}</span>
        </button>
      ))}

      <label className="now__sess-label now__start-label" htmlFor="now-start-other">Or something else</label>
      <input
        id="now-start-other"
        className="now__sess-input"
        value={other}
        onChange={(e) => { setOther(e.target.value); setChoice(null); }}
        placeholder="what you're about to do"
      />

      <div className="now__sess-label now__start-label">How long? (optional)</div>
      <div className="now__sess-acts">
        <button type="button" className="now__sess-btn" aria-pressed={minutes === null} onClick={() => setMinutes(null)}>
          Not saying
        </button>
        {START_LENGTHS.map((m) => (
          <button key={m} type="button" className="now__sess-btn" aria-pressed={minutes === m} onClick={() => setMinutes(m)}>
            {m}m
          </button>
        ))}
      </div>
      {minutes === null && (
        <div className="now__meta">
          It will use the task&rsquo;s own estimate if it has one, otherwise assume
          {assumedMinutes != null ? ` ${assumedMinutes} minutes` : ' a length'} — and say it is assumed.
        </div>
      )}

      {error && <div className="now__sess-err">{error}</div>}

      {running ? (
        <div className="now__sess-shrink">
          <div className="now__sess-label">
            You&rsquo;re already on &ldquo;{running.text || 'an untitled session'}&rdquo;
            {running.elapsedMinutes != null ? ` (${running.elapsedMinutes}m in)` : ''}. Switching closes it and keeps
            it in history — it can&rsquo;t be picked back up afterwards.
          </div>
          <div className="now__sess-acts">
            <button type="button" className="now__sess-btn now__sess-btn--go" disabled={busy} onClick={() => begin(true)}>
              Switch to this
            </button>
            <button type="button" className="now__sess-btn" disabled={busy} onClick={async () => { reset(); await onStarted?.(); }}>
              Stay on that one
            </button>
          </div>
        </div>
      ) : (
        <div className="now__sess-acts">
          <button type="button" className="now__sess-btn now__sess-btn--go" disabled={busy || !picked} onClick={() => begin(false)}>
            Start
          </button>
          <button type="button" className="now__sess-btn" disabled={busy} onClick={reset}>Cancel</button>
        </div>
      )}
    </div>
  );
}

function Section({ title, state, children }) {
  return (
    <section className="now__sec">
      <h2 className="now__sech">{title}</h2>
      {state && state.known === false ? (
        <div className="card now__unread">
          I couldn&rsquo;t read this{state.why ? ` — ${state.why}` : ''}.
          <span className="now__unread-note"> That isn&rsquo;t the same as nothing being there.</span>
        </div>
      ) : children}
    </section>
  );
}

function Countdown({ minutesAway, running, allDay }) {
  // ⚠ Null-check BEFORE coercing. `Number(null)` is 0 and `isFinite(0)` is true,
  // so a deliberate "no answer" prints a confident "0m" (28 Aug).
  if (allDay) return <span className="now__when">all day</span>;
  if (minutesAway === null || minutesAway === undefined) return null;
  const mins = Number(minutesAway);
  if (!Number.isFinite(mins)) return null;
  if (running) return <span className="now__when now__when--live">on now</span>;
  if (mins < 60) return <span className="now__when">in {mins}m</span>;
  return <span className="now__when">in {Math.round(mins / 60)}h</span>;
}

export default function Now({ onNavigate }) {
  const { snapshot, freshness, fetchedAt, error, busy, refresh } = useNickNow();
  const [queue, setQueue] = useState([]);
  const [ticking, setTicking] = useState(null);
  const [flash, setFlash] = useState(null);
  // The LIVE session read — GET /api/session: { session, recovery, assumedMinutes }.
  // The snapshot is a cached morning and carries no recovery prompt, so this is
  // read separately. `data: null` with an error means "couldn't ask", which is
  // not "no session", and nothing below treats it as one.
  const [live, setLive] = useState({ data: null, error: null });
  // The last finish's close-out, verbatim from the server.
  const [closeout, setCloseout] = useState(null);

  // ⚠ READINESS RIDES ON /api/attention, which this screen did not read.
  // attention.js attaches it to every payload and the Scriptable widget has
  // rendered the dial off it for months — the PWA, the kiosk and iOS all threw
  // it away. Its own fetch, so a failure here cannot take the session card with
  // it: the two are independent facts about the same moment.
  const [readiness, setReadiness] = useState(null);
  useEffect(() => {
    let live = true;
    apiFetch('/api/attention')
      .then((d) => { if (live) setReadiness(d?.readiness || null); })
      // ⚠ Swallowed deliberately and ONLY here: Readiness renders nothing
      // without data, so a missing dial is the correct outcome of a failed
      // read. It never renders a zero.
      .catch(() => {});
    return () => { live = false; };
  }, []);

  const reloadSession = useCallback(async () => {
    try {
      setLive({ data: await apiFetch('/api/session'), error: null });
    } catch (e) {
      setLive({ data: null, error: e.message });
    }
  }, []);

  useEffect(() => { reloadSession(); }, [reloadSession]);

  const sessionChanged = useCallback(async () => {
    await Promise.all([refresh(), reloadSession()]);
  }, [refresh, reloadSession]);

  // ⚠ The line is the server's (`initiation-signals.estimateCloseout`) and is
  // shown as it came. A null close-out is an unreadable duration and says so —
  // it is never rendered as "0 min", and a real 0 arrives as "Under a minute".
  const finished = useCallback((result) => {
    setCloseout({ text: result?.session?.text || null, say: result?.closeout?.say || null });
  }, []);

  const reloadQueue = useCallback(async () => {
    try { setQueue(await pendingOps()); } catch { /* the queue view is a nicety */ }
  }, []);

  useEffect(() => {
    reloadQueue();
    return subscribe(() => reloadQueue());
  }, [reloadQueue]);

  // Ticking a task offline is the one WRITE on this screen, and it goes through
  // the outbox like everything else — never straight to the API. Two code paths
  // for one act is what Phase 2 exists to remove.
  //
  // ⚠ The outcome is read from THIS operation's receipt, never from flush()'s
  // aggregate counts. `flush()` drains the whole queue, so `confirmed >= 1` is
  // true whenever any older capture happens to land in the same round trip —
  // which would print "Done" over a completion NEURO rejected, or over one it
  // HELD pending a write-up. That is the silent half-failure shape, on the one
  // screen Nick uses to find what he owes.
  async function tick(task) {
    if (ticking) return;
    setTicking(task.id);
    setFlash(null);
    try {
      const op = await enqueue('todo.complete', { taskId: task.taskId });
      const result = await flush();
      const outcome = outcomeFor(result.receipts[op.operationId]);
      setFlash({
        ok: outcome.state === 'confirmed',
        msg: outcome.state === 'confirmed'
          ? `Done — ${task.text.slice(0, 40)}`
          : outcome.message,
      });
    } catch (e) {
      setFlash({ ok: false, msg: `Couldn't queue that: ${e.message}` });
    } finally {
      setTicking(null);
      reloadQueue();
    }
  }

  const s = snapshot;
  const recovery = live.data?.recovery || null;
  // The live read wins over the cached snapshot when it answered; otherwise the
  // snapshot's session is the best we have and is shown as before.
  const session = live.data ? live.data.session : s?.focus?.session || null;
  const queuedCount = queue.filter((o) => o.status === 'queued' || o.status === 'sending' || o.status === 'failed').length;
  const attentionCount = queue.filter((o) => o.status === 'needs-attention').length;

  return (
    <section className="now">
      <h1 className="view__title">Now</h1>
      <p className="view__lede">
        {s ? `As of ${stampFor(s.generatedAt) || '—'}` : 'Loading your working set…'}
      </p>

      {closeout && (
        <div className="card now__focus now__closeout">
          <div className="now__focus-label">Finished{closeout.text ? ` — ${closeout.text}` : ''}</div>
          {closeout.say
            ? <div className="now__focus-text">{closeout.say}</div>
            : <div className="now__meta">The time on it didn&rsquo;t come back, so there is nothing to compare it with.</div>}
          <button type="button" className="now__go" onClick={() => setCloseout(null)}>Close</button>
        </div>
      )}

      {/* The return prompt leads the screen: the cost of an interruption is the
          failure to come back, so it sits above anything new to start. */}
      {recovery && (
        <ReturnCard recovery={recovery} onChanged={sessionChanged} onFinished={finished} />
      )}

      {/* ⚠ Readiness, from the same /api/attention the Surface reads. It sits
          BELOW the return prompt and above the working set: how recovered he is
          informs what to take on, but it never outranks an unclosed session.
          Renders nothing at all without data — see Readiness.jsx, which refuses
          to draw a dial for a number it does not have. */}
      {readiness && (
        <div className="card now__readiness">
          <Readiness readiness={readiness} />
        </div>
      )}

      <Freshness
        freshness={freshness}
        fetchedAt={fetchedAt}
        error={error}
        busy={busy}
        onRetry={() => refresh()}
      />

      {(queuedCount > 0 || attentionCount > 0) && (
        <div className="now__outbox">
          {queuedCount > 0 && <span>{queuedCount} waiting to reach NEURO</span>}
          {queuedCount > 0 && attentionCount > 0 && <span> · </span>}
          {attentionCount > 0 && <span className="err">{attentionCount} need{attentionCount === 1 ? 's' : ''} attention</span>}
          <button type="button" className="now__outbox-btn" onClick={() => flush({ force: true })}>Send now</button>
        </div>
      )}

      {flash && <div className={`now__flash${flash.ok ? '' : ' err'}`}>{flash.msg}</div>}

      {!s && freshness !== 'loading' && (
        <div className="card now__unread">Nothing to show yet.</div>
      )}

      {s && (
        <>
          {/* ── The one current action ─────────────────────────────────── */}
          <Section title="Right now" state={s.focus}>
            {session && recovery ? (
              // Said once: the return prompt above already owns this session and
              // its controls, and two cards with two "Back to it" buttons for one
              // thread is how a screen starts to argue with itself.
              <div className="card now__calm">That session is waiting at the top of the screen.</div>
            ) : session ? (
              <SessionCard session={session} onChanged={sessionChanged} onFinished={finished} />
            ) : s.focus.item ? (
              <div className="card now__focus">
                <div className="now__focus-text">{s.focus.item.title}</div>
                {s.focus.nextStep && <div className="now__next">{s.focus.nextStep}</div>}
                {s.focus.item.tab && onNavigate && (
                  <button type="button" className="now__go" onClick={() => onNavigate(s.focus.item.tab)}>
                    Open →
                  </button>
                )}
              </div>
            ) : (
              <div className="card now__calm">
                {s.poolAvailable
                  ? 'Nothing pending. That is the real answer, not a blank screen.'
                  : "I couldn't read what needs doing — this is NOT an all-clear."}
              </div>
            )}
            {/* Offered only when NEURO has actually said nothing is running. If
                the live read failed, a Start button would fail the same way. */}
            {!session && live.data && (
              <StartCard
                tasks={s.tasks.known ? s.tasks.items.slice(0, 4) : null}
                assumedMinutes={live.data.assumedMinutes ?? null}
                onStarted={async () => { setCloseout(null); await sessionChanged(); }}
              />
            )}
            {!live.data && live.error && (
              <div className="now__meta">
                I couldn&rsquo;t check for a running session ({live.error}), so starting one isn&rsquo;t offered until NEURO answers.
              </div>
            )}
          </Section>

          {/* ── The next transition ─────────────────────────────────────── */}
          <Section title={s.agenda.known && s.agenda.scope !== 'today' ? `Next — ${s.agenda.scope}` : 'Next'} state={s.agenda}>
            {s.agenda.items.length === 0 ? (
              <div className="card now__calm">Nothing left in the diary.</div>
            ) : (
              s.agenda.items.map((e) => (
                <div className="card now__event" key={e.id}>
                  <div className="now__event-top">
                    <span className="now__event-title">{e.title}</span>
                    <Countdown minutesAway={e.minutesAway} running={e.running} allDay={e.allDay} />
                  </div>
                  {e.withOthers === true && <div className="now__meta">with other people</div>}
                </div>
              ))
            )}
          </Section>

          {/* ── Follow-ups ──────────────────────────────────────────────── */}
          <Section title="Needs a decision" state={s.followUps}>
            {s.followUps.items.length === 0 ? (
              <div className="card now__calm">
                {s.followUps.quiet ? 'Quiet — nothing worth interrupting you for.' : 'Nothing pending.'}
              </div>
            ) : (
              s.followUps.items.map((f) => (
                <div className="card now__item" key={f.id}>
                  <div className="now__item-title">{f.title}</div>
                  {f.say && <div className="now__item-say">{f.say}</div>}
                  {f.tab && onNavigate && (
                    <button type="button" className="now__go" onClick={() => onNavigate(f.tab)}>Open →</button>
                  )}
                </div>
              ))
            )}
            {s.followUps.known && s.followUps.dropped > 0 && (
              <div className="now__meta">{s.followUps.dropped} held back for now — held is not lost.</div>
            )}
          </Section>

          {/* ── The bounded task set ────────────────────────────────────── */}
          <Section title="Tasks" state={s.tasks}>
            {s.tasks.items.length === 0 ? (
              <div className="card now__calm">Nothing open.</div>
            ) : (
              <>
                {s.tasks.items.map((t) => (
                  <div className="card now__task" key={t.id}>
                    <button
                      type="button"
                      className="now__tick"
                      onClick={() => tick(t)}
                      disabled={!t.completableOffline || ticking === t.id}
                      aria-label={`Complete ${t.text}`}
                      title={t.completableOffline ? 'Complete' : 'Owned elsewhere — open it online to tick it'}
                    >{ticking === t.id ? '…' : '○'}</button>
                    <div className="now__task-body">
                      <div className="now__task-text">{t.text}</div>
                      <div className="now__meta">
                        {t.dueDate ? `due ${String(t.dueDate).slice(0, 10)}` : 'no due date'}
                        {t.moscow ? ` · ${t.moscow}` : ''}
                        {t.estimateMinutes ? ` · ${t.estimateMinutes}m` : ''}
                      </div>
                    </div>
                  </div>
                ))}
                {s.tasks.total > s.tasks.items.length && (
                  <div className="now__meta">
                    Showing {s.tasks.items.length} of {s.tasks.total} — the rest live in NEURO.
                  </div>
                )}
              </>
            )}
          </Section>

          {/* Everything NEURO could not see, named rather than swallowed. */}
          {s.gaps && s.gaps.length > 0 && (
            <details className="now__gaps">
              <summary>{s.gaps.length} thing{s.gaps.length === 1 ? '' : 's'} I couldn&rsquo;t read</summary>
              <ul>
                {s.gaps.map((g, i) => (
                  <li key={`${g.input}-${i}`}><strong>{g.input}</strong> — {g.why}</li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </section>
  );
}
