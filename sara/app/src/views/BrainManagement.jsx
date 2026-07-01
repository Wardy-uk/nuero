import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../api';
import './BrainManagement.css';

// Brain management = the Vault Hygiene surface. Small, frequent, do-anywhere jobs.
// Lint on load, then one-tap actions. Orphans surfaced here are the "Speaker N"
// recordings awaiting a name (the naming itself happens in Obsidian).
const basename = (p) => (p || '').split('/').pop().replace(/\.md$/, '');

export default function BrainManagement() {
  const [lint, setLint] = useState({ loading: true, error: null, data: null });
  const [action, setAction] = useState(null); // { key, running, result, error }

  const loadLint = useCallback(async () => {
    setLint({ loading: true, error: null, data: null });
    try {
      const data = await apiFetch('/api/vault-hygiene/lint');
      setLint({ loading: false, error: null, data });
    } catch (error) {
      setLint({ loading: false, error: error.message, data: null });
    }
  }, []);

  useEffect(() => { loadLint(); }, [loadLint]);

  async function run(key, fn) {
    setAction({ key, running: true, result: null, error: null });
    try {
      const result = await fn();
      setAction({ key, running: false, result, error: null });
    } catch (error) {
      setAction({ key, running: false, result: null, error: error.message });
    }
  }

  const ACTIONS = [
    { key: 'plan', label: 'Plan links', desc: 'Preview contextual links (read-only)',
      run: () => apiFetch('/api/vault-hygiene/contextual-link/plan', { method: 'POST', body: JSON.stringify({}) }),
      summary: (r) => `${r.total} links across ${r.notesTouched} notes` },
    { key: 'alias', label: 'Alias suggest', desc: 'Name variants that may be one person',
      run: () => apiFetch('/api/vault-hygiene/alias-suggest?threshold=0.82'),
      summary: (r) => `${r.count} suggestion${r.count === 1 ? '' : 's'}` },
    { key: 'orphans', label: 'Connect orphans', desc: 'Link stragglers into the graph',
      run: () => apiFetch('/api/vault-hygiene/connect-orphans', { method: 'POST', body: JSON.stringify({}) }),
      summary: (r) => `${r.nova} to NOVA · ${r.daily} daily chained` },
    { key: 'reconcile', label: 'PLAUD reconcile', desc: 'Find recordings with no active note',
      run: () => apiFetch('/api/plaud/reconcile', { method: 'POST', body: JSON.stringify({}) }),
      summary: (r) => `${r.reconciled} unmatched recording${r.reconciled === 1 ? '' : 's'}` },
    { key: 'repull', label: 'PLAUD repull', desc: 'Re-pull unmatched recordings (max 10)',
      run: () => apiFetch('/api/plaud/repull', { method: 'POST', body: JSON.stringify({ limit: 10 }) }),
      summary: (r) => `${r.pulled} pulled · ${r.failed} failed` },
  ];

  const counts = lint.data?.counts;

  return (
    <section>
      <h1 className="view__title">Brain</h1>
      <p className="view__lede">Keep the vault healthy from anywhere.</p>

      {lint.loading && <div className="card">Linting the vault…</div>}
      {lint.error && <div className="card err">Couldn’t reach the brain: {lint.error}</div>}

      {counts && (
        <div className="bm__counts">
          <div className="bm__count"><span className="bm__n">{counts.broken}</span><span className="bm__l">broken</span></div>
          <div className="bm__count"><span className="bm__n">{counts.orphans}</span><span className="bm__l">orphans</span></div>
          <div className="bm__count"><span className="bm__n">{counts.underlinkedPeople}</span><span className="bm__l">underlinked</span></div>
          <div className="bm__count"><span className="bm__n">{counts.stale}</span><span className="bm__l">stale</span></div>
        </div>
      )}

      {lint.data?.orphans?.length > 0 && (
        <div className="bm__orphans">
          <div className="bm__h">Orphans to name / link ({lint.data.orphans.length})</div>
          <div className="bm__orphan-list">
            {lint.data.orphans.slice(0, 12).map((o) => (
              <div className="bm__orphan" key={o}>{basename(o)}</div>
            ))}
            {lint.data.orphans.length > 12 && <div className="bm__more">+{lint.data.orphans.length - 12} more</div>}
          </div>
        </div>
      )}

      <div className="bm__actions">
        <div className="bm__h">Actions</div>
        {ACTIONS.map((a) => {
          const active = action?.key === a.key;
          return (
            <div className="card bm__action" key={a.key}>
              <div className="bm__action-main">
                <div className="bm__action-label">{a.label}</div>
                <div className="bm__action-desc">{a.desc}</div>
                {active && action.result && <div className="bm__action-result">✓ {a.summary(action.result)}</div>}
                {active && action.error && <div className="bm__action-result err">✕ {action.error}</div>}
              </div>
              <button className="bm__run" type="button" disabled={active && action.running} onClick={() => run(a.key, a.run)}>
                {active && action.running ? '…' : 'Run'}
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}
