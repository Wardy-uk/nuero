import { useCallback, useState } from 'react';
import * as api from './api';
import SignIn from './views/SignIn.jsx';
import Home from './views/Home.jsx';
import Wall from './views/Wall.jsx';

/**
 * VESTA — the shared home surface. Nick's is SAiM; this one is the household's.
 *
 * Sign in, home, or the family WALL (15 Oct 2026) — an always-on screen in the
 * house. The wall is a mode chosen on the device (or `?wall=1` in the URL), not
 * a route: there is still nothing to navigate to.
 */
export default function App() {
  // A token in storage is a resumed session, not a verified one — `/home`
  // decides, and a 401 there drops straight back here.
  const [session, setSession] = useState(() => (api.getToken() ? { resumed: true } : null));
  const [wall, setWall] = useState(() => api.getWallMode());

  const signOut = useCallback(() => {
    api.clearToken();
    setSession(null);
  }, []);

  const toWall = useCallback((on) => { api.setWallMode(on); setWall(on); }, []);

  if (session && wall) {
    return (
      <div className="app app--wall">
        <Wall onExit={() => toWall(false)} onSignedOut={signOut} />
      </div>
    );
  }

  return (
    <div className="app">
      {session
        ? <Home onSignedOut={signOut} onWall={() => toWall(true)} />
        : <SignIn onSignedIn={setSession} />}
    </div>
  );
}
