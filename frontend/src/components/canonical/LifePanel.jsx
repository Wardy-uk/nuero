import React, { useState } from 'react';
import { useCanonical, postCanonical, DOMAIN_IDS, DOMAIN_LABELS } from './canonicalUi';
import './Canonical.css';

/**
 * Life — the whole of Nick's life as the world model can currently see it
 * (Build 10C/10G). Two things, both honest about how thin they are:
 *
 *  • Goals and intentions — ONLY what Nick has stored. NEURO never proposes
 *    one, never turns one into a task, never nags about one. An empty list is
 *    the correct state until he writes one down.
 *  • Coverage by life domain — how many commitments, sources, goals and
 *    upcoming events carry EVIDENCE of belonging to each domain. A row of
 *    zeros is kept, not hidden: it is the measurement that work is better
 *    instrumented than the rest of his life, which is the point.
 */
export default function LifePanel() {
  const { data, error, loading, reload } = useCanonical('/api/canonical/life');
  const [title, setTitle] = useState('');
  const [domain, setDomain] = useState('');
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState(null);

  const add = async (e) => {
    e.preventDefault();
    if (!title.trim()) return;
    setBusy(true); setSaveError(null);
    try { await postCanonical('/api/canonical/goals', { title, domains: domain ? [domain] : null }); setTitle(''); setDomain(''); await reload(); }
    catch (err) { setSaveError(err.message); }
    setBusy(false);
  };
  const setStatus = async (g, status) => {
    setBusy(true); setSaveError(null);
    try { await postCanonical(`/api/canonical/goals/${encodeURIComponent(g.id)}`, { status }); await reload(); }
    catch (err) { setSaveError(err.message); }
    setBusy(false);
  };

  return (
    <div className="cn-panel">
      <div className="cn-head">
        <h2 className="cn-title">Life</h2>
        <button type="button" className="cn-btn" onClick={reload}>Refresh</button>
      </div>
      <p className="cn-sub">Work is one part of this. What NEURO can see across the rest, and what you have said you want.</p>
      {loading && !data && <div className="cn-muted">Reading…</div>}
      {error && <div className="cn-error">Couldn’t read this — {error}</div>}

      <section className="cn-section">
        <h3 className="cn-h3">Goals and intentions</h3>
        {data && !data.goals.length && <div className="cn-empty">None stored. NEURO only shows goals you write down here — it never makes them up.</div>}
        <ul className="cn-list">
          {data && data.goals.map((g) => (
            <li key={g.id} className="cn-row cn-goal">
              <span className="cn-rowtitle">{g.title}</span>
              {g.domains.map((d) => <span key={d.domain} className="cn-chip cn-chip--firm">{DOMAIN_LABELS[d.domain] || d.domain}</span>)}
              <span className="cn-goal-actions">
                <button type="button" className="cn-btn" disabled={busy} onClick={() => setStatus(g, 'paused')}>Pause</button>
                <button type="button" className="cn-btn" disabled={busy} onClick={() => setStatus(g, 'done')}>Done</button>
                <button type="button" className="cn-btn" disabled={busy} onClick={() => setStatus(g, 'dropped')}>Drop</button>
              </span>
            </li>
          ))}
        </ul>
        <form className="cn-goalform" onSubmit={add}>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. hike once a fortnight" maxLength={300} aria-label="Goal" />
          <select value={domain} onChange={(e) => setDomain(e.target.value)} aria-label="Life domain">
            <option value="">no domain</option>
            {DOMAIN_IDS.map((d) => <option key={d} value={d}>{DOMAIN_LABELS[d]}</option>)}
          </select>
          <button type="submit" className="cn-btn" disabled={busy || !title.trim()}>Add</button>
        </form>
        {saveError && <div className="cn-error">Not saved — {saveError}</div>}
      </section>

      {data && (
        <section className="cn-section">
          <h3 className="cn-h3">What NEURO can see, by part of your life</h3>
          <table className="cn-table">
            <thead><tr><th>Domain</th><th>Commitments</th><th>Upcoming events</th><th>Sources</th><th>Goals</th><th>Set by you</th></tr></thead>
            <tbody>
              {data.coverage.domains.map((r) => {
                const empty = !r.commitments && !r.upcoming && !r.sources && !r.goals;
                return (
                  <tr key={r.domain} className={empty ? 'cn-tr--empty' : undefined}>
                    <td>{r.label}</td><td>{r.commitments}</td><td>{r.upcoming}</td><td>{r.sources}</td><td>{r.goals}</td><td>{r.declared}</td>
                  </tr>
                );
              })}
              <tr className="cn-tr--unknown"><td>domain unknown</td><td>{data.coverage.unknown.commitments}</td><td>{data.coverage.unknown.upcoming}</td><td>—</td><td>—</td><td>—</td></tr>
            </tbody>
          </table>
          <p className="cn-muted">These are counts of evidence, not judgements. Work leans on a colleague’s People note or a task’s default; nothing is guessed for health, family or money.</p>
          {data.gaps && data.gaps.length > 0 && <div className="cn-error">Couldn’t read: {data.gaps.map((g) => g.input).join(', ')}</div>}
        </section>
      )}
    </div>
  );
}
