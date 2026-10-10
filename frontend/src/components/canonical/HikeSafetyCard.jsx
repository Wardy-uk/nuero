import React, { useState } from 'react';
import { useCanonical, postCanonical, Fold, HowItWorks } from './canonicalUi';
import './HikeSafetyCard.css';
import WalkMap from '../WalkMap';

/**
 * Life → Outdoor → Hike safety (10 Oct 2026). Upload a GPX with an approximate
 * start and finish; NEURO makes a route card and, if you have not checked in
 * by finish + grace, emails it with your last known positions to the people
 * listed. Every judgement is the server's (`hike-safety-v1`) — this card only
 * renders it and sends Nick's own presses.
 */

const ALERT_WORDS = { none: null, sending: 'sending the alert…', sent: 'alert sent', confirmed: 'alert sent (in Sent Items)', uncertain: 'alert send unconfirmed — retrying', failed: 'alert could not be sent — retrying' };

function localInput(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function ArmForm({ act, busy }) {
  const now = new Date();
  const start = new Date(now.getTime() + 30 * 60000); start.setMinutes(Math.ceil(start.getMinutes() / 15) * 15, 0, 0);
  const [gpx, setGpx] = useState(null);
  const [gpxName, setGpxName] = useState('');
  const [name, setName] = useState('');
  const [plannedStart, setStart] = useState(localInput(start));
  const [plannedFinish, setFinish] = useState(localInput(new Date(start.getTime() + 5 * 3600000)));
  const [grace, setGrace] = useState(60);
  const [ember, setEmber] = useState(false);
  const [notes, setNotes] = useState('');
  const pick = (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) { setGpx(null); setGpxName(''); return; }
    const reader = new FileReader();
    reader.onload = () => { setGpx(String(reader.result || '')); setGpxName(f.name); };
    reader.readAsText(f);
  };
  const submit = async (e) => {
    e.preventDefault();
    await act('/api/outdoor/safety/trips', { gpx: gpx || undefined, gpxName: gpxName || undefined, name: name.trim() || undefined, plannedStart, plannedFinish, graceMinutes: Number(grace), emberPlanned: ember, notes: notes.trim() || undefined });
  };
  return (
    <form className="hs-form" onSubmit={submit} data-testid="hike-arm-form">
      <label>GPX route <input type="file" accept=".gpx,application/gpx+xml,application/octet-stream" onChange={pick} aria-label="GPX file" /></label>
      {gpxName && <span className="cn-muted cn-small">{gpxName}</span>}
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder={gpx ? 'name (or the GPX file’s own)' : 'walk name'} maxLength={120} aria-label="Walk name" />
      <label>Start (approx) <input type="datetime-local" value={plannedStart} onChange={(e) => setStart(e.target.value)} required /></label>
      <label>Finish (approx) <input type="datetime-local" value={plannedFinish} onChange={(e) => setFinish(e.target.value)} required /></label>
      <label>Alert if not back after <select value={grace} onChange={(e) => setGrace(e.target.value)}>{[30, 60, 90, 120].map((m) => <option key={m} value={m}>{m} min</option>)}</select></label>
      <label className="cn-small"><input type="checkbox" checked={ember} onChange={(e) => setEmber(e.target.checked)} /> Ember coming (her tracker joins the trail)</label>
      <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="notes for the card — where you’ve parked, kit, plan B" maxLength={1000} rows={2} />
      <button type="submit" className="cn-btn" disabled={busy || (!gpx && !name.trim())}>Arm this walk</button>
    </form>
  );
}

