import React, { useState } from 'react';
import { useCanonical, postCanonical, Fold, HowItWorks } from './canonicalUi';
import HikingLoopCard from './HikingLoopCard';

/**
 * Life → Outdoor (Build 29). One compact section: this week, the Hike weekly
 * goal, hikes it confirmed, walks, what it refused to call a hike, route plans,
 * the next outing and its weather, and where each source stands.
 *
 * NOT a workout dashboard: no map, no charts, no calories, no streak, no score.
 * Every judgement is the server's (`outdoor-v1`); a hike is the hiking loop's
 * verdict and this card never re-derives it. Plans are drawn as plans, never as
 * activity; weather as context, never as evidence.
 */

const GOAL_WORDS = { achieved: 'done this week', planned: 'planned', not_yet: 'not yet', recording_gap: 'can’t tell', unknown: 'waiting on evidence' };
const STATE_WORDS = { confirmed: 'confirmed', not_hike: 'not a hike', recording_gap: 'can’t tell', planned: 'planned', unknown: 'waiting' };
const KIND_WORDS = { hike: 'Hike', walk: 'Walk', dog_walk: 'Walk with Ember', outdoor_time: 'Outdoors', route_plan: 'Route plan', unknown: 'Activity' };
const SOURCE_WORDS = { healthy: 'working', proven: 'working', unproven: 'not proven yet', stale: 'stale', failing: 'failing', partial: 'partly available', unavailable: 'unavailable', unknown: 'not read yet', manual: 'yours', 'not-connected': 'not connected' };
const WEATHER_WORDS = { favourable: 'favourable', mixed: 'mixed', poor: 'poor', unknown: 'no forecast yet' };

const km = (v) => (v === null || v === undefined ? null : `${v} km`);
const mins = (v) => (v === null || v === undefined ? null : v >= 60 ? `${Math.floor(v / 60)} h ${v % 60} min` : `${v} min`);
const facts = (a) => [a.durationMin != null ? mins(a.durationMin) : null, km(a.distanceKm), a.elevationM != null ? `${a.elevationM} m up` : null].filter(Boolean).join(' · ');

function Weather({ w }) {
  if (!w) return null;
  return <div className={`cn-small ${w.severe ? 'cn-error' : 'cn-muted'}`}>Weather {WEATHER_WORDS[w.state] || w.state}: {w.line}</div>;
}

function ActivityRow({ a, routes, companions, act, busy }) {
  const [routeId, setRouteId] = useState('');
  const ember = companions[0] || null;
  const hasEmber = ember && a.companions.some((c) => c.id === ember.id);
  const planned = routes.filter((r) => r.status === 'planned');
  return (
    <li data-testid="outdoor-activity">
      <strong>{a.day}</strong> {KIND_WORDS[a.kind] || a.kind}
      {a.kind === 'hike' && <span className="cn-chip">{STATE_WORDS[a.state] || a.state}</span>}
      {facts(a) && <span className="cn-muted"> · {facts(a)}</span>}
      {a.route && <span className="cn-chip" title="you linked it">route: {a.route.name || a.route.routeId}</span>}
      <div className="cn-muted cn-small">{a.kind === 'hike' ? a.evidence.join(' · ') : a.hike ? `Not a hike — ${a.hike.why}.` : a.evidence.join(' · ')}</div>
      {act && (
        <div className="cn-row-actions">
          {ember && (hasEmber
            ? <button type="button" className="cn-btn cn-btn--tiny" disabled={busy} onClick={() => act(`/api/outdoor/activities/${encodeURIComponent(a.activityId)}/companion/remove`, { companionId: ember.id })}>{ember.name} wasn’t there</button>
            : <button type="button" className="cn-btn cn-btn--tiny" disabled={busy} onClick={() => act(`/api/outdoor/activities/${encodeURIComponent(a.activityId)}/companion`, { companionId: ember.id })}>{ember.name} came</button>)}
          {a.route
            ? <button type="button" className="cn-btn cn-btn--tiny" disabled={busy} onClick={() => act(`/api/outdoor/activities/${encodeURIComponent(a.activityId)}/route/remove`, {})}>Unlink route</button>
            : planned.length > 0 && (
              <span>
                <select value={routeId} onChange={(e) => setRouteId(e.target.value)} aria-label="Planned route it followed">
                  <option value="">it followed route…</option>
                  {planned.map((r) => <option key={r.routeId} value={r.routeId}>{r.name}{r.plannedDate ? ` (${r.plannedDate})` : ''}</option>)}
                </select>
                <button type="button" className="cn-btn cn-btn--tiny" disabled={busy || !routeId} onClick={() => act(`/api/outdoor/activities/${encodeURIComponent(a.activityId)}/route`, { routeId })}>Link</button>
              </span>
            )}
        </div>
      )}
    </li>
  );
}

