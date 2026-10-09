import React, { useState } from 'react';
import { useCanonical, postCanonical, HowItWorks, Fold } from './canonicalUi';

/**
 * Build 21 → 27 — Life → Transport.
 *
 * What the car IS (your record), what it NEEDS (dates, repairs), what it COSTS
 * (Tally's figures, shown exactly as Tally gives them), and whether you need to
 * do anything. Which transactions are the car's is decided in Tally (Outlook →
 * Motoring) — this card never classifies spending. Unknown stays unknown and
 * says so; a figure that cannot be honestly worked out shows the reason. No map,
 * no route, no trip diary, and nothing here recommends keeping, selling or
 * buying a car.
 */

const OB_TYPES = [['mot', 'MOT'], ['tax', 'Vehicle tax'], ['insurance', 'Insurance'], ['service', 'Service'], ['warranty', 'Warranty'], ['breakdown_cover', 'Breakdown cover']];
const EV_TYPES = [['scheduled_service', 'Service'], ['repair', 'Repair'], ['breakdown', 'Breakdown'], ['tyres', 'Tyres'], ['battery', 'Battery'], ['brakes', 'Brakes'], ['exhaust', 'Exhaust'], ['fluids', 'Fluids'], ['suspension', 'Suspension'], ['inspection', 'Inspection'], ['mot_work', 'MOT work'], ['other', 'Other']];
const TYRE_ACTIONS = ['fitted', 'replaced', 'repaired', 'puncture', 'inspection'];
const REPAIRISH = ['repair', 'breakdown', 'battery', 'brakes', 'exhaust', 'suspension'];
const BUCKETS = [['fuelSpendPence', 'Fuel'], ['insuranceSpendPence', 'Insurance'], ['maintenanceSpendPence', 'Maintenance'], ['repairsSpendPence', 'Repairs'], ['taxSpendPence', 'Tax'], ['breakdownSpendPence', 'Breakdown'], ['financeRepaymentsPence', 'Finance'], ['otherMotoringSpendPence', 'Other']];
const STATE_WORDS = { overdue: 'Overdue', needs_you: 'Needs you', preparation_open: 'In hand', upcoming: 'Upcoming', later: 'Later', unknown: 'No date', complete: 'Done' };
const CONF_WORDS = { verified: 'verified', stated: 'your record', conflict: 'differs from official', unknown: 'unknown' };
const HEALTH_WORDS = { current: 'Current', attention_needed: 'Needs attention', incomplete_data: 'Incomplete', unknown: 'Unknown' };
const DRIVE_WORDS = { driving: 'Driving now', recently_drove: 'Was in the car recently', parked: 'Not driving', unknown: 'Driving: unknown' };
// Tally's pence, displayed — formatting only, never arithmetic.
const money = (p) => (p == null ? '—' : `£${(p / 100).toFixed(2)}`);
const label = (pairs, k) => (pairs.find(([v]) => v === k) || [k, k])[1];

export default function TransportCard() {
  const { data, error, reload } = useCanonical('/api/transport');
  const tasks = useCanonical('/api/canonical/tasks?status=open');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);
  const act = async (fn) => {
    setBusy(true); setNote(null);
    try { await fn(); await reload(); } catch (e) { setNote(`Not saved — ${e.message}`); }
    setBusy(false);
  };
  if (error && !data) return <section className="cn-section"><h3>Transport</h3><div className="cn-error">Couldn’t read transport — {error}</div></section>;
  if (!data) return <section className="cn-section"><h3>Transport</h3><div className="cn-muted">Reading…</div></section>;
  return <TransportView data={data} tasks={(tasks.data && tasks.data.items) || []} busy={busy} act={act} note={note} />;
}

// Exported for the render test: the container fetches in useEffect, which renderToString never runs.
export function TransportView({ data, tasks = [], busy = false, act = () => {}, note = null }) {
  return (
    <section className="cn-section">
      <h3>Transport</h3>
      {note && <div className="cn-error">{note}</div>}
      {!data.vehicles.length
        ? <><div className="cn-muted">No vehicle recorded. Add one and only what you know about it.</div><CreateVehicle busy={busy} act={act} /></>
        : data.vehicles.map((v) => <OneVehicle key={v.vehicle.id} r={v} driving={data.driving} tallyUrl={data.tallyUrl} tasks={tasks} busy={busy} act={act} />)}
    </section>
  );
}

