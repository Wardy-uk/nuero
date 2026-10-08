import React, { useState } from 'react';
import { useCanonical, postCanonical } from './canonicalUi';

/**
 * Build 21 — the Captur under Life → Vehicle.
 *
 * Only what Nick recorded, what an official source said, and what Tally holds
 * that he CONFIRMED is the car's. Unknown stays unknown and says so; a figure
 * NEURO cannot honestly compute shows the reason instead of a number. Ticking
 * "Book MOT" never marks the MOT done — that needs evidence. Evidence only:
 * nothing here recommends replacing, selling or buying a car.
 */

const OB_TYPES = [['mot', 'MOT'], ['tax', 'Vehicle tax'], ['insurance', 'Insurance'], ['service', 'Service'], ['warranty', 'Warranty'], ['breakdown_cover', 'Breakdown cover']];
const EV_TYPES = [['scheduled_service', 'Service'], ['repair', 'Repair'], ['tyres', 'Tyres'], ['battery', 'Battery'], ['brakes', 'Brakes'], ['exhaust', 'Exhaust'], ['suspension', 'Suspension'], ['mot_work', 'MOT work'], ['other', 'Other']];
const SPEND_TYPES = [['fuel', 'Fuel'], ['insurance', 'Insurance'], ['tax', 'Tax'], ['service', 'Service'], ['repair', 'Repair'], ['tyres', 'Tyres'], ['mot', 'MOT'], ['breakdown_cover', 'Breakdown cover'], ['warranty', 'Warranty'], ['parking', 'Parking (not counted)'], ['other', 'Other']];
const STATE_WORDS = { overdue: 'Overdue', needs_you: 'Needs you', preparation_open: 'In hand', upcoming: 'Upcoming', later: 'Later', unknown: 'No date', complete: 'Done' };
const CONF_WORDS = { verified: 'verified', stated: 'your record', conflict: 'differs from official', unknown: 'unknown' };
const money = (p) => (p == null ? '—' : `£${(p / 100).toFixed(2)}`);
const label = (pairs, k) => (pairs.find(([v]) => v === k) || [k, k])[1];

