import { useState, useEffect, useCallback } from 'react';
import { apiUrl } from '../api';
import './TimeFitCard.css';

/**
 * "You have forty minutes before your next meeting — here's what fits."
 *
 * The one ADHD accommodation nothing else in NEURO substituted for. Focus tells
 * you what matters, quick wins tell you what's small, the lane tells you what's
 * urgent — and none of them knew how long anything takes or how much time there
 * was, so every one of them could hand you a two-hour job at 4:40pm.
 *
 * Two rules it holds to:
 *
 * · An assumed duration is labelled as one. The backend flags every task with no
 *   estimate and this says so on the row. A card that quietly treats an unknown
 *   as half an hour is right until it isn't, and then it is never trusted again.
 *
 * · The estimate control lives HERE, on the row where the assumption is
 *   showing. That is the only moment the question "how long is this?" is worth
 *   answering — asking for 128 estimates up front is how the priority field
 *   ended up 18% populated and meaningless.
 */

// Coarse on purpose. "About how long?" is a judgement anyone can make in a
// second; "37 minutes" is a number nobody has and nobody can check.
const BUCKETS = [
  { minutes: 5, label: '5 min' },
  { minutes: 15, label: '15 min' },
  { minutes: 30, label: '30 min' },
  { minutes: 60, label: '1 hr' },
  { minutes: 120, label: '2 hr' },
  { minutes: 240, label: 'half a day' },
  { minutes: 480, label: 'a full day' },
];

// A working week, matching task-store's own ceiling. Past that it is a project.
const MAX_ESTIMATE_MINUTES = 2400;

// "I have some time" — the answers to "how long have you got?". Coarse for the
// same reason the estimate buckets are: it is a judgement made in a second.
const TIME_PRESETS = [15, 30, 45, 60, 90, 120, 180];

// When Nick says how long he has, he wants EVERYTHING that fits, not a top five.
// Bounded server-side at 50.
const ASKED_LIMIT = 50;

// "420 min" is a number you have to do arithmetic on to understand.
function formatMinutes(m) {
  if (m == null) return '—';
  if (m < 60) return `${m} min`;
  const hours = m / 60;
  return `${Number.isInteger(hours) ? hours : hours.toFixed(1)} hr`;
}

