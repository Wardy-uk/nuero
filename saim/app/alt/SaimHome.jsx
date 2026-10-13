import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch, chatStream } from '../src/api';
import { enqueue, flush, outcomeFor } from '../src/mobile/outbox';
import { matchSaid } from '../../../shared/heard.cjs';
import {
  presence, silence, currentThread, toolHandoff, nextChange, heldWork, judgement, evidence,
  neuroLink, deskStateText, deskStateSettled, deskStateBusy,
} from './model.mjs';
import './SaimHome.css';

// SAiM Alt — the desktop companion page.
//
// ONE dominant thread and a quiet supporting rail, over her field. Every
// sentence about WORK is NEURO's (`/api/canonical/now`), rendered verbatim;
// `model.mjs` decides only how presence is said, which tool comes first, and
// how to say "I can't tell".
//
// ⚠ Nothing here approves or sends. Approvals are a statement and a link to
//   NEURO, where the approval code lives.
// ⚠ A request sent is not an action completed: desk opens report the server's
//   own lifecycle (waiting → claimed → opened | failed | expired), never "done".
// ⚠ An app the laptop did not offer is never a button.

const POLL_MS = 60_000;

/** A desk app as a button — or, when it can't be pressed, as plain text. */
function ToolButton({ app, onDeskOpen, deskStates, primary = false }) {
  const st = deskStates[app.id];
  if (!app.available || !onDeskOpen) {
    return <span className="alt-tool alt-tool--off">{app.label}{app.why ? <span className="alt-tool__why"> — {app.why}</span> : null}</span>;
  }
  return (
    <span className="alt-tool">
      <button
        type="button"
        className={primary ? 'alt-tool__primary' : 'alt-tool__btn'}
        disabled={deskStateBusy(st)}
        onClick={() => onDeskOpen(app.id)}
      >{primary ? `Open ${app.label}` : app.label}</button>
      {st ? <span className={`alt-desk alt-desk--${st}`}>{deskStateText(st)}</span> : null}
    </span>
  );
}

/**
 * Pure presentational half, exported so it renders under test with no fetch.
 * Every handler is optional; a missing one means the control is not offered.
 */
