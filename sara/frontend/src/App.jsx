import { SaraStateProvider, useSaraState } from './state/saraState';
import { usePresenceLock } from './state/usePresenceLock';
import ViewSwitcher from './components/ViewSwitcher';
import RecommendedView from './components/RecommendedView';
import ViewRouter from './components/ViewRouter';
import ExitButton from './components/ExitButton';
import LockScreen from './components/LockScreen';

// SARA app shell (WS2-WP1; inference strip WS5-WP1; Exit + auto-lock WS2-WP2/WP3).
//
// The shell provides the shared-state context for every screen, the manual view switcher
// (proof of the many-views architecture), SARA's advisory context inference, an Exit
// control, and a privacy auto-lock. The lock + clock live in an inner component so they
// can read the shared clock from context; the provider itself wraps everything.
function AppShell() {
  const { now } = useSaraState();
  const { locked, reason, lockNow, unlock } = usePresenceLock();

  return (
    <div className="app">
      {/* Lock covers everything (z above these); render it last so it's on top. */}
      <button
        type="button"
        className="lockbtn"
        aria-label="Lock SARA"
        title="Lock SARA"
        onClick={lockNow}
      >
        <span aria-hidden="true">🔒</span>
      </button>
      <ExitButton />
      <ViewSwitcher />
      <RecommendedView />
      <main className="app__view">
        <ViewRouter />
      </main>
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
