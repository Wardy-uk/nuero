import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch, chatStream } from '../src/api';
import { enqueue, flush, outcomeFor } from '../src/mobile/outbox';
import { matchSaid } from '../../../shared/heard.cjs';
import {
  presence, silence, currentThread, toolHandoff, nextChange, heldWork, judgement,
  neuroLink, deskStateText, deskStateSettled,
} from './model.mjs';
import './SaimHome.css';

// SAiM Alt — the desktop companion page.
//
// A persistent work companion over her field, not a dashboard: where he is,
// the thread he is on, the one tool to reach for, what is coming, what she is
// holding back and what needs his judgement. Every sentence about WORK is
// NEURO's (`/api/canonical/now`), rendered verbatim; `model.mjs` decides only
// layout, the tool order, and how to say "I can't tell".
//
// ⚠ Nothing here approves or sends. Approvals are a statement and a link to
//   NEURO, where the approval code lives. An ambient surface that can send is
//   one that can send by accident.
// ⚠ A request sent is not an action completed: desk opens report the server's
//   own lifecycle (waiting → claimed → opened | failed | expired), never "done".

const POLL_MS = 60_000;

/**
 * Pure presentational half, exported so it renders under test with no fetch.
 * Every handler is optional; a missing one means the control is not offered.
 */
export function SaimHomeView({
  data, session = null, error = null, neuroUrl = null,
  deskStates = {}, onDeskOpen = null, onAct = null, busy = false,
  heldOpen = false, onToggleHeld = null,
  onNameStep = null, onNavigate = null,
  dock = null,
}) {
  if (!data) {
    return (
      <div className="alt-home alt-home--bare">
        <p className="alt-home__bare">{error ? `I can’t reach NEURO — ${error}.` : 'Reading the room…'}</p>
        {dock}
      </div>
    );
  }

  const p = presence(data);
  const quietLine = silence(data);
  const thread = currentThread(data, session);
  const tools = toolHandoff(data, thread);
  const change = nextChange(data);
  const held = heldWork(data);
  const judge = judgement(data);
  const actionsLink = neuroLink(neuroUrl, 'actions');

  return (
    <div className="alt-home">
      {error && <p className="alt-home__stale" role="status">Couldn’t refresh — {error}. Showing the last read.</p>}

      {/* ── Presence ───────────────────────────────────────────────────── */}
      <section className="alt-presence" aria-label="Where SAiM thinks you are">
        <span className={`alt-presence__fact${p.where.known ? '' : ' is-unknown'}`}>{p.where.text}</span>
        <span className={`alt-presence__fact${p.desk.known ? '' : ' is-unknown'}`}>{p.desk.text}</span>
        <span className={`alt-presence__phase${p.operation.known ? '' : ' is-unknown'}`}>
          {p.operation.known ? p.operation.label : 'I can’t say what I’m doing'}
          {p.operation.detail ? <span className="alt-presence__detail"> · {p.operation.detail}</span> : null}
        </span>
      </section>

      {/* ── The current thread ─────────────────────────────────────────── */}
      <section className="alt-card alt-thread" aria-label="The current thread">
        <h2 className="alt-card__eyebrow">The thread</h2>
        {thread.item ? (
          <>
            <p className="alt-thread__title">{thread.item.say || thread.item.title}</p>
            {thread.item.say && thread.item.title && thread.item.title !== thread.item.say && (
              <p className="alt-thread__sub">{thread.item.title}</p>
            )}
            {thread.item.reason && <p className="alt-thread__why">{thread.item.reason}</p>}
          </>
        ) : (
          <p className="alt-thread__title">{quietLine ? quietLine.text : 'Nothing in hand.'}</p>
        )}
        {quietLine && quietLine.kind === 'blind' && thread.item && <p className="alt-warn">{quietLine.text}</p>}
        {!thread.item && thread.workWhy && <p className="alt-thread__why">{thread.workWhy}</p>}

        <div className="alt-thread__step">
          <span className="alt-label">Next step</span>
          {thread.nextStep.known
            ? <span className="alt-thread__steptext">{thread.nextStep.text}</span>
            : <span className="alt-thread__steptext is-unknown">No next step named.</span>}
          {onNameStep && thread.sessionActive && !thread.nextStep.known && (
            <StepForm onSubmit={onNameStep} disabled={busy} />
          )}
        </div>

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
      </section>

      {/* ── Tool handoff ───────────────────────────────────────────────── */}
      <section className="alt-card alt-tools" aria-label="Open on the desk">
        <h2 className="alt-card__eyebrow">Open on {tools.host || 'the desk'}</h2>
        {tools.top ? (
          <div className="alt-tools__top">
            <button
              type="button"
              className="alt-tools__primary"
              disabled={!onDeskOpen || !tools.top.available || deskStates[tools.top.id] === 'waiting' || deskStates[tools.top.id] === 'claimed'}
              onClick={() => onDeskOpen && onDeskOpen(tools.top.id)}
            >{tools.top.label}</button>
            <span className="alt-tools__because">
              {tools.top.because}
              {deskStates[tools.top.id] ? <strong className={`alt-desk alt-desk--${deskStates[tools.top.id]}`}> · {deskStateText(deskStates[tools.top.id])}</strong> : null}
            </span>
          </div>
        ) : (
          <p className="alt-tools__none">Nothing to open — {tools.blockedWhy}.</p>
        )}
        <ul className="alt-tools__alts">
          {tools.alternatives.map((a) => (
            <li key={a.id}>
              <button
                type="button"
                className="alt-tools__alt"
                disabled={!onDeskOpen || !a.available || deskStates[a.id] === 'waiting' || deskStates[a.id] === 'claimed'}
                aria-describedby={a.why ? `why-${a.id}` : undefined}
                onClick={() => onDeskOpen && a.available && onDeskOpen(a.id)}
              >{a.label}</button>
              {!a.available && <span id={`why-${a.id}`} className="alt-tools__why">{a.why}</span>}
              {deskStates[a.id] && <span className={`alt-desk alt-desk--${deskStates[a.id]}`}>{deskStateText(deskStates[a.id])}</span>}
            </li>
          ))}
        </ul>
        {!onDeskOpen && tools.top && <p className="alt-tools__why">This screen can’t reach the desk queue.</p>}
      </section>

      {/* ── Next context change — only when relevant ───────────────────── */}
      {change && (
        <section className="alt-next" aria-label="What changes next">
          <span className="alt-label">Next</span> {change.text}
          {change.question ? <span className="alt-next__q"> {change.question}</span> : null}
        </section>
      )}

      {/* ── Holding the day ─────────────────────────────────────────────── */}
      {held.count > 0 && (
        <section className="alt-held" aria-label="Held back">
          <p className="alt-held__line">
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
                <li key={i}>{it.label}{it.why ? <span className="alt-held__why"> — {it.why}</span> : null}</li>
              ))}
            </ul>
          )}
        </section>
      )}

      {/* ── Needs your judgement ───────────────────────────────────────── */}
      {(judge.count > 0 || !judge.known) && (
        <section className="alt-card alt-judge" aria-label="Needs your judgement">
          <h2 className="alt-card__eyebrow">Needs your judgement</h2>
          <p className="alt-judge__text">{judge.text}</p>
          {judge.known && actionsLink && (
            <a className="alt-link" href={actionsLink} target="_blank" rel="noopener noreferrer">
              Review in NEURO →
            </a>
          )}
          {judge.known && judge.where && <p className="alt-judge__where">Approve in {judge.where}. Nothing is approved or sent from here.</p>}
        </section>
      )}

      {dock}
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
 * "Ask SAiM or capture anything." One box, two verbs.
 * Capture goes through the SAME outbox as the Capture tab: on disk first, then
 * sent, and the box is cleared only once the words are safely queued.
 */
