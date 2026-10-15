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
// One decimal for the team figures: 94.7 must not read as a met 95% target.
function pct1(v) { return v == null ? "—" : `${Math.round(v * 10) / 10}%`; }
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

// Work = sphere 'work'. Personal = everything else (personal, health, context).
// A view filter only: the server's selection is unchanged, so "All" is exactly
// what was composed.
export const MODES = [['all', 'All'], ['work', 'Work'], ['personal', 'Personal']];
export function inMode(sphere, mode) {
  if (mode === 'work') return sphere === 'work';
  if (mode === 'personal') return sphere !== 'work';
  return true;
}

export function ModeToggle({ mode, onChange }) {
  return (
    <div className="brf-tabs brf-mode" role="radiogroup" aria-label="Show">
      {MODES.map(([id, label]) => (
        <button key={id} type="button" role="radio" aria-checked={mode === id} className={`brf-tab${mode === id ? ' brf-tab--on' : ''}`} onClick={() => onChange(id)}>{label}</button>
      ))}
    </div>
  );
}

export function DailyView({ briefing, onNotUseful = null, dismissedKinds = [], mode = 'all' }) {
  const p = briefing?.payload;
  if (!p) return <p className="brf-meta">No daily briefing yet.</p>;
  const sections = (p.sections || [])
    .map((s) => ({ ...s, items: s.items.filter((i) => inMode(i.sphere, mode)) }))
    .filter((s) => s.items.length);
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
      {sections.map((s) => (
        <section key={s.id} className={`brf-section brf-section--${s.id}`}>
          <h3>{s.label}</h3>
          <ul className="brf-items">{s.items.map((i) => <Item key={i.key} item={i} onNotUseful={onNotUseful} dismissed={dismissedKinds.includes(i.kind)} />)}</ul>
        </section>
      ))}
      {!sections.length && mode !== 'all' ? (
        <p className="brf-meta">Nothing {mode === 'work' ? 'work-related' : 'personal'} earned a place today.</p>
      ) : null}
      <Gaps gaps={p.gaps} />
      <p className="brf-close">{mode === 'all' ? p.close : `${p.close} (Showing ${mode} only.)`}</p>
      {heldBits.length ? <p className="brf-meta">Held back: {heldBits.join(' · ')}.</p> : null}
    </div>
  );
}

