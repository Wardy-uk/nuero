import React, { useState } from 'react';
import { useCanonical, postCanonical, Fold, HowItWorks, LoggerConditions, Headline, Stat, StatTiles, Tile, TileGrid, Group, PrimaryAction, dayLabel as uiDay } from './canonicalUi';
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

// "Sat 11 Oct" from a local datetime — sliced, never parsed as UTC.
function dayLabel(local) {
  return /^\d{4}-\d{2}-\d{2}/.test(String(local || '')) ? uiDay(local) : 'an unknown day';
}
const hhmm = (local) => String(local || '').slice(11, 16);

/** What happened on a closed walk, in a few words — the server's facts. */
function closedWords(r) {
  if (r.status !== 'checked_in') return 'cancelled before it started';
  return `checked in ${hhmm(r.checkedInAt)} on ${dayLabel(r.checkedInAt)}${r.alert && r.alert !== 'none' ? ` (after the alert went at ${hhmm(r.alertAt)})` : ', no alert sent'}`;
}

const MODE_SHORT = { walking: 'walking pace', still: 'stopped', fast: 'faster than walking', driving: 'driving', unknown: 'speed unknown' };

/** A finished walk on the map, fetched when asked for. Nick's page only. */
function PastWalk({ tripId }) {
  const { data, error } = useCanonical(`/api/outdoor/safety/trips/${encodeURIComponent(tripId)}/map`);
  if (error && !data) return <div className="cn-error cn-small">Couldn’t read this walk’s map — {error}.</div>;
  if (!data) return <div className="cn-muted cn-small">Reading the walk…</div>;
  if (data.purged) return <div className="cn-muted cn-small">This walk’s trail was deleted on {dayLabel(data.purgedAt)} (30 days after it ended).</div>;
  const modes = Object.entries(data.modes || {}).sort((a, b) => b[1] - a[1]).map(([m, n]) => `${n} ${MODE_SHORT[m] || m}`).join(' · ');
  return (
    <div className="hs-past" data-testid="hike-past-map">
      <WalkMap route={data.route || []} trail={data.trail || []} emberTrail={data.emberTrail || []} positions={data.positions || []} />
      <div className="cn-small cn-muted">
        {data.trailSource === 'watch'
          ? `Your watch’s GPS track (${data.track.type}): ${data.points.toLocaleString('en-GB')} points, ${String(data.firstFix).slice(11)}–${String(data.lastFix).slice(11)}`
          : data.points ? `${data.points} tracker fixes from ${String(data.firstFix).slice(11)} to ${String(data.lastFix).slice(11)} — the watch’s own track hasn’t reached NEURO` : 'No position reached NEURO on this walk'}
        {modes ? ` · ${modes}` : ''}{data.checkedInAt ? ` · checked in ${String(data.checkedInAt).slice(11)}` : ''}
      </div>
      <LoggerConditions c={data.conditions} />
    </div>
  );
}