function Dock({ utterances, onSay }) {
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
    setNote({ ok: true, msg: 'Queued on this device — not in NEURO yet.' });
    try {
      const result = await flush();
      const outcome = outcomeFor(result.receipts[queued.operationId]);
      if (outcome.state === 'confirmed') setNote({ ok: true, msg: 'Saved to NEURO.' });
      else if (outcome.state === 'refused') setNote({ ok: false, msg: `${outcome.message} It’s waiting in Capture.` });
      else setNote({ ok: true, msg: 'Queued on this device — I’ll send it when there’s signal.' });
    } catch {
      setNote({ ok: true, msg: 'Queued on this device — I’ll send it when there’s signal.' });
    } finally {
      setBusy(false);
    }
  }

  async function ask() {
    const question = text.trim();
    if (!question || busy) return;
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
    <section className="alt-dock" aria-label="Ask SAiM or capture anything">
      {answer && (
        <div className="alt-dock__answer">
          <p className="alt-dock__q">{answer.question}</p>
          <p className="alt-dock__a">{answer.error ? `I couldn’t answer — ${answer.error}` : (answer.text || (answer.thinking ? '…' : ''))}</p>
          <button type="button" className="alt-link" onClick={() => setAnswer(null)}>Clear</button>
        </div>
      )}
      <textarea
        className="alt-input alt-dock__box"
        rows={2}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(); } }}
        placeholder="Ask SAiM or capture anything"
        aria-label="Ask SAiM or capture anything"
      />
      <div className="alt-dock__row">
        <button type="button" className="alt-pill alt-pill--strong" disabled={busy || !text.trim()} onClick={ask}>Ask</button>
        <button type="button" className="alt-pill" disabled={busy || !text.trim()} onClick={capture}>Capture</button>
        {note && <span className={`alt-dock__note${note.ok ? '' : ' is-bad'}`} role="status">{note.msg}</span>}
      </div>
    </section>
  );
}

/** The live container: polls the canonical read and owns every write. */
export default function SaimHome({ onPayload, onNavigate, neuroUrl }) {
  const [state, setState] = useState({ data: null, error: null });
  const [session, setSession] = useState(null);
  const [busy, setBusy] = useState(false);
  const [heldOpen, setHeldOpen] = useState(false);
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
        onNameStep={nameStep}
        onNavigate={onNavigate}
        dock={<Dock utterances={state.data?.utterances} onSay={onSay} />}
      />
    </>
  );
}
