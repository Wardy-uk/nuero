import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch, chatStream } from '../src/api';
import { enqueue, flush, outcomeFor } from '../src/mobile/outbox';
import { matchSaid } from '../../../shared/heard.cjs';
import {
  presence, silence, currentThread, statement, toolHandoff, nextChange, heldWork, judgement,
  neuroLink, deskStateText, deskStateSettled, deskStateBusy,
} from './model.mjs';
import './SaimHome.css';

// SAiM Alt — the desktop companion page.
//
// TWO MODES, decided by `currentThread`:
//   quiet  — no thread and no named step. Uncertainty is a QUIET state and a
//            successful one: her field fills the screen and only a small
//            statement sits over it ("You’re home. VS Code is open. / I’m
//            holding work for now."), with at most two quiet links. No card, no
//            app chooser, no empty rail, no form, nothing asking him to decide.
//   thread — there is a thread. A compact card: NEURO's wording verbatim, the
//            step HE named, the server's lifecycle sentences, and a tool ONLY
//            when a named step supports one.
//
// ⚠ Nothing here approves or sends; approvals are a statement and a link.
// ⚠ A request sent is not an action completed: desk opens report the server's
//   own lifecycle (waiting → claimed → opened | failed | expired).
// ⚠ An app the laptop did not offer is never a button, and an app already in
//   front is never offered to be opened.

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

