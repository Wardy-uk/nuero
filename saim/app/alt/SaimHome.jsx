import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch, chatStream } from '../src/api';
import { enqueue, flush, outcomeFor } from '../src/mobile/outbox';
import { matchSaid } from '../../../shared/heard.cjs';
import {
  presence, silence, currentThread, toolHandoff, nextChange, heldWork, judgement, evidence, leadOf,
  neuroLink, deskStateText, deskStateSettled, deskStateBusy,
} from './model.mjs';
import './SaimHome.css';

// SAiM Alt — the desktop companion page.
//
// SAiM's field is her presence; it is not the whole product. This page ALWAYS
// has a work surface: the field gives presence, the foreground gives
// orientation and agency. Uncertainty changes the wording inside the surface —
// it never removes it.
//
//   main — the current thread (NEURO's words verbatim), the step HE named, the
//          server's lifecycle sentences, a tool only when a named step supports
//          one, and a compact contextual Ask/Save line.
//   rail — only what holds something: a waiting approval, a relevant
//          transition, held work (count + Show), and evidence only when it helps
//          resolve uncertainty.
//
// ⚠ Presence follows an evidence priority (model.mjs → presence): recent use of
//   THIS page beats the desk agent, which beats a watch heard in a room. It
//   never says "away from the laptop" while he is using the desk.
// ⚠ Nothing here approves or sends. Desk opens report the server's lifecycle.

