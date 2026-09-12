import { useCallback, useEffect, useState } from 'react';
import { apiFetch, apiUrl, authHeaders } from '../api';
import { completeTask } from '../completeTask';
import './Today.css';

// The phone cut of the ADHD dashboard. Same /api/adhd payload as desktop, but
// ruthless about what earns a place on a small screen at a bad moment:
//
//   in  — the one thing, momentum, quick wins, one avoidance line
//   out — the 7-day trend, the full wins list, the log-a-win box
//
// Those all reward sitting and reading. This surface catches you mid-drift, so
// everything on it is either "what do I do" or "you have already done things".
export default function Today({ onNavigate }) {
  const [state, setState] = useState({ loading: true, error: null, data: null });
  const [busy, setBusy] = useState({});
  const [headline, setHeadline] = useState(null);
  const [showWins, setShowWins] = useState(false);
  // Bumped by the refresh button so the sections that load on their own
  // (friction, health) re-read with everything else rather than going stale.
  const [refreshKey, setRefreshKey] = useState(0);

  const load = useCallback(async () => {
    try {
      const data = await apiFetch('/api/adhd');
      setState({ loading: false, error: null, data });
    } catch (error) {
      setState({ loading: false, error: error.message, data: null });
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function tick(item, index) {
    if (busy[index]) return;
    setBusy((b) => ({ ...b, [index]: true }));
    try {
      // The running total, stated the moment the task closes. Null on an empty
      // day or an unreachable ledger — never a fabricated number.
      const line = await completeTask(item);
      if (line) setHeadline(line);
      load();
    } catch (error) {
      setState((s) => ({ ...s, error: error.message }));
      setBusy((b) => ({ ...b, [index]: false }));
    }
  }

  const { loading, error, data } = state;

  if (loading) return <section><div className="card">Working out where you are…</div></section>;
  if (error) {
    return (
      <section>
        <div className="card err">
          {error}
          <div className="today__hint">Check you're on Tailscale and the PIN is right, or that the NEURO backend is up.</div>
        </div>
      </section>
    );
  }
  if (!data) return null;

  const { shape, rightNow, momentum, winsToday, avoidance, quickWins, signals } = data;
  const topAvoidance = avoidance.signals[0] || null;

  return (
    <section className="today">
      {/* What the day comes to, the moment a task closes. Statement of fact,
          not a celebration — and nothing at all on an empty day. */}
      {headline && <div className="card today__headline">{headline}</div>}
      <div className="today__head">
        <p className="today__shape">{shape.line}</p>
        <button
          className="today__refresh"
          type="button"
          onClick={() => { load(); setRefreshKey((k) => k + 1); }}
          aria-label="Refresh"
          title="Refresh"
        >↻</button>
      </div>

      {/* ── The one thing ── */}
      <div className={`card today__now today__now--${rightNow.item?.urgency || 'none'}`}>
        <div className="today__now-label">Right now</div>
        {rightNow.item ? (
          <>
            <div className="today__now-title">{rightNow.item.title}</div>
            {rightNow.item.reason && <div className="today__now-reason">{rightNow.item.reason}</div>}
            <div className="today__now-actions">
              <button className="today__do" type="button" onClick={() => onNavigate?.('focus')}>
                {rightNow.action?.label || 'Open it'}
              </button>
              <button className="today__later" type="button" onClick={() => onNavigate?.('tasks')}>
                Something else
              </button>
            </div>
            {rightNow.waiting > 0 && (
              <div className="today__waiting">{rightNow.waiting} other thing{rightNow.waiting === 1 ? '' : 's'} tracked. They can wait.</div>
            )}
          </>
        ) : (
          <div className="today__now-title today__now-title--clear">Nothing pressing. You're clear.</div>
        )}
      </div>

      {/* ── Momentum: tappable, because the wins list is the payoff ── */}
      <button
        className="card today__momentum"
        type="button"
        onClick={() => setShowWins((v) => !v)}
        aria-expanded={showWins}
        disabled={winsToday.length === 0}
      >
        <span className="today__count">{momentum.doneToday}</span>
        <span className="today__count-label">
          finished today
          {momentum.typical > 0 && momentum.doneToday > momentum.typical && (
            <span className="today__streak">above your usual {momentum.typical}</span>
          )}
        </span>
        <span className="today__rituals">
          <span className={momentum.rituals.standup ? 'on' : ''}>{momentum.rituals.standup ? '✓' : '○'}</span>
          <span className={momentum.rituals.eod ? 'on' : ''}>{momentum.rituals.eod ? '✓' : '○'}</span>
        </span>
      </button>

      {showWins && winsToday.length > 0 && (
        <div className="card today__wins">
          {winsToday.map((w, i) => (
            <div className="today__win" key={i}>
              <span className="today__win-time">{w.time}</span>
              <span>{w.text}</span>
            </div>
          ))}
        </div>
      )}

      {/* ── Quick wins ── */}
      {quickWins.length > 0 && (
        <div className="card today__quick">
          <div className="today__h">If that's too big</div>
          {quickWins.map((q, i) => (
            <div className="today__quick-item" key={i}>
              <button
                className="today__tick"
                type="button"
                onClick={() => tick(q, i)}
                disabled={busy[i]}
                aria-label={`Complete: ${q.text}`}
              >{busy[i] ? '…' : ''}</button>
              <span>{q.text}</span>
            </div>
          ))}
        </div>
      )}

      {/* ── One avoidance line, stated flat ── */}
      {topAvoidance && (
        <div className="card today__avoid">
          <span className="today__avoid-label">{topAvoidance.label}</span>
          <span className="today__avoid-detail">{topAvoidance.detail}</span>
        </div>
      )}

      <InitiationSection signals={signals} />
      <FrictionSection refreshKey={refreshKey} />
      <HealthChangedSection refreshKey={refreshKey} />
    </section>
  );
}

// ── Sections added for parity with the desktop Now page ─────────────────────
//
// Three reads that all come from things Nick DID or his body measured, each one
// judged entirely server-side. These components only render. Four rules they
// hold, and `backend/services/sara-today-source.test.js` pins them:
//   * unreadable is a NAMED gap, never a zero and never an all-clear;
//   * friction with no evidence renders nothing at all — no consolation line;
//   * nothing here is graded — counts and sentences, never a rating of him;
//   * the Pi kiosk refuses `health` on purpose (body data on a desk screen with
//     no login), and that refusal renders as "not shown on this screen", which
//     is a decision about the screen, not an error and not "nothing changed".

// apiFetch flattens a non-2xx body into an Error message, and two answers here
// are only readable from the body: the kiosk's `reason: 'not-a-door'` and the
// health ack's refusal reason. Same auth, from the one place it is built.
async function readJson(path, options = {}) {
  const res = await fetch(apiUrl(path), { ...options, headers: authHeaders(path, options.headers) });
  let body = null;
  try { body = await res.json(); } catch { /* a non-JSON answer carries no reason */ }
  return { ok: res.ok, status: res.status, body };
}

function isNotADoor(r) {
  return r.status === 403 && r.body?.reason === 'not-a-door';
}

function errorOf(r) {
  return r.body?.error || r.body?.reason || `${r.status}`;
}

/**
 * Starting, not finishing. Rides on /api/adhd's `signals` rather than a second
 * fetch — this page is read at low moments and one round trip is the rule.
 */
function InitiationSection({ signals }) {
  if (!signals) {
    // /api/adhd sends null when the read threw. Not a day with no starts.
    return (
      <div className="card today__init">
        <div className="today__h">Getting started</div>
        <p className="today__gap">Couldn&rsquo;t read your sessions — this is not a count of zero.</p>
      </div>
    );
  }

  const starts = signals.starts || {};
  const shrinks = signals.shrinks || {};
  const triage = signals.triage || {};
  const estimates = signals.estimates || {};
  const ladder = (shrinks.ladder || []).slice(0, 2);
  const gaps = signals.gaps || [];

  const nothingYet = !starts.today && !shrinks.today && !triage.today && ladder.length === 0 && !estimates.known;
  if (nothingYet && gaps.length === 0 && starts.complete !== false) return null;

  return (
    <div className="card today__init">
      <div className="today__h">Getting started</div>
      <div className="today__init-stats">
        <span>
          <strong>{starts.today ?? 0}</strong> started
          {starts.typical > 0 && starts.today > starts.typical && (
            <em className="today__init-note">above your usual {starts.typical}</em>
          )}
        </span>
        {shrinks.today > 0 && (
          <span><strong>{shrinks.today}</strong> made smaller</span>
        )}
        <span>
          <strong>{triage.today ?? 0}</strong> triaged
          {triage.firstEstimatesToday > 0 && (
            <em className="today__init-note">
              {triage.firstEstimatesToday} first estimate{triage.firstEstimatesToday === 1 ? '' : 's'}
            </em>
          )}
        </span>
      </div>
      {starts.live && <div className="today__init-live">One running now.</div>}

      {/* What a task had to become before it could be started. A fact about the
          work, never about him. */}
      {ladder.length > 0 && (
        <ul className="today__init-ladder">
          {ladder.map((rung) => (
            <li key={rung.id}>
              <span className="today__init-from">{rung.from}</span>
              <span aria-hidden="true"> → </span>
              <span>{rung.to}</span>
            </li>
          ))}
        </ul>
      )}

      {/* Only sessions where the estimate was his. NEURO's own 30-minute
          assumption is excluded and the exclusion is said. */}
      {estimates.known ? (
        <p className="today__init-est">
          Your estimates: {estimates.close} close, {estimates.under} under, {estimates.over} over,
          across {estimates.judged} session{estimates.judged === 1 ? '' : 's'} you set.
          {estimates.assumedExcluded > 0 && ` ${estimates.assumedExcluded} more had no estimate of yours.`}
        </p>
      ) : estimates.reason && !nothingYet ? (
        <p className="today__init-est">Estimates: {estimates.reason}.</p>
      ) : null}

      {starts.complete === false && starts.incompleteWhy && (
        <p className="today__gap">Counts are a floor — {starts.incompleteWhy}.</p>
      )}
      {gaps.length > 0 && (
        <p className="today__gap">
          Couldn&rsquo;t read {gaps.map((g) => g.source).join(', ')} — this is not a count of zero.
        </p>
      )}
    </div>
  );
}

/**
 * What has got in the way, from things Nick did. GET /api/friction.
 * No insights and no gaps renders NOTHING.
 */
function FrictionSection({ refreshKey }) {
  const [state, setState] = useState({ loading: true, error: null, notHere: false, data: null });
  const [busy, setBusy] = useState(null);
  const [failed, setFailed] = useState(null);
  // Bumped by a successful "Noted" so the section re-reads without touching the
  // page's own refresh — noting one line must not re-fetch the whole dashboard.
  const [localKey, setLocalKey] = useState(0);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const r = await readJson('/api/friction');
        if (!live) return;
        if (isNotADoor(r)) return setState({ loading: false, error: null, notHere: true, data: null });
        if (!r.ok) return setState({ loading: false, error: errorOf(r), notHere: false, data: null });
        setState({ loading: false, error: null, notHere: false, data: r.body });
      } catch (e) {
        if (live) setState({ loading: false, error: e.message, notHere: false, data: null });
      }
    })();
    return () => { live = false; };
  }, [refreshKey, localKey]);

  /**
   * "Noted" — he has taken the line on board.
   *
   * ⚠ IT ANSWERS THE LINE, NOT THE WORK. It does not tick anything, does not
   * un-record the evidence, and the server holds it only while the SIGNATURE is
   * unchanged — a third shrink on the same task raises the observation again.
   * That is why the signature he was looking at is sent rather than just the id.
   *
   * ⚠ IT EXISTED ON THE DESKTOP ONLY UNTIL NOW, and SARA already honoured the
   * result: the filter is server-side, so a line noted at the desk was already
   * gone from here. What was missing was pressing it FROM here — a line you can
   * read on your phone and only dismiss at your desk, in the one panel whose
   * whole purpose is removing friction.
   */
  async function note(ins) {
    if (!ins?.id || busy) return;
    setBusy(ins.id);
    setFailed(null);
    try {
      const r = await readJson('/api/friction/note', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: ins.id, signature: ins.signature }),
      });
      if (!r.ok) throw new Error(errorOf(r));
      setLocalKey((k) => k + 1);
    } catch (e) {
      // Said out loud. A button that silently does nothing is worse than none.
      setFailed(e.message);
    }
    setBusy(null);
  }

  const { loading, error, notHere, data } = state;
  if (loading) return null;

  if (notHere) {
    return (
      <div className="card today__friction">
        <div className="today__h">Got in the way</div>
        <p className="today__quiet">Not shown on this screen.</p>
      </div>
    );
  }
  if (error) {
    return (
      <div className="card today__friction">
        <div className="today__h">Got in the way</div>
        <p className="today__gap">Couldn&rsquo;t read this — {error}. That is not the same as nothing being in your way.</p>
      </div>
    );
  }

  const insights = data?.insights || [];
  const gaps = data?.gaps || [];
  // ⚠ STILL NOTHING WHEN THERE IS NOTHING, and deliberately NOT widened to
  // include `noted`. The desktop shows its "N noted already" line unconditionally
  // because it has the room; here that would mount a whole section whose only
  // content is a reminder that he dismissed some things, which is noise on the
  // surface he opens at a bad moment. The line rides ALONGSIDE real observations
  // or not at all.
  if (insights.length === 0 && gaps.length === 0) return null;

  return (
    <div className="card today__friction">
      <div className="today__h">Got in the way</div>
      {insights.map((ins, i) => (
        <div className="today__friction-item" key={ins.id || i}>
          <p className="today__friction-text">{ins.text}</p>
          {ins.because && <p className="today__because">Based on {ins.because}.</p>}
          {/* ⚠ No id, no button — never one that guesses which line it answers. */}
          {ins.id && (
            <button
              type="button"
              className="today__small-btn"
              disabled={busy === ins.id}
              onClick={() => note(ins)}
            >
              {busy === ins.id ? '…' : 'Noted'}
            </button>
          )}
        </div>
      ))}
      {failed && <p className="today__gap">Couldn&rsquo;t note that — {failed}.</p>}
      {/* Held back, not gone. A section that quietly shrank would look like one
          that had stopped working. Same wording as the desktop's. */}
      {data?.noted > 0 && (
        <p className="today__quiet">
          {data.noted} noted already — back if the evidence grows.
        </p>
      )}
      {gaps.length > 0 && (
        <p className="today__gap">
          Couldn&rsquo;t read: {gaps.map((g) => g.source).join(', ')}.
        </p>
      )}
    </div>
  );
}