function RouteForm({ act, busy }) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState('hike');
  const [plannedDate, setPlannedDate] = useState('');
  const [gpx, setGpx] = useState(null);
  const [gpxName, setGpxName] = useState('');
  const [ember, setEmber] = useState(false);
  const pick = (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) { setGpx(null); setGpxName(''); return; }
    const reader = new FileReader();
    reader.onload = () => { setGpx(String(reader.result || '')); setGpxName(f.name); };
    reader.readAsText(f);
  };
  const submit = async (e) => {
    e.preventDefault();
    const ok = await act('/api/outdoor/routes', { name: name.trim() || undefined, kind, plannedDate: plannedDate || undefined, gpx: gpx || undefined, emberPlanned: ember });
    if (ok) { setName(''); setPlannedDate(''); setGpx(null); setGpxName(''); setEmber(false); }
  };
  return (
    <form className="cn-goalform" onSubmit={submit} data-testid="outdoor-route-form">
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder={gpx ? 'name (or the GPX file’s own)' : 'route name'} maxLength={120} aria-label="Route name" />
      <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Hike or walk"><option value="hike">hike</option><option value="walk">walk</option></select>
      <input type="date" value={plannedDate} onChange={(e) => setPlannedDate(e.target.value)} aria-label="Planned date" />
      <label className="cn-small"><input type="checkbox" checked={ember} onChange={(e) => setEmber(e.target.checked)} /> Ember coming</label>
      <label className="cn-small">GPX <input type="file" accept=".gpx,application/gpx+xml" onChange={pick} aria-label="GPX file" /></label>
      {gpxName && <span className="cn-muted cn-small">{gpxName}</span>}
      <button type="submit" className="cn-btn" disabled={busy || (!name.trim() && !gpx)}>Add route plan</button>
    </form>
  );
}

