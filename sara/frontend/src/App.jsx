import { useEffect, useState } from 'react';

// WS0-WP1 connectivity proof: the frontend reads the shared state model from the
// backend over the defined runtime path (/api) and reports whether the loop is up.
// This is intentionally minimal — it proves runtime health, not features.

export default function App() {
  const [status, setStatus] = useState('connecting');
  const [state, setState] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/state');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (cancelled) return;
        setState(data);
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

  return (
    <main className="sara">
      <header className="sara__header">
        <span className="sara__mark">SARA</span>
        <span className={`sara__dot sara__dot--${status}`} />
        <span className="sara__status">{status}</span>
      </header>

      {state?.placeholder && (
        <div className="sara__banner">
          Placeholder state — central State Engine not wired yet (WS0 scope).
        </div>
      )}

      <section className="sara__panel">
        {status === 'connected' && state && (
          <dl className="sara__kv">
            <dt>runtime</dt>
            <dd>{state.runtime}</dd>
            <dt>sara.status</dt>
            <dd>{state.sara?.status}</dd>
            <dt>backend started</dt>
            <dd>{state.startedAt}</dd>
            <dt>served at</dt>
            <dd>{state.servedAt}</dd>
          </dl>
        )}
        {status === 'disconnected' && (
          <p className="sara__error">
            Backend unreachable on /api/state — {error}
          </p>
        )}
        {status === 'connecting' && <p className="sara__muted">Reaching backend…</p>}
      </section>

      <footer className="sara__footer">
        Runtime foundation only. {state?.sara?.note}
      </footer>
    </main>
  );
}
