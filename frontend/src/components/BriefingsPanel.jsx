import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../api';
import './BriefingsPanel.css';

// ── Briefings — the 08:00 daily and the Monday weekly ──────────────────────
//
// ⚠ THE SERVER DECIDES. What earns a place, the order, what was held back and
// what could not be read are all composed in services/briefings.js. This file
// renders them, and says plainly what it was not shown.
// ⚠ A gap is never a quiet day: anything the briefing could not read is shown
// in amber with the reason.

function pct(v) { return v == null ? '—' : `${Math.round(v)}%`; }
function signed(v) { return v == null ? '—' : `${v > 0 ? '+' : ''}${v}`; }

const VOLUME_LABEL = {
  raised: 'Tickets raised',
  closed: 'Tickets closed',
  backlogSupport: 'Backlog — Support',
  backlogDevelopment: 'Backlog — Development (Tier 3 + Dev)',
  backlogTotal: 'Backlog — total open',
};

function Delivery({ delivery }) {
  if (!delivery) return <p className="brf-meta">Not delivered — built on request.</p>;
  const say = (d, what) => (d?.sent ? `${what} sent` : `${what} not sent${d?.reason ? ` (${d.reason})` : d?.outcome ? ` (${d.outcome})` : ''}`);
  return <p className="brf-meta">{say(delivery.push, 'Push')} · {say(delivery.email, 'Email')}</p>;
}

function Gaps({ gaps }) {
  if (!gaps || !gaps.length) return null;
  return (
    <div className="brf-gaps" role="note">
      <strong>Couldn’t read:</strong>
      <ul>{gaps.map((g, i) => <li key={i}>{g.source}{g.why ? ` — ${g.why}` : ''}</li>)}</ul>
      <p>Treat what’s missing as unknown, not as nothing.</p>
    </div>
  );
}

function Item({ item, onNotUseful, dismissed }) {
  return (
    <li className={`brf-item brf-item--${item.sphere}`}>
      <div className="brf-item-head">
        <span className="brf-item-title">{item.when ? <span className="brf-when">{item.when}</span> : null}{item.title}</span>
        <span className="brf-sphere">{item.sphere}</span>
      </div>
      {item.detail ? <p className="brf-detail">{item.detail}</p> : null}
      {item.items && item.items.length ? <ul className="brf-sub">{item.items.map((x, i) => <li key={i}>{x}</li>)}</ul> : null}
      <div className="brf-item-foot">
        {item.why ? <span className="brf-why">{item.why}</span> : <span />}
        {onNotUseful && !item.needsYou ? (
          dismissed
            ? <button type="button" className="brf-link" onClick={() => onNotUseful(item.kind, true)}>Less of this from now on · Undo</button>
            : <button type="button" className="brf-link" onClick={() => onNotUseful(item.kind, false)}>Not useful</button>
        ) : null}
      </div>
    </li>
  );
}

export function DailyView({ briefing, onNotUseful = null, dismissedKinds = [] }) {
  const p = briefing?.payload;
  if (!p) return <p className="brf-meta">No daily briefing yet.</p>;
  const held = p.held || {};
  const heldBits = [];
  if (held.work) heldBits.push(`${held.work} work item${held.work === 1 ? '' : 's'} (day off)`);
  if (held.belowBar) heldBits.push(`${held.belowBar} not worth your attention today`);
  if (held.overBudget) heldBits.push(`${held.overBudget} over the day’s limit`);
  return (
    <div className="brf-body">
      <div className="brf-head">
        <h2>{p.dayLabel}</h2>
        <span className={`brf-daytype brf-daytype--${p.dayType}`}>{p.dayType === 'off' ? `Day off${p.dayReason ? ` — ${p.dayReason}` : ''}` : 'Work day'}</span>
      </div>
      {p.context?.weather ? <p className="brf-meta">Weather: {p.context.weather}</p> : null}
      <Delivery delivery={briefing.delivery} />
      {(p.sections || []).map((s) => (
        <section key={s.id} className={`brf-section brf-section--${s.id}`}>
          <h3>{s.label}</h3>
          <ul className="brf-items">{s.items.map((i) => <Item key={i.key} item={i} onNotUseful={onNotUseful} dismissed={dismissedKinds.includes(i.kind)} />)}</ul>
        </section>
      ))}
      <Gaps gaps={p.gaps} />
      <p className="brf-close">{p.close}</p>
      {heldBits.length ? <p className="brf-meta">Held back: {heldBits.join(' · ')}.</p> : null}
    </div>
  );
}

