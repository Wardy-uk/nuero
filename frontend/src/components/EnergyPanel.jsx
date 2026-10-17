import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { apiUrl } from '../api';
import { TrendChart } from './HealthPanel';
import { Headline, Stat, StatTiles, Fold, HowItWorks, Pill, dayLabel } from './canonical/canonicalUi';
import { BrightConnectCard } from './BrightConnectCard';
import './EnergyPanel.css';

/**
 * Home → Energy. Renders /api/energy (energy-v1) and /api/energy/insights.
 * Decides nothing: every number, completeness flag and caveat is the server's.
 * Three things must never look alike: no reading (—), a partial day (marked),
 * and a real total. Every £ is an ESTIMATE and says so.
 */

const FUEL = { electricity: 'Electricity', gas: 'Gas' };
const RANGES = [30, 90, 365];

export const pounds = (p) => (p == null ? '—' : `£${(p / 100).toFixed(2)}`);
export { BrightConnectCard };
export const kwh = (v, dp = 1) => (v == null ? '—' : `${Number(v).toFixed(dp)} kWh`);

async function getJson(path, init) {
  const r = await fetch(apiUrl(path), init);
  const d = await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }));
  return d;
}

function dayCell(d, unitKey = 'kwh') {
  if (!d) return { v: '—', partial: false };
  return { v: unitKey === 'cost' ? pounds(d.costP) : kwh(d.kwh), partial: d.kwh != null && !d.complete };
}

function FreshnessPill({ f }) {
  if (!f) return null;
  const tone = { usual: 'good', late: 'warn', stalled: 'bad', none: 'neutral' }[f.state] || 'neutral';
  const text = f.state === 'none' ? 'no readings yet'
    : `newest ${f.ageHours}h ago${f.state === 'usual' ? ' (normal lag)' : f.state === 'late' ? ' — later than usual' : ' — stopped?'}`;
  return <Pill tone={tone} title={`Smart-meter data usually arrives within ~${f.usualLagHours}h`}>{text}</Pill>;
}

export function FuelSection({ fuel, f, ins, range }) {
  const rows = useMemo(() => [...(f.days || [])].reverse(), [f.days]); // TrendChart wants newest first
  const y = f.yesterday;
  const t = f.today;
  const normalised = ins && ins.normalised ? [...ins.normalised].reverse().map((d) => ({ day: d.day, kwh: d.kwh, expected: d.expected })) : null;
  return (
    <section className="energy-fuel" data-testid={`energy-${fuel}`}>
      <div className="energy-fuel__head">
        <h3>{FUEL[fuel]}</h3>
        <FreshnessPill f={f.freshness} />
      </div>
      <StatTiles>
        <Stat l={`Today${t && !t.complete ? ' (so far)' : ''}`} v={dayCell(t).v} title="Today is normally partial — meter data arrives late" />
        <Stat l={`Yesterday${y && !y.complete && y.kwh != null ? ' (incomplete)' : ''}`} v={dayCell(y).v} tone={y && !y.complete && y.kwh != null ? 'warn' : undefined}
          title={y ? `${y.present}/${y.expected} half-hours in` : ''} />
        <Stat l="Yesterday est. cost" v={pounds(y && y.costP)} title={y && y.costWhy ? y.costWhy : 'Estimated from the tariff NEURO holds'} />
        <Stat l="This month" v={kwh(f.month.kwh, 0)} title={`${f.month.completeDays}/${f.month.days} days complete`} />
        <Stat l="Month est. cost" v={pounds(f.month.costP)} title={`${f.month.costedDays}/${f.month.days} days costed`} />
        <Stat l="Last month (same days)" v={kwh(f.lastMonthToDate.kwh, 0)} />
        <Stat l="Last month total" v={kwh(f.lastMonth.kwh, 0)} title={pounds(f.lastMonth.costP)} />
      </StatTiles>
      <TrendChart title={`${FUEL[fuel]} per day`} unit="kWh" dp={1} days={rows} valueKey="kwh" spanYear={range > 60}
        hint="Incomplete days are lower because half-hours are still missing — hover a day for its count." />
      {fuel === 'gas' && normalised && normalised.length > 0 && (
        <TrendChart title="Gas vs what the weather explains (last 14 complete days)" unit="kWh" dp={1} days={normalised}
          series={[{ key: 'kwh', label: 'Actual' }, { key: 'expected', label: 'Expected for the weather' }]}
          hint="Expected comes from how gas has tracked outdoor temperature in this house — a correlation, not a cause." />
      )}
      {fuel === 'gas' && rows.some((r) => r.tMean != null) && (
        <TrendChart title="Outdoor mean temperature" unit="°C" dp={1} days={rows} valueKey="tMean" spanYear={range > 60} />
      )}
      {ins && <Insights fuel={fuel} ins={ins} />}
      {f.backfill && (
        <p className="energy-note">
          History: {f.backfill.complete ? 'all of Bright’s available history is in' : `backfilling — ${f.backfill.progressPct ?? '?'}% of Bright’s history so far`}
          {f.backfill.earliestAvailable ? ` (Bright has data from ${new Date(f.backfill.earliestAvailable).toLocaleDateString('en-GB')}${f.backfill.floorSource === 'assumed-400-days' ? ', assumed' : ''})` : ''}
          {f.backfill.slotsMissing ? ` · ${f.backfill.slotsMissing} half-hours Bright has no reading for (rechecked daily)` : ''}
          {f.backfill.lastError ? ` · last error: ${f.backfill.lastError}` : ''}
        </p>
      )}
      {f.sync && f.sync.consecutiveFailures > 0 && (
        <p className="energy-note energy-note--warn">Last sync failed ({f.sync.consecutiveFailures}×): {f.sync.lastError}</p>
      )}
    </section>
  );
}