function CreateVehicle({ busy, act }) {
  const [f, setF] = useState({ make: '', model: '', plateDescriptor: '', fuelType: '' });
  return (
    <form className="cn-goalform" onSubmit={(e) => { e.preventDefault(); act(() => postCanonical('/api/vehicle', f)); }}>
      <input value={f.make} onChange={(e) => setF({ ...f, make: e.target.value })} placeholder="Make" aria-label="Make" />
      <input value={f.model} onChange={(e) => setF({ ...f, model: e.target.value })} placeholder="Model" aria-label="Model" />
      <input value={f.plateDescriptor} onChange={(e) => setF({ ...f, plateDescriptor: e.target.value })} placeholder="Plate, e.g. 65-plate" aria-label="Plate" />
      <input value={f.fuelType} onChange={(e) => setF({ ...f, fuelType: e.target.value })} placeholder="Fuel" aria-label="Fuel type" />
      <button type="submit" className="cn-btn" disabled={busy || !f.make || !f.model}>Add vehicle</button>
    </form>
  );
}

export function OneVehicle({ r, driving, tallyUrl, tasks = [], busy, act }) {
  const v = r.vehicle;
  const base = `/api/vehicle/${encodeURIComponent(v.id)}`;
  const name = `${v.make} ${v.model}`;
  const open = r.obligations.filter((o) => o.recordStatus === 'open');
  const done = r.obligations.filter((o) => o.recordStatus !== 'open');
  const urgent = r.needsYou.length > 0;
  const fin = r.finance;
  const next = r.nextObligation;
  return (
    <div className="cn-care">
      <div className="cn-care-row">
        <span className="cn-rowtitle">{name}</span>
        <span className="cn-muted">{[v.registration, v.plateDescriptor, v.variant, v.fuelType].filter(Boolean).join(' · ')}</span>
        <span className="cn-muted">{v.currentMileage != null ? `${v.currentMileage.toLocaleString()} mi (${v.mileageObservedAt})` : 'mileage not recorded'}</span>
        {driving && <span className="cn-chip cn-chip--soft" title={`${driving.why}. ${driving.note}.`}>{DRIVE_WORDS[driving.state] || driving.state}</span>}
      </div>

      {r.needsYou.length > 0 && (
        <ul className="cn-act-lines">{r.needsYou.map((n) => <li key={n.id} className="cn-error">Needs you — {n.line}</li>)}</ul>
      )}

      <div className="cn-glance">
        {!open.length && <span className="cn-muted">No MOT, tax, insurance or service date recorded yet.</span>}
        {open.map((o) => (
          <span key={o.id} className={`cn-chip ${o.status === 'needs_you' || o.status === 'overdue' ? 'cn-chip--firm' : 'cn-chip--soft'}`} title={o.statusWhy}>
            {o.label} {o.dueDate || '—'} · {STATE_WORDS[o.status] || o.status}
          </span>
        ))}
        <span className="cn-chip cn-chip--soft" title={r.health.why.join(' ')}>Health: {HEALTH_WORDS[r.health.state] || r.health.state}</span>
      </div>
      {next && <div className="cn-small cn-muted">Next: {next.label} {next.dueDate} — {next.statusWhy}</div>}

      <Fold title="Dates" meta={open.length ? `${open.length} recorded${urgent ? ' — needs you' : ''}` : 'none recorded'} open={urgent}>
        <ul className="cn-list">{open.map((o) => <Obligation key={o.id} o={o} busy={busy} act={act} />)}</ul>
        {r.actionSuggestions.map((s) => (
          <div key={`${s.obligationId}:${s.taskId}`} className="cn-hike-form">
            <span className="cn-muted">“{s.description}” — {s.why}.</span>
            <button type="button" className="cn-btn cn-btn--tiny" disabled={busy}
              onClick={() => act(() => postCanonical(`/api/vehicle/obligations/${encodeURIComponent(s.obligationId)}`, { linkedTaskRef: s.taskId }))}>Make it the {s.label}’s action</button>
          </div>
        ))}
        <AddObligation base={base} tasks={tasks} busy={busy} act={act} />
        {done.length > 0 && (
          <details className="cn-details"><summary>Done ({done.length})</summary>
            <ul className="cn-act-lines">{done.map((o) => <li key={o.id}>{o.label} — {o.statusWhy}</li>)}</ul>
          </details>
        )}
      </Fold>

      <Fold title="Running costs (Tally)" meta={fin.available && fin.latestCompleteMonth ? `${fin.latestCompleteMonth.month}: ${money(fin.latestCompleteMonth.totalVehicleSpendPence)}` : fin.available ? 'no complete month yet' : 'not available'}>
        <Costs r={r} tallyUrl={tallyUrl} />
      </Fold>

      <Fold title="Mileage" meta={v.currentMileage != null ? `${v.currentMileage.toLocaleString()} mi on ${v.mileageObservedAt}` : 'not recorded'}>
        <Mileage r={r} base={base} busy={busy} act={act} />
      </Fold>

      <Fold title="Fuel & MPG" meta={r.fuel.mpg.latest ? `${r.fuel.mpg.latest.mpg} mpg (${r.fuel.mpg.latest.quality})` : 'not enough data'}>
        <Fuel r={r} base={base} busy={busy} act={act} />
      </Fold>

      <Fold title="History" meta={r.history.length ? `${r.history.length} entr${r.history.length === 1 ? 'y' : 'ies'}${r.tyres.length ? ` · ${r.tyres.length} tyre` : ''}` : 'nothing recorded'}>
        <History r={r} base={base} busy={busy} act={act} />
      </Fold>

      <Fold title="Details" meta={v.unknown.length ? `Not known: ${v.unknown.join(', ')}` : 'complete'}>
        <VehicleFacts v={v} base={base} busy={busy} act={act} />
      </Fold>

      <Fold title="Official record" meta={r.official.latest ? `checked ${r.official.latest.checked_at.slice(0, 10)}` : 'no reading yet'}>
        <Official r={r} base={base} busy={busy} act={act} />
      </Fold>

      <Fold title="Health & replacement evidence" meta={`${HEALTH_WORDS[r.health.state] || r.health.state} · ${r.replacement.state.replace(/_/g, ' ')}`}>
        <Health r={r} />
      </Fold>

      <Fold title="Sources" meta={r.sources.filter((s) => ['none', 'unavailable', 'incomplete', 'old', 'unread', 'not-offered', 'nothing-classified'].includes(s.state)).length ? 'some missing' : 'all reporting'}>
        <ul className="cn-act-lines">{r.sources.map((s) => <li key={s.id}><b>{s.label}</b>: {String(s.state).replace(/[-_]/g, ' ')} — {s.why}</li>)}</ul>
      </Fold>

      <Fold title={`Linked to the ${v.model}`} meta={r.links.length ? `${r.links.length} task${r.links.length === 1 ? '' : 's'}` : 'nothing linked'}>
        <Links r={r} name={name} tasks={tasks} busy={busy} act={act} />
      </Fold>
    </div>
  );
}