export default function VehicleCard() {
  const { data, error, reload } = useCanonical('/api/vehicle');
  const review = useCanonical('/api/vehicle/finance/review');
  const tasks = useCanonical('/api/canonical/tasks?status=open');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);

  const act = async (fn) => {
    setBusy(true); setNote(null);
    try { await fn(); await reload(); await review.reload(); } catch (e) { setNote(`Not saved — ${e.message}`); }
    setBusy(false);
  };

  if (error && !data) return <section className="cn-section"><h3>Vehicle</h3><div className="cn-error">Couldn’t read the vehicle — {error}</div></section>;
  if (!data) return <section className="cn-section"><h3>Vehicle</h3><div className="cn-muted">Reading…</div></section>;
  if (!data.vehicles.length) {
    return (
      <section className="cn-section">
        <h3>Vehicle</h3>
        <div className="cn-muted">No vehicle recorded. Add one and only what you know about it.</div>
        <CreateVehicle busy={busy} act={act} />
        {note && <div className="cn-error">{note}</div>}
      </section>
    );
  }
  return (
    <section className="cn-section">
      <h3>Vehicle</h3>
      {note && <div className="cn-error">{note}</div>}
      {data.vehicles.map((v) => <OneVehicle key={v.vehicle.id} r={v} review={review.data} tasks={(tasks.data && tasks.data.items) || []} busy={busy} act={act} />)}
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

// Exported for the render test: the container fetches in useEffect, which
// renderToString never runs.
export function OneVehicle({ r, review, tasks, busy, act }) {
  const v = r.vehicle;
  const base = `/api/vehicle/${encodeURIComponent(v.id)}`;
  const name = `${v.make} ${v.model}`;
  const open = r.obligations.filter((o) => o.recordStatus === 'open');
  const done = r.obligations.filter((o) => o.recordStatus !== 'open');
  return (
    <div className="cn-care">
      <div className="cn-care-row">
        <span className="cn-rowtitle">{name}</span>
        <span className="cn-muted">{[v.plateDescriptor, v.fuelType, v.registration].filter(Boolean).join(' · ')}</span>
        <span className="cn-muted">{v.currentMileage != null ? `${v.currentMileage.toLocaleString()} mi (${v.mileageObservedAt})` : 'mileage not recorded'}</span>
      </div>
      {v.unknown.length > 0 && <div className="cn-small cn-muted">Not known: {v.unknown.join(', ')}.</div>}
      <VehicleFacts v={v} base={base} busy={busy} act={act} />

      <h4 className="cn-subhead">Dates</h4>
      {!open.length && <div className="cn-muted">No MOT, tax, insurance or service date recorded. NEURO assumes none.</div>}
      <ul className="cn-list">
        {open.map((o) => <Obligation key={o.id} o={o} busy={busy} act={act} />)}
      </ul>
      <AddObligation base={base} tasks={tasks} busy={busy} act={act} />
      {done.length > 0 && (
        <details className="cn-details"><summary>Done ({done.length})</summary>
          <ul className="cn-act-lines">{done.map((o) => <li key={o.id}>{o.label} — {o.statusWhy}</li>)}</ul>
        </details>
      )}

      <h4 className="cn-subhead">Official record</h4>
      <Official r={r} base={base} busy={busy} act={act} />

      <h4 className="cn-subhead">Mileage</h4>
      <Mileage r={r} base={base} busy={busy} act={act} />

      <h4 className="cn-subhead">History</h4>
      <History r={r} base={base} busy={busy} act={act} />

      <h4 className="cn-subhead">Running costs</h4>
      <Costs r={r} />

      <h4 className="cn-subhead">Spending that might be the {v.model}</h4>
      <SpendReview review={review} vehicleId={v.id} busy={busy} act={act} />

      <h4 className="cn-subhead">Health — evidence only</h4>
      <Health h={r.health} />

      <Links r={r} name={name} busy={busy} act={act} />
    </div>
  );
}

function VehicleFacts({ v, base, busy, act }) {
  const [reg, setReg] = useState('');
  const [variant, setVariant] = useState('');
  if (v.registration && v.variant) return null;
  return (
    <form className="cn-hike-form" onSubmit={(e) => { e.preventDefault(); const body = {}; if (reg) body.registration = reg; if (variant) body.variant = variant; act(() => postCanonical(base, body)); }}>
      {!v.registration && <input value={reg} onChange={(e) => setReg(e.target.value)} placeholder="Registration" aria-label="Registration" maxLength={10} />}
      {!v.variant && <input value={variant} onChange={(e) => setVariant(e.target.value)} placeholder="Engine / trim (as on the V5C)" aria-label="Engine or trim" maxLength={80} />}
      <button type="submit" className="cn-btn" disabled={busy || (!reg && !variant)}>Save</button>
    </form>
  );
}

function Obligation({ o, busy, act }) {
  const [resolving, setResolving] = useState(false);
  const [f, setF] = useState({ evidence: '', nextDueDate: '' });
  const firm = o.status === 'needs_you' || o.status === 'overdue';
  return (
    <li className="cn-row">
      <span className="cn-rowtitle">{o.label}</span>
      <span className="cn-muted">
        {o.dueDate || 'no date'}{o.dueMileage != null ? ` · or ${Number(o.dueMileage).toLocaleString()} mi` : ''}
        {o.dueDerived ? ` · from your ${o.interval.basis} interval` : ''}
      </span>
      <span className={`cn-chip ${firm ? 'cn-chip--firm' : 'cn-chip--soft'}`} title={o.statusWhy}>{STATE_WORDS[o.status] || o.status}</span>
      <span className="cn-muted">{o.statusWhy} · {CONF_WORDS[o.confidence] || o.confidence}</span>
      {o.linkedTask && <span className="cn-muted">action: “{o.linkedTask.description}” ({o.linkedTask.state})</span>}
      {o.actionNote && <div className="cn-small cn-muted">{o.actionNote}</div>}
      {o.conflict && (
        <div className="cn-error">
          {o.conflict.message}: you recorded {o.conflict.neuro.value}; {o.conflict.official.source} says {o.conflict.official.value} ({o.conflict.official.observedAt.slice(0, 10)}). Nothing was changed — correct whichever is wrong.
        </div>
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
      <ul className="cn-act-lines">
        {r.official.sources.map((s) => <li key={s.source}>{s.name}: {s.available ? 'available' : `not available — ${s.why}`}</li>)}
      </ul>
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
    </>
  );
}

function History({ r, base, busy, act }) {
  const [f, setF] = useState({ type: 'scheduled_service', date: '', description: '', mileage: '', cost: '', axle: '', brand: '' });
  const submit = (e) => {
    e.preventDefault();
    const body = { type: f.type, date: f.date, description: f.description, mileage: f.mileage || null, costPence: f.cost ? Math.round(Number(f.cost) * 100) : null };
    if (f.type === 'tyres') Object.assign(body, { axle: f.axle || null, brand: f.brand || null });
    act(async () => { await postCanonical(`${base}/events`, body); setF({ ...f, description: '', mileage: '', cost: '' }); });
  };
  return (
    <>
      {!r.history.length && <div className="cn-muted">No service, repair or tyre history recorded. A garage payment never creates one by itself.</div>}
      <ul className="cn-act-lines">
        {r.history.map((h) => (
          <li key={h.id}>{h.date} — {label(EV_TYPES, h.type)}: {h.description}{h.mileage != null ? ` · ${Number(h.mileage).toLocaleString()} mi` : ''}{h.costPence != null ? ` · ${money(h.costPence)}${h.costRef ? ' (Tally)' : ''}` : ''}
            {h.detail ? ` · ${Object.entries(h.detail).map(([k, x]) => `${k} ${x}`).join(', ')}` : ''}
          </li>
        ))}
      </ul>
      <form className="cn-goalform" onSubmit={submit}>
        <select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })} aria-label="What kind">{EV_TYPES.map(([k, w]) => <option key={k} value={k}>{w}</option>)}</select>
        <input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} aria-label="Date" />
        <input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} placeholder="What was done" aria-label="Description" maxLength={400} />
        <input className="cn-input--tiny" type="number" min="0" value={f.mileage} onChange={(e) => setF({ ...f, mileage: e.target.value })} placeholder="miles" aria-label="Mileage" />
        <input className="cn-input--tiny" type="number" min="0" step="0.01" value={f.cost} onChange={(e) => setF({ ...f, cost: e.target.value })} placeholder="£" aria-label="Cost (pounds)" />
        {f.type === 'tyres' && (
          <>
            <input className="cn-input--tiny" value={f.axle} onChange={(e) => setF({ ...f, axle: e.target.value })} placeholder="axle" aria-label="Axle" />
            <input className="cn-input--tiny" value={f.brand} onChange={(e) => setF({ ...f, brand: e.target.value })} placeholder="brand" aria-label="Brand" />
          </>
        )}
        <button type="submit" className="cn-btn" disabled={busy || !f.date || !f.description.trim()}>Add</button>
      </form>
    </>
  );
}