const POLL_MS = 60_000;
const SCENARIO_NOTE = 'Scenario mode — nothing was sent to NEURO or the laptop.';

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
  localActiveAt = null, now = Date.now(),
  deskStates = {}, onDeskOpen = null, onAct = null, busy = false,
  heldOpen = false, onToggleHeld = null,
  helpOpen = false, onToggleHelp = null,
  moreOpen = false, onToggleMore = null,
  onBringWork = null,
  dock = null,
}) {
  if (!data) {
    return (
      <div className="alt-home">
        <div className="alt-grid alt-grid--solo">
          <section className="alt-thread" aria-label="The current thread">
            <p className="alt-thread__title alt-thread__title--small">{error ? `I can’t reach NEURO — ${error}.` : 'Reading the room…'}</p>
            <div className="alt-thread__dock">{dock}</div>
          </section>
        </div>
      </div>
    );
  }

  const opts = { localActiveAt, now };
  const p = presence(data, opts);
  const blind = silence(data);
  const thread = currentThread(data, session, opts);
  const tools = toolHandoff(data, thread);
  const change = nextChange(data);
  const held = heldWork(data);
  const judge = judgement(data);
  const ev = evidence(data, thread, p);
  const actionsLink = neuroLink(neuroUrl, 'actions');
  const lead = leadOf(data, thread);
  const prepLink = neuroLink(neuroUrl, 'meeting-prep');
  // Tools belong to a thread. On his own time (off duty) nothing work-shaped is offered.
  const showOthers = (lead === 'thread' || lead === 'context') && !thread.offDuty && tools.mode !== 'blocked' && (Boolean(tools.top) || helpOpen);
  const offerHelp = (lead === 'thread' || lead === 'context') && !thread.offDuty && !showOthers && tools.mode !== 'blocked' && Boolean(onToggleHelp);

  const rail = [];
  if ((judge.count > 0 || !judge.known) && lead !== 'judgement') {
    rail.push(
      <section key="judge" className="alt-rail__block" aria-label="Needs your judgement">
        <h2 className="alt-rail__head">Needs your judgement</h2>
        <p className={`alt-rail__text${judge.count > 0 ? ' is-strong' : ' is-unknown'}`}>{judge.text}</p>
        {judge.count > 0 && actionsLink && (
          <a className="alt-link" href={actionsLink} target="_blank" rel="noopener noreferrer">Review in NEURO →</a>
        )}
      </section>,
    );
  }
  if (change && lead !== 'transition') {
    rail.push(
      <section key="next" className="alt-rail__block" aria-label="Next transition">
        <h2 className="alt-rail__head">Next</h2>
        <p className="alt-rail__text">{change.text}</p>
        {change.question && <p className="alt-rail__sub">{change.question}</p>}
      </section>,
    );
  }
  if (held.count > 0) {
    rail.push(
      <section key="held" className="alt-rail__block" aria-label="Holding the day">
        <h2 className="alt-rail__head">Holding the day</h2>
        <p className="alt-rail__text">{held.line}</p>
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
      </section>,
    );
  }
  if (ev && (lead === 'thread' || lead === 'context')) {
    rail.push(
      <section key="ev" className="alt-rail__block" aria-label="Context">
        <h2 className="alt-rail__head">Context</h2>
        <ul className="alt-trail">
          {ev.lines.map((l, i) => <li key={i}>{l}</li>)}
          {ev.gaps.length > 0 && <li className="alt-trail__gap">Can’t read: {ev.gaps.join('; ')}.</li>}
        </ul>
      </section>,
    );
  }

  return (
    <div className="alt-home">
      {/* ── Presence ─────────────────────────────────────────────────────── */}
      <header className="alt-presence" aria-label="Presence">
        <p className={`alt-presence__who${p.whereKnown ? '' : ' is-unknown'}`}>{p.line1}</p>
        <p className="alt-presence__desk">
          {p.desk}
          {p.operation ? <span className="alt-presence__op"> · {p.operation}{p.operationDetail ? ` — ${p.operationDetail}` : ''}</span> : null}
        </p>
        {p.disagree && <p className="alt-presence__disagree">{p.disagree}</p>}
      </header>

      {error && <p className="alt-home__stale" role="status">Couldn’t refresh — {error}. Showing the last read.</p>}

      <div className={`alt-grid${rail.length ? '' : ' alt-grid--solo'}`}>
        {/* ── Main work area: always present ──────────────────────────── */}
        <section className={`alt-thread alt-thread--${lead}`} aria-label="The current thread">
          {lead === 'transition' && (
            <>
              <p className="alt-label alt-thread__eyebrow">Coming up</p>
              <p className="alt-thread__title">{data.transition.prompt}</p>
              {data.transition.question && <p className="alt-thread__sub">{data.transition.question}</p>}
              <div className="alt-thread__links">
                {prepLink && <a className="alt-quietlink" href={prepLink} target="_blank" rel="noopener noreferrer">Open the prep in NEURO →</a>}
              </div>
              {(thread.state === 'item' || thread.state === 'work') && (
                <p className="alt-thread__held"><span className="alt-label">Holding</span>{thread.item.title}</p>
              )}
            </>
          )}

          {lead === 'judgement' && (
            <>
              <p className="alt-label alt-thread__eyebrow">Needs your judgement</p>
              <p className="alt-thread__title alt-thread__title--small">{judge.text}</p>
              <div className="alt-thread__links">
                {actionsLink && <a className="alt-quietlink" href={actionsLink} target="_blank" rel="noopener noreferrer">Review in NEURO →</a>}
              </div>
              <p className="alt-thread__uncertain">Approve or send in NEURO — nothing is sent from here.</p>
            </>
          )}

          {lead === 'calm' && (
            <p className="alt-thread__title alt-thread__title--small">{data.situation.calmSay || 'Nothing needs you right now.'}</p>
          )}

          {(lead === 'thread' || lead === 'context') && (
            <>
              <p className={`alt-thread__title${thread.state === 'unknown' ? ' alt-thread__title--small' : ''}`}>{thread.item.title}</p>
              {thread.item.sub && <p className="alt-thread__sub">{thread.item.sub}</p>}
              {thread.item.reason && <p className="alt-thread__why">{thread.item.reason}</p>}
              {blind && blind.kind === 'blind' && <p className="alt-warn">{blind.text}</p>}

              {thread.nextStep.known
                ? <p className="alt-thread__next"><span className="alt-label">Next</span>{thread.nextStep.text}</p>
                : thread.uncertain && <p className="alt-thread__uncertain">{thread.uncertain}</p>}

              {tools.mode === 'step' && tools.top && (
                <div className="alt-place__best">
                  <span className="alt-label">Best next place</span>
                  <span className="alt-place__name">{tools.top.label}</span>
                  <ToolButton app={tools.top} onDeskOpen={onDeskOpen} deskStates={deskStates} primary />
                </div>
              )}
              {tools.mode === 'step' && tools.already && <p className="alt-place__already">{tools.already.because} Carry on there.</p>}
              {tools.mode === 'blocked' && thread.nextStep.known && <p className="alt-place__none">Nothing to open — {tools.blockedWhy}.</p>}
              {tools.top && !onDeskOpen && <p className="alt-tool__why">This screen can’t reach the laptop, so nothing here can open.</p>}

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

              {showOthers && tools.row.length > 0 && (
                <div className="alt-ways" aria-label="Other ways in">
                  <span className="alt-label">{tools.top ? 'Other ways in' : 'Ways in'}</span>
                  <div className="alt-ways__row">
                    {tools.row.map((a) => <ToolButton key={a.id} app={a} onDeskOpen={onDeskOpen} deskStates={deskStates} />)}
                    {tools.more.length > 0 && onToggleMore && (
                      <button type="button" className="alt-link" aria-expanded={moreOpen} onClick={onToggleMore}>
                        {moreOpen ? 'Fewer' : `More available apps (${tools.more.length})`}
                      </button>
                    )}
                  </div>
                  {moreOpen && tools.more.length > 0 && (
                    <div className="alt-ways__row">
                      {tools.more.map((a) => <ToolButton key={a.id} app={a} onDeskOpen={onDeskOpen} deskStates={deskStates} />)}
                    </div>
                  )}
                </div>
              )}

              {(offerHelp || (thread.canBringWork && onBringWork)) && (
                <div className="alt-thread__links">
                  {offerHelp && (
                    <button type="button" className="alt-quietlink" onClick={onToggleHelp}>Help me move this forward</button>
                  )}
                  {thread.canBringWork && onBringWork && (
                    <button type="button" className="alt-quietlink" disabled={busy} onClick={onBringWork}>Bring work back</button>
                  )}
                </div>
              )}
            </>
          )}

          <div className="alt-thread__dock">{dock}</div>
        </section>

        {rail.length > 0 && <aside className="alt-rail" aria-label="Supporting">{rail}</aside>}
      </div>
    </div>
  );
}