function Costs({ r, tallyUrl }) {
  const fin = r.finance;
  const cpm = r.costPerMile;
  if (!fin.available) {
    return (
      <>
        <div className="cn-muted">{fin.why}.</div>
        <div className="cn-small cn-muted">Which transactions are the car’s is decided in <a href={tallyUrl} target="_blank" rel="noreferrer">Tally</a> → {fin.reviewIn.replace(/^Tally → /, '')}.</div>
      </>
    );
  }
  const m = fin.latestCompleteMonth;
  const cur = fin.currentMonth;
  const line = (x) => BUCKETS.filter(([k]) => x[k]).map(([k, l]) => `${l} ${money(x[k])}`).join(' · ') || 'nothing classified';
  return (
    <>
      {m && <div className="cn-care-row"><span className="cn-now-k">{m.month}</span><span>{money(m.totalVehicleSpendPence)}</span><span className="cn-muted">{line(m)}</span></div>}
      {cur && cur !== m && <div className="cn-care-row"><span className="cn-now-k">{cur.month} so far</span><span>{money(cur.totalVehicleSpendPence)}</span><span className="cn-muted">partial — {cur.reasons.join('; ') || 'month not over'}</span></div>}
      {[['Last 3 months', fin.last3CompleteMonths], ['Last 12 months', fin.rolling12m]].map(([l, w]) => (
        <div key={l} className="cn-care-row"><span className="cn-now-k">{l}</span>{w.available ? <><span>{money(w.totalVehicleSpendPence)}</span><span className="cn-muted">{w.from} – {w.to}</span></> : <span className="cn-muted">{w.why}</span>}</div>
      ))}
      <div className="cn-care-row"><span className="cn-now-k">Trend</span><span>{String(fin.trend.state).replace(/_/g, ' ')}</span>{fin.trend.why && <span className="cn-muted">{fin.trend.why}</span>}</div>
      <div className="cn-care-row"><span className="cn-now-k">Per mile</span>
        {cpm.value != null
          ? <span>{cpm.value}p ({cpm.fuelValue}p fuel) — Tally’s {money(cpm.numerator.totalPence)} over {cpm.numerator.from} – {cpm.numerator.to} ÷ {cpm.denominator.miles.toLocaleString()} mi from your readings{cpm.why ? ` — ${cpm.why}` : ''}</span>
          : <span className="cn-muted">{cpm.why}</span>}
      </div>
      {fin.review && fin.review.pending > 0 && <div className="cn-small cn-muted">{fin.review.pending} transaction{fin.review.pending === 1 ? '' : 's'} might be the car’s — review them in <a href={tallyUrl} target="_blank" rel="noreferrer">Tally</a> → Outlook → Motoring.</div>}
      <HowItWorks>Every figure here is Tally’s ({fin.confidence} confidence). {fin.explanation.join(' ')} Cost per mile is the one sum NEURO does: Tally’s total for a window of complete months divided by the miles your odometer readings measure across the same window.</HowItWorks>
    </>
  );
}