function Insights({ fuel, ins }) {
  return (
    <div className="energy-insights">
      <StatTiles>
        <Stat l="Typical day (28-day median)" v={kwh(ins.baselineKwhPerDay)} />
        {fuel === 'electricity' && <Stat l="Always-on load" v={ins.alwaysOnKw == null ? '—' : `${(ins.alwaysOnKw * 1000).toFixed(0)} W`} title={ins.alwaysOnNote} />}
        {fuel === 'gas' && ins.weather && <Stat l="Per degree-day" v={`${ins.weather.kwhPerDegreeDay} kWh`} title={`r² ${ins.weather.r2} over ${ins.weather.n} days. ${ins.weather.note}`} />}
        {fuel === 'gas' && ins.weather && <Stat l="Non-heating base" v={kwh(ins.weather.baseKwhPerDay)} title="Gas on a day warm enough to need no heating (hot water, cooking)" />}
        {fuel === 'gas' && ins.efficiency && (
          <Stat l="Heating per degree-day vs prior 90d" v={`${ins.efficiency.changePct > 0 ? '+' : ''}${ins.efficiency.changePct}%`} title={ins.efficiency.note}
            tone={ins.efficiency.changePct > 15 ? 'warn' : undefined} />
        )}
        <Stat l="Incomplete days (60d)" v={ins.missing ? ins.missing.incompleteDays : '—'} />
      </StatTiles>
      {fuel === 'gas' && !ins.weather && ins.weatherWhy && <p className="energy-note">Weather baseline: {ins.weatherWhy}</p>}
      {ins.unusual && ins.unusual.length > 0 && (
        <ul className="energy-unusual">
          {ins.unusual.map((u) => (
            <li key={u.day}>{dayLabel(u.day)}: {u.actual} kWh — about {u.pctAbove}% above {fuel === 'gas' ? 'what the weather explains' : 'the usual day'} (~{u.expected} kWh)</li>
          ))}
        </ul>
      )}
      {ins.weekly && ins.weekly.length > 0 && (
        <Fold title="Weekly totals" meta={`${ins.weekly.length} weeks`}>
          <table className="energy-table">
            <thead><tr><th>Week of</th><th>kWh</th><th>Est. cost</th><th /></tr></thead>
            <tbody>{[...ins.weekly].reverse().map((w) => (
              <tr key={w.week}><td>{dayLabel(w.week)}</td><td>{w.kwh ?? '—'}</td><td>{pounds(w.costP)}</td><td>{w.complete ? '' : 'incomplete'}</td></tr>
            ))}</tbody>
          </table>
        </Fold>
      )}
    </div>
  );
}