/**
 * The compact contextual input, always on the work surface. Two different verbs:
 *   Ask  (Enter) — an offered sentence is acted on, else a chat question.
 *   Save         — a capture, through the SAME outbox as the Capture tab: on
 *                  disk first, then sent; the box clears only once it is queued.
 */
export function Dock({ utterances, onSay, placeholder = 'Ask SAiM or capture anything…', scenario = false }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);       // { ok, msg }
  const [answer, setAnswer] = useState(null);   // { question, text, thinking, error }

  async function capture() {
    if (scenario) { setNote({ ok: true, msg: SCENARIO_NOTE }); return; }
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
    if (scenario) { setNote({ ok: true, msg: SCENARIO_NOTE }); return; }
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
        />
        <button type="submit" className="alt-quietlink" disabled={busy || !text.trim()} title="Ask SAiM (Enter)">Ask</button>
        <button type="button" className="alt-quietlink" disabled={busy || !text.trim()} onClick={capture} title="Save as a capture in NEURO">Save</button>
      </form>
      {note && <p className={`alt-dock__note${note.ok ? '' : ' is-bad'}`} role="status">{note.msg}</p>}
    </div>
  );
}

/** The live container: polls the canonical read and owns every write. */
/**
 * Recent use of THIS page, as direct evidence he is at this desk now.
 *
 * ⚠ Narrow on purpose: memory only (a timestamp in React state — never
 *   localStorage, never sent anywhere, gone on reload), only real input
 *   (pointer, key, wheel, focus) while the page is visible, and coarse (one
 *   update per 15s at most). It is not a second state engine; it answers one
 *   question — "is someone using this screen?" — so presence never says "away
 *   from the laptop" to the person using it.
 */