function Costs({ r }) {
  const fin = r.finance;
  const own = fin.ownership12m;
  const rows = Object.entries(own.byType).filter(([k]) => k !== 'parking');
  return (
    <>
      <div className="cn-muted">Finance from {fin.source}{fin.range.from ? `, ${fin.range.from} to ${fin.range.through}` : ' — not read yet'}.</div>
      <div className="cn-care-row"><span className="cn-now-k">Last 12 months</span>
        <span>{money(own.totalPence)}</span>
        <span className="cn-muted">{own.coverage === 'complete' ? '' : `partial — ${own.coverageWhy}`}</span>
      </div>
      {rows.length > 0 && <ul className="cn-act-lines">{rows.map(([k, p]) => <li key={k}>{label(SPEND_TYPES, k)} {money(p)}</li>)}</ul>}
      {own.excluded.parking ? <div className="cn-small cn-muted">Parking {money(own.excluded.parking)} — shown, not counted.</div> : null}
      <div className="cn-care-row"><span className="cn-now-k">Per mile (12m)</span>{own.perMile != null ? <span>{own.perMile}p</span> : <span className="cn-muted">{own.why}</span>}</div>
      <div className="cn-care-row"><span className="cn-now-k">Fuel per mile (3m)</span>{fin.fuelCostPerMile.value != null ? <span>{fin.fuelCostPerMile.value}p</span> : <span className="cn-muted">{fin.fuelCostPerMile.why}</span>}</div>
      <div className="cn-care-row"><span className="cn-now-k">MPG</span>{fin.mpg.value != null ? <span>{fin.mpg.value}</span> : <span className="cn-muted">{fin.mpg.why}</span>}</div>
    </>
  );
}

