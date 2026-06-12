import { SaraStateProvider, useSaraState } from './state/saraState';
import { usePresenceLock } from './state/usePresenceLock';
import { SARA_VIEWS, normalizeViewId } from './state/views';
import ViewSwitcher from './components/ViewSwitcher';
import RecommendedView from './components/RecommendedView';
import ViewRouter from './components/ViewRouter';
import ExitButton from './components/ExitButton';
import LockScreen from './components/LockScreen';
import LockCountdown from './components/LockCountdown';

// SARA app shell (WS2-WP1; inference strip WS5-WP1; Exit + auto-lock WS2-WP2/WP3).
//
// The shell provides the shared-state context for every screen, the manual view switcher
// (proof of the many-views architecture), SARA's advisory context inference, an Exit
// control, and a privacy auto-lock. The lock + clock live in an inner component so they
// can read the shared clock from context; the provider itself wraps everything.
function AppShell() {
  const { now, currentView } = useSaraState();
  // Fast watch-driven lock: poll 2s, lock on the first away report. The presence
  // service already does noise-smoothing (7/10 over ~5s), so a second streak layer
  // here would only add latency — awayStreak:1 keeps end-to-end lock ~5-6s.
  // Watch-presence is the primary lock trigger; idle is a long safety-net (15 min) so a
  // glance-display doesn't keep locking itself while you're nearby.
  const { locked, reason, pending, lockNow, unlock, dismissCountdown } = usePresenceLock({
    pollMs: 2000,
    awayStreak: 1,
    idleMs: 15 * 60 * 1000,
    graceMs: 5000, // "Locking…" countdown before an AWAY lock; activity cancels it
  });

  // The Briefing (JARVIS) view is full-bleed: it draws its OWN nav, header and footer,
  // so the shell hides its chrome (ViewSwitcher + SARA-thinks strip) to avoid doubling
  // up. Every other view keeps the shared shell chrome.
  const fullBleed = normalizeViewId(currentView) === SARA_VIEWS.BRIEFING;

  const sysControls = (
    <div className="app__sys">
      <button type="button" className="lockbtn" aria-label="Lock SARA" title="Lock SARA" onClick={lockNow}>
        <span aria-hidden="true">🔒</span>
      </button>
      <ExitButton />
    </div>
  );

  if (fullBleed) {
    return (
      <div className="app app--bleed">
        {/* JARVIS view fills everything and owns its own nav/header/footer. The shell
            still provides the global lock/power controls (fixed) and the lock overlay. */}
        <main className="app__bleed-view">
          <ViewRouter />
        </main>
        <div className="app__sys app__sys--floating">{sysControls.props.children}</div>
        {pending != null && !locked && <LockCountdown seconds={pending} onStay={dismissCountdown} />}
        {locked && <LockScreen reason={reason} now={now} onUnlock={unlock} />}
      </div>
    );
  }

  return (
    <div className="app">
      <div className="app__main">
        <div className="app__nav">
          <ViewSwitcher />
          {sysControls}
        </div>
        <main className="app__view">
          <ViewRouter />
        </main>
      </div>
      <RecommendedView />
      {pending != null && !locked && <LockCountdown seconds={pending} onStay={dismissCountdown} />}
      {locked && <LockScreen reason={reason} now={now} onUnlock={unlock} />}
    </div>
  );
}

export default function App() {
  return (
    <SaraStateProvider>
      <AppShell />
    </SaraStateProvider>
  );
}