export function WeeklyView({ briefing }) {
  const p = briefing?.payload;
  if (!p) return <p className="brf-meta">No weekly briefing yet.</p>;
  const lb = p.leaderboard;
  // No "days worked": NOVA's `days` counts days with a row on the board, weekends included.
  const agent = (a) => `${a.agentName} — score ${Math.round(a.compositeScore)}, ${a.solved} solved, SLA ${pct(a.slaCompliancePct)}`;
  return (
    <div className="brf-body">
      <div className="brf-head">
        <h2>Week {p.weeks?.report?.from} to {p.weeks?.report?.to}</h2>
        <span className="brf-daytype">Compared with the week before</span>
      </div>
      <Delivery delivery={briefing.delivery} />

      {(p.sla && p.sla.length) || (p.csatRows && p.csatRows.length) || p.supportSla ? (
        <section className="brf-section">
          <h3>CSAT and SLAs</h3>
          <table className="brf-table">
            <thead><tr><th>KPI</th><th>Last week</th><th>Week before</th><th>Δ</th><th>Target</th></tr></thead>
            <tbody>
              {['frt', 'res'].filter((m) => p.supportSla && p.supportSla[m]).map((m) => {
                const r = p.supportSla[m];
                const total = r.now.met + r.now.breached;
                return (
                  <tr key={`support-${m}`} className={`brf-team${r.now.pct != null && r.now.pct < r.target ? ' brf-below' : ''}`}>
                    <td>{r.label}</td>
                    <td>{pct(r.now.pct)}<span className="brf-partial-muted"> {total ? `(${r.now.met} of ${total} tickets${r.now.days < 7 ? `, ${r.now.days}/7 days` : ''})` : '(no tickets solved)'}</span></td>
                    <td>{pct(r.was.pct)}</td>
                    <td>{signed(r.delta)}</td>
                    <td>{`${r.target}%${r.now.pct != null ? (r.now.pct >= r.target ? ' · met' : ' · missed') : ''}`}</td>
                  </tr>
                );
              })}
              {(p.csatRows || []).map((r) => <tr key={r.key}><td>{r.label}</td><td>{r.now}</td><td>{r.was}</td><td>{r.delta}</td><td>—</td></tr>)}
              {(p.sla || []).map((r) => (
                <tr key={r.kpi} className={r.measured && r.target != null && r.now != null && r.now < r.target ? 'brf-below' : ''}>
                  <td>{r.kpi}</td>
                  <td>{r.measured ? pct(r.now) : `not measured${r.lastSeen ? ` (last ${r.lastSeen})` : ''}`}</td>
                  <td>{pct(r.was)}</td>
                  <td>{signed(r.delta)}</td>
                  <td>{r.targetMoved ? 'moved' : r.target == null ? '—' : `${r.target}%${r.measured && r.now != null ? (r.now >= r.target ? ' · met' : ' · missed') : ''}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}

      {p.volumes ? (
        <section className="brf-section">
          <h3>Volumes and backlog</h3>
          <table className="brf-table">
            <thead><tr><th></th><th>Last week</th><th>Week before</th><th>Δ</th></tr></thead>
            <tbody>
              {p.volumes.map((r) => (
                <tr key={r.name}>
                  <td>{VOLUME_LABEL[r.name] || r.name}</td>
                  <td>{r.now ?? '—'}{r.flow && r.nowDays && r.nowDays < 7 ? <span className="brf-partial"> ({r.nowDays}/7 days captured)</span> : null}{!r.flow && r.asOf ? <span className="brf-partial"> (as of {r.asOf})</span> : null}</td>
                  <td>{r.was ?? '—'}</td>
                  <td>{signed(r.delta)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}

      {lb ? (
        <section className="brf-section">
          <h3>Leaderboard</h3>
          {lb.top ? <p><strong>Top:</strong> {agent(lb.top)}</p> : <p className="brf-meta">No one ranked last week.</p>}
          {lb.weakest ? <p><strong>Weakest:</strong> {agent(lb.weakest)}</p> : null}
          <p className="brf-meta">{lb.rankedCount} ranked on NOVA’s KPI Rebuild leaderboard (Model A). {lb.unranked?.length ? `${lb.unranked.length} unranked — no measurable work in the week.` : ''}</p>
        </section>
      ) : null}

      {p.slm?.known ? (
        <section className="brf-section">
          <h3>Friday Support Leadership Meeting</h3>
          <p className="brf-meta">From “{p.slm.note?.name}”</p>
          {[['Highlights', p.slm.highlights], ['Lowlights', p.slm.lowlights], ['Blockers & escalations', p.slm.blockers]].map(([label, xs]) => (
            <div key={label} className="brf-slm">
              <h4>{label}</h4>
              {xs && xs.length ? <ul>{xs.map((x, i) => <li key={i}>{x}</li>)}</ul> : <p className="brf-meta">Nothing recorded.</p>}
            </div>
          ))}
        </section>
      ) : null}

      {p.bp && (p.bp.now?.days || p.bp.was?.days) ? (
        <section className="brf-section">
          <h3>Blood pressure</h3>
          <p>
            Last week: {p.bp.now.days ? `${p.bp.now.systolic}/${p.bp.now.diastolic} mmHg (median of ${p.bp.now.days} day${p.bp.now.days === 1 ? '' : 's'})` : 'no readings'}
            {' · '}Week before: {p.bp.was.days ? `${p.bp.was.systolic}/${p.bp.was.diastolic}` : 'no readings'}
          </p>
          <p className="brf-meta">Here and on your phone only — never in the work email.</p>
        </section>
      ) : null}

      <Gaps gaps={p.gaps} />
      <p className="brf-close">{p.close}</p>
    </div>
  );
}

export default function BriefingsPanel() {
  const initialKind = (() => {
    try { return new URLSearchParams(window.location.search).get('kind') === 'weekly' ? 'weekly' : 'daily'; } catch { return 'daily'; }
  })();
  const [kind, setKind] = useState(initialKind);
  const [history, setHistory] = useState([]);
  const [selected, setSelected] = useState(null);
  const [briefing, setBriefing] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [dismissed, setDismissed] = useState([]);

  const load = useCallback(async (k, id = null) => {
    setError(null);
    try {
      const [h, b] = await Promise.all([
        apiFetch(`/api/briefings?kind=${k}&limit=30`).then((r) => r.json()),
        apiFetch(id ? `/api/briefings/${id}` : `/api/briefings/latest?kind=${k}`).then((r) => r.json()),
      ]);
      if (!h.ok || !b.ok) throw new Error(h.error || b.error || 'could not load');
      setHistory(h.briefings || []);
      setBriefing(b.briefing || null);
      setSelected(b.briefing?.id || null);
    } catch (e) {
      setError(e.message);
    }
  }, []);

  useEffect(() => { load(kind); }, [kind, load]);

  const rebuild = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await apiFetch('/api/briefings/run', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind }),
      }).then((x) => x.json());
      if (!r.ok) throw new Error(r.error || 'rebuild failed');
      await load(kind);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const notUseful = async (k, undo) => {
    try {
      const r = await apiFetch('/api/briefings/feedback', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: k, undo }),
      }).then((x) => x.json());
      if (!r.ok) throw new Error(r.error || 'not saved');
      setDismissed((d) => (undo ? d.filter((x) => x !== k) : [...d, k]));
    } catch (e) {
      setError(`Couldn’t save that: ${e.message}`);
    }
  };

  return (
    <div className="brf-panel">
      <div className="brf-top">
        <h1>Briefings</h1>
        <div className="brf-tabs" role="tablist">
          {['daily', 'weekly'].map((k) => (
            <button key={k} type="button" role="tab" aria-selected={kind === k} className={`brf-tab${kind === k ? ' brf-tab--on' : ''}`} onClick={() => setKind(k)}>
              {k === 'daily' ? 'Daily' : 'Weekly'}
            </button>
          ))}
        </div>
        <div className="brf-controls">
          {history.length > 1 ? (
            <select value={selected || ''} onChange={(e) => load(kind, Number(e.target.value))} aria-label="Earlier briefings">
              {history.map((h) => <option key={h.id} value={h.id}>{h.date}{h.dayType === 'off' ? ' (day off)' : ''}</option>)}
            </select>
          ) : null}
          <button type="button" className="brf-btn" onClick={rebuild} disabled={busy}>{busy ? 'Building…' : 'Rebuild now'}</button>
        </div>
      </div>
      <p className="brf-hint">{kind === 'daily'
        ? 'Every day at 08:00. Only what earns a place today; a day off has no work in it.'
        : 'Mondays at 08:00, for the 09:00 tech leadership meeting. Rebuilding here does not send it again.'}</p>
      {error ? <p className="brf-error">{error}</p> : null}
      {kind === 'daily'
        ? <DailyView briefing={briefing} onNotUseful={notUseful} dismissedKinds={dismissed} />
        : <WeeklyView briefing={briefing} />}
    </div>
  );
}