function Fuel({ r, base, busy, act }) {
  const [f, setF] = useState({ filledOn: r.today, litres: '', odometer: '', fullTank: true });
  const mpg = r.fuel.mpg;
  return (
    <>
      <div className="cn-care-row"><span className="cn-now-k">MPG</span>
        {mpg.latest ? <span>{mpg.latest.mpg} ({mpg.latest.quality}, {mpg.latest.from} – {mpg.latest.to}){mpg.rolling ? ` · ${mpg.rolling.days}-day ${mpg.rolling.mpg} (${mpg.rolling.quality})` : ''}</span> : <span className="cn-muted">Not enough data — {mpg.why}</span>}
      </div>
      {mpg.why && mpg.latest && <div className="cn-small cn-muted">{mpg.why}</div>}
      <form className="cn-hike-form" onSubmit={(e) => { e.preventDefault(); act(async () => { await postCanonical(`${base}/fuel`, { filledOn: f.filledOn, litres: Number(f.litres), odometer: f.odometer ? Number(f.odometer) : null, fullTank: f.fullTank }); setF({ ...f, litres: '', odometer: '' }); }); }}>
        <input type="date" value={f.filledOn} max={r.today} onChange={(e) => setF({ ...f, filledOn: e.target.value })} aria-label="Filled on" />
        <input className="cn-input--tiny" type="number" min="0" step="0.01" value={f.litres} onChange={(e) => setF({ ...f, litres: e.target.value })} placeholder="litres" aria-label="Litres" />
        <input type="number" min="0" value={f.odometer} onChange={(e) => setF({ ...f, odometer: e.target.value })} placeholder="odometer at the pump" aria-label="Odometer at the pump" />
        <label className="cn-muted"><input type="checkbox" checked={f.fullTank} onChange={(e) => setF({ ...f, fullTank: e.target.checked })} /> filled to the brim</label>
        <button type="submit" className="cn-btn" disabled={busy || !f.litres}>Add fill</button>
      </form>
      {r.fuel.fills.length > 0 && (
        <ul className="cn-act-lines">{r.fuel.fills.slice(0, 6).map((x) => (
          <li key={x.id}>{x.filledOn} — {x.litres} L{x.odometer != null ? ` at ${Number(x.odometer).toLocaleString()} ${x.odometerUnit}` : ''}{x.fullTank ? ' · brim' : ''}
            {' '}<button type="button" className="cn-btn cn-btn--tiny" disabled={busy} onClick={() => act(() => postCanonical(`${base}/fuel/${encodeURIComponent(x.id)}/withdraw`, {}))}>Remove</button></li>))}</ul>
      )}
      <div className="cn-small cn-muted">Litres and the odometer only — what a fill cost is Tally’s.</div>
    </>
  );
}