export function OutdoorView({ data, act = null, busy = false, hikeLoop = null }) {
  const s = data.summary;
  const g = data.goal;
  const routes = data.routes || [];
  const companions = data.companions || [];
  const recent = [...(data.hikes || []), ...(data.walks || [])].sort((x, y) => y.day.localeCompare(x.day));
  const goalMeta = g ? `${GOAL_WORDS[g.state] || g.state}${g.lastConfirmed ? ` · last confirmed ${g.lastConfirmed}` : ''}` : 'no active goal';
  const sourceProblems = (data.sources || []).filter((x) => !['healthy', 'proven', 'manual'].includes(x.state));
  return (
    <section className="cn-section" data-testid="outdoor-card">
      <h3>Outdoor</h3>
      <div className="cn-hike-line" data-testid="outdoor-week">
        {g ? <>This week: <strong>{GOAL_WORDS[g.state] || g.state}</strong> — {g.line}</> : 'No active Hike weekly goal.'}
      </div>
      <div className="cn-muted cn-small">
        {[`${s.confirmedHikes} confirmed hike${s.confirmedHikes === 1 ? '' : 's'}`, `${s.meaningfulWalks} walk${s.meaningfulWalks === 1 ? '' : 's'}`,
          s.knownDurationMin != null ? `${mins(s.knownDurationMin)} outside on those` : null,
          s.daylight && s.daylight.known ? s.daylight.line : null].filter(Boolean).join(' · ')}
      </div>
      {data.atRisk && data.atRisk.atRisk && <div className="cn-muted" data-testid="outdoor-at-risk">{data.atRisk.why}.</div>}
      {data.nextPlan && (
        <div data-testid="outdoor-next">
          Next: <strong>{data.nextPlan.label}</strong> {data.nextPlan.when}
          {data.nextPlan.routes.some((r) => r.emberPlanned) && <span className="cn-chip">with Ember</span>}
          <Weather w={data.nextPlan.weather} />
        </div>
      )}
      {(data.now && data.now.needsYou || []).map((n, i) => <div key={i} className="cn-error" data-testid="outdoor-needs-you">{n.line}</div>)}

      <Fold title="Hike goal" meta={goalMeta}>
        {hikeLoop}
      </Fold>

      <Fold title="Recent hikes and walks" meta={`${recent.length} in ${data.weeksShown || 4} weeks${data.shortWalks ? ` · ${data.shortWalks} short walk${data.shortWalks === 1 ? '' : 's'} not listed` : ''}`}>
        {recent.length ? <ul className="cn-list">{recent.map((a) => <ActivityRow key={a.activityId} a={a} routes={routes} companions={companions} act={act} busy={busy} />)}</ul>
          : <div className="cn-muted">No hike or walk recorded in this window.</div>}
        {(data.hikeGaps || []).length > 0 && (
          <div className="cn-muted cn-small">Hike workouts NEURO can’t confirm: {data.hikeGaps.map((a) => `${a.day} (${a.hike.why})`).join('; ')}.</div>
        )}
      </Fold>

      <Fold title="Not counted as a hike" meta={`${(data.refused || []).length} day${(data.refused || []).length === 1 ? '' : 's'}`}>
        <ul className="cn-list" data-testid="outdoor-refused">
          {(data.refused || []).map((r) => (
            <li key={r.day}>
              <strong>{r.day}</strong> <span className="cn-chip">{STATE_WORDS[r.state]}</span> {r.by === 'you' ? '(you said so)' : ''}
              <div className="cn-muted cn-small">{r.why}{r.saw && r.saw.steps != null ? ` — NEURO saw ${r.saw.steps.toLocaleString('en-GB')} steps${r.saw.distanceKm != null ? `, ${r.saw.distanceKm} km` : ''}; neither confirms a hike.` : ''}</div>
            </li>
          ))}
        </ul>
      </Fold>

      <Fold title="Route plans" meta={`${routes.filter((r) => r.status === 'planned').length} planned`}>
        <ul className="cn-list">
          {routes.map((r) => (
            <li key={r.routeId} data-testid="outdoor-route">
              <strong>{r.name}</strong> <span className="cn-muted">{r.kind}{r.plannedDate ? ` · ${r.plannedDate}` : ' · no date'}{r.distanceKm ? ` · ${r.distanceKm} km` : ''}{r.elevationGainM ? ` · ${r.elevationGainM} m up` : ''}{r.source === 'gpx' ? ' · GPX' : ''}</span>
              {r.outcome && <span className="cn-chip">{r.outcome === 'completed' ? 'done (linked)' : r.outcome === 'not-linked' ? 'nothing linked' : r.outcome}</span>}
              {r.emberPlanned && <span className="cn-chip">Ember planned</span>}
              {act && r.status === 'planned' && <button type="button" className="cn-btn cn-btn--tiny" disabled={busy} onClick={() => act(`/api/outdoor/routes/${encodeURIComponent(r.routeId)}`, { status: 'cancelled' })}>Cancel</button>}
              {act && r.status === 'cancelled' && <button type="button" className="cn-btn cn-btn--tiny" disabled={busy} onClick={() => act(`/api/outdoor/routes/${encodeURIComponent(r.routeId)}`, { status: 'planned' })}>Re-plan</button>}
            </li>
          ))}
        </ul>
        {act && <RouteForm act={act} busy={busy} />}
      </Fold>

      <Fold title="Sources" meta={sourceProblems.length ? `${sourceProblems.length} to know about` : 'all working'}>
        <ul className="cn-list" data-testid="outdoor-sources">
          {(data.sources || []).map((x) => <li key={x.id}><strong>{x.label}</strong> <span className="cn-chip">{SOURCE_WORDS[x.state] || x.state}</span><div className="cn-muted cn-small">{x.line}</div></li>)}
        </ul>
      </Fold>

      <HowItWorks>
        {data.rule} {data.evidence && data.evidence.nickWins} Week: {data.week && data.week.convention}. Nothing here is a fitness score, nothing pushes except Hike safety’s check-in prompts, and NEURO keeps no record of where you went — only workouts Apple Health sent, your route plans, and what you link — except during a walk you arm in Life → Hike safety, whose trail is deleted 30 days after it ends.
      </HowItWorks>
    </section>
  );
}

export default function OutdoorCard() {
  const { data, error, reload } = useCanonical('/api/outdoor');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  if (error && !data) return <div className="cn-error">Couldn’t read Outdoor — {error}.</div>;
  if (!data) return <div className="cn-muted">Reading Outdoor…</div>;
  const act = async (path, body) => {
    setBusy(true); setMsg(null);
    try { await postCanonical(path, body); reload(); return true; } catch (e) { setMsg(e.message); return false; } finally { setBusy(false); }
  };
  return (
    <>
      <OutdoorView data={data} act={act} busy={busy} hikeLoop={<HikingLoopCard />} />
      {msg && <div className="cn-error">Not saved — {msg}</div>}
    </>
  );
}
