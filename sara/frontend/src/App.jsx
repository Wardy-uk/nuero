import { useEffect, useState } from 'react';

// WS1-WP1: the frontend reads the single shared runtime model (State Engine v1)
// from the backend over the existing /api path and renders SARA's derived briefing
// plus a per-domain summary. Data is seeded (hardcoded) in WS1 — surfaced honestly
// via the seed banner rather than the old WS0 placeholder flag.

const DOMAIN_ORDER = ['queue', 'focus', 'people', 'vault'];

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

  const domains = state?.domains;

  return (
    <main className="sara">
      <header className="sara__header">
        <span className="sara__mark">SARA</span>
        <span className={`sara__dot sara__dot--${status}`} />
        <span className="sara__status">{status}</span>
      </header>

      {state?.dataSource === 'seed' && (
        <div className="sara__banner">
          Seed data — State Engine v1 contract is live, inputs are hardcoded (WS1 scope).
        </div>
      )}

      <section className="sara__panel">
        {status === 'connected' && state && (
          <>
            <p className="sara__briefing">{state.briefing?.line}</p>
            <dl className="sara__kv">
              <dt>runtime</dt>
              <dd>{state.runtime}</dd>
              <dt>contract</dt>
              <dd>
                {state.contract} (v{state.schemaVersion})
              </dd>
              <dt>valid</dt>
              <dd>{String(state.meta?.valid)}</dd>
              <dt>served at</dt>
              <dd>{state.servedAt}</dd>
            </dl>
            {domains && (
              <ul className="sara__domains">
                {DOMAIN_ORDER.map((name) => (
                  <li key={name}>
                    <span className="sara__domain-name">{name}</span>
                    <span className="sara__domain-summary">{domains[name]?.summary}</span>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
        {status === 'disconnected' && (
          <p className="sara__error">Backend unreachable on /api/state — {error}</p>
        )}
        {status === 'connecting' && <p className="sara__muted">Reaching backend…</p>}
      </section>

      <footer className="sara__footer">{state?.sara?.note}</footer>
    </main>
  );
}