function Tariffs({ onChange }) {
  const [data, setData] = useState(null);
  const [form, setForm] = useState({ fuel: 'electricity', effectiveFrom: '', unitRateP: '', standingPDay: '', label: '' });
  const [cv, setCv] = useState('');
  const [error, setError] = useState(null);
  const load = useCallback(async () => { const d = await getJson('/api/energy/tariffs?all=1'); if (d.ok) setData(d); }, []);
  useEffect(() => { load(); }, [load]);
  const add = async () => {
    setError(null);
    const d = await getJson('/api/energy/tariffs', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...form, unitRateP: Number(form.unitRateP), standingPDay: Number(form.standingPDay) }) });
    if (!d.ok) { setError(d.error); return; }
    setForm({ ...form, effectiveFrom: '', unitRateP: '', standingPDay: '', label: '' });
    await load(); onChange && onChange();
  };
  const remove = async (id) => { await getJson(`/api/energy/tariffs/${id}/remove`, { method: 'POST' }); await load(); onChange && onChange(); };
  const saveCv = async () => {
    setError(null);
    const d = await getJson('/api/energy/gas-calorific-value', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cv: cv === '' ? null : Number(cv) }) });
    if (!d.ok) setError(d.error); else { setCv(''); await load(); onChange && onChange(); }
  };
  if (!data) return null;
  return (
    <Fold title="Tariffs" meta={`${data.tariffs.filter((t) => !t.removedAt).length} held`}>
      <table className="energy-table">
        <thead><tr><th>Fuel</th><th>From</th><th>Unit rate</th><th>Standing</th><th>Source</th><th /></tr></thead>
        <tbody>{data.tariffs.map((t) => (
          <tr key={t.id} className={t.removedAt ? 'energy-row--removed' : ''}>
            <td>{FUEL[t.fuel]}</td><td>{t.effectiveFrom}</td>
            <td>{t.unitRateP == null ? '—' : `${t.unitRateP}p/kWh`}</td><td>{t.standingPDay == null ? '—' : `${t.standingPDay}p/day`}</td>
            <td>{t.source === 'meter' ? 'meter (Bright)' : 'you'}{!t.flat ? ' · time-of-use, not costed' : ''}{t.removedAt ? ' · withdrawn' : ''}</td>
            <td>{t.source === 'manual' && !t.removedAt && <button className="admin-btn" onClick={() => remove(t.id)}>Withdraw</button>}</td>
          </tr>
        ))}</tbody>
      </table>
      <div className="energy-form">
        <select value={form.fuel} onChange={(e) => setForm({ ...form, fuel: e.target.value })}><option value="electricity">Electricity</option><option value="gas">Gas</option></select>
        <input type="date" value={form.effectiveFrom} onChange={(e) => setForm({ ...form, effectiveFrom: e.target.value })} />
        <input type="number" step="0.001" placeholder="Unit rate p/kWh" value={form.unitRateP} onChange={(e) => setForm({ ...form, unitRateP: e.target.value })} />
        <input type="number" step="0.01" placeholder="Standing p/day" value={form.standingPDay} onChange={(e) => setForm({ ...form, standingPDay: e.target.value })} />
        <input placeholder="Label (optional)" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} />
        <button className="admin-btn" disabled={!form.effectiveFrom || form.unitRateP === '' || form.standingPDay === ''} onClick={add}>Add tariff</button>
      </div>
      <p className="energy-note">A tariff you add beats the meter’s on the same date. Enter rates as on your bill (including VAT). Days before any tariff are not costed.</p>
      <div className="energy-form">
        <span>Gas calorific value: {data.settings.gasCalorificValue ?? 'not set'} </span>
        <input type="number" step="0.1" placeholder="MJ/m³ (from your gas bill)" value={cv} onChange={(e) => setCv(e.target.value)} />
        <button className="admin-btn" onClick={saveCv}>{cv === '' ? 'Clear' : 'Save'}</button>
      </div>
      <p className="energy-note">Only needed if Bright ever reports gas in cubic metres — today it reports kWh.</p>
      {error && <div className="admin-error">{error}</div>}
    </Fold>
  );
}

