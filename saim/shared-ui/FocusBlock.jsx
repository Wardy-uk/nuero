import { useEffect, useState } from 'react';
import './FocusBlock.css';

/**
 * The focus block (1 Nov 2026) — ONE component, mounted by desktop Now
 * (AdhdPanel) and SAiM's Surface (phone, Electron, kiosk). It renders the
 * server's `focus-block-v1` composition verbatim: the words, the candidates,
 * the phase and the clock all come from NEURO.
 *
 * `onAct(action, body)` → Promise<{ ok, say?, win?, error? }> performs a press
 * through the shell's own transport. NULL (the kiosk) = read-only: the block,
 * its clock and its candidates are shown and NO button is drawn — never a
 * control that fails when tapped. `onSomethingElse` opens the task list.
 *
 * ⚠ Nothing here completes work on its own, and no wording speaks of avoiding
 * or failing — a block put off is a block put off.
 */

// Counted from the block's own instants, so a payload read a minute ago still
// counts down truly; the server's seconds are the fallback.
function minutesLeft(clock, nowMs) {
  if (!clock) return null;
  const end = Date.parse(clock.endsAt);
  const start = Date.parse(clock.startsAt);
  if (!Number.isFinite(end)) return Math.ceil((clock.remainingSeconds || 0) / 60);
  return Math.max(0, Math.ceil((end - Math.max(nowMs, Number.isFinite(start) ? start : nowMs)) / 60000));
}
function minutesUntil(clock, nowMs) {
  if (!clock) return null;
  const start = Date.parse(clock.startsAt);
  if (!Number.isFinite(start)) return Math.ceil((clock.startsInSeconds || 0) / 60);
  return Math.max(0, Math.ceil((start - nowMs) / 60000));
}