function Contacts({ contacts, act, busy }) {
  const [rows, setRows] = useState(contacts.length ? contacts : [{ name: '', email: '' }]);
  const set = (i, k, v) => setRows(rows.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  return (
    <form className="hs-form" onSubmit={(e) => { e.preventDefault(); act('/api/outdoor/safety/contacts', { contacts: rows.filter((r) => r.name.trim() || r.email.trim()) }); }} data-testid="hike-contacts-form">
      {rows.map((r, i) => (
        <div key={i} className="hs-contact">
          <input value={r.name} onChange={(e) => set(i, 'name', e.target.value)} placeholder="name" aria-label="Contact name" />
          <input type="email" value={r.email} onChange={(e) => set(i, 'email', e.target.value)} placeholder="email" aria-label="Contact email" />
        </div>
      ))}
      {rows.length < 5 && <button type="button" className="cn-btn cn-btn--tiny" onClick={() => setRows([...rows, { name: '', email: '' }])}>Add someone</button>}
      <button type="submit" className="cn-btn" disabled={busy}>Save who gets the alert</button>
    </form>
  );
}

export function HikeSafetyView({ data, act = null, busy = false }) {
  const t = data.active;
  const contacts = data.contacts || [];
  const alertLine = t && ALERT_WORDS[t.alert.status];
  return (
    <div className="hs" data-testid="hike-safety">
      {t ? (
        <div className={`hs-active${t.status === 'alerted' ? ' hs-active--alerted' : ''}`} data-testid="hike-active">
          <div className="hs-title"><strong>{t.name}</strong> <span className="cn-chip">{t.status === 'alerted' ? 'overdue' : 'armed'}</span></div>
          <div className="cn-small">
            Back by <strong>{t.due.slice(11)}</strong>{t.extended ? ' (extended)' : ''} · alert to {t.alerting.join(' and ')} at <strong>{t.alertAt.slice(11)}</strong>
            {t.due.slice(0, 10) !== t.start.slice(0, 10) ? ` on ${t.alertAt.slice(0, 10)}` : ''}
            {t.status === 'armed' && t.minutesToAlert > 0 && t.minutesToAlert < 600 ? ` · in ${t.minutesToAlert} min` : ''}
          </div>
          {alertLine && <div className={`cn-small ${t.alert.status === 'sent' || t.alert.status === 'confirmed' ? '' : 'cn-error'}`}>{alertLine}{t.alert.error ? ` — ${t.alert.error}` : ''}</div>}
          {act && (
            <div className="hs-actions">
              <button type="button" className="cn-btn hs-checkin" disabled={busy} onClick={() => act(`/api/outdoor/safety/trips/${encodeURIComponent(t.tripId)}/checkin`, { via: 'NEURO' })}>I’m back — check in</button>
              {t.status === 'armed' && [30, 60].map((m) => <button key={m} type="button" className="cn-btn cn-btn--tiny" disabled={busy} onClick={() => act(`/api/outdoor/safety/trips/${encodeURIComponent(t.tripId)}/extend`, { minutes: m })}>+{m} min</button>)}
              {t.status === 'armed' && <button type="button" className="cn-btn cn-btn--tiny" disabled={busy} onClick={() => act(`/api/outdoor/safety/trips/${encodeURIComponent(t.tripId)}/cancel`, {})}>Cancel walk</button>}
            </div>
          )}
          <div className="cn-small cn-muted" data-testid="hike-trail">
            Trail: {t.trail.points} point{t.trail.points === 1 ? '' : 's'}
            {t.trail.sources.map((s) => ` · ${s.label}: ${s.lastSeen}, ${s.modeWords}${s.battery != null ? `, battery ${s.battery}%` : ''}`).join('')}
            {!t.trail.points && ' — no position has reached NEURO yet (tracking runs from 15 min before your start)'}
          </div>
          {t.map && <WalkMap route={t.map.route} trail={t.map.trail} emberTrail={t.map.emberTrail} positions={t.map.positions} />}
          {t.map && t.map.positions.length > 0 && (
            <ul className="cn-list" data-testid="hike-positions">
              {t.map.positions.map((p, i) => <li key={i}><strong>{p.label}</strong> <span className="cn-muted">{p.at.slice(11)} ({p.ago}){p.gridRef ? ` · ${p.gridRef}` : ''} · {p.modeWords}{p.battery != null ? ` · battery ${p.battery}%` : ''}</span> <a href={p.maps} target="_blank" rel="noreferrer">Maps</a></li>)}
            </ul>
          )}
          <Fold title="Route card" meta={t.gpxAttached ? 'GPX attached to the alert' : 'no GPX'}>
            <pre className="hs-card">{t.card}</pre>
          </Fold>
        </div>
      ) : (
        contacts.length
          ? (act && <ArmForm act={act} busy={busy} />)
          : <div className="cn-error cn-small">Add who gets the alert before you can arm a walk.</div>
      )}
      <Fold title="Who gets the alert" meta={contacts.length ? contacts.map((c) => c.name).join(', ') : 'nobody yet'} open={!contacts.length}>
        <ul className="cn-list">{contacts.map((c) => <li key={c.email}><strong>{c.name}</strong> <span className="cn-muted">{c.email}</span></li>)}</ul>
        {act && <Contacts contacts={contacts} act={act} busy={busy} />}
      </Fold>
      {(data.recent || []).length > 0 && (
        <Fold title="Recent walks" meta={`${data.recent.length}`}>
          <ul className="cn-list">{data.recent.map((r) => <li key={r.tripId}><strong>{r.name}</strong> <span className="cn-muted">{r.start.replace('T', ' ')} · {r.status === 'checked_in' ? `checked in ${String(r.checkedInAt || '').slice(11, 16)}` : 'cancelled'}{r.alert !== 'none' ? ` · alert ${r.alert}` : ''}</span></li>)}</ul>
        </Fold>
      )}
      <HowItWorks>{data.rule} {data.limits}</HowItWorks>
    </div>
  );
}

export default function HikeSafetyCard() {
  const { data, error, reload } = useCanonical('/api/outdoor/safety', { interval: 60000 });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  if (error && !data) return <div className="cn-error">Couldn’t read hike safety — {error}.</div>;
  if (!data) return <div className="cn-muted">Reading hike safety…</div>;
  const act = async (path, body) => {
    setBusy(true); setMsg(null);
    try { await postCanonical(path, body); reload(); return true; } catch (e) { setMsg(e.message); return false; } finally { setBusy(false); }
  };
  return (
    <>
      <HikeSafetyView data={data} act={act} busy={busy} />
      {msg && <div className="cn-error">Not done — {msg}</div>}
    </>
  );
}