function SpendReview({ review, vehicleId, busy, act }) {
  const [types, setTypes] = useState({});
  if (!review) return <div className="cn-muted">Reading Tally…</div>;
  const st = review.state;
  const decide = (t, decision, remember = null) => act(() => postCanonical(`/api/vehicle/finance/transactions/${t.sourceTransactionId}/decide`,
    { decision, spendType: decision === 'vehicle' ? (types[t.sourceTransactionId] || (t.candidate && t.candidate.proposedType) || 'other') : null, vehicleId, remember }));
  return (
    <>
      <div className="cn-small cn-muted">
        {st ? (st.lastOk ? `Tally read ${st.lastOkAt.slice(0, 10)}: ${st.kept} of ${st.scanned} transactions might be motoring. Its data stops ${st.dataThrough}.` : `Tally could not be read — ${st.error}`) : 'Tally has not been read yet.'}
        {' '}{review.explicitVehicleCategory.why}. Nothing counts as the car’s until you say so.
      </div>
      {!review.pending.length && <div className="cn-muted">Nothing waiting.</div>}
      <ul className="cn-list">
        {review.pending.slice(0, 15).map((t) => (
          <li key={t.sourceTransactionId} className="cn-row">
            <span className="cn-rowtitle">{t.date} {money(-t.amountPence)}</span>
            <span className="cn-muted">{t.description} · {t.category || 'uncategorised'} · {t.payer || '—'}</span>
            {t.candidate && <span className="cn-muted" title={t.candidate.reasons.join('; ')}>{t.candidate.confidence}: {t.candidate.reasons[0]}{t.candidate.note ? ` — ${t.candidate.note}` : ''}</span>}
            <select value={types[t.sourceTransactionId] || (t.candidate && t.candidate.proposedType) || 'other'} onChange={(e) => setTypes({ ...types, [t.sourceTransactionId]: e.target.value })} aria-label="Type" disabled={busy}>
              {SPEND_TYPES.map(([k, w]) => <option key={k} value={k}>{w}</option>)}
            </select>
            <button type="button" className="cn-btn" disabled={busy} onClick={() => decide(t, 'vehicle')}>The car’s</button>
            {t.merchantKey && <button type="button" className="cn-btn cn-btn--tiny" disabled={busy} title={`Every transaction from exactly "${t.merchantKey}"`} onClick={() => decide(t, 'vehicle', { matchKind: 'merchant' })}>…and always {t.merchantKey}</button>}
            <button type="button" className="cn-btn cn-btn--tiny" disabled={busy} onClick={() => decide(t, 'not-vehicle')}>Not the car</button>
            <button type="button" className="cn-btn cn-btn--tiny" disabled={busy} onClick={() => decide(t, 'unknown')}>Leave it</button>
          </li>
        ))}
      </ul>
      {review.pending.length > 15 && <div className="cn-small cn-muted">{review.pending.length - 15} more waiting.</div>}
      {review.rules.length > 0 && (
        <details className="cn-details"><summary>Rules you confirmed ({review.rules.length})</summary>
          <ul className="cn-act-lines">{review.rules.map((x) => <li key={x.rule_id}>{x.match_kind}: {x.merchant_key || ''}{x.category_name ? ` [${x.category_name}]` : ''} → {x.spend_type} · {x.confirmed_at.slice(0, 10)}{x.active ? '' : ' (retired)'}
            {x.active ? <> {' '}<button type="button" className="cn-btn cn-btn--tiny" disabled={busy} onClick={() => act(() => postCanonical(`/api/vehicle/finance/rules/${encodeURIComponent(x.rule_id)}/retire`, {}))}>Retire</button></> : null}</li>)}</ul>
        </details>
      )}
    </>
  );
}

function Health({ h }) {
  return (
    <>
      <div className="cn-care-row"><span className="cn-now-k">Cost pressure</span><span>{h.costPressure.state}</span>{h.costPressure.why && <span className="cn-muted">{h.costPressure.why}</span>}</div>
      <div className="cn-muted">Repairs in 12 months: {h.repairs12m.count} · maintenance: {h.maintenance12m.count}{h.upcomingMajor.length ? ` · coming up: ${h.upcomingMajor.map((u) => u.label).join(', ')}` : ''}</div>
      {h.gaps.length > 0 && <ul className="cn-act-lines">{h.gaps.map((g) => <li key={g}>{g}</li>)}</ul>}
      <div className="cn-small cn-muted">{h.stance}</div>
    </>
  );
}

function Links({ r, name, busy, act }) {
  const [linkTo, setLinkTo] = useState('');
  return (
    <>
      <h4 className="cn-subhead">Linked to the {r.vehicle.model}</h4>
      {!r.links.length && <div className="cn-muted">Nothing linked. A task counts as the car’s only when you link it.</div>}
      <ul className="cn-act-lines">{r.links.map((l) => <li key={l.entityId}>{l.entityId} <button type="button" className="cn-btn cn-btn--tiny" disabled={busy} onClick={() => act(() => postCanonical('/api/canonical/vehicle-links/remove', { vehicle: r.vehicle.id, entityId: l.entityId }))}>Unlink</button></li>)}</ul>
      {r.linkSuggestions.length > 0 && (
        <div className="cn-hike-form">
          <select value={linkTo} onChange={(e) => setLinkTo(e.target.value)} aria-label={`Link to the ${name}`} disabled={busy}>
            <option value="">{r.linkSuggestions.length} open task{r.linkSuggestions.length === 1 ? '' : 's'} mention the car — link one…</option>
            {r.linkSuggestions.map((s) => <option key={s.id} value={s.id}>{s.description}</option>)}
          </select>
          <button type="button" className="cn-btn" disabled={busy || !linkTo} onClick={() => act(async () => { await postCanonical('/api/canonical/vehicle-links', { vehicle: r.vehicle.id, entityId: linkTo, label: (r.linkSuggestions.find((s) => s.id === linkTo) || {}).description }); setLinkTo(''); })}>Link</button>
        </div>
      )}
    </>
  );
}