export function FocusBlockView({ block, onAct = null, onSomethingElse = null, now = null }) {
  const [tick, setTick] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState(null);
  const [smaller, setSmaller] = useState({});
  const [note, setNote] = useState('');
  const [stuck, setStuck] = useState(false);
  const [step, setStep] = useState('');

  useEffect(() => {
    if (now != null) return undefined;
    const id = setInterval(() => setTick(Date.now()), 30000);
    return () => clearInterval(id);
  }, [now]);

  if (!block) return null;
  const nowMs = now != null ? now : tick;
  const clock = block.clock || null;
  const act = onAct ? async (action, body = {}) => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await onAct(action, body);
      setSaid(r && (r.win || r.say || (r.ok === false ? (r.error || 'That didn’t go through.') : null)));
    } catch (e) {
      setSaid(e.message || 'That didn’t go through.');
    } finally {
      setBusy(false);
    }
  } : null;

  if (block.phase === 'notice') {
    return (
      <section className="fblock fblock--notice" aria-label="Focus block">
        <p className="fblock__say">{block.notice && block.notice.say}</p>
      </section>
    );
  }

  const left = minutesLeft(clock, nowMs);
  const until = minutesUntil(clock, nowMs);
  const span = `${block.startTime}–${block.endTime}`;
  const lengthNote = block.lengthLearned === false
    ? ' · length is the default for now'
    : block.minutesAssumed ? ' · assumed length' : '';

  return (
    <section className={`fblock fblock--${block.phase}`} aria-label="Focus block">
      <div className="fblock__head">
        <span className="fblock__label">Focus block</span>
        <span className="fblock__clock">
          {block.phase === 'ready'
            ? `starts in ${until} min`
            : ['running', 'two-minute', 'wind-down', 'start'].includes(block.phase)
              ? `${left} min left · until ${block.endTime}`
              : span}
          <span className="fblock__basis">{lengthNote}</span>
        </span>
      </div>

      {block.say && <p className="fblock__say">{block.say}</p>}

      {block.chosen && ['running', 'two-minute', 'wind-down', 'end'].includes(block.phase) && (
        <p className="fblock__task">{block.chosen.text}</p>
      )}
      {block.held > 0 && ['running', 'two-minute', 'wind-down'].includes(block.phase) && (
        <p className="fblock__quiet">{`${block.held} notification${block.held === 1 ? '' : 's'} held for the end.`}</p>
      )}
      {/* The laptop: links opening for the task (or why not), and its Do Not
          Disturb as Windows reports it. Words are the server's; read-only. */}
      {block.laptop && (block.laptop.opens || []).map((o, i) => (
        <p key={`lo${i}`} className="fblock__quiet">{o.say}</p>
      ))}
      {block.laptop && block.laptop.unreachable && <p className="fblock__quiet">{`Not opened on your laptop — ${block.laptop.unreachable}.`}</p>}
      {block.laptop && block.laptop.dndSay && <p className="fblock__quiet">{block.laptop.dndSay}</p>}

      {block.phase === 'ready' && block.candidates.length > 0 && (
        <ul className="fblock__cands fblock__cands--quiet">
          {block.candidates.map((c) => <li key={c.taskId}>{c.text}</li>)}
        </ul>
      )}

      {block.phase === 'start' && (
        <>
          <ul className="fblock__cands">
            {block.candidates.map((c) => (
              <li key={c.taskId} className="fblock__cand">
                <span className="fblock__cand-text">{c.text}</span>
                {c.smallerStep && <span className="fblock__cand-step">Last time: {c.smallerStep}</span>}
                {c.context && (c.context.jira || c.context.draft || (c.context.notes || []).length > 0 || c.context.microsoft) && (
                  <span className="fblock__cand-ctx">
                    {[
                      c.context.jira,
                      c.context.draft ? `draft: ${c.context.draft.title}` : null,
                      ...(c.context.notes || []).map((n) => n.title),
                      c.context.microsoft ? (c.context.microsoft.plan || c.context.microsoft.source) : null,
                    ].filter(Boolean).join(' · ')}
                  </span>
                )}
                {c.tooBig && <span className="fblock__cand-big">{block.tooBigSay}</span>}
                {act && (
                  <span className="fblock__acts">
                    {c.tooBig ? (
                      <>
                        <input
                          className="fblock__input"
                          type="text"
                          placeholder="The smallest first bit…"
                          value={smaller[c.taskId] || ''}
                          onChange={(e) => setSmaller({ ...smaller, [c.taskId]: e.target.value })}
                        />
                        <button type="button" className="fblock__btn fblock__btn--go" disabled={busy || !(smaller[c.taskId] || '').trim()}
                          onClick={() => act('choose', { taskId: c.taskId, smallerStep: smaller[c.taskId] })}>Start with that</button>
                      </>
                    ) : (
                      <button type="button" className="fblock__btn fblock__btn--go" disabled={busy}
                        onClick={() => act('choose', { taskId: c.taskId, ...(c.smallerStep ? { smallerStep: c.smallerStep } : {}) })}>Start</button>
                    )}
                    <button type="button" className="fblock__btn" disabled={busy}
                      onClick={() => act('choose', { taskId: c.taskId, twoMinute: true })}>Just open it for 2 minutes</button>
                  </span>
                )}
              </li>
            ))}
          </ul>
          {block.candidates.length === 0 && <p className="fblock__quiet">Nothing ranked to offer — pick something from your tasks.</p>}
          {act && (
            <span className="fblock__acts fblock__acts--foot">
              {onSomethingElse && <button type="button" className="fblock__btn" onClick={() => onSomethingElse()}>Something else</button>}
              <button type="button" className="fblock__btn fblock__btn--quiet" disabled={busy} onClick={() => act('not-now')}>Not now</button>
            </span>
          )}
        </>
      )}

      {block.phase === 'two-minute' && act && (
        <span className="fblock__acts">
          <button type="button" className="fblock__btn fblock__btn--go" disabled={busy} onClick={() => act('two-minute', { answer: 'carry-on' })}>Carry on</button>
          <button type="button" className="fblock__btn" disabled={busy} onClick={() => act('two-minute', { answer: 'stop' })}>Stop there</button>
        </span>
      )}

      {block.phase === 'wind-down' && act && (
        <span className="fblock__acts">
          <input className="fblock__input" type="text" placeholder="Where you got to (optional)" value={note}
            onChange={(e) => setNote(e.target.value)} />
          <button type="button" className="fblock__btn" disabled={busy || !note.trim()} onClick={() => act('wind-down', { note })}>Save</button>
        </span>
      )}

      {block.phase === 'end' && act && (
        <>
          <span className="fblock__acts">
            <button type="button" className="fblock__btn fblock__btn--go" disabled={busy} onClick={() => act('end', { answer: 'done' })}>Done</button>
            {(block.moreTime || []).map((m) => (
              <button key={m} type="button" className="fblock__btn" disabled={busy} onClick={() => act('end', { answer: 'more', minutes: m })}>{`${m} more min`}</button>
            ))}
            <button type="button" className="fblock__btn" disabled={busy} onClick={() => setStuck(true)}>Stuck</button>
          </span>
          {stuck && (
            <span className="fblock__acts">
              <input className="fblock__input" type="text" placeholder="Make it smaller — the smallest next bit" value={step}
                onChange={(e) => setStep(e.target.value)} />
              <button type="button" className="fblock__btn" disabled={busy} onClick={() => act('end', { answer: 'stuck', step })}>Keep that</button>
            </span>
          )}
        </>
      )}

      {said && <p className="fblock__said" role="status">{said}</p>}
    </section>
  );
}

export default FocusBlockView;