function VehicleFacts({ v, base, busy, act }) {
  const [f, setF] = useState({ registration: '', variant: '', vin: '', firstRegistered: '', ownershipStart: '' });
  const missing = [['registration', 'Registration', 'text'], ['variant', 'Engine / trim (as on the V5C)', 'text'], ['vin', 'VIN', 'text'], ['firstRegistered', 'First registered (YYYY-MM)', 'text'], ['ownershipStart', 'Owned since (YYYY-MM)', 'text']].filter(([k]) => !v[k]);
  return (
    <>
      <ul className="cn-act-lines">
        {v.registration && <li>Registration {v.registration}</li>}
        {v.variant && <li>Engine / trim {v.variant}</li>}
        {v.vin && <li>VIN {v.vin}</li>}
        {(v.firstRegistered || v.registeredWindow) && <li>Registered {v.firstRegistered || `${v.registeredWindow.from} – ${v.registeredWindow.to} (from ${v.registeredWindow.basis})`}</li>}
        {v.ownershipStart && <li>Owned since {v.ownershipStart}</li>}
      </ul>
      {missing.length > 0 && (
        <form className="cn-hike-form" onSubmit={(e) => { e.preventDefault(); const body = Object.fromEntries(Object.entries(f).filter(([, x]) => x)); act(() => postCanonical(base, body)); }}>
          {missing.map(([k, ph]) => <input key={k} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} placeholder={ph} aria-label={ph} maxLength={k === 'vin' ? 17 : 80} />)}
          <button type="submit" className="cn-btn" disabled={busy || !Object.values(f).some(Boolean)}>Save</button>
        </form>
      )}
    </>
  );
}

function Obligation({ o, busy, act }) {
  const [resolving, setResolving] = useState(false);
  const [f, setF] = useState({ evidence: '', nextDueDate: '' });
  const firm = o.status === 'needs_you' || o.status === 'overdue';
  return (
    <li className="cn-row">
      <span className="cn-rowtitle">{o.label}</span>
      <span className="cn-muted">{o.dueDate || 'no date'}{o.dueMileage != null ? ` · or ${Number(o.dueMileage).toLocaleString()} mi` : ''}{o.dueDerived ? ` · from your ${o.interval.basis} interval` : ''}</span>
      <span className={`cn-chip ${firm ? 'cn-chip--firm' : 'cn-chip--soft'}`} title={o.statusWhy}>{STATE_WORDS[o.status] || o.status}</span>
      <span className="cn-muted">{o.statusWhy} · {CONF_WORDS[o.confidence] || o.confidence}</span>
      {o.linkedTask && <span className="cn-muted">action: “{o.linkedTask.description}” ({o.linkedTask.state})</span>}
      {o.actionNote && <div className="cn-small cn-muted">{o.actionNote}</div>}
      {o.conflict && (
        <div className="cn-error">{o.conflict.message}: you recorded {o.conflict.neuro.value}; {o.conflict.official.source} says {o.conflict.official.value} ({o.conflict.official.observedAt.slice(0, 10)}). Nothing was changed — correct whichever is wrong.</div>
      )}
      {!resolving
        ? <button type="button" className="cn-btn cn-btn--tiny" disabled={busy} onClick={() => setResolving(true)}>It’s done…</button>
        : (
          <form className="cn-hike-form" onSubmit={(e) => { e.preventDefault(); act(() => postCanonical(`/api/vehicle/obligations/${encodeURIComponent(o.id)}/resolve`, { outcome: 'complete', evidence: f.evidence, nextDueDate: f.nextDueDate || null })); }}>
            <input value={f.evidence} onChange={(e) => setF({ ...f, evidence: e.target.value })} placeholder="What shows it’s done (certificate, renewal…)" aria-label="Evidence" maxLength={300} />
            <input type="date" value={f.nextDueDate} onChange={(e) => setF({ ...f, nextDueDate: e.target.value })} aria-label="Next due date (optional)" />
            <button type="submit" className="cn-btn" disabled={busy || !f.evidence.trim()}>Mark done</button>
            <button type="button" className="cn-btn cn-btn--tiny" onClick={() => setResolving(false)}>Cancel</button>
          </form>
        )}
    </li>
  );
}

