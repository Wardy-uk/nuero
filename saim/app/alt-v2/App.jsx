import { useCallback, useEffect, useRef, useState } from 'react';
import { getPin, clearPin, apiFetch } from '../src/api';
import LockScreen from '../src/components/LockScreen';
import DeploymentGuard from '../src/components/DeploymentGuard';
import { readRuntime } from '../src/runtime';
import { startAutoFlush } from '../src/mobile/outbox';
import Review from '../src/views/Review';
import Capture from '../src/views/Capture';
import Now from '../src/views/Now';
import './now-alt.css';
import { isPressing } from '../../shared-ui/useFieldDrive';
import '../../shared-ui/Lit.css';
import Shell from './Shell';
import Dock from './Dock';
import { WorkingView } from './WorkingFixture';
import { NowPageView } from './NowPage';
import { BriefingPageView } from './BriefingPage';
import { ControlsPageView } from './ControlsPage';
import Authority from '../src/views/Authority';
import {
  DEFAULT_TAB, resolveTab, parseDeepLink, subFromSearch, debugFromSearch, neuroLink, driveFrom, deskStateSettled, hhmmOf, workingView,
} from './model.mjs';
import '../src/App.css';
import './v2.css';

// SAiM Alt v2 — the actionable daily front door, over her unchanged field.
//
// Six destinations: SAiM · Now · Briefing · Review · Capture · Controls.
// Review and Capture are the control's own views, mounted unchanged (Capture
// keeps its offline queue). Controls is this build's own page: the control's
// offers "Turn notifications on", which would subscribe THIS origin to push and
// double every notification during the A/B run.
// Anything else a view asks for is NEURO's control room and opens there.
//
// ⚠ Isolation, so the A/B run cannot touch the control: no service worker (so
//   no push subscription — push stays on the control), no screen-usage
//   reporting, its own origin (own PIN, own capture outbox).
// ⚠ One read, every surface: SAiM and Now render the SAME polled payloads, and
//   the field is driven from that same canonical read.

const ENV = import.meta.env || {};
const NEURO_URL = ENV.VITE_NEURO_URL || ENV.VITE_API_URL || '';
const CONTROL_URL = ENV.VITE_CONTROL_URL || 'https://saim.nickward.co.uk';
const POLL_MS = 60_000;

function initialRoute() {
  if (typeof window === 'undefined') return { tab: DEFAULT_TAB, focus: null, sub: null };
  const d = parseDeepLink(window.location.search);
  const r = d ? { tab: d.tab, focus: (d.recordId || d.blockId) ? { recordId: d.recordId, blockId: d.blockId } : null } : { tab: DEFAULT_TAB, focus: null };
  return { ...r, sub: subFromSearch(window.location.search, r.tab) };
}

