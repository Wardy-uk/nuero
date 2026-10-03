import React, { useState } from 'react';
import { useCanonical, DomainChips, when } from './canonicalUi';
import './Canonical.css';

/**
 * Findings — what NEURO is noticing, and what it decided to do about it
 * (Build 10J). Deep NEURO, never SAiM.
 *
 * Reads /api/canonical/findings: every evaluator's findings with the attention
 * verdict beside them. Shadow is said on every row — a shadow finding was
 * judged, recorded and deliberately NOT sent. The "why" lines are the
 * evaluators' own short audit strings; there is no model reasoning here.
 *
 * ⚠ No finding row records the evaluator version it was produced by, so the
 * version shown is the current code's and is labelled as such.
 */
export default function FindingsPanel() {
  const [status, setStatus] = useState('active');
  const { data, error, loading, reload } = useCanonical(`/api/canonical/findings?status=${status}`);
  return (
    <div className="cn-panel">
      <div className="cn-head">
        <h2 className="cn-title">Findings</h2>
        <button type="button" className="cn-btn" onClick={reload}>Refresh</button>
      </div>
      <p className="cn-sub">What NEURO is noticing, and what its attention policy decided. Shadow means judged and recorded, never sent.</p>
      <div className="cn-tabs">
        {['active', 'resolved', 'all'].map((s) => (
          <button key={s} type="button" className={`cn-tab${status === s ? ' cn-tab--on' : ''}`} onClick={() => setStatus(s)}>{s}</button>
        ))}
      </div>
      {data && (
        <div className="cn-evals">
          {data.evaluators.map((e) => (
            <span key={e.name} className={`cn-eval${e.readable ? '' : ' cn-eval--bad'}`} title={e.error || undefined}>
              {e.label} · {e.mode}{e.shadow ? ' (shadow)' : ''} · current rules {e.version} · {e.readable ? `${e.count}` : 'unreadable'}
            </span>
          ))}
        </div>
      )}
      {loading && !data && <div className="cn-muted">Reading findings…</div>}
      {error && <div className="cn-error">Couldn’t read findings — {error}. Not the same as nothing noticed.</div>}
      {data && !data.findings.length && <div className="cn-empty">No {status === 'all' ? '' : `${status} `}findings from any evaluator that could be read.</div>}
      <ul className="cn-list">
        {data && data.findings.map((f) => (
          <li key={f.id} className="cn-row cn-finding">
            <div className="cn-src-top">
              <span className="cn-chip cn-chip--firm">{f.evaluatorLabel}</span>
              <span className="cn-muted">{f.type}</span>
              {f.severity && <span className="cn-chip">{f.severity}</span>}
              <span className="cn-chip">{f.shadow ? 'shadow' : 'live'}</span>
              <span className="cn-muted">{f.status} · {f.lifecycle}</span>
            </div>
            <div className="cn-rowtitle">{f.title}</div>
            {f.summary && <div className="cn-muted">{f.summary}</div>}
            <div className="cn-meta">
              <span>confidence {f.confidence != null ? `${Math.round(f.confidence * 100)}%` : 'not stated'}</span>
              <span>noticed {when(f.createdAt)}</span>
              {f.resolvedAt && <span>resolved {when(f.resolvedAt)}</span>}
              {f.domains && <DomainChips domains={{ domains: f.domains }} showUnknown={false} />}
            </div>
            <div className="cn-verdictline">
              {!f.attention.decided
                ? 'Attention has not judged this yet.'
                : f.attention.wouldInterrupt
                  ? `Would interrupt${f.attention.sent ? ' — and did' : ' — held back (shadow)'}.`
                  : `Would not interrupt${f.attention.suppressedBecause ? ` — ${f.attention.suppressedBecause}` : ''}.`}
              {f.attention.deferredTo && <span className="cn-muted"> Deferred to {f.attention.deferredTo}.</span>}
            </div>
            {f.evidenceRefs.length > 0 && (
              <details className="cn-refs">
                <summary>{f.evidenceRefs.length} evidence reference(s)</summary>
                <ul>{f.evidenceRefs.map((r) => <li key={r} className="cn-path">{r.length > 60 ? `${r.slice(0, 57)}…` : r}</li>)}</ul>
              </details>
            )}
            <div className="cn-muted cn-small">rules: {f.evaluatorVersion} (current code — the version that produced this row was not recorded)</div>
          </li>
        ))}
      </ul>
    </div>
  );
}