/** Held work as a compact count + link; the list only on request. Reranks nothing. */
function Held({ held, open, onToggle }) {
  if (!held.count) return null;
  return (
    <div className="alt-held">
      {onToggle && (
        <button type="button" className="alt-link" aria-expanded={open} onClick={onToggle}>
          {open ? 'Hide what’s held' : `Show what’s held (${held.count})`}
        </button>
      )}
      {open && (
        <ul className="alt-held__list">
          {held.items.map((it, i) => (
            <li key={i}>{it.label}{it.why ? <span className="alt-held__why"> — {it.why}</span> : null}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Only what is actually there: a waiting approval, a relevant transition. */
function Notices({ judge, change, actionsLink }) {
  const items = [];
  if (judge.count > 0) {
    items.push(
      <p key="judge" className="alt-notice alt-notice--judge">
        {judge.text}{' '}
        {actionsLink && <a className="alt-link" href={actionsLink} target="_blank" rel="noopener noreferrer">Review in NEURO →</a>}
      </p>,
    );
  }
  if (change) {
    items.push(
      <p key="next" className="alt-notice">
        <span className="alt-label">Next</span>{change.text}{change.question ? <span className="alt-notice__sub"> {change.question}</span> : null}
      </p>,
    );
  }
  return items.length ? <div className="alt-notices" aria-label="Needs your attention">{items}</div> : null;
}

/**
 * Pure presentational half, exported so it renders under test with no fetch.
 * Every handler is optional; a missing one means the control is not offered.
 */
export function SaimHomeView({
  data, session = null, error = null, neuroUrl = null,
  deskStates = {}, onDeskOpen = null, onAct = null, busy = false,
  heldOpen = false, onToggleHeld = null,
  helpOpen = false, onToggleHelp = null,
  askOpen = false, onQuiet = null,
  dock = null,
}) {
  if (!data) {
    return (
      <div className="alt-home alt-home--quiet">
        <div className="alt-quiet">
          <p className="alt-quiet__line">{error ? `I can’t reach NEURO — ${error}.` : 'Reading the room…'}</p>
        </div>
      </div>
    );
  }

  const thread = currentThread(data, session);
  const held = heldWork(data);
  const judge = judgement(data);
  const change = nextChange(data);
  const actionsLink = neuroLink(neuroUrl, 'actions');
  const stale = error ? <p className="alt-home__stale" role="status">Couldn’t refresh — {error}. Showing the last read.</p> : null;

  // ── Quiet: the field is the content ─────────────────────────────────────
  if (thread.mode === 'quiet') {
    const st = statement(data);
    return (
      <div className="alt-home alt-home--quiet">
        {stale}
        <div className="alt-quiet" aria-label="SAiM">
          {st.lines.map((l, i) => <p key={i} className={i === 0 ? 'alt-quiet__line' : 'alt-quiet__sub'}>{l}</p>)}
          {(st.qualifiers.length > 0 || st.operation) && (
            <p className="alt-quiet__qual">
              {st.qualifiers.join(' ')}
              {st.operation ? <span className="alt-quiet__op">{st.qualifiers.length ? ' · ' : ''}{st.operation}</span> : null}
            </p>
          )}
          <div className="alt-quiet__actions">
            {st.actions.map((a) => (
              <button
                key={a.id}
                type="button"
                className="alt-quietlink"
                aria-expanded={a.id === 'tell' ? askOpen : undefined}
                disabled={!onQuiet || busy}
                onClick={() => onQuiet && onQuiet(a)}
              >{a.label}</button>
            ))}
            <Held held={held} open={heldOpen} onToggle={onToggleHeld} />
          </div>
          {askOpen && dock && <div className="alt-quiet__dock">{dock}</div>}
          <Notices judge={judge} change={change} actionsLink={actionsLink} />
        </div>
      </div>
    );
  }

  // ── Thread: one compact card ────────────────────────────────────────────
  const p = presence(data);
  const blind = silence(data);
  const tools = toolHandoff(data, thread);
  const showOthers = Boolean(tools.top) || helpOpen;
  return (
    <div className="alt-home">
      <header className="alt-presence" aria-label="Presence">
        <p className={`alt-presence__who${p.whereKnown ? '' : ' is-unknown'}`}>{p.line1}</p>
        {p.operation && <p className="alt-presence__op">{p.operation}{p.operationDetail ? ` — ${p.operationDetail}` : ''}</p>}
      </header>
      {stale}

      <section className="alt-thread" aria-label="The current thread">
        <p className="alt-thread__title">{thread.item.title}</p>
        {thread.item.sub && <p className="alt-thread__sub">{thread.item.sub}</p>}
        {thread.item.reason && <p className="alt-thread__why">{thread.item.reason}</p>}
        {blind && blind.kind === 'blind' && <p className="alt-warn">{blind.text}</p>}
        {thread.nextStep.known && <p className="alt-thread__next"><span className="alt-label">Next</span>{thread.nextStep.text}</p>}

        {tools.mode === 'step' && tools.top && (
          <div className="alt-place__best">
            <span className="alt-label">Best next place</span>
            <span className="alt-place__name">{tools.top.label}</span>
            <ToolButton app={tools.top} onDeskOpen={onDeskOpen} deskStates={deskStates} primary />
          </div>
        )}
        {tools.mode === 'step' && tools.already && <p className="alt-place__already">{tools.already.because}</p>}

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

        {tools.mode === 'blocked' && tools.top === null && thread.nextStep.known && (
          <p className="alt-place__none">Nothing to open — {tools.blockedWhy}.</p>
        )}
        {tools.top && !onDeskOpen && <p className="alt-tool__why">This screen can’t reach the laptop, so nothing here can open.</p>}

        <div className="alt-thread__foot">
          {tools.mode !== 'blocked' && !showOthers && onToggleHelp && (
            <button type="button" className="alt-quietlink" onClick={onToggleHelp}>Help me move this forward</button>
          )}
          {onQuiet && (
            <button type="button" className="alt-quietlink" aria-expanded={askOpen} onClick={() => onQuiet({ id: 'tell' })}>Ask about this</button>
          )}
          <Held held={held} open={heldOpen} onToggle={onToggleHeld} />
        </div>

        {showOthers && tools.mode !== 'blocked' && tools.row.length > 0 && (
          <div className="alt-ways" aria-label="Other ways in">
            <span className="alt-label">Other ways in</span>
            <div className="alt-ways__row">
              {tools.row.map((a) => <ToolButton key={a.id} app={a} onDeskOpen={onDeskOpen} deskStates={deskStates} />)}
            </div>
          </div>
        )}
        {askOpen && dock && <div className="alt-thread__dock">{dock}</div>}
      </section>

      <Notices judge={judge} change={change} actionsLink={actionsLink} />
    </div>
  );
}

/**
 * A compact contextual input, opened on request. Two clearly different verbs:
 *   Ask  (Enter) — an offered sentence is acted on, else a chat question.
 *   Save         — a capture, through the SAME outbox as the Capture tab: on
 *                  disk first, then sent; the box clears only once it is queued.
 */
export function Dock({ utterances, onSay, placeholder = 'Ask SAiM or capture anything…' }) {
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
          <p className="alt-dock__q">{answer.question}</p>
          <p className="alt-dock__a">{answer.error ? `I couldn’t answer — ${answer.error}` : (answer.text || (answer.thinking ? '…' : ''))}</p>
        </div>
      )}
      <form className="alt-dock__line" onSubmit={(e) => { e.preventDefault(); ask(); }}>
        <input
          className="alt-input alt-dock__input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={placeholder}
          aria-label={placeholder}
          autoFocus
        />
        <button type="submit" className="alt-quietlink" disabled={busy || !text.trim()} title="Ask SAiM (Enter)">Ask</button>
        <button type="button" className="alt-quietlink" disabled={busy || !text.trim()} onClick={capture} title="Save as a capture in NEURO">Save</button>
      </form>
      {note && <p className={`alt-dock__note${note.ok ? '' : ' is-bad'}`} role="status">{note.msg}</p>}
    </div>
  );
}

/** The live container: polls the canonical read and owns every write. */
export default function SaimHome({ onPayload, onNavigate, neuroUrl }) {
  const [state, setState] = useState({ data: null, error: null });
  const [session, setSession] = useState(null);
  const [busy, setBusy] = useState(false);
  const [heldOpen, setHeldOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [askOpen, setAskOpen] = useState(false);
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
      if (!alive.current) return null;
      hadData.current = true;
      setState({ data, error: null });
      setSession(sess);
      onPayload && onPayload(data);
      return data;
    } catch (e) {
      if (!alive.current) return null;
      setState((s) => ({ data: s.data, error: e.message }));
      if (!hadData.current) onPayload && onPayload(null);
      return null;
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
      setActNote(e.message || 'That didn’t go through.');
    } finally {
      setBusy(false);
    }
  }

  // The two quiet links. Neither queues a desktop intent.
  //   tell — opens the compact contextual input (Ask / Save).
  //   bring — tells NEURO he is working, which releases held work; the page
  //           then re-reads and shows whatever thread NEURO surfaces. No step
  //           is invented: if NEURO has nothing, that is said.
  async function onQuiet(action) {
    if (!action) return;
    if (action.id === 'tell') { setAskOpen((o) => !o); return; }
    if (action.id !== 'bring') return;
    setBusy(true);
    setActNote(null);
    try {
      await apiFetch('/api/signals/life/declare', { method: 'POST', body: JSON.stringify({ doing: 'working' }) });
      const d = await load();
      if (d && !currentThread(d, null).item) setActNote((d.situation && d.situation.calmSay) || 'Work is back — nothing needs you right now.');
    } catch (e) {
      setActNote(e.message || 'That didn’t go through.');
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
        helpOpen={helpOpen}
        onToggleHelp={() => setHelpOpen((o) => !o)}
        askOpen={askOpen}
        onQuiet={onQuiet}
        dock={<Dock utterances={state.data?.utterances} onSay={onSay} placeholder={askOpen ? 'What are you doing? Ask, or save a note…' : undefined} />}
      />
    </>
  );
}