// `renderSaim` (16 Oct 2026): a build may supply its own SAiM page (the alt-v3
// policy-driven desktop). It gets the same read and the same write paths — this
// App stays the one place that talks to NEURO. Omitted, v2 renders as before.
export default function App({ renderSaim = null, driveFor = null, footer = 'SAiM Alt · comparison build' } = {}) {
  const runtime = readRuntime();
  const [authed, setAuthed] = useState(() => !!getPin());
  const [route, setRoute] = useState(initialRoute);
  const [handoff, setHandoff] = useState(null);
  const [day, setDay] = useState({ canonical: null, adhd: null, taskBlocks: null, session: null, error: null, at: null });
  const [briefing, setBriefing] = useState({ resp: null, error: null });
  const [controls, setControls] = useState({ resp: null, error: null, busy: false });
  const [busy, setBusy] = useState(false);
  const [actNote, setActNote] = useState(null);
  const [actOk, setActOk] = useState(null); // what NEURO did, when it did something worth saying
  const [heldOpen, setHeldOpen] = useState(false);
  const [deskStates, setDeskStates] = useState({});
  const [deskReachable, setDeskReachable] = useState(true);
  const alive = useRef(true);

  useEffect(() => { if (authed) return startAutoFlush(); return undefined; }, [authed]);

  const load = useCallback(async () => {
    // Each source fails on its own: one unreadable source is a named gap on its
    // section, never a blank app.
    const get = (p) => apiFetch(p).then((v) => ({ v }), (e) => ({ e: e.message || 'unreachable' }));
    const [c, a, t, s] = await Promise.all([get('/api/canonical/now'), get('/api/adhd'), get('/api/task-blocks'), get('/api/session')]);
    if (!alive.current) return;
    setDay((prev) => ({
      canonical: c.v || prev.canonical,
      adhd: a.v || prev.adhd,
      taskBlocks: t.v || prev.taskBlocks,
      session: s.v || (s.e ? prev.session : null),
      error: c.e || a.e || t.e || null,
      at: (c.v || a.v) ? Date.now() : prev.at,
    }));
  }, []);

  const loadBriefing = useCallback(async () => {
    try {
      const resp = await apiFetch('/api/briefings/latest?kind=daily');
      if (alive.current) setBriefing({ resp, error: null });
    } catch (e) {
      if (alive.current) setBriefing((b) => ({ resp: b.resp, error: e.message }));
    }
  }, []);

  useEffect(() => {
    if (!authed) return undefined;
    alive.current = true;
    load();
    const t = setInterval(load, POLL_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') load(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { alive.current = false; clearInterval(t); document.removeEventListener('visibilitychange', onVisible); };
  }, [authed, load]);

  useEffect(() => { if (authed && route.tab === 'briefing') loadBriefing(); }, [authed, route.tab, loadBriefing]);

  const loadControls = useCallback(async () => {
    try {
      const resp = await apiFetch('/api/attention/settings');
      if (alive.current) setControls({ resp, error: null, busy: false });
    } catch (e) {
      if (alive.current) setControls((c) => ({ ...c, error: e.message, busy: false }));
    }
  }, []);
  useEffect(() => { if (authed && route.tab === 'controls') loadControls(); }, [authed, route.tab, loadControls]);

  // A settings write shows what NEURO SAVED (its answer), never the value sent.
  async function patchControls(p) {
    setControls((c) => ({ ...c, busy: true, error: null }));
    try {
      const r = await apiFetch('/api/attention/settings', { method: 'PATCH', body: JSON.stringify(p) });
      if (!r || r.ok === false || !r.settings) throw new Error((r && r.error) || 'NEURO didn’t confirm it');
      setControls((c) => ({ resp: { ...(c.resp || {}), settings: r.settings }, error: null, busy: false }));
    } catch (e) {
      setControls((c) => ({ ...c, error: e.message, busy: false }));
    }
  }

  // What SAiM may do: a view PUSHED under Controls (its own history entry, so the
  // phone's back gesture and the browser's Back return to Controls).
  const openAuthority = useCallback(() => {
    setRoute({ tab: 'controls', focus: null, sub: 'authority' });
    if (typeof window !== 'undefined') window.history.pushState({ altSub: 'authority' }, '', '/?tab=controls&view=authority');
  }, []);
  const backToControls = useCallback(() => {
    if (typeof window !== 'undefined' && window.history.state && window.history.state.altSub === 'authority') { window.history.back(); return; }
    setRoute({ tab: 'controls', focus: null, sub: null });
    if (typeof window !== 'undefined') window.history.replaceState(null, '', '/?tab=controls');
  }, []);
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const onPop = () => {
      const d = parseDeepLink(window.location.search);
      const tab = d ? d.tab : DEFAULT_TAB;
      setRoute({ tab, focus: null, sub: subFromSearch(window.location.search, tab) });
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const go = useCallback((id) => {
    const r = resolveTab(id);
    if (r.tab) {
      setRoute({ tab: r.tab, focus: null, sub: null });
      setHandoff(null);
      if (typeof window !== 'undefined') window.history.replaceState(null, '', `/?tab=${r.tab}`);
      return;
    }
    setHandoff(r.requested || 'that');
    const href = neuroLink(NEURO_URL, null);
    if (href && typeof window !== 'undefined') window.open(href, '_blank', 'noopener');
  }, []);

  // ── Writes: every one is NEURO's route, reported as NEURO answered it. ──
  async function run(fn) {
    setBusy(true);
    setActNote(null);
    setActOk(null);
    try { await fn(); await load(); } catch (e) { setActNote(e.message || 'That didn’t go through.'); } finally { setBusy(false); }
  }

  const onAct = (u) => run(async () => {
    const intent = u && u.intent;
    if (!intent) return;
    if (intent.kind === 'start-block') {
      await apiFetch('/api/session/start', {
        // Same route NEURO's task list uses; `minutes` = what is left of the block, when SAiM said so.
        method: 'POST', body: JSON.stringify({ taskId: intent.taskId, text: intent.text, source: 'task-block', ...(Number.isFinite(intent.minutes) ? { minutes: intent.minutes } : {}) }),
      }).catch((e) => refused(e, (m) => (/session-active/.test(m)
        ? 'Something else is already running — finish or pause it first. Nothing was started.'
        : `Not started — ${m}`)));
      return;
    }
    if (intent.kind === 'act') {
      if (!intent.recordId) { setActNote('That card has no record to act on — nothing was changed.'); return; }
      const res = await apiFetch(`/api/attention/records/${encodeURIComponent(intent.recordId)}/act`, {
        method: 'POST', body: JSON.stringify({ action: intent.action, minutes: intent.minutes, reason: intent.reason }),
      });
      if (res && res.ok === false) setActNote(res.error || 'NEURO refused that.');
      else if (intent.action === 'complete' && res && res.taskHeld) setActNote('The tick is held — NEURO didn’t close it yet.');
      else if (intent.action === 'complete' && res && res.taskCompleted === false && res.taskWhy) setActNote(res.taskWhy);
    } else if (intent.kind === 'session') {
      if (intent.action === 'start') {
        // NEURO's session start; a task id when SAiM has the exact task (the rail's "Do now").
        await apiFetch('/api/session/start', { method: 'POST', body: JSON.stringify({ text: intent.text, source: 'attention', ...(Number.isInteger(intent.taskId) ? { taskId: intent.taskId } : {}) }) })
          .catch((e) => refused(e, (m) => (/session-active/.test(m) ? 'Something else is already running — finish or pause it first. Nothing was started.' : `Not started — ${m}`)));
        if (intent.recordId) await apiFetch(`/api/attention/records/${encodeURIComponent(intent.recordId)}/act`, { method: 'POST', body: JSON.stringify({ action: 'start' }) }).catch(() => {});
      } else {
        await apiFetch(`/api/session/${intent.action}`, { method: 'POST', body: JSON.stringify({}) });
        if (intent.action === 'finish' && intent.recordId) {
          await apiFetch(`/api/attention/records/${encodeURIComponent(intent.recordId)}/act`, { method: 'POST', body: JSON.stringify({ action: 'complete' }) });
        }
      }
    } else if (intent.kind === 'block-next') {
      // "Make next": NEURO books this task's own window in the next free slot (POST /api/task-blocks,
      // the route NEURO's task list uses). Said as NEURO answered — the slot it chose, or why not.
      const res = await apiFetch('/api/task-blocks', { method: 'POST', body: JSON.stringify({ taskId: intent.taskId }) })
        .catch((e) => refused(e, (m) => `Not booked — ${m}`));
      if (res && res.ok && res.slot) setActOk(`Booked next: ${res.slot.startTime}–${res.slot.endTime}${res.slot.date && res.slot.date !== new Date().toLocaleDateString('en-CA') ? ` on ${res.slot.date}` : ''}.`);
      else if (res && res.ok === false) setActNote(`Not booked — ${res.error || 'NEURO refused it'}.`);
    } else if (intent.kind === 'meeting') {
      const path = ({ finished: 'finished', 'not-attending': 'not-attending' })[intent.action] || 'resume';
      const res = await apiFetch(`/api/attention/meeting/${path}`, { method: 'POST', body: JSON.stringify({ key: intent.key }) });
      if (res && res.ok === false) setActNote(res.error || 'NEURO refused that.');
    } else if (intent.kind === 'room') {
      // A room offer (17 Oct 2026): the KEY and nothing else — NEURO re-reads the
      // house and re-derives what the offer was. Said as NEURO answered it; a
      // refusal is said as a refusal, never as "done".
      const verb = intent.action === 'accept' ? 'accept' : 'decline';
      const res = await apiFetch(`/api/rooms/${encodeURIComponent(intent.key)}/${verb}`, { method: 'POST', body: JSON.stringify({}) })
        .catch((e) => refused(e, (m) => `Not done — ${m}`));
      if (verb === 'accept') {
        if (res && res.ok) setActOk(res.say || 'Done.');
        else setActNote((res && (res.say || (res.reason && `Not done — ${res.reason}.`))) || 'Not done — NEURO didn’t answer.');
      } else if (res && res.ok === false) setActNote(`Not saved — ${res.reason || 'NEURO refused it'}.`);
    } else if (intent.kind === 'navigate' && intent.tab) {
      go(intent.tab);
    }
  });

  // A refusal comes back as an HTTP error; say what NEURO meant, not the status line.
  const refused = (e, plain) => { throw new Error(plain(String((e && e.message) || ''))); };

  async function deskOpen(app) {
    setDeskStates((s) => ({ ...s, [app]: 'waiting' }));
    let id;
    try {
      const r = await apiFetch('/api/desktop/intents', { method: 'POST', body: JSON.stringify({ app, host: day.canonical?.work?.host || null }) });
      if (!r || !r.ok) throw new Error((r && r.reason) || 'refused');
      id = r.intent.id;
    } catch (e) {
      if (e && /not found|404|unreachable|failed to fetch/i.test(e.message || '')) setDeskReachable(false);
      setDeskStates((s) => ({ ...s, [app]: 'failed' }));
      return;
    }
    // Watched past the server's own deadline, so `expired` is always seen.
    for (let i = 0; i < 45; i++) {
      await new Promise((r) => setTimeout(r, i < 15 ? 2000 : 10000));
      if (!alive.current) return;
      try {
        const st = await apiFetch(`/api/desktop/intents/${encodeURIComponent(id)}`);
        setDeskStates((s) => ({ ...s, [app]: st.state }));
        if (deskStateSettled(st.state)) return;
      } catch { /* a failed poll is not an outcome */ }
    }
  }

  if (runtime.deploymentIssue) return <DeploymentGuard />;
  if (!authed) return <LockScreen onUnlock={() => setAuthed(true)} />;

  const drive = driveFor ? driveFor(day.canonical) : driveFrom(day.canonical, isPressing);
  const updated = day.at ? `Read ${hhmmOf(day.at)}${day.error ? ' · last refresh failed' : ''}` : (day.error ? 'Can’t reach NEURO' : null);

  // ?debug=1 shows the operational chrome; normal view is the moment alone.
  const debug = typeof window !== 'undefined' && debugFromSearch(window.location.search);
  const lock = () => { clearPin(); setAuthed(false); };
  let page;
  if (route.tab === 'saim' && renderSaim) {
    page = renderSaim({
      canonical: day.canonical, error: day.error, at: day.at, busy, focus: route.focus,
      onAct, run, onDeskOpen: deskReachable ? deskOpen : null, deskStates, neuroUrl: NEURO_URL, debug,
      onOpenAuthority: openAuthority,
    });
  } else if (route.tab === 'saim') {
    // Nothing read yet: the same composition, saying so — never a guess about the day.
    const v = (day.canonical || day.adhd)
      ? workingView({ ...day, now: Date.now() })
      : {
        presence: 'SAiM', current: null, step: null, actions: [], tools: null, next: null, held: null, judgement: null,
        note: day.error ? `I can’t reach NEURO — ${day.error}.` : 'Reading the day…',
      };
    // A deep link names a block or a record: say plainly when it has moved on.
    let focusNote = null;
    if (route.focus && route.focus.blockId && !(v.current && v.current.blockId === route.focus.blockId)) {
      focusNote = 'That block isn’t the current one any more.';
    } else if (route.focus && route.focus.recordId && !v.actions.some((a) => a.intent && a.intent.recordId === route.focus.recordId)) {
      focusNote = 'That item isn’t current any more — NEURO has moved on.';
    }
    page = (
      <WorkingView
        v={v} busy={busy} error={(day.canonical || day.adhd) ? day.error : null}
        focus={focusNote ? { note: focusNote } : null}
        onAct={onAct} heldOpen={heldOpen} onToggleHeld={() => setHeldOpen((o) => !o)}
        onDeskOpen={deskReachable ? deskOpen : null} deskStates={deskStates} neuroUrl={NEURO_URL}
        dock={<Dock variant="wk" utterances={day.canonical?.utterances} onSay={onAct} />}
      />
    );
  } else if (route.tab === 'now') {
    // 16 Oct 2026 (Nick): Now is the control's own Now view — same data, same
    // controls — dressed in Alt's look by `now-alt.css` (scoped to .v2-now, so the
    // control app is untouched). NowPageView (the block timeline) stays in the
    // tree for its tests but is no longer routed.
    page = <div className="v2-control v2-now"><Now onNavigate={go} /></div>;
  } else if (route.tab === 'controls' && route.sub === 'authority') {
    // The control's own What SAiM may do screen, unchanged: human-only routes,
    // a read that writes nothing, and every sentence the server's.
    page = (
      <div className="v2-control v2-authority">
        <button type="button" className="v2-link v2-back" onClick={backToControls} aria-label="Back to Controls"><span aria-hidden="true">‹</span> Controls</button>
        <Authority />
      </div>
    );
  } else if (route.tab === 'controls') {
    page = <ControlsPageView onOpenAuthority={openAuthority} onLock={lock}resp={controls.resp} error={controls.error} busy={controls.busy} onPatch={patchControls} notificationsHref={CONTROL_URL ? `${CONTROL_URL.replace(/\/+$/, '')}/?tab=controls` : null} />;
  } else if (route.tab === 'briefing') {
    page = <BriefingPageView resp={briefing.resp} error={briefing.error} neuroUrl={NEURO_URL} />;
  } else {
    const V = { review: Review, capture: Capture }[route.tab];
    page = V ? <div className="v2-control"><V key={route.tab} onNavigate={go} onShowAll={() => go('saim')} /></div> : null;
  }

  return (
    <Shell
      active={route.tab}
      onGo={go}
      drive={drive}
      updated={updated}
      footer={footer}
      debug={debug}
      onLock={lock}
      // The control's ↻: a full reload, so a new deploy is picked up as well as fresh data.
      onRefresh={() => window.location.reload()}
      marker={<a className="v2__ctl" href={CONTROL_URL}>Control ↗</a>}
    >
      {handoff && (
        <p className="v2-note" role="status">
          “{handoff}” lives in NEURO — opened it in a new tab.
          <button type="button" className="v2-link" onClick={() => setHandoff(null)}>OK</button>
        </p>
      )}
      {actNote && <p className="v2-note v2-note--bad" role="status">{actNote}</p>}
      {actOk && !actNote && <p className="v2-note" role="status">{actOk}</p>}
      {page}
    </Shell>
  );
}