function useLocalActivity() {
  const [at, setAt] = useState(null);
  const last = useRef(0);
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const mark = () => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      const t = Date.now();
      if (t - last.current < 15_000) return;
      last.current = t;
      setAt(t);
    };
    const events = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'focus'];
    events.forEach((e) => window.addEventListener(e, mark, { passive: true }));
    return () => events.forEach((e) => window.removeEventListener(e, mark));
  }, []);
  // A clock tick so "recent" can lapse without another event.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  return { at, now: Math.max(now, at || 0) };
}

/**
 * The live container: polls the canonical read and owns every write.
 *
 * `scenario` (development only, SAiM Alt only — see scenarios.mjs): a fixture
 * replaces the read. In that mode NOTHING is fetched, polled or written — every
 * write path below begins with the same guard and says so instead.
 */
export default function SaimHome({ onPayload, onNavigate, neuroUrl, scenario = null }) {
  const [state, setState] = useState({ data: null, error: null });
  const [session, setSession] = useState(null);
  const [busy, setBusy] = useState(false);
  const [heldOpen, setHeldOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [deskStates, setDeskStates] = useState({});
  const [deskReachable, setDeskReachable] = useState(true);
  const [actNote, setActNote] = useState(null);
  const local = useLocalActivity();
  const alive = useRef(true);
  const hadData = useRef(false);

  const load = useCallback(async () => {
    if (scenario) {
      setState({ data: scenario.data, error: null });
      setSession(scenario.session || null);
      onPayload && onPayload(scenario.data);
      return scenario.data;
    }
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
  }, [onPayload, scenario]);

  useEffect(() => {
    alive.current = true;
    load();
    if (scenario) return () => { alive.current = false; };   // a fixture is never polled
    const t = setInterval(load, POLL_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') load(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { alive.current = false; clearInterval(t); document.removeEventListener('visibilitychange', onVisible); };
  }, [load]);

  async function deskOpen(app) {
    if (scenario) { setActNote(SCENARIO_NOTE); return; }
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
    if (scenario) { setActNote(SCENARIO_NOTE); return; }
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

  // "Bring work back": tells NEURO he is working (its existing life-declare
  // route), which releases held work; the page re-reads and shows whatever
  // thread NEURO surfaces. No desktop intent, no step invented.
  async function bringWork() {
    if (scenario) { setActNote(SCENARIO_NOTE); return; }
    setBusy(true);
    setActNote(null);
    try {
      await apiFetch('/api/signals/life/declare', { method: 'POST', body: JSON.stringify({ doing: 'working' }) });
      const d = await load();
      if (d && currentThread(d, null).state !== 'item') setActNote((d.situation && d.situation.calmSay) || 'Work is back — nothing needs you right now.');
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
        localActiveAt={scenario ? (scenario.localActive ? local.now : null) : local.at}
        now={local.now}
        deskStates={deskStates}
        onDeskOpen={deskReachable ? deskOpen : null}
        onAct={onSay}
        busy={busy}
        heldOpen={heldOpen}
        onToggleHeld={() => setHeldOpen((o) => !o)}
        helpOpen={helpOpen}
        onToggleHelp={() => setHelpOpen((o) => !o)}
        moreOpen={moreOpen}
        onToggleMore={() => setMoreOpen((o) => !o)}
        onBringWork={bringWork}
        dock={<Dock utterances={state.data?.utterances} onSay={onSay} scenario={Boolean(scenario)} />}
      />
    </>
  );
}
