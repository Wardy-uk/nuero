import React, { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../api';
import { Headline, Stat, StatTiles, HowItWorks } from './canonical/canonicalUi';
import './canonical/Canonical.css';
import './MyHealthPanel.css';

/**
 * My Health — the whole picture across every health source NEURO holds: the
 * Watch and the HiLo bracelet (both via Apple Health), the JC Ring, medical
 * records and the exertion model. The per-source pages (Apple Health, JC Ring,
 * Medical) stay where they are; this is the page that puts them side by side.
 *
 * ⚠ It renders /api/health/picture VERBATIM. Ranking, wording and thresholds are
 * the server's (services/health-picture.js), so this page and any other surface
 * cannot phrase one fact two ways. The component decides layout and nothing else.
 */

const LEVEL_LABEL = { act: 'Act on this', watch: 'Worth watching', gap: 'Can’t see', good: 'Holding up' };
const STATUS_LABEL = { act: 'Act', watch: 'Watch', good: 'Good', unknown: 'Unknown' };
const VIEW_LABEL = { health: 'Apple Health', 'jc-ring': 'JC Ring', medical: 'Medical' };

function ago(hours) {
  if (hours == null) return 'never';
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} min ago`;
  if (hours < 48) return `${Math.round(hours)} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

function InsightCard({ insight, onNavigate }) {
  const [open, setOpen] = useState(false);
  const hasDetail = (insight.evidence && insight.evidence.length) || insight.basis || insight.caveat;
  return (
    <article className={`mh-insight mh-insight--${insight.level}`}>
      <div className="mh-insight-head">
        <span className={`mh-chip mh-chip--${insight.level}`}>{insight.today ? 'Today' : LEVEL_LABEL[insight.level]}</span>
        <h3>{insight.title}</h3>
      </div>
      <p className="mh-finding">{insight.finding}</p>
      {insight.action && <p className="mh-action"><span aria-hidden="true">→</span> {insight.action}</p>}
      <div className="mh-insight-foot">
        {hasDetail && (
          <button type="button" className="mh-link" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
            {open ? 'Hide what this is based on' : 'What this is based on'}
          </button>
        )}
        {insight.view && onNavigate && (
          <button type="button" className="mh-link" onClick={() => onNavigate(insight.view)}>
            Open {VIEW_LABEL[insight.view] || insight.view}
          </button>
        )}
      </div>
      {open && (
        <div className="mh-detail">
          {insight.evidence && insight.evidence.length > 0 && (
            <ul>{insight.evidence.map((e, i) => <li key={i}><span>{e.source}</span> {e.text}</li>)}</ul>
          )}
          {insight.basis && <p>{insight.basis}</p>}
          {insight.caveat && <p className="mh-caveat">{insight.caveat}</p>}
        </div>
      )}
    </article>
  );
}

function SystemTile({ system, onNavigate }) {
  const body = (
    <>
      <div className="mh-tile-top">
        <span className="mh-tile-label">{system.label}</span>
        <span className={`mh-status mh-status--${system.status}`}>{STATUS_LABEL[system.status] || system.status}</span>
      </div>
      <div className="mh-tile-value">
        {system.value != null ? <>{system.value}{system.unit && <small> {system.unit}</small>}</> : <span className="mh-muted">—</span>}
      </div>
      {system.sub && <div className="mh-tile-sub">{system.sub}</div>}
      {system.sources && system.sources.length > 0 && <div className="mh-tile-src">{system.sources.join(' · ')}</div>}
    </>
  );
  return onNavigate && system.view
    ? <button type="button" className={`mh-tile mh-tile--${system.status}`} onClick={() => onNavigate(system.view)}>{body}</button>
    : <div className={`mh-tile mh-tile--${system.status}`}>{body}</div>;
}

/** Pure view of one payload, so it renders without a network. */
export function MyHealthView({ data, onNavigate }) {
  const insights = data.insights || [];
  const doThis = insights.filter((i) => i.level === 'act' || i.level === 'watch');
  const gaps = insights.filter((i) => i.level === 'gap');
  const good = insights.filter((i) => i.level === 'good');
  const counts = data.counts || null;
  // The pill restates the server's own counts and completeness; nothing is judged here.
  const [tone, pill] = counts?.act ? ['warn', 'Act']
    : !data.complete ? ['warn', 'Partial']
      : counts?.watch ? ['plan', 'Watch']
        : ['good', 'Holding up'];
  return (
    <>
      <Headline tone={tone} pill={pill} testid="my-health-headline"
        detail={!data.complete && !/not an all-clear/.test(data.headline || "") ? <span className="mh-incomplete">Part of the picture could not be read, so this is not an all-clear.</span> : null}>
        {data.headline}
      </Headline>
      {counts && (
        <StatTiles>
          <Stat v={counts.act ?? null} l="To act on" tone={counts.act ? 'warn' : undefined} />
          <Stat v={counts.watch ?? null} l="Worth watching" />
          <Stat v={counts.gap ?? null} l="Can’t see" />
          <Stat v={counts.good ?? null} l="Holding up" />
        </StatTiles>
      )}

      {doThis.length > 0 && (
        <section className="mh-section">
          <h2>What to do</h2>
          <div className="mh-insights">
            {doThis.map((i) => <InsightCard key={i.id} insight={i} onNavigate={onNavigate} />)}
          </div>
        </section>
      )}

      <section className="mh-section">
        <h2>At a glance</h2>
        <div className="mh-grid">
          {(data.systems || []).map((s) => <SystemTile key={s.id} system={s} onNavigate={onNavigate} />)}
        </div>
      </section>

      {gaps.length > 0 && (
        <section className="mh-section">
          <h2>What NEURO can’t see</h2>
          <div className="mh-insights">
            {gaps.map((i) => <InsightCard key={i.id} insight={i} onNavigate={onNavigate} />)}
          </div>
        </section>
      )}

      {good.length > 0 && (
        <section className="mh-section">
          <h2>Holding up</h2>
          <div className="mh-insights">
            {good.map((i) => <InsightCard key={i.id} insight={i} onNavigate={onNavigate} />)}
          </div>
        </section>
      )}

      <section className="mh-section">
        <h2>Sources</h2>
        <div className="mh-sources">
          {(data.sources || []).map((s) => (
            <div key={s.name} className="mh-source">
              <span className={`mh-dot mh-dot--${s.state}`} aria-hidden="true" />
              <div className="mh-source-main">
                <strong>{s.name}</strong>
                <span>{s.role}</span>
              </div>
              <div className="mh-source-when">
                {s.ageHours != null ? ago(s.ageHours) : s.state === 'none' ? 'no data' : ''}
                {s.extra && <small>{s.extra}</small>}
              </div>
            </div>
          ))}
        </div>
        <HowItWorks>{data.note}</HowItWorks>
      </section>
    </>
  );
}

export default function MyHealthPanel({ onNavigate }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch('/api/health/picture');
      const body = await res.json();
      if (!res.ok || body.contract !== 'health-picture-v1') throw new Error(body.error || `HTTP ${res.status}`);
      setData(body);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="mh">
      <header className="mh-head">
        <div>
          <h1>My Health</h1>
        </div>
        <button type="button" className="mh-refresh" onClick={load} disabled={loading}>{loading ? 'Reading…' : 'Refresh'}</button>
      </header>
      {error && <p className="mh-error">Couldn’t read your health picture: {error}. This is not an all-clear.</p>}
      {!data && !error && <p className="mh-muted">Reading every source…</p>}
      {data && <MyHealthView data={data} onNavigate={onNavigate} />}
    </div>
  );
}
