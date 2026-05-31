import { createContext, useContext, useEffect, useState } from 'react';
import { SHARED_PRESENTATION } from './presentation';
import { DEFAULT_VIEW } from './views';

// SARA shared state/context — the single in-app source of truth for every screen
// (WS2-WP1).
//
// Charter principle 7: all screens must read from the same shared state/context
// model; a screen may format, prioritise, or hide data, but must not become a
// separate source of truth. This provider is that shared layer for the frontend.
//
// It assembles three things into ONE value that screens consume read-only:
//   1. `model`        — the WS1 State Engine model, fetched from /api/state. This is
//                       the authoritative shared state (current state, location,
//                       confidence, current goal/focus, domains). The frontend does
//                       NOT re-derive or own any of it.
//   2. `presentation` — the shared placeholder UI-only fields (What Matters Now, Up
//                       Next, Quick Actions) housed in shared state (see
//                       presentation.js), NOT inside any screen. Every view reads
//                       this one block.
//   3. `now`          — a live clock ticked here, so screens read the current time
//                       from shared state instead of owning a timer of their own.
//
// It also holds the current-view selection (`currentView` / `setCurrentView`) — the
// concrete "current view" concept the architecture is built around.

const SaraStateContext = createContext(null);

export function SaraStateProvider({ children }) {
  const [status, setStatus] = useState('connecting'); // connecting | connected | disconnected
  const [model, setModel] = useState(null);
  const [error, setError] = useState(null);
  const [now, setNow] = useState(() => new Date());
  const [currentView, setCurrentView] = useState(DEFAULT_VIEW);

  // Read the one shared state model from the backend (the WS1 runtime path).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/state');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (cancelled) return;
        setModel(data);
        setStatus('connected');
      } catch (e) {
        if (cancelled) return;
        setError(e.message);
        setStatus('disconnected');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Live clock lives in shared state, not in any screen, so "current time" stays a
  // representation of shared state like everything else on a view.
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const value = {
    status,
    error,
    model,
    now,
    presentation: SHARED_PRESENTATION,
    currentView,
    setCurrentView,
  };

  return <SaraStateContext.Provider value={value}>{children}</SaraStateContext.Provider>;
}

// Read-only accessor. Throwing here keeps the discipline honest: a screen can only
// get its data by being mounted inside the shared-state provider.
export function useSaraState() {
  const ctx = useContext(SaraStateContext);
  if (!ctx) throw new Error('useSaraState must be used within a SaraStateProvider');
  return ctx;
}
