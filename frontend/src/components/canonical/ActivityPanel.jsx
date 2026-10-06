import React, { useState } from 'react';
import { useCanonical, when } from './canonicalUi';
import './Canonical.css';

/**
 * Activity — "what has NEURO done?" (Build 15D). Deep NEURO, never SAiM.
 *
 * Reads /api/activity/timeline: semantic entries normalised from the records
 * NEURO already keeps (findings, investigations, self-heal attempts, prepared
 * actions, the external-write ledger, refusals, switch flips, runtime gaps,
 * the hiking loop). Not a log viewer — the plumbing of a lifecycle is folded
 * into its meaning on the server, and nothing is re-worded here.
 *
 * The verbs matter and come from the server verbatim: noticed · investigated
 * · recommended · prepared · retried/sent · verified. "Recovered" appears only
 * where a verification proved it.
 */

const FILTER_LABELS = {
  all: 'All', investigations: 'Investigations', actions: 'Actions', sources: 'Sources',
  decisions: 'Decisions', problems: 'Blocked / failed', approvals: 'My approvals',
};
const CATEGORY_WORD = {
  sensed: 'noticed', investigated: 'investigated', decided: 'decided', prepared: 'prepared',
  acted: 'acted', verified: 'verified', recovered: 'recovered', blocked: 'blocked', configured: 'configured',
};
const TONE = { recovered: 'ok', verified: 'ok', confirmed: 'ok', failed: 'bad', uncertain: 'warn', blocked: 'warn', inconclusive: 'warn', manual: 'warn', attempted: 'warn' };

function Entry({ e }) {
  const [open, setOpen] = useState(false);
  const tone = TONE[e.status] || (e.severity === 'warning' ? 'warn' : '');
  const refs = [
    e.findingRef && ['finding', e.findingRef], e.investigationRef && ['investigation', e.investigationRef],
    e.actionRef && ['action', e.actionRef], e.verificationRef && ['verification', e.verificationRef],
    ...e.sourceRefs.map((r) => ['source', r.replace(/^source:/, '')]), ...e.subjectRefs.map((r) => ['subject', r]),
  ].filter(Boolean);
  return (
    <li className={`cn-src cn-act${tone ? ` cn-src--${tone}` : ''}`}>
      <button type="button" className="cn-act-btn" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <div className="cn-src-top">
          <span className="cn-act-time">{when(e.occurredAt)}</span>
          <span className="cn-chip">{CATEGORY_WORD[e.category] || e.category}</span>
          {e.authority && <span className="cn-chip cn-chip--firm" title="authority of what was done">{e.authority}</span>}
          {e.actor === 'nick' && <span className="cn-chip">you</span>}
          {e.actor === 'external-system' && <span className="cn-chip cn-chip--soft">machine client</span>}
          {e.actor === 'system-runtime' && <span className="cn-chip cn-chip--soft">runtime</span>}
          {e.status && <span className="cn-muted">{e.status}</span>}
        </div>
        <div className="cn-rowtitle">{e.headline}</div>
        {e.summary && <div className="cn-muted">{e.summary}</div>}
      </button>
      {open && (
        <div className="cn-act-detail">
          <dl className="cn-dl">
            <dt>Type</dt><dd className="cn-path">{e.type}</dd>
            <dt>When</dt><dd>{new Date(e.occurredAt).toLocaleString('en-GB')}</dd>
            {refs.map(([k, v]) => (<React.Fragment key={`${k}:${v}`}><dt>{k}</dt><dd className="cn-path">{v}</dd></React.Fragment>))}
            {Object.entries(e.metadata || {}).filter(([, v]) => v !== null && typeof v !== 'object').map(([k, v]) => (
              <React.Fragment key={k}><dt>{k}</dt><dd className="cn-path">{String(v)}</dd></React.Fragment>
            ))}
          </dl>
        </div>
      )}
    </li>
  );
}

/** The page, pure over its props — exported so it can be rendered in a test. */
export function ActivityView({ data, error, loading, filter, setFilter, reload }) {
  return (
    <div className="cn-panel">
      <div className="cn-head">
        <h2 className="cn-title">Activity</h2>
        <button type="button" className="cn-btn" onClick={reload}>Refresh</button>
      </div>
      <p className="cn-sub">What NEURO noticed, investigated, decided and changed — and whether it worked. The last seven days.</p>

      {data && (
        <section className="cn-act-today" aria-label="Today">
          <div className="cn-k">Today NEURO</div>
          <ul className="cn-act-lines">
            {data.today.lines.map((l) => <li key={l}>{l}</li>)}
          </ul>
        </section>
      )}

      <div className="cn-tabs">
        {(data ? data.filters : Object.keys(FILTER_LABELS)).map((f) => (
          <button key={f} type="button" className={`cn-tab${filter === f ? ' cn-tab--on' : ''}`} onClick={() => setFilter(f)}>{FILTER_LABELS[f] || f}</button>
        ))}
      </div>

      {loading && !data && <div className="cn-muted">Reading activity…</div>}
      {error && <div className="cn-error">Couldn’t read activity — {error}. Not the same as nothing happening.</div>}
      {data && data.gaps.length > 0 && (
        <div className="cn-error">Partly read: {data.gaps.map((g) => g.source).join(', ')} could not be read, so this list may be missing entries from it.</div>
      )}
      {data && !data.entries.length && (
        <div className="cn-empty">{filter === 'all' ? 'Nothing NEURO did in the last seven days that is worth a line.' : `Nothing under “${FILTER_LABELS[filter]}” in the last seven days.`}</div>
      )}
      <ul className="cn-list">
        {data && data.entries.map((e) => <Entry key={e.id} e={e} />)}
      </ul>

      {data && data.pending.length > 0 && (
        <section className="cn-section">
          <div className="cn-k">Deliberately not done yet</div>
          <ul className="cn-act-lines cn-muted">{data.pending.map((p) => <li key={p.id}>{p.text}</li>)}</ul>
        </section>
      )}
    </div>
  );
}

export default function ActivityPanel() {
  const [filter, setFilter] = useState('all');
  const { data, error, loading, reload } = useCanonical(`/api/activity/timeline?filter=${filter}`, { interval: 60000 });
  return <ActivityView data={data} error={error} loading={loading} filter={filter} setFilter={setFilter} reload={reload} />;
}