export default function EnergyPanel() {
  const [range, setRange] = useState(30);
  const [data, setData] = useState(null);
  const [ins, setIns] = useState(null);
  const [error, setError] = useState(null);
  const [syncing, setSyncing] = useState(false);

  const load = useCallback(async () => {
    try {
      const [a, b] = await Promise.all([getJson(`/api/energy?days=${range}`), getJson('/api/energy/insights')]);
      if (!a.ok) throw new Error(a.error || 'could not read energy');
      setData(a); setIns(b.ok ? b : null); setError(null);
    } catch (e) { setError(e.message); }
  }, [range]);
  useEffect(() => { load(); }, [load]);

  const syncNow = async () => { setSyncing(true); await getJson('/api/energy/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); setSyncing(false); load(); };

  if (error && !data) return <div className="energy-panel"><Headline tone="bad" pill="Can’t read">I couldn’t read energy: {error}. That isn’t the same as no usage.</Headline></div>;
  if (!data) return <div className="energy-panel"><p className="energy-note">Loading…</p></div>;

  const present = Object.entries(data.fuels).filter(([, f]) => f.present);
  const y = present.map(([fuel, f]) => (f.yesterday && f.yesterday.kwh != null ? `${kwh(f.yesterday.kwh)} ${fuel}${f.yesterday.complete ? '' : ' (so far)'}` : null)).filter(Boolean);
  const yCost = present.every(([, f]) => f.yesterday && f.yesterday.costP != null)
    ? present.reduce((s, [, f]) => s + f.yesterday.costP, 0) : null;

  return (
    <div className="energy-panel">
      {!data.connection.configured || data.connection.state === 'rejected' ? (
        <>
          <Headline tone="plan" pill="Not connected">Connect Bright to start collecting your smart-meter readings.</Headline>
          <BrightConnectCard connection={data.connection} onChange={load} />
        </>
      ) : !present.length ? (
        <Headline tone="plan" pill="Starting">Connected — waiting for the first readings from Bright.</Headline>
      ) : (
        <Headline tone="neutral" pill="Yesterday" detail={`${data.labels.cost} ${data.labels.lag}`}>
          {y.length ? y.join(' · ') : 'No readings for yesterday yet'}{yCost != null ? ` · ~${pounds(yCost)} estimated` : ''}
          {data.household.monthCostP != null ? ` · this month ~${pounds(data.household.monthCostP)}` : ''}
        </Headline>
      )}
      <div className="energy-toolbar">
        {RANGES.map((r) => (
          <button key={r} type="button" className={`view-tab${r === range ? ' view-tab--active' : ''}`} onClick={() => setRange(r)}>{r === 365 ? '1 year' : `${r} days`}</button>
        ))}
        {data.connection.configured && <button type="button" className="admin-btn" disabled={syncing} onClick={syncNow}>{syncing ? 'Syncing…' : 'Sync now'}</button>}
      </div>
      <div className="energy-grid">
        {present.map(([fuel, f]) => <FuelSection key={fuel} fuel={fuel} f={f} ins={ins && ins.fuels[fuel]} range={range} />)}
      </div>
      {data.connection.configured && <Tariffs onChange={load} />}
      {data.connection.configured && <BrightConnectCard connection={data.connection} onChange={load} />}
      <HowItWorks>
        Readings come from your smart meters through Hildebrand Bright (DCC data, half-hourly, usually a day or so behind — gas
        can lag more). NEURO keeps its own copy of the whole history. A half-hour Bright has no reading for is shown as missing,
        never as zero, and a day is only “complete” when every half-hour is in. Costs are estimates from the tariff NEURO holds
        (the meter’s, or one you add) — not your bill. Gas is compared with the outdoor temperature (heating degree days, base
        15.5 °C) to say what the weather explains; that is a correlation in this house’s history, not a cause. You get one
        notification when a complete day is clearly unusual.
      </HowItWorks>
    </div>
  );
}