export default function TimeFitCard({ onStarted, onCompleted }) {
  const [data, setData] = useState(null);
  // Which row is mid-write. A card that lists work you cannot pick up or put
  // down is a reading exercise — this one told you what fits in your gap and
  // then made you go and find it again in the list below.
  const [actingId, setActingId] = useState(null);
  const [actError, setActError] = useState(null);
  const [error, setError] = useState(null);
  const [override, setOverride] = useState(null);
  const [savingId, setSavingId] = useState(null);
  // The row currently showing the "how many hours?" box, if any.
  const [customId, setCustomId] = useState(null);
  const [customHours, setCustomHours] = useState('');
  // "I have some time" — the picker is open, and what is typed in its box.
  const [asking, setAsking] = useState(false);
  const [askMinutes, setAskMinutes] = useState('');

  const load = useCallback((minutes = override) => {
    const qs = minutes ? `?minutes=${minutes}&limit=${ASKED_LIMIT}` : '';
    fetch(apiUrl(`/api/time/what-fits${qs}`))
      .then(r => r.json())
      .then(d => { setData(d); setError(null); })
      .catch(e => setError(e.message));
  }, [override]);

  useEffect(() => { load(); }, [load]);

  // `exact` marks a number Nick typed rather than one he picked. The backend
  // snaps a preset to a bucket and leaves a typed number alone — a duration
  // someone went and entered is not a guess in need of rounding.
  const setEstimate = async (taskId, minutes, exact = false) => {
    if (!taskId) return;
    setSavingId(taskId);
    try {
      await fetch(apiUrl(`/api/tasks/${taskId}`), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ estimateMinutes: minutes, estimateExact: exact }),
      });
    } catch { /* the reload below is the feedback */ }
    setSavingId(null);
    setCustomId(null);
    setCustomHours('');
    load();
  };

  const saveCustom = (taskId) => {
    const hours = Number(customHours);
    if (!Number.isFinite(hours) || hours <= 0) return;
    const minutes = Math.min(Math.round(hours * 60), MAX_ESTIMATE_MINUTES);
    setEstimate(taskId, minutes, true);
  };

  /**
   * Start a session on the thing that fits. This is the whole point of the card
   * — Nick's difficulty is INITIATION, and "here is what fits" followed by no
   * way to begin it is awareness raised with the barrier left exactly where it
   * was.
   *
   * ⚠ 409 means a session is already running. That is a question, not an error,
   * and it is answered the same way `AdhdPanel` answers it: name what is
   * running and ask, rather than silently replacing it.
   */
  const start = async (item) => {
    if (!item.task_id || actingId) return;
    setActingId(item.task_id);
    setActError(null);
    try {
      const post = (force) => fetch(apiUrl('/api/session/start'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId: item.task_id, text: item.text, ...(force ? { force: true } : {}) }),
      });
      let res = await post(false);
      let json = await res.json().catch(() => ({}));
      if (res.status === 409 && json.session) {
        const ok = window.confirm(
          `You're ${json.session.elapsedMinutes} minutes into "${json.session.text}".\n\nPark it and start this instead?`
        );
        if (!ok) { setActingId(null); return; }
        res = await post(true);
        json = await res.json().catch(() => ({}));
      }
      if (!res.ok) throw new Error(json.error || `${res.status}`);
      onStarted?.();
      load();
    } catch (e) {
      // Said out loud. A button that silently did nothing is worse than none.
      setActError(e.message);
    }
    setActingId(null);
  };

  /**
   * Close it from here.
   *
   * ⚠ A tick can be HELD — `task-blocks` refuses to complete a task whose
   * outcome note has not been written — and the response says so. Reporting
   * that as done would be the silent half-failure this codebase refuses
   * everywhere else, so the hold is surfaced in words.
   */
  const complete = async (item) => {
    if (!item.task_id || actingId) return;
    setActingId(item.task_id);
    setActError(null);
    try {
      const res = await fetch(apiUrl(`/api/tasks/${item.task_id}/complete`), { method: 'POST' });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `${res.status}`);
      // `held` rides on the returned ROW — the same field TodoPanel reads, not a
      // second shape invented here.
      const held = json.task?.held || null;
      if (held) {
        setActError(
          `Held, not done — ${held.reason || 'no write-up yet'}. `
          + (held.notePath ? `Write it up in ${held.notePath} and it closes itself.` : 'It stays in progress until the outcome note is written.')
        );
      } else {
        onCompleted?.();
      }
      load();
    } catch (e) {
      setActError(e.message);
    }
    setActingId(null);
  };

  const chooseTime = (m) => {
    const minutes = Math.round(Number(m));
    if (!Number.isFinite(minutes) || minutes <= 0) return;
    setOverride(Math.min(minutes, MAX_ESTIMATE_MINUTES));
    setAsking(false);
    setAskMinutes('');
  };

  // Asked, never inferred: the diary says when the next wall is, only Nick
  // knows how much of the time before it is actually his.
  const askButton = !asking && (
    <button className="tf-inline tf-ask-btn" onClick={() => setAsking(true)}>I have some time</button>
  );
  const askRow = asking && (
    <div className="tf-ask">
      <span className="tf-ask-q">How long have you got?</span>
      {TIME_PRESETS.map(m => (
        <button key={m} className="tf-chip" onClick={() => chooseTime(m)}>{formatMinutes(m)}</button>
      ))}
      <input
        className="tf-custom-input"
        type="number"
        min="5"
        step="5"
        value={askMinutes}
        placeholder="min"
        onChange={e => setAskMinutes(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter') chooseTime(askMinutes);
          if (e.key === 'Escape') { setAsking(false); setAskMinutes(''); }
        }}
        aria-label="How many minutes have you got?"
      />
      <button className="tf-inline" onClick={() => chooseTime(askMinutes)}>Go</button>
      <button className="tf-inline" onClick={() => { setAsking(false); setAskMinutes(''); }}>Cancel</button>
    </div>
  );

  if (error) return null;          // never let this push a real error at anyone
  if (!data) return null;

  const { gap, items = [], assumedCount = 0, calendarKnown, coverage } = data;

  // "I can't see the calendar" and "your diary is clear" must not look the
  // same — one of them means calendar-sync has stopped. The backend decides
  // which it is from the cache as a whole, NOT from today's event count: a
  // Saturday with nothing on it is not a broken sync.
  // Once Nick has SAID how long he has, the diary no longer decides anything,
  // so an unreadable calendar must not hide his answer.
  if (!calendarKnown && !override) {
    return (
      <section className="tf-card tf-unknown">
        <div className="tf-head">Can't see your diary {askButton}</div>
        <p className="tf-blurb">
          The calendar cache is empty or stale, so I don't know what's ahead —
          this isn't the same as a clear afternoon.
        </p>
        {askRow}
      </section>
    );
  }

  if (gap?.openEnded && !override) {
    return (
      <section className="tf-card">
        <div className="tf-head">Nothing left in the diary today {askButton}</div>
        <p className="tf-blurb">
          So nothing here has to fit around anything.
        </p>
        {askRow}
      </section>
    );
  }

  const minutes = data.minutes ?? gap?.minutes;

  // Every item fits ON ITS OWN; together they may not. When Nick has said how
  // long he has, mark where the running total (in priority order) passes it, so
  // "all of these fit" is never read as "you can do all of these".
  let fillIndex = -1;
  if (override) {
    let total = 0;
    for (let i = 0; i < items.length; i++) {
      total += items[i].minutes || 0;
      if (total > minutes) { fillIndex = i; break; }
    }
  }

  return (
    <section className="tf-card">
      <div className="tf-head">
        {override
          ? `${minutes} minutes`
          : `${minutes} minutes before ${gap?.nextEvent?.subject || 'your next meeting'}`}
        {!override && gap?.until && <span className="tf-until">until {gap.until}</span>}
        {override && items.length > 0 && (
          <span className="tf-until">{items.length} fit · priority order</span>
        )}
        {askButton}
      </div>
      {askRow}

      {items.length === 0 ? (
        <p className="tf-blurb">
          Nothing on the list fits in {minutes} minutes
          {assumedCount === 0 && coverage?.unestimated > 0 && <> that I have a duration for</>}.
        </p>
      ) : (
        <ul className="tf-list">
          {items.map((item, i) => (
            <li className={`tf-row${i === fillIndex ? ' tf-row-overflow' : ''}`} key={item.task_id || item.text}>
              {i === fillIndex && (
                <span className="tf-fill">The ones above fill your {formatMinutes(minutes)} — these fit on their own.</span>
              )}
              <span className="tf-text">{item.text}</span>
              <span className={`tf-mins${item.assumed ? ' tf-assumed' : ''}`}>
                {formatMinutes(item.minutes)}{item.assumed && <em> assumed</em>}
              </span>
              {/* Fix the assumption right where it is showing. */}
              {customId === item.task_id ? (
                <span className="tf-custom">
                  <input
                    className="tf-custom-input"
                    type="number"
                    min="0.25"
                    max={MAX_ESTIMATE_MINUTES / 60}
                    step="0.25"
                    autoFocus
                    value={customHours}
                    placeholder="hours"
                    disabled={savingId === item.task_id}
                    onChange={e => setCustomHours(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') saveCustom(item.task_id);
                      if (e.key === 'Escape') { setCustomId(null); setCustomHours(''); }
                    }}
                    aria-label="How many hours does this take?"
                  />
                  <button className="tf-inline" onClick={() => saveCustom(item.task_id)}>Save</button>
                  <button className="tf-inline" onClick={() => { setCustomId(null); setCustomHours(''); }}>Cancel</button>
                </span>
              ) : (
                <select
                  className="tf-est"
                  value=""
                  disabled={savingId === item.task_id}
                  onChange={e => {
                    if (e.target.value === 'custom') { setCustomId(item.task_id); setCustomHours(''); }
                    else setEstimate(item.task_id, Number(e.target.value));
                  }}
                  aria-label="How long does this take?"
                >
                  <option value="">{item.assumed ? 'How long?' : 'Change'}</option>
                  {BUCKETS.map(b => <option key={b.minutes} value={b.minutes}>{b.label}</option>)}
                  {/* The presets stop at a day. Some things are bigger than the
                      longest preset, and a list that cannot say so quietly files
                      a two-day job as a four-hour one. */}
                  <option value="custom">Custom…</option>
                </select>
              )}
              {/* Only a NEURO-owned row can be started or closed from here. A
                  row without an id gets no buttons rather than buttons that
                  would 400 on the tap. */}
              {item.task_id && (
                <span className="tf-acts">
                  <button
                    className="tf-inline tf-start"
                    disabled={actingId === item.task_id}
                    onClick={() => start(item)}
                  >{actingId === item.task_id ? '…' : 'Start'}</button>
                  <button
                    className="tf-inline"
                    disabled={actingId === item.task_id}
                    onClick={() => complete(item)}
                  >Done</button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      {actError && <p className="tf-blurb tf-acterr">{actError}</p>}

      <div className="tf-foot">
        {assumedCount > 0 && (
          <span className="tf-note">
            {assumedCount} of these {assumedCount === 1 ? 'is a guess' : 'are guesses'} — {data.assumedMinutes} min assumed.
          </span>
        )}
        {coverage && coverage.total > 0 && (
          <span className="tf-coverage">{coverage.estimated}/{coverage.total} tasks estimated</span>
        )}
        {override && <button className="tf-inline" onClick={() => setOverride(null)}>Use my diary</button>}
      </div>
    </section>
  );
}