export function SaimHomeView({
  data, session = null, error = null, neuroUrl = null,
  deskStates = {}, onDeskOpen = null, onAct = null, busy = false,
  heldOpen = false, onToggleHeld = null,
  moreOpen = false, onToggleMore = null,
  onNameStep = null,
  dock = null,
}) {
  if (!data) {
    return (
      <div className="alt-home alt-home--bare">
        <p className="alt-home__bare">{error ? `I can’t reach NEURO — ${error}.` : 'Reading the room…'}</p>
        <div className="alt-home__baredock">{dock}</div>
      </div>
    );
  }

  const p = presence(data);
  const blind = silence(data);
  const thread = currentThread(data, session);
  const tools = toolHandoff(data, thread);
  const change = nextChange(data);
  const held = heldWork(data);
  const judge = judgement(data);
  const seen = evidence(data);
  const actionsLink = neuroLink(neuroUrl, 'actions');

  return (
    <div className="alt-home">
      {/* ── Presence: who and where, then the desk and what she is doing ─── */}
      <header className="alt-presence" aria-label="Presence">
        <p className={`alt-presence__who${p.whereKnown ? '' : ' is-unknown'}`}>{p.line1}</p>
        <p className="alt-presence__desk">
          {p.line2}
          {p.operationDetail ? ` — ${p.operationDetail}` : ''}
          {p.device ? <span className="alt-presence__device"> · {p.device}</span> : null}
        </p>
      </header>

      {error && <p className="alt-home__stale" role="status">Couldn’t refresh — {error}. Showing the last read.</p>}

      <div className="alt-grid">
        {/* ── The thread: the one dominant card ────────────────────────── */}
        <section className="alt-thread" aria-label="The current thread">
          {thread.state === 'unknown' ? (
            <>
              <p className="alt-thread__title">{thread.unknown.title}</p>
              <p className="alt-thread__prompt">{thread.unknown.prompt}</p>
            </>
          ) : (
            <>
              <p className="alt-thread__title">{thread.item.title}</p>
              {thread.item.sub && <p className="alt-thread__sub">{thread.item.sub}</p>}
              {thread.item.reason && <p className="alt-thread__why">{thread.item.reason}</p>}
            </>
          )}
          {blind && blind.kind === 'blind' && <p className="alt-warn">{blind.text}</p>}

          {thread.state !== 'unknown' && (
            <div className="alt-thread__step">
              <span className="alt-label">Next step</span>
              {thread.nextStep.known
                ? <span className="alt-thread__steptext">{thread.nextStep.text}</span>
                : <span className="alt-thread__steptext is-unknown">No next step named.</span>}
              {onNameStep && thread.sessionActive && !thread.nextStep.known && (
                <StepForm onSubmit={onNameStep} disabled={busy} />
              )}
            </div>
          )}

          {thread.actions.length > 0 && (
            <div className="alt-thread__actions">
              {thread.actions.map((u) => (
                <button
                  key={`${u.intent.kind}:${u.intent.action || ''}:${u.say}`}
                  type="button"
                  className="alt-pill"
                  disabled={!onAct || busy}
                  onClick={() => onAct && onAct(u)}
                >{u.say}</button>
              ))}
            </div>
          )}

          {/* ── Best next place ─────────────────────────────────────────── */}
          <div className="alt-place" aria-label="Best next place">
            <span className="alt-label">Best next place{tools.host ? ` · ${tools.host}` : ''}</span>
            {tools.top ? (
              <>
                <p className="alt-place__name">{tools.top.label}</p>
                <p className="alt-place__because">{tools.top.because}</p>
                <ToolButton app={tools.top} onDeskOpen={onDeskOpen} deskStates={deskStates} primary />
                {!onDeskOpen && <p className="alt-tool__why">This screen can’t reach the desk queue, so nothing here can open.</p>}

                <div className="alt-ways">
                  <span className="alt-label">Other ways in</span>
                  <div className="alt-ways__row">
                    {[tools.ai, tools.music, ...tools.context].filter(Boolean).map((a) => (
                      <ToolButton key={a.id} app={a} onDeskOpen={onDeskOpen} deskStates={deskStates} />
                    ))}
                  </div>
                  {tools.more.length > 0 && onToggleMore && (
                    <>
                      <button type="button" className="alt-link" aria-expanded={moreOpen} onClick={onToggleMore}>
                        {moreOpen ? 'Fewer apps' : `More available apps (${tools.more.length})`}
                      </button>
                      {moreOpen && (
                        <div className="alt-ways__row alt-ways__more">
                          {tools.more.map((a) => <ToolButton key={a.id} app={a} onDeskOpen={onDeskOpen} deskStates={deskStates} />)}
                        </div>
                      )}
                    </>
                  )}
                </div>
              </>
            ) : (
              <p className="alt-place__none">Nothing to open — {tools.blockedWhy}.</p>
            )}
          </div>

          <div className="alt-thread__dock">{dock}</div>
        </section>

        {/* ── The rail: quiet, supporting ──────────────────────────────── */}
        <aside className="alt-rail" aria-label="Supporting">
          <section className="alt-rail__block" aria-label="Needs your judgement">
            <h2 className="alt-rail__head">Needs your judgement</h2>
            <p className={`alt-rail__text${judge.count > 0 ? ' is-strong' : ''}${judge.known ? '' : ' is-unknown'}`}>{judge.text}</p>
            {judge.count > 0 && actionsLink && (
              <a className="alt-link" href={actionsLink} target="_blank" rel="noopener noreferrer">Review in NEURO →</a>
            )}
          </section>

          {change && (
            <section className="alt-rail__block" aria-label="Next transition">
              <h2 className="alt-rail__head">Next</h2>
              <p className="alt-rail__text">{change.text}</p>
              {change.question && <p className="alt-rail__sub">{change.question}</p>}
            </section>
          )}

          <section className="alt-rail__block" aria-label="Holding the day">
            <h2 className="alt-rail__head">Holding the day</h2>
            {held.count === 0 ? (
              <p className="alt-rail__text">Nothing held back.</p>
            ) : (
              <>
                <p className="alt-rail__text">
                  {`Holding ${held.count} back${held.reasons.length ? `: ${held.reasons.join('; ')}` : ''}.`}
                </p>
                {onToggleHeld && (
                  <button type="button" className="alt-link" aria-expanded={heldOpen} onClick={onToggleHeld}>
                    {heldOpen ? 'Hide held work' : 'Show held work'}
                  </button>
                )}
                {heldOpen && (
                  <ul className="alt-held__list">
                    {held.items.map((it, i) => (
                      <li key={i}>{it.label}{it.why ? <span className="alt-rail__sub"> — {it.why}</span> : null}</li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </section>

          <section className="alt-rail__block" aria-label="What SAiM can see">
            <h2 className="alt-rail__head">What I can see</h2>
            {seen.seen.length === 0 && seen.gaps.length === 0 && <p className="alt-rail__text is-unknown">NEURO gave no evidence with this read.</p>}
            {seen.seen.length > 0 && (
              <ul className="alt-rail__list">{seen.seen.map((s, i) => <li key={i}>{s}</li>)}</ul>
            )}
            {seen.gaps.length > 0 && (
              <p className="alt-rail__gap">Can’t read: {seen.gaps.join('; ')}.</p>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}

function StepForm({ onSubmit, disabled }) {
  const [text, setText] = useState('');
  return (
    <form
      className="alt-stepform"
      onSubmit={(e) => { e.preventDefault(); const t = text.trim(); if (t) { onSubmit(t); setText(''); } }}
    >
      <input
        className="alt-input"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="The smallest physical next step…"
        maxLength={200}
        aria-label="Name the next step"
      />
      <button type="submit" className="alt-pill" disabled={disabled || !text.trim()}>Set</button>
    </form>
  );
}

/**
 * "Ask SAiM or capture anything…" — one line, two clearly different verbs.
 *   Ask  (Enter) — a question; an offered sentence is acted on, else chat.
 *   Save         — a capture, through the SAME outbox as the Capture tab: on
 *                  disk first, then sent; the box clears only once it is queued.
 */
export function Dock({ utterances, onSay }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);       // { ok, msg }
  const [answer, setAnswer] = useState(null);   // { question, text, thinking, error }

  async function capture() {
    const content = text.trim();
    if (!content || busy) return;
    setBusy(true);
    setNote(null);
    let queued;
    try {
      queued = await enqueue('capture.note', { content });
    } catch (err) {
      setNote({ ok: false, msg: `NOT saved — this device couldn’t store it (${err.message}). Your words are still here.` });
      setBusy(false);
      return;
    }
    setText('');
    setNote({ ok: true, msg: 'Saved on this device — not in NEURO yet.' });
    try {
      const result = await flush();
      const outcome = outcomeFor(result.receipts[queued.operationId]);
      if (outcome.state === 'confirmed') setNote({ ok: true, msg: 'Capture saved to NEURO.' });
      else if (outcome.state === 'refused') setNote({ ok: false, msg: `${outcome.message} It’s waiting in Capture.` });
      else setNote({ ok: true, msg: 'Saved on this device — I’ll send it when there’s signal.' });
    } catch {
      setNote({ ok: true, msg: 'Saved on this device — I’ll send it when there’s signal.' });
    } finally {
      setBusy(false);
    }
  }

  async function ask() {
    const question = text.trim();
    if (!question || busy) return;
    setNote(null);
    // A sentence she offered is acted on, not chatted about — matched by string
    // equality against the server's own phrases, never parsed here.
    const heard = matchSaid(question, utterances);
    if (heard && heard.kind === 'utterance') {
      setAnswer({ question, text: heard.utterance.say, thinking: false, error: null });
      setText('');
      await onSay(heard.utterance);
      return;
    }
    setBusy(true);
    setText('');
    setAnswer({ question, text: '', thinking: true, error: null });
    let acc = '';
    try {
      await chatStream({ message: question }, {
        onChunk: (c) => { acc += c; setAnswer((a) => (a ? { ...a, text: acc } : a)); },
        onError: (msg) => setAnswer((a) => (a ? { ...a, error: msg } : a)),
      });
    } catch {
      try {
        const res = await apiFetch('/api/chat/sync', { method: 'POST', body: JSON.stringify({ message: question }) });
        acc = (res && (res.reply || res.content)) || '';
      } catch (e2) {
        setAnswer((a) => (a ? { ...a, thinking: false, error: e2.message } : a));
        setBusy(false);
        return;
      }
    }
    setAnswer((a) => (a ? { ...a, text: acc, thinking: false } : a));
    setBusy(false);
  }

  return (
    <div className="alt-dock" aria-label="Ask SAiM or capture anything">
      {answer && (
        <div className="alt-dock__answer">
          <p className="alt-dock__q">You asked: {answer.question}</p>
          <p className="alt-dock__a">{answer.error ? `I couldn’t answer — ${answer.error}` : (answer.text || (answer.thinking ? '…' : ''))}</p>
          <button type="button" className="alt-link" onClick={() => setAnswer(null)}>Clear</button>
        </div>
      )}
      <form className="alt-dock__line" onSubmit={(e) => { e.preventDefault(); ask(); }}>
        <input
          className="alt-input alt-dock__input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Ask SAiM or capture anything…"
          aria-label="Ask SAiM or capture anything"
        />
        <button type="submit" className="alt-pill alt-pill--strong" disabled={busy || !text.trim()} title="Ask SAiM (Enter)">Ask</button>
        <button type="button" className="alt-pill" disabled={busy || !text.trim()} onClick={capture} title="Save as a capture in NEURO">Save</button>
      </form>
      <p className={`alt-dock__note${note && !note.ok ? ' is-bad' : ''}`} role="status">
        {note ? note.msg : 'Ask gets an answer. Save keeps it as a capture in NEURO.'}
      </p>
    </div>
  );
}

/** The live container: polls the canonical read and owns every write. */
export default function SaimHome({ onPayload, onNavigate, neuroUrl }) {
  const [state, setState] = useState({ data: null, error: null });
  const [session, setSession] = useState(null);
  const [busy, setBusy] = useState(false);
  const [heldOpen, setHeldOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [deskStates, setDeskStates] = useState({});
  const [deskReachable, setDeskReachable] = useState(true);
  const [actNote, setActNote] = useState(null);
  const alive = useRef(true);
  const hadData = useRef(false);

  const load = useCallback(async () => {
    try {
      const [data, sess] = await Promise.all([
        apiFetch('/api/canonical/now'),
        apiFetch('/api/session').catch(() => null),
      ]);
      if (!alive.current) return;
      hadData.current = true;
      setState({ data, error: null });
      setSession(sess);
      onPayload && onPayload(data);
    } catch (e) {
      if (!alive.current) return;
      // An error is not an empty feed: keep the last good read, say it failed.
      setState((s) => ({ data: s.data, error: e.message }));
      // Never had a read: the field must look unresolved, not calm.
      if (!hadData.current) onPayload && onPayload(null);
    }
  }, [onPayload]);

  useEffect(() => {
    alive.current = true;
    load();
    const t = setInterval(load, POLL_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') load(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { alive.current = false; clearInterval(t); document.removeEventListener('visibilitychange', onVisible); };
  }, [load]);

  async function deskOpen(app) {
    setDeskStates((s) => ({ ...s, [app]: 'waiting' }));
    let id;
    try {
      const r = await apiFetch('/api/desktop/intents', {
        method: 'POST',
        body: JSON.stringify({ app, host: state.data?.work?.host || null }),
      });
      if (!r || !r.ok) throw new Error((r && r.reason) || 'refused');
      id = r.intent.id;
    } catch (e) {
      if (e && /not found|404|unreachable|failed to fetch/i.test(e.message || '')) setDeskReachable(false);
      setDeskStates((s) => ({ ...s, [app]: 'failed' }));
      return;
    }
    // Follow it until the machine says what happened — past the server's own
    // deadline, so `expired` is always seen. A failed poll is not an outcome.
    for (let i = 0; i < 45; i++) {
      await new Promise((r) => setTimeout(r, i < 15 ? 2000 : 10000));
      if (!alive.current) return;
      try {
        const st = await apiFetch(`/api/desktop/intents/${encodeURIComponent(id)}`);
        setDeskStates((s) => ({ ...s, [app]: st.state }));
        if (deskStateSettled(st.state)) return;
      } catch { /* keep watching */ }
    }
  }

  // The server's structured intents, dispatched to the API each belongs to —
  // the same closed set the control Surface honours. An unknown kind does nothing.
  async function onSay(u) {
    const intent = u && u.intent;
    if (!intent) return;
    setBusy(true);
    setActNote(null);
    try {
      if (intent.kind === 'act') {
        if (!intent.recordId) { setActNote('That card has no record to act on — nothing was changed.'); return; }
        const res = await apiFetch(`/api/attention/records/${intent.recordId}/act`, {
          method: 'POST',
          body: JSON.stringify({ action: intent.action, minutes: intent.minutes, reason: intent.reason }),
        });
        if (res && res.ok === false) setActNote(res.error || 'NEURO refused that.');
        else if (intent.action === 'complete' && res && res.taskCompleted === false && res.taskWhy) setActNote(res.taskWhy);
      } else if (intent.kind === 'session') {
        if (intent.action === 'start') {
          await apiFetch('/api/session/start', { method: 'POST', body: JSON.stringify({ text: intent.text, source: 'attention' }) });
          if (intent.recordId) {
            await apiFetch(`/api/attention/records/${intent.recordId}/act`, { method: 'POST', body: JSON.stringify({ action: 'start' }) }).catch(() => {});
          }
        } else {
          await apiFetch(`/api/session/${intent.action}`, { method: 'POST', body: JSON.stringify({}) });
          if (intent.action === 'finish' && intent.recordId) {
            await apiFetch(`/api/attention/records/${intent.recordId}/act`, { method: 'POST', body: JSON.stringify({ action: 'complete' }) });
          }
        }
      } else if (intent.kind === 'meeting') {
        const path = ({ finished: 'finished', 'not-attending': 'not-attending' })[intent.action] || 'resume';
        await apiFetch(`/api/attention/meeting/${path}`, { method: 'POST', body: JSON.stringify({ key: intent.key }) });
      } else if (intent.kind === 'navigate') {
        if (intent.tab) onNavigate && onNavigate(intent.tab);
        return;
      } else {
        return;
      }
      await load();
    } catch (e) {
      // Left on screen — a control that clears itself on an error is one he
      // believes worked.
      setActNote(e.message || 'That didn’t go through.');
    } finally {
      setBusy(false);
    }
  }

  async function nameStep(step) {
    setBusy(true);
    try {
      await apiFetch('/api/session/next-step', { method: 'POST', body: JSON.stringify({ step }) });
      await load();
    } catch (e) {
      setActNote(e.message || 'The step wasn’t saved.');
    } finally { setBusy(false); }
  }

  return (
    <>
      {actNote && <p className="alt-home__note" role="status">{actNote}</p>}
      <SaimHomeView
        data={state.data}
        session={session}
        error={state.error}
        neuroUrl={neuroUrl}
        deskStates={deskStates}
        onDeskOpen={deskReachable ? deskOpen : null}
        onAct={onSay}
        busy={busy}
        heldOpen={heldOpen}
        onToggleHeld={() => setHeldOpen((o) => !o)}
        moreOpen={moreOpen}
        onToggleMore={() => setMoreOpen((o) => !o)}
        onNameStep={nameStep}
        dock={<Dock utterances={state.data?.utterances} onSay={onSay} />}
      />
    </>
  );
}
