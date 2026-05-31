import { SaraStateProvider } from './state/saraState';
import ViewSwitcher from './components/ViewSwitcher';
import ViewRouter from './components/ViewRouter';

// SARA app shell (WS2-WP1).
//
// The shell does three things and no more: it provides the shared-state context
// for every screen, offers the manual view switcher (the visible proof of the
// many-views architecture), and renders whichever view is current via ViewRouter.
// It deliberately holds no screen data — screens read shared state directly. This
// keeps the app from being hardcoded around a single home screen.
export default function App() {
  return (
    <SaraStateProvider>
      <div className="app">
        <ViewSwitcher />
        <main className="app__view">
          <ViewRouter />
        </main>
      </div>
    </SaraStateProvider>
  );
}