function AddObligation({ base, tasks, busy, act }) {
  const [f, setF] = useState({ type: 'mot', dueDate: '', dueMileage: '', linkedTaskRef: '', intervalMonths: '', intervalMiles: '', intervalBasis: '' });
  const byMileage = f.type === 'service' || f.type === 'warranty';
  const submit = (e) => {
    e.preventDefault();
    const body = { type: f.type, dueDate: f.dueDate || null, linkedTaskRef: f.linkedTaskRef || null };
    if (byMileage && f.dueMileage) body.dueMileage = Number(f.dueMileage);
    if (f.type === 'service' && f.intervalBasis) Object.assign(body, { intervalMonths: f.intervalMonths ? Number(f.intervalMonths) : null, intervalMiles: f.intervalMiles ? Number(f.intervalMiles) : null, intervalBasis: f.intervalBasis });
    act(async () => { await postCanonical(`${base}/obligations`, body); setF({ ...f, dueDate: '', dueMileage: '', linkedTaskRef: '' }); });
  };
  return (
    <form className="cn-goalform" onSubmit={submit}>
      <select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })} aria-label="Which date">{OB_TYPES.map(([k, w]) => <option key={k} value={k}>{w}</option>)}</select>
      <input type="date" value={f.dueDate} onChange={(e) => setF({ ...f, dueDate: e.target.value })} aria-label="Due date" />
      {byMileage && <input type="number" min="1" value={f.dueMileage} onChange={(e) => setF({ ...f, dueMileage: e.target.value })} placeholder="or at miles" aria-label="Due at mileage" />}
      {f.type === 'service' && (
        <>
          <input className="cn-input--tiny" type="number" min="1" max="60" value={f.intervalMonths} onChange={(e) => setF({ ...f, intervalMonths: e.target.value })} placeholder="every months" aria-label="Interval months" />
          <input className="cn-input--tiny" type="number" min="1" value={f.intervalMiles} onChange={(e) => setF({ ...f, intervalMiles: e.target.value })} placeholder="every miles" aria-label="Interval miles" />
          <input value={f.intervalBasis} onChange={(e) => setF({ ...f, intervalBasis: e.target.value })} placeholder="interval from (service book…)" aria-label="Where the interval comes from" />
        </>
      )}
      <select value={f.linkedTaskRef} onChange={(e) => setF({ ...f, linkedTaskRef: e.target.value })} aria-label="Its action (task or reminder)">
        <option value="">no linked task</option>
        {tasks.map((t) => <option key={t.id} value={t.id}>{t.description}</option>)}
      </select>
      <button type="submit" className="cn-btn" disabled={busy || (!f.dueDate && !f.dueMileage) || ((f.intervalMonths || f.intervalMiles) && !f.intervalBasis)}>Add</button>
    </form>
  );
}

function Official({ r, base, busy, act }) {
  const [f, setF] = useState({ motStatus: '', motExpiryDate: '', taxStatus: '', taxDueDate: '' });
  const latest = r.official.latest;
  return (
    <>
      {latest
        ? <div className="cn-muted">Last official reading ({latest.source}, {latest.checked_at.slice(0, 10)}): MOT {latest.mot_status || '—'}{latest.mot_expiry_date ? ` to ${latest.mot_expiry_date}` : ''}; tax {latest.tax_status || '—'}{latest.tax_due_date ? ` due ${latest.tax_due_date}` : ''}.</div>
        : <div className="cn-muted">No official reading yet.</div>}
      <ul className="cn-act-lines">{r.official.sources.map((s) => <li key={s.source}>{s.name}: {s.available ? 'available' : `not available — ${s.why}`}</li>)}</ul>
      {r.official.sources.find((s) => s.source === 'dvla-ves').available && (
        <button type="button" className="cn-btn" disabled={busy} onClick={() => act(() => postCanonical(`${base}/official-check`, {}))}>Check with DVLA</button>
      )}
      <form className="cn-hike-form" onSubmit={(e) => { e.preventDefault(); const body = Object.fromEntries(Object.entries(f).filter(([, x]) => x)); act(() => postCanonical(`${base}/official-by-hand`, body)); }}>
        <span className="cn-muted">From gov.uk:</span>
        <input value={f.motStatus} onChange={(e) => setF({ ...f, motStatus: e.target.value })} placeholder="MOT status" aria-label="MOT status" maxLength={30} />
        <input type="date" value={f.motExpiryDate} onChange={(e) => setF({ ...f, motExpiryDate: e.target.value })} aria-label="MOT expiry" />
        <input value={f.taxStatus} onChange={(e) => setF({ ...f, taxStatus: e.target.value })} placeholder="Tax status" aria-label="Tax status" maxLength={30} />
        <input type="date" value={f.taxDueDate} onChange={(e) => setF({ ...f, taxDueDate: e.target.value })} aria-label="Tax due" />
        <button type="submit" className="cn-btn" disabled={busy || !Object.values(f).some(Boolean)}>Record</button>
      </form>
    </>
  );
}

