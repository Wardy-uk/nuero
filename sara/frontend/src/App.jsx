import { SaraStateProvider } from './state/saraState';
import ViewSwitcher from './components/ViewSwitcher';
import RecommendedView from './components/RecommendedView';
import ViewRouter from './components/ViewRouter';

// SARA app shell (WS2-WP1; advisory inference strip added WS5-WP1).
//
// The shell provides the shared-state context for every screen, offers the manual view
// switcher (the visible proof of the many-views architecture), shows SARA's advisory
// context inference (RecommendedView — read-only, never auto-switches), and renders
// whichever view is current via ViewRouter. It deliberately holds no screen data —
// screens read shared state directly. This keeps the app from being hardcoded around a
// single home screen, and keeps the recommendation advisory: only the user's click on
// the switcher or the suggestion's button changes the current view.
export default function App() {
  return (
    <SaraStateProvider>
      <div className="app">
        <ViewSwitcher />
        <RecommendedView />
        <main className="app__view">
          <ViewRouter />
        </main>
      </div>
    </SaraStateProvider>
  );
}