function shortDay(ymd) {
  if (!ymd || !/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return '';
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}

function hoursLabel(h) {
  if (h == null) return '—';
  const whole = Math.floor(h);
  return `${whole}h${String(Math.round((h - whole) * 60)).padStart(2, '0')}`;
}

const GOAL_WORDS = { met: 'at target', 'on-track': 'on track', behind: 'behind', 'not-moving': 'not moving', 'moving-away': 'going the wrong way', unknown: 'can’t tell' };

/** Goals this week — goal-measures' judgement as given, each with its one top suggestion. */
export function GoalsWeek({ g }) {
  if (!g) return null;
  return (
    <section className="brf-section" data-testid="brf-goals">
      <h3>Your goals</h3>
      {!g.known
        ? <p className="brf-meta">Couldn’t read your goals — not the same as “no progress”.</p>
        : g.items.length
          ? (
            <ul className="brf-items">
              {g.items.map((i, n) => (
                <li key={n} className="brf-item brf-item--personal">
                  <div className="brf-item-head">
                    <span className="brf-item-title">{i.title}</span>
                    <span className="brf-sphere">{GOAL_WORDS[i.state] || i.state}</span>
                  </div>
                  <p className="brf-detail">{i.line}</p>
                  {i.help ? <p className="brf-detail">→ {i.help.action} <span className="brf-partial-muted">({i.help.source})</span></p> : null}
                </li>
              ))}
            </ul>
          )
          : <p className="brf-meta">No goal has a measure yet{g.unmeasured ? ` (${g.unmeasured} without one)` : ''} — give one a measure in Life → Goals and it shows here.</p>}
    </section>
  );
}

/** The personal half of the weekly: the week ahead, and last week's body. Never emailed. */
function PersonalWeek({ p }) {
  const ahead = p.weekAhead;
  const h = p.health;
  const bp = p.bp;
  const row = (label, cur, prev, fmt, unit = '') => (
    <tr>
      <td>{label}</td>
      <td>{cur.median != null ? `${fmt(cur.median)}${unit}` : 'no readings'}{cur.days ? <span className="brf-partial-muted"> ({cur.days} day{cur.days === 1 ? '' : 's'})</span> : null}</td>
      <td>{prev.median != null ? `${fmt(prev.median)}${unit}` : '—'}</td>
    </tr>
  );
  return (
    <>
      <section className="brf-section">
        <h3>Your week ahead</h3>
        {!ahead || !ahead.known
          ? <p className="brf-meta">Couldn’t read the Future Radar — not the same as an empty week.</p>
          : ahead.items.length
            ? (
              <ul className="brf-items">
                {ahead.items.map((i, n) => (
                  <li key={n} className="brf-item brf-item--personal">
                    <div className="brf-item-head">
                      <span className="brf-item-title"><span className="brf-when">{shortDay(i.date)}{i.time ? ` ${i.time}` : ''}</span>{i.title}</span>
                      {i.needsYou ? <span className="brf-sphere">needs you</span> : null}
                    </div>
                    {i.why ? <p className="brf-detail">{i.why}</p> : null}
                  </li>
                ))}
              </ul>
            )
            : <p className="brf-meta">Nothing personal on the radar for the next 7 days.</p>}
      </section>
      <GoalsWeek g={p.goals} />
      {h || bp ? (
        <section className="brf-section">
          <h3>Your body last week</h3>
          <table className="brf-table">
            <thead><tr><th></th><th>Last week (median)</th><th>Week before</th></tr></thead>
            <tbody>
              {h ? row('Sleep', h.sleepHours.now, h.sleepHours.was, hoursLabel) : null}
              {h ? row('Resting heart rate', h.restingHr.now, h.restingHr.was, (v) => Math.round(v), ' bpm') : null}
              {bp ? (
                <tr>
                  <td>Blood pressure</td>
                  <td>{bp.now.days ? `${bp.now.systolic}/${bp.now.diastolic} mmHg` : 'no readings'}{bp.now.days ? <span className="brf-partial-muted"> ({bp.now.days} day{bp.now.days === 1 ? '' : 's'})</span> : null}</td>
                  <td>{bp.was.days ? `${bp.was.systolic}/${bp.was.diastolic}` : '—'}</td>
                </tr>
              ) : null}
            </tbody>
          </table>
          <p className="brf-meta">Here and on your phone only — never in the work email.</p>
        </section>
      ) : null}
    </>
  );
}

export function WeeklyView({ briefing, mode = 'all' }) {
  const p = briefing?.payload;
  if (!p) return <p className="brf-meta">No weekly briefing yet.</p>;
  const showWork = mode !== 'personal';
  const showPersonal = mode !== 'work';
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

      {showWork ? (<>
      {(p.sla && p.sla.length) || (p.csatRows && p.csatRows.length) || p.supportSla ? (
        <section className="brf-section">
          <h3>Team SLA and CSAT</h3>
          <table className="brf-table">
            <thead><tr><th>KPI</th><th>Last week</th><th>Week before</th><th>Δ</th><th>Target</th></tr></thead>
            <tbody>
              {['frt', 'res'].filter((m) => p.supportSla && p.supportSla[m]).map((m) => {
                const r = p.supportSla[m];
                const total = r.now.met + r.now.breached;
                return (
                  <tr key={`support-${m}`} className={`brf-team${r.now.pct != null && r.now.pct < r.target ? ' brf-below' : ''}`}>
                    <td>{r.label}</td>
                    <td>{pct1(r.now.pct)}<span className="brf-partial-muted"> {total ? `(${r.now.met} of ${total} tickets${r.now.days < 7 ? `, ${r.now.days}/7 days` : ''})` : '(no tickets solved)'}</span></td>
                    <td>{pct1(r.was.pct)}</td>
                    <td>{signed(r.delta)}</td>
                    <td>{`${r.target}%${r.now.pct != null ? (r.now.pct >= r.target ? ' · met' : ' · missed') : ''}`}</td>
                  </tr>
                );
              })}
              {(p.csatRows || []).map((r) => <tr key={r.key}><td>{r.label}</td><td>{r.now}</td><td>{r.was}</td><td>{r.delta}</td><td>—</td></tr>)}
            </tbody>
          </table>
        </section>
      ) : null}

      {p.sla && p.sla.length ? (
        <section className="brf-section">
          <h3>SLA by queue</h3>
          <table className="brf-table">
            <thead><tr><th>KPI</th><th>Last week</th><th>Week before</th><th>Δ</th><th>Target</th></tr></thead>
            <tbody>
              {p.sla.map((r) => (
                <tr key={r.kpi} className={r.measured && r.target != null && r.now != null && r.now < r.target ? 'brf-below' : ''}>
                  <td>{r.kpi}</td>
                  <td>{r.measured ? pct1(r.now) : `not measured${r.lastSeen ? ` (last ${r.lastSeen})` : ''}`}</td>
                  <td>{pct1(r.was)}</td>
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
      </>) : null}

      {showPersonal ? <PersonalWeek p={p} /> : null}

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
  // A per-device convenience, so it is remembered here and nowhere else.
  const [mode, setModeState] = useState(() => {
    try { const v = window.localStorage.getItem('neuro_briefing_mode'); return MODES.some(([id]) => id === v) ? v : 'all'; } catch { return 'all'; }
  });
  const setMode = (m) => {
    setModeState(m);
    try { window.localStorage.setItem('neuro_briefing_mode', m); } catch { /* storage unavailable: still works for this visit */ }
  };

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
        <ModeToggle mode={mode} onChange={setMode} />
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
        ? <DailyView briefing={briefing} onNotUseful={notUseful} dismissedKinds={dismissed} mode={mode} />
        : <WeeklyView briefing={briefing} mode={mode} />}
    </div>
  );
}