function localInput(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * Arm a walk, or (with `trip`) edit the armed one. Edit sends every field, and
 * a GPX only if a new file was chosen — the server keeps the old one otherwise.
 */
function WalkForm({ act, busy, trip = null, onDone = null }) {
  const now = new Date();
  const start = new Date(now.getTime() + 30 * 60000); start.setMinutes(Math.ceil(start.getMinutes() / 15) * 15, 0, 0);
  const [gpx, setGpx] = useState(null);
  const [gpxName, setGpxName] = useState('');
  const [name, setName] = useState(trip ? trip.name : '');
  const [plannedStart, setStart] = useState(trip ? trip.startLocal : localInput(start));
  const [plannedFinish, setFinish] = useState(trip ? trip.finishLocal : localInput(new Date(start.getTime() + 5 * 3600000)));
  const [grace, setGrace] = useState(trip ? trip.graceMin : 60);
  const [ember, setEmber] = useState(trip ? !!trip.ember : false);
  const [notes, setNotes] = useState(trip ? trip.notes || '' : '');
  const [party, setParty] = useState(trip && trip.party && trip.party.length ? trip.party.map((x) => ({ name: x.name, phone: x.phone || '' })) : []);
  const graces = [...new Set([30, 60, 90, 120, Number(grace)])].sort((a, b) => a - b);
  const setPerson = (i, k, v) => setParty(party.map((x, j) => (j === i ? { ...x, [k]: v } : x)));
  const pick = (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) { setGpx(null); setGpxName(''); return; }
    const reader = new FileReader();
    reader.onload = () => { setGpx(String(reader.result || '')); setGpxName(f.name); };
    reader.readAsText(f);
  };
  const submit = async (e) => {
    e.preventDefault();
    const body = {
      gpx: gpx || undefined, gpxName: gpx ? gpxName : undefined, name: name.trim() || undefined, plannedStart, plannedFinish,
      graceMinutes: Number(grace), emberPlanned: ember, notes: trip ? notes.trim() : notes.trim() || undefined,
      party: party.filter((x) => x.name.trim() || x.phone.trim()).map((x) => (x.phone.trim() ? { name: x.name.trim(), phone: x.phone.trim() } : { name: x.name.trim() })),
    };
    const ok = await act(trip ? `/api/outdoor/safety/trips/${encodeURIComponent(trip.tripId)}/edit` : '/api/outdoor/safety/trips', body);
    if (ok && onDone) onDone();
  };
  return (
    <form className="hs-form" onSubmit={submit} data-testid={trip ? 'hike-edit-form' : 'hike-arm-form'}>
      <label>{trip ? 'Replace the GPX (optional)' : 'GPX route'} <input type="file" accept=".gpx,application/gpx+xml,application/octet-stream" onChange={pick} aria-label="GPX file" /></label>
      {gpxName && <span className="cn-muted cn-small">{gpxName}</span>}
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder={gpx ? 'name (or the GPX file’s own)' : 'walk name'} maxLength={120} aria-label="Walk name" />
      <label>Start (approx) <input type="datetime-local" value={plannedStart} onChange={(e) => setStart(e.target.value)} required /></label>
      <label>Finish (approx) <input type="datetime-local" value={plannedFinish} onChange={(e) => setFinish(e.target.value)} required /></label>
      <label>Alert if not back after <select value={grace} onChange={(e) => setGrace(e.target.value)}>{graces.map((m) => <option key={m} value={m}>{m} min</option>)}</select></label>
      <fieldset className="hs-party" data-testid="hike-party">
        <legend>Walking with you</legend>
        {party.map((x, i) => (
          <div key={i} className="hs-contact">
            <input value={x.name} onChange={(e) => setPerson(i, 'name', e.target.value)} placeholder="name" aria-label="Walker name" maxLength={60} />
            <input type="tel" value={x.phone} onChange={(e) => setPerson(i, 'phone', e.target.value)} placeholder="phone (optional)" aria-label="Walker phone" />
            <button type="button" className="cn-btn cn-btn--tiny" onClick={() => setParty(party.filter((_, j) => j !== i))} aria-label="Remove walker">Remove</button>
          </div>
        ))}
        {party.length < 8 && <button type="button" className="cn-btn cn-btn--tiny" onClick={() => setParty([...party, { name: '', phone: '' }])}>Add someone walking with you</button>}
      </fieldset>
      <label className="cn-small"><input type="checkbox" checked={ember} onChange={(e) => setEmber(e.target.checked)} /> Ember coming (her tracker joins the trail)</label>
      <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="notes for the card — where you’ve parked, kit, plan B" maxLength={1000} rows={2} />
      <div className="hs-actions">
        <button type="submit" className="cn-btn" disabled={busy || (!trip && !gpx && !name.trim())}>{trip ? 'Save changes' : 'Arm this walk'}</button>
        {onDone && <button type="button" className="cn-btn cn-btn--tiny" onClick={onDone}>{trip ? 'Cancel editing' : 'Cancel'}</button>}
      </div>
      {trip && <span className="cn-muted cn-small">Saving redraws the route card and re-reads who gets the alert.</span>}
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

// The address the alert goes from — the server's answer (mail-identity), never composed here.
function SendsFrom({ s }) {
  if (!s) return null;
  return (
    <div className="cn-small cn-muted" data-testid="hike-sends-from">
      Alert sends from <strong>{s.from}</strong>{s.copy ? <> and from <strong>{s.copy.address}</strong></> : null}
      {s.replyTo ? ` · replies to ${s.replyTo}` : ''}
      {s.mailbox !== 'work' && s.lastResort ? ` · only if neither can send, from ${s.lastResort}` : ''}
      {(s.mailbox === 'work' || !s.copy) && s.why ? ` — ${s.why}` : ''}
    </div>
  );
}

export function HikeSafetyView({ data, act = null, busy = false }) {
  const t = data.active;
  const [editing, setEditing] = useState(false);
  const [planning, setPlanning] = useState(false);
  const last = (data.recent || [])[0] || null;
  const [shown, setShown] = useState(null);
  const toggle = (id) => setShown(shown === id ? null : id);
  const contacts = data.contacts || [];
  const alertLine = t && ALERT_WORDS[t.alert.status];
  const alertees = t ? t.alerting.join(' and ') : '';
  const one = t ? t.alerting.length === 1 : true;
  const sameDay = t ? t.due.slice(0, 10) === t.start.slice(0, 10) : true;
  return (
    <div className="hs" data-testid="hike-safety">
      {t ? (
        <Headline testid="hike-headline" tone={t.status === 'alerted' ? 'bad' : 'plan'} pill={t.status === 'alerted' ? 'overdue' : 'armed'}>
          <strong>{t.name}</strong> — {t.status === 'alerted'
            ? `you haven’t checked in, so ${alertees} ${one ? 'has' : 'have'} been sent the alert.`
            : `check in when you’re back, or ${alertees} get${one ? 's' : ''} the alert.`}
        </Headline>
      ) : (
        <Headline testid="hike-headline" pill="no walk armed">
          {last
            ? <>Last walk: <strong>{last.name}</strong>, {last.status === 'checked_in' ? dayLabel(last.checkedInAt) : 'cancelled'}.</>
            : 'No walk has been armed yet.'}
        </Headline>
      )}
      {t ? (
        <div className={`hs-active${t.status === 'alerted' ? ' hs-active--alerted' : ''}`} data-testid="hike-active">
          <StatTiles>
            <Stat v={t.due.slice(11)} l={t.extended ? 'Back by (extended)' : 'Back by'} />
            <Stat v={sameDay ? t.alertAt.slice(11) : `${dayLabel(t.alertAt)} ${t.alertAt.slice(11)}`} l={`Alert to ${alertees}`} tone={t.status === 'alerted' ? 'bad' : undefined} />
            {t.status === 'armed' && t.minutesToAlert > 0 && t.minutesToAlert < 600 && <Stat v={`${t.minutesToAlert} min`} l="Until the alert" />}
            <Stat v={t.trail.points} l={`Trail point${t.trail.points === 1 ? '' : 's'}`} />
          </StatTiles>
          {(t.party || []).length > 0 && <div className="cn-small" data-testid="hike-party-line">Walking with {t.party.map((x) => (x.phone ? `${x.name} (${x.phone})` : x.name)).join(', ')}{t.ember ? ' and Ember' : ''}</div>}
          {alertLine && <div className={`cn-small ${t.alert.status === 'sent' || t.alert.status === 'confirmed' ? '' : 'cn-error'}`}>{alertLine}{t.alert.sentFrom ? ` (from ${t.alert.sentFrom})` : ''}{t.alert.error ? ` — ${t.alert.error}` : ''}</div>}
          {t.alert.copy && t.alert.copy.status && <div className={`cn-small ${['sent', 'confirmed'].includes(t.alert.copy.status) ? '' : 'cn-error'}`} data-testid="hike-copy-line">Copy from {t.alert.copy.from}: {ALERT_WORDS[t.alert.copy.status] || t.alert.copy.status}{t.alert.copy.error ? ` — ${t.alert.copy.error}` : ''}</div>}
          {!t.alert.sentFrom && <SendsFrom s={data.sendsFrom} />}
          {act && (
            <div className="cn-actions">
              <PrimaryAction disabled={busy} onClick={() => act(`/api/outdoor/safety/trips/${encodeURIComponent(t.tripId)}/checkin`, { via: 'NEURO' })}>I’m back — check in</PrimaryAction>
              {t.status === 'armed' && [30, 60].map((m) => <button key={m} type="button" className="cn-btn cn-btn--tiny" disabled={busy} onClick={() => act(`/api/outdoor/safety/trips/${encodeURIComponent(t.tripId)}/extend`, { minutes: m })}>+{m} min</button>)}
              {t.status === 'armed' && <button type="button" className="cn-btn cn-btn--tiny" disabled={busy} onClick={() => setEditing(!editing)}>{editing ? 'Close edit' : 'Edit walk'}</button>}
              {t.status === 'armed' && <button type="button" className="cn-btn cn-btn--tiny" disabled={busy} onClick={() => act(`/api/outdoor/safety/trips/${encodeURIComponent(t.tripId)}/cancel`, {})}>Cancel walk</button>}
            </div>
          )}
          {editing && act && t.status === 'armed' && <WalkForm act={act} busy={busy} trip={t} onDone={() => setEditing(false)} />}
          <div className="cn-small cn-muted" data-testid="hike-trail">
            {t.trail.sources.length
              ? t.trail.sources.map((s) => `${s.label}: ${s.lastSeen}, ${s.modeWords}${s.battery != null ? `, battery ${s.battery}%` : ''}`).join(' · ')
              : 'No tracker has reported yet'}
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
        <div className="hs-idle" data-testid="hike-idle">
          {!contacts.length && <div className="cn-error cn-small">Add who gets the alert before you can arm a walk.</div>}
          {act && contacts.length > 0 && (planning
            ? <WalkForm act={act} busy={busy} onDone={() => setPlanning(false)} />
            : <div className="cn-actions"><PrimaryAction onClick={() => setPlanning(true)}>Plan a new walk</PrimaryAction></div>)}
          {last && (
            <Group label="Last walk">
              <TileGrid>
                <Tile testid="hike-last" title={last.name} sub={closedWords(last)}
                  why={last.trailPoints && last.trailUntil ? `Trail kept until ${dayLabel(last.trailUntil)}` : undefined}
                  foot={last.trailPoints > 0 ? <button type="button" className="cn-btn cn-btn--tiny" onClick={() => toggle(last.tripId)}>{shown === last.tripId ? 'Hide map' : 'Show on map'}</button> : null} />
              </TileGrid>
              {shown === last.tripId && <PastWalk tripId={last.tripId} />}
            </Group>
          )}
        </div>
      )}
      <Fold title="Who gets the alert" meta={contacts.length ? contacts.map((c) => c.name).join(', ') : 'nobody yet'} open={!contacts.length}>
        <SendsFrom s={data.sendsFrom} />
        <ul className="cn-list">{contacts.map((c) => <li key={c.email}><strong>{c.name}</strong> <span className="cn-muted">{c.email}</span></li>)}</ul>
        {act && <Contacts contacts={contacts} act={act} busy={busy} />}
      </Fold>
      {(data.recent || []).length > 0 && (
        <Fold title="Recent walks" meta={`${data.recent.length}`}>
          <ul className="cn-list">{data.recent.map((r) => (
            <li key={r.tripId}>
              <strong>{r.name}</strong> <span className="cn-muted">{dayLabel(r.start)} {hhmm(r.start)} · {r.status === 'checked_in' ? `checked in ${hhmm(r.checkedInAt)}` : 'cancelled'}{r.alert !== 'none' ? ` · alert ${r.alert}` : ''}{r.trailPoints ? ` · trail kept until ${dayLabel(r.trailUntil)}` : ''}</span>
              {r.trailPoints > 0 && <> <button type="button" className="cn-btn cn-btn--tiny" onClick={() => toggle(r.tripId)}>{shown === r.tripId ? 'Hide map' : 'Map'}</button></>}
              {shown === r.tripId && (!last || last.tripId !== r.tripId || t) && <PastWalk tripId={r.tripId} />}
            </li>
          ))}</ul>
        </Fold>
      )}
      <HowItWorks>Arm a walk with its GPX and approximate times, and check in when you’re back. {data.rule} {data.limits}</HowItWorks>
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
