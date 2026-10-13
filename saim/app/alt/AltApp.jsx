import { useCallback, useEffect, useMemo, useState } from 'react';
import { getPin, clearPin, apiFetch } from '../src/api';
import LockScreen from '../src/components/LockScreen';
import DeploymentGuard from '../src/components/DeploymentGuard';
import { readRuntime } from '../src/runtime';
import { startAutoFlush } from '../src/mobile/outbox';
import Now from '../src/views/Now';
import Review from '../src/views/Review';
import Capture from '../src/views/Capture';
import Controls from '../src/views/Controls';
// ⚠ The field drive is the control's, UNCHANGED (see AltShell.jsx).
import { useFieldDrive, isPressing } from '../../shared-ui/useFieldDrive';
import '../../shared-ui/Lit.css';
import AltShell from './AltShell';
import SaimHome from './SaimHome';
import { ALT_DEFAULT_TAB, resolveAltTab, neuroLink, driveFrom, scenarioFromUrl } from './model.mjs';
import '../src/App.css';
import './AltApp.css';

// SAiM Alt — the A/B treatment shell.
//
// Five destinations and nothing else. Anything the reused views try to route to
// that is not one of the five (Tasks, Chat, Prep, Ritual, Who's in) is NEURO's
// control room, so it is handed off to NEURO in a new tab with a note saying so
// — never rebuilt here and never a silent no-op.
//
// ⚠ Deliberately absent, so the experiment cannot contaminate the control:
//   no service worker (no push, no precache), no screen-usage reporting (the
//   server keys usage on `surface: 'saim'` and the treatment would be counted as
//   the control), and no wake-lock toggle.

const ENV = import.meta.env || {};
const CONTROL_URL = ENV.VITE_CONTROL_URL || 'https://saim.nickward.co.uk';
const NEURO_URL = ENV.VITE_NEURO_URL || ENV.VITE_API_URL || '';

const VIEWS = { now: Now, review: Review, capture: Capture, controls: Controls };

export default function AltApp() {
  const runtime = readRuntime();
  const [authed, setAuthed] = useState(() => !!getPin());
  const [active, setActive] = useState(ALT_DEFAULT_TAB);
  const [handoff, setHandoff] = useState(null);
  const [homeDrive, setHomeDrive] = useState(null);
  const [updatedAt, setUpdatedAt] = useState(null);
  // DEVELOPMENT SCENARIOS — SAiM Alt only, only by an explicit ?scenario=<id>.
  // The fixtures are a separate chunk, loaded only when asked for; with no
  // parameter this is null and everything below is the live path.
  const scenarioId = useMemo(() => (typeof window === 'undefined' ? null : scenarioFromUrl(window.location.search)), []);
  const [scenario, setScenario] = useState(null);
  useEffect(() => {
    if (!scenarioId) return undefined;
    let alive = true;
    import('./scenarios.mjs').then((m) => { if (alive) setScenario(m.getScenario(scenarioId)); });
    return () => { alive = false; };
  }, [scenarioId]);

  useEffect(() => {
    if (!authed) return undefined;
    return startAutoFlush();
  }, [authed]);

  const go = useCallback((id) => {
    const r = resolveAltTab(id);
    if (r.tab) { setActive(r.tab); setHandoff(null); return; }
    // Not one of the five: NEURO holds it.
    setHandoff(r.requested || 'that');
    const href = neuroLink(NEURO_URL, null);
    if (href && typeof window !== 'undefined') window.open(href, '_blank', 'noopener');
  }, []);

  // On the SAiM page the field follows the page's own live read; elsewhere the
  // shell polls slowly, exactly as the control shell does. Either way the bar's
  // "Updated" time is the time of the read the screen is showing.
  const onPayload = useCallback((d) => {
    setHomeDrive(driveFrom(d, isPressing));
    if (d && d.generatedAt) setUpdatedAt(d.generatedAt);
  }, []);
  const fetchCanonical = useCallback(async () => {
    const d = await apiFetch('/api/canonical/now');
    if (d && d.generatedAt) setUpdatedAt(d.generatedAt);
    return d;
  }, []);
  const polled = useFieldDrive(fetchCanonical, authed && active !== 'saim');
  const drive = active === 'saim' && homeDrive ? homeDrive : polled;

  const ActiveView = useMemo(() => VIEWS[active] || null, [active]);

  if (runtime.deploymentIssue) return <DeploymentGuard />;
  if (!authed) return <LockScreen onUnlock={() => setAuthed(true)} />;
  if (scenarioId && !scenario) return null; // a moment while the fixture loads — never the live read under its marker

  return (
    <AltShell
      active={active}
      onGo={go}
      drive={drive}
      updatedAt={updatedAt}
      controlUrl={CONTROL_URL}
      neuroUrl={NEURO_URL ? neuroLink(NEURO_URL, null) : null}
      buildLabel={runtime.buildLabel}
      onLock={() => { clearPin(); setAuthed(false); }}
      handoff={handoff}
      onClearHandoff={() => setHandoff(null)}
      scenario={scenario ? { id: scenario.id, label: scenario.label, liveHref: typeof window === 'undefined' ? '/' : window.location.pathname } : null}
    >
      {active === 'saim'
        ? <SaimHome onPayload={onPayload} onNavigate={go} neuroUrl={NEURO_URL} scenario={scenario} />
        : ActiveView && <div className="alt-app__column"><ActiveView key={active} onNavigate={go} onShowAll={() => go('saim')} /></div>}
    </AltShell>
  );
}