function Mileage({ r, base, busy, act }) {
  const [f, setF] = useState({ value: '', observedOn: r.today, correction: false });
  return (
    <>
      <form className="cn-hike-form" onSubmit={(e) => { e.preventDefault(); act(async () => { await postCanonical(`${base}/mileage`, { value: Number(f.value), observedOn: f.observedOn, correction: f.correction }); setF({ ...f, value: '' }); }); }}>
        <input type="number" min="0" value={f.value} onChange={(e) => setF({ ...f, value: e.target.value })} placeholder="Odometer (miles)" aria-label="Odometer reading" />
        <input type="date" value={f.observedOn} max={r.today} onChange={(e) => setF({ ...f, observedOn: e.target.value })} aria-label="Read on" />
        <label className="cn-muted"><input type="checkbox" checked={f.correction} onChange={(e) => setF({ ...f, correction: e.target.checked })} /> odometer corrected/replaced</label>
        <button type="submit" className="cn-btn" disabled={busy || !f.value}>Add reading</button>
      </form>
      {r.mileage.readings.length > 0 && (
        <ul className="cn-act-lines">
          {r.mileage.readings.slice(0, 6).map((m) => (
            <li key={m.id}>{m.observedOn} — {m.miles.toLocaleString()} mi ({m.source}){m.state === 'needs-review' ? <span className="cn-error"> needs review: {m.review}</span> : ''}
              {' '}<button type="button" className="cn-btn cn-btn--tiny" disabled={busy} onClick={() => act(() => postCanonical(`${base}/mileage/${m.id}/withdraw`, {}))}>Remove</button>
            </li>
          ))}
        </ul>
      )}
      <div className="cn-small cn-muted">The odometer only — never worked out from where the phone has been.</div>
    </>
  );
}

function History({ r, base, busy, act }) {
  const [f, setF] = useState({ type: 'scheduled_service', date: '', description: '', mileage: '', action: '', position: '', outcome: '' });
  const submit = (e) => {
    e.preventDefault();
    const body = { type: f.type, date: f.date, description: f.description, mileage: f.mileage || null };
    if (f.type === 'tyres') Object.assign(body, { action: f.action || null, position: f.position || null });
    if (REPAIRISH.includes(f.type) && f.outcome) body.outcome = f.outcome;
    act(async () => { await postCanonical(`${base}/events`, body); setF({ ...f, description: '', mileage: '' }); });
  };
  return (
    <>
      {!r.history.length && <div className="cn-muted">No service, repair or tyre history recorded. A garage payment never creates one by itself.</div>}
      <ul className="cn-act-lines">
        {r.history.map((h) => (
          <li key={h.id}>{h.date} — {label(EV_TYPES, h.type)}: {h.description}{h.mileage != null ? ` · ${Number(h.mileage).toLocaleString()} mi` : ''}
            {h.detail ? ` · ${Object.entries(h.detail).map(([k, x]) => `${k} ${x}`).join(', ')}` : ''}{h.costRef ? ' · cost in Tally' : ''}
          </li>
        ))}
      </ul>
      <form className="cn-goalform" onSubmit={submit}>
        <select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })} aria-label="What kind">{EV_TYPES.map(([k, w]) => <option key={k} value={k}>{w}</option>)}</select>
        <input type="date" value={f.date} max={r.today} onChange={(e) => setF({ ...f, date: e.target.value })} aria-label="Date" />
        <input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} placeholder="What was done" aria-label="Description" maxLength={400} />
        <input className="cn-input--tiny" type="number" min="0" value={f.mileage} onChange={(e) => setF({ ...f, mileage: e.target.value })} placeholder="miles" aria-label="Mileage" />
        {f.type === 'tyres' && (
          <>
            <select value={f.action} onChange={(e) => setF({ ...f, action: e.target.value })} aria-label="Tyre action"><option value="">what happened</option>{TYRE_ACTIONS.map((a) => <option key={a} value={a}>{a}</option>)}</select>
            <input className="cn-input--tiny" value={f.position} onChange={(e) => setF({ ...f, position: e.target.value })} placeholder="position" aria-label="Position" />
          </>
        )}
        {REPAIRISH.includes(f.type) && (
          <select value={f.outcome} onChange={(e) => setF({ ...f, outcome: e.target.value })} aria-label="Outcome"><option value="">outcome</option><option value="resolved">resolved</option><option value="unresolved">unresolved</option><option value="monitoring">monitoring</option></select>
        )}
        <button type="submit" className="cn-btn" disabled={busy || !f.date || !f.description.trim()}>Add</button>
      </form>
      <div className="cn-small cn-muted">What it cost stays in Tally. No tyre or service schedule is assumed.</div>
    </>
  );
}

