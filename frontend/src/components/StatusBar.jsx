import { useEffect, useState } from 'react';
import { watchVersion } from '../../../shared/version-watch.mjs';
import './StatusBar.css';

/* global __APP_BUILD__, __APP_BUILT_AT__ */
const BUILD = typeof __APP_BUILD__ === 'string' ? __APP_BUILD__ : null;
const BUILT_AT = typeof __APP_BUILT_AT__ === 'string' ? __APP_BUILT_AT__ : null;

/**
 * NEURO's status bar (5 Oct 2026), after NOVA's: which build this tab is
 * running, whether the Pi answered, and — in amber — when a newer build is
 * being served than the one on screen. A tab left open across a deploy keeps
 * running the bundle it loaded with and looks entirely normal; this says so.
 *
 * The Pi check is version.json itself: it is served by the same Express that
 * serves the API, so "could not read it" is "the Pi did not answer".
 */
export default function StatusBar() {
  const [state, setState] = useState({ newer: null, reachable: true });
  useEffect(() => watchVersion({ current: BUILD, onState: setState }), []);
  const built = BUILT_AT ? new Date(BUILT_AT).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : null;

  return (
    <footer className={`statusbar${state.newer ? ' statusbar--newer' : ''}`}>
      <span className="statusbar-item">
        <span className={`statusbar-dot ${state.reachable ? 'statusbar-dot--ok' : 'statusbar-dot--bad'}`} />
        {state.reachable ? 'pi5' : 'pi5 not answering'}
      </span>
      <span className="statusbar-spacer" />
      {BUILD && <span className="statusbar-item" title={built ? `Built ${built}` : undefined}>NEURO {BUILD}</span>}
      {state.newer && (
        <button type="button" className="statusbar-update" onClick={() => window.location.reload()}
          title={`This tab is running ${BUILD}; the Pi is serving ${state.newer}. Click to reload.`}>
          {state.newer} available — reload
        </button>
      )}
    </footer>
  );
}
