import React from 'react';
import { useCanonical, DomainChips, when } from './canonicalUi';
import './Canonical.css';

/**
 * Sources — what NEURO can currently see (Build 10D).
 *
 * Reads /api/canonical/sources, which is SourceHealth and nothing else. Six
 * verdicts that must never collapse into each other:
 *   seeing · quiet (old reading, transport alive) · stale · failing ·
 *   unknown (no evidence — NOT a green light) · retired (history only)
 * Transport and freshness are shown side by side so a source that is both
 * failing and stale reads as both.
 *
 * Senses not on the event spine yet are NAMED, with no verdict: their checks
 * are the older ones on NEURO Health, and two verdicts for one sense on two
 * screens is the contradiction this screen exists to end.
 */

const VERDICT_CLASS = { seeing: 'ok', quiet: 'quiet', stale: 'warn', failing: 'bad', unknown: 'unknown', retired: 'retired' };

function age(ms) {
  if (ms == null) return null;
  const h = Math.round(ms / 3600000);
  return h >= 24 ? `${Math.round(h / 24)}d` : `${h}h`;
}

function SourceRow({ s }) {
  return (
    <li className={`cn-src cn-src--${VERDICT_CLASS[s.verdict]}`}>
      <div className="cn-src-top">
        <span className={`cn-dot cn-dot--${VERDICT_CLASS[s.verdict]}`} aria-hidden="true" />
        <strong>{s.label}</strong>
        <span className="cn-verdict">{s.verdictLabel}</span>
        <span className="cn-muted">{s.lifecycle}{s.importance ? ` · ${s.importance} importance` : ''}</span>
        <DomainChips domains={{ domains: s.domains }} showUnknown={false} />
      </div>
      {s.what && <div className="cn-muted">Carries {s.what}.</div>}
      <div className="cn-src-grid">
        <div>
          <div className="cn-k">Transport</div>
          <div>{s.transport.state}{s.transport.consecutiveFailures ? ` · ${s.transport.consecutiveFailures} failure(s) in a row` : ''}</div>
          <div className="cn-muted">last success {when(s.transport.lastSuccessAt)}{s.transport.aliveVia ? ` · alive via ${s.transport.aliveVia}` : ''}</div>
          {s.transport.failure && <div className="cn-error">{s.transport.failure}</div>}
        </div>
        <div>
          <div className="cn-k">Freshness</div>
          <div>{s.freshness.state}{s.freshness.basis ? ` (by ${s.freshness.basis})` : ''}</div>
          <div className="cn-muted">last observation {when(s.freshness.lastObservedAt)} · stale after {age(s.freshness.staleAfterMs) || '—'}</div>
          {s.freshness.staleSince && <div className="cn-muted">stale since {when(s.freshness.staleSince)}</div>}
          {s.freshness.quietSince && <div className="cn-muted">quiet since {when(s.freshness.quietSince)}</div>}
        </div>
      </div>
      {s.blind && (
        <div className="cn-blind">
          Blind: {s.blind.condition} ({s.blind.severity}) since {when(s.blind.since)} — {s.blind.why}
          {s.blind.coveredBy && s.blind.coveredBy.length > 0 && <span className="cn-muted"> Covered meanwhile by {s.blind.coveredBy.join(', ')}.</span>}
        </div>
      )}
    </li>
  );
}

export default function SourcesPanel({ onNavigate }) {
  const { data, error, loading, reload } = useCanonical('/api/canonical/sources', { interval: 60000 });
  const counts = data ? data.counts : {};
  const failingJobs = data && data.runtime ? data.runtime.jobs.filter((j) => j.failed24h > 0 || j.overdue > 0) : [];
  return (
    <div className="cn-panel">
      <div className="cn-head">
        <h2 className="cn-title">Sources</h2>
        <button type="button" className="cn-btn" onClick={reload}>Refresh</button>
      </div>
      <p className="cn-sub">What NEURO can currently see, from SourceHealth on the event spine.</p>
      {loading && !data && <div className="cn-muted">Reading SourceHealth…</div>}
      {error && <div className="cn-error">Couldn’t read SourceHealth — {error}. That is not the same as every source being fine.</div>}
      {data && (
        <div className="cn-stats">
          {['seeing', 'quiet', 'stale', 'failing', 'unknown', 'retired'].filter((v) => counts[v]).map((v) => (
            <span key={v} className={v === 'failing' || v === 'stale' ? 'cn-stat--warn' : undefined}>{counts[v]} {v}</span>
          ))}
          {data.projection && data.projection.current === false && <span className="cn-stat--warn">projection {data.projection.lag} event(s) behind</span>}
        </div>
      )}
      <ul className="cn-list">{data && data.spine.map((s) => <SourceRow key={s.sourceId} s={s} />)}</ul>

      {data && data.runtime && (
        <section className="cn-section">
          <h3 className="cn-h3">NEURO’s own jobs</h3>
          {failingJobs.length === 0
            ? <div className="cn-muted">{data.runtime.jobs.length} durable jobs; none failed or overdue in the last 24h.</div>
            : failingJobs.map((j) => (
              <div key={j.name} className="cn-blind">{j.name}: {j.failed24h} failed, {j.overdue} overdue{j.lastError ? ` — ${j.lastError}` : ''}</div>
            ))}
        </section>
      )}

      {data && data.offSpine && (
        <section className="cn-section">
          <h3 className="cn-h3">Not on the event spine yet</h3>
          <p className="cn-muted">NEURO uses these too, but they are still judged by the older checks, so their state is not shown here.
            {onNavigate && <> See <button type="button" className="cn-link" onClick={() => onNavigate('pi-health')}>NEURO Health</button>.</>}</p>
          <ul className="cn-offspine">{data.offSpine.map((o) => <li key={o.id}><strong>{o.label}</strong> <span className="cn-muted">— {o.what}</span></li>)}</ul>
        </section>
      )}
    </div>
  );
}