function Health({ r }) {
  const h = r.health;
  const rep = r.replacement;
  return (
    <>
      <div className="cn-care-row"><span className="cn-now-k">Health</span><span>{HEALTH_WORDS[h.state] || h.state}</span></div>
      <ul className="cn-act-lines">{h.why.map((w) => <li key={w}>{w}</li>)}</ul>
      <div className="cn-small cn-muted">{h.rule}</div>
      <div className="cn-care-row"><span className="cn-now-k">Replacement evidence</span><span>{rep.state.replace(/_/g, ' ')}</span></div>
      <ul className="cn-act-lines">{rep.items.map((i) => <li key={i.key}>{i.key.replace(/([A-Z])/g, ' $1').toLowerCase()}: {i.known ? i.value : <span className="cn-muted">{i.why}</span>}</li>)}</ul>
      <div className="cn-small cn-muted">{rep.stance}</div>
    </>
  );
}

function Links({ r, name, tasks = [], busy, act }) {
  const [linkTo, setLinkTo] = useState('');
  const linked = new Set(r.links.map((l) => l.entityId));
  const suggested = new Set(r.linkSuggestions.map((x) => x.id));
  const others = tasks.filter((t) => !linked.has(t.id) && !suggested.has(t.id));
  const describe = (id) => (r.linkSuggestions.find((x) => x.id === id) || tasks.find((t) => t.id === id) || {}).description;
  return (
    <>
      {!r.links.length && <div className="cn-muted">A task counts as the car’s only when you link it.</div>}
      <ul className="cn-act-lines">{r.links.map((l) => <li key={l.entityId}>{l.label || describe(l.entityId) || l.entityId} <button type="button" className="cn-btn cn-btn--tiny" disabled={busy} onClick={() => act(() => postCanonical('/api/canonical/vehicle-links/remove', { vehicle: r.vehicle.id, entityId: l.entityId }))}>Unlink</button></li>)}</ul>
      {(r.linkSuggestions.length > 0 || others.length > 0) && (
        <div className="cn-hike-form">
          <select value={linkTo} onChange={(e) => setLinkTo(e.target.value)} aria-label={`Link to the ${name}`} disabled={busy}>
            <option value="">{r.linkSuggestions.length ? `${r.linkSuggestions.length} open task${r.linkSuggestions.length === 1 ? '' : 's'} mention the car — link one…` : 'Link a task to the car…'}</option>
            {r.linkSuggestions.length > 0 && <optgroup label="Mention the car">{r.linkSuggestions.map((s) => <option key={s.id} value={s.id}>{s.description}</option>)}</optgroup>}
            {others.length > 0 && <optgroup label="Other open tasks">{others.map((t) => <option key={t.id} value={t.id}>{t.description}</option>)}</optgroup>}
          </select>
          <button type="button" className="cn-btn" disabled={busy || !linkTo} onClick={() => act(async () => { await postCanonical('/api/canonical/vehicle-links', { vehicle: r.vehicle.id, entityId: linkTo, label: describe(linkTo) }); setLinkTo(''); })}>Link</button>
        </div>
      )}
    </>
  );
}