/**
 * What has CHANGED in his body against his own baseline. GET /api/health/signals.
 * "I've read it" moves a finding to its own list; it comes back by itself if it
 * clears and happens again, and there is always a way back by hand.
 */
function HealthChangedSection({ refreshKey }) {
  const [state, setState] = useState({ loading: true, error: null, notHere: false, data: null });
  const [busy, setBusy] = useState(null);
  const [failed, setFailed] = useState(null);
  const [showRead, setShowRead] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await readJson('/api/health/signals');
      if (isNotADoor(r)) return setState({ loading: false, error: null, notHere: true, data: null });
      if (!r.ok) return setState({ loading: false, error: errorOf(r), notHere: false, data: null });
      setState({ loading: false, error: null, notHere: false, data: r.body });
    } catch (e) {
      setState({ loading: false, error: e.message, notHere: false, data: null });
    }
  }, []);

  useEffect(() => { load(); }, [load, refreshKey]);

  async function setRead(finding, read) {
    if (busy) return;
    setBusy(finding.id);
    setFailed(null);
    try {
      const r = await readJson(`/api/health/signals/${encodeURIComponent(finding.id)}/ack`, {
        method: read ? 'POST' : 'DELETE',
      });
      // The server refuses to ack anything not in the current pass — said out
      // loud, because a button that silently did nothing is worse than none.
      if (!r.ok) setFailed(errorOf(r));
      await load();
    } catch (e) {
      setFailed(e.message);
    }
    setBusy(null);
  }

  const { loading, error, notHere, data } = state;
  if (loading) return null;

  if (notHere) {
    return (
      <div className="card today__health">
        <div className="today__h">Body — what&rsquo;s changed</div>
        <p className="today__quiet">Not shown on this screen. Health data stays off shared displays.</p>
      </div>
    );
  }
  if (error) {
    return (
      <div className="card today__health">
        <div className="today__h">Body — what&rsquo;s changed</div>
        <p className="today__gap">Couldn&rsquo;t read your health signals — {error}. That is not the same as nothing having changed.</p>
      </div>
    );
  }

  const findings = data?.findings || [];
  const acknowledged = data?.acknowledged || [];
  const unknowns = data?.unknowns || [];

  return (
    <div className="card today__health">
      <div className="today__h">Body — what&rsquo;s changed</div>

      {findings.map((f) => (
        <div className="today__finding" key={f.id}>
          <p className="today__finding-title">{f.title}</p>
          {f.detail && <p className="today__finding-detail">{f.detail}</p>}
          {/* The caveat travels with the finding, never dropped: Apple Health
              cannot tell exercise, illness, alcohol and a hard week apart. */}
          {f.caveat && <p className="today__because">{f.caveat}</p>}
          <button
            className="today__small-btn"
            type="button"
            disabled={busy === f.id}
            onClick={() => setRead(f, true)}
          >{busy === f.id ? '…' : 'I’ve read it'}</button>
        </div>
      ))}

      {findings.length === 0 && data?.allClear && (
        <p className="today__quiet">Nothing stood out against your own baseline.</p>
      )}

      {/* Read, not resolved: still true, and still counted. */}
      {acknowledged.length > 0 && (
        <>
          <button
            className="today__small-btn today__small-btn--link"
            type="button"
            aria-expanded={showRead}
            onClick={() => setShowRead((v) => !v)}
          >{acknowledged.length} read — still true</button>
          {showRead && acknowledged.map((f) => (
            <div className="today__finding today__finding--read" key={f.id}>
              <p className="today__finding-title">{f.title}</p>
              {f.caveat && <p className="today__because">{f.caveat}</p>}
              <button
                className="today__small-btn"
                type="button"
                disabled={busy === f.id}
                onClick={() => setRead(f, false)}
              >{busy === f.id ? '…' : 'Bring it back'}</button>
            </div>
          ))}
        </>
      )}

      {unknowns.length > 0 && (
        <p className="today__gap">
          Couldn&rsquo;t judge: {unknowns.map((u) => u.input).join(', ')}.
        </p>
      )}
      {failed && <p className="today__gap">Couldn&rsquo;t change that — {failed}.</p>}
    </div>
  );
}
