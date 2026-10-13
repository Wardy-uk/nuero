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
// ⚠ The field is the control's, UNCHANGED: same component, same drive, same
// colour function. This shell only decides what sits in front of it.
import Field from '../../shared-ui/Field';
import { useFieldDrive, isPressing } from '../../shared-ui/useFieldDrive';
import { surfaceRgb } from '../../shared-ui/fieldDrive.mjs';
import '../../shared-ui/Lit.css';
import SaimHome from './SaimHome';
import { ALT_TABS, ALT_DEFAULT_TAB, resolveAltTab, neuroLink, driveFrom } from './model.mjs';
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

const fetchCanonical = () => apiFetch('/api/canonical/now');

export default function AltApp() {
  const runtime = readRuntime();
  const [authed, setAuthed] = useState(() => !!getPin());
  const [active, setActive] = useState(ALT_DEFAULT_TAB);
  const [handoff, setHandoff] = useState(null);
  const [homeDrive, setHomeDrive] = useState(null);

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
  // shell polls slowly, exactly as the control shell does.
  const onPayload = useCallback((d) => setHomeDrive(driveFrom(d, isPressing)), []);
  const polled = useFieldDrive(fetchCanonical, authed && active !== 'saim');
  const drive = active === 'saim' && homeDrive ? homeDrive : polled;

  const ActiveView = useMemo(() => VIEWS[active] || null, [active]);

  if (runtime.deploymentIssue) return <DeploymentGuard />;
  if (!authed) return <LockScreen onUnlock={() => setAuthed(true)} />;

  return (
    <div className="app lit-scope alt-app" style={{ '--saim-rgb': surfaceRgb(drive) }}>
      <div className="app__field alt-app__field" aria-hidden="true"><Field {...drive} /></div>

      <header className="app__header alt-app__header">
        <span className="app__brand">SAiM</span>
        <span className="alt-marker" title="Experimental treatment — not the everyday SAiM">SAiM Alt</span>
        {runtime.buildLabel && <span className="app__build">{runtime.buildLabel}</span>}
        <span className="alt-app__spacer" />
        <a className="alt-app__link" href={CONTROL_URL}>Control SAiM ↗</a>
        {NEURO_URL && <a className="alt-app__link" href={neuroLink(NEURO_URL, null)} target="_blank" rel="noopener noreferrer">NEURO ↗</a>}
        <button
          className="app__lock"
          type="button"
          onClick={() => { clearPin(); setAuthed(false); }}
          aria-label="Lock / change PIN"
          title="Lock / change PIN"
        >🔒</button>
      </header>

      <nav className="alt-app__nav" aria-label="SAiM Alt">
        {ALT_TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`alt-app__tab${active === t.id ? ' is-on' : ''}`}
            aria-current={active === t.id ? 'page' : undefined}
            onClick={() => go(t.id)}
          >{t.label}</button>
        ))}
      </nav>

      <main className="app__view alt-app__view">
        {handoff && (
          <p className="alt-app__handoff" role="status">
            “{handoff}” lives in NEURO — opened it in a new tab.
            <button type="button" className="alt-link" onClick={() => setHandoff(null)}>OK</button>
          </p>
        )}
        {active === 'saim'
          ? <SaimHome onPayload={onPayload} onNavigate={go} neuroUrl={NEURO_URL} />
          : ActiveView && <ActiveView key={active} onNavigate={go} onShowAll={() => go('saim')} />}
      </main>
    </div>
  );
}
