import React, { useState } from 'react';
import { useCanonical, postCanonical, Fold, HowItWorks, LoggerConditions, Headline, Stat, StatTiles, Tile, TileGrid, Group, PrimaryAction, dayLabel } from './canonicalUi';
import HikingLoopCard from './HikingLoopCard';
import { GoalNote } from './GoalsCard';

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

// Tones are meanings (docs/design-rules.md): "not yet" is neutral, never a guilt colour.
const GOAL_TONE = { achieved: 'good', planned: 'plan', recording_gap: 'warn' };
const WEATHER_PILL = { favourable: 'cn-pill--good', mixed: 'cn-pill--warn', poor: 'cn-pill--bad' };

// The forecast as its verdict plus each input it rests on — the same facts the
// server's sentence carries, laid out so they can be read at a glance.
function Weather({ w }) {
  if (!w) return null;
  const pill = <span className={`cn-pill ${w.severe ? 'cn-pill--bad' : WEATHER_PILL[w.state] || ''}`}>{w.severe ? 'severe weather' : `weather ${WEATHER_WORDS[w.state] || w.state}`}</span>;
  if (!w.inputs || !w.inputs.length) return <div className="cn-tile-foot">{pill}<span>{w.line}</span></div>;
  return (
    <div className="cn-tile-foot" title={w.line}>
      {pill}
      {w.inputs.map((i) => <span key={i.input} className={`cn-chip${i.level !== 'favourable' ? ' cn-stat--warn' : ''}`}>{i.input === 'condition' ? i.said.replace(/^Home Assistant says "(.*)"$/, '$1') : i.said}</span>)}
      {w.missing && w.missing.length > 0 && <span>not known: {w.missing.join(', ')}</span>}
    </div>
  );
}

// One hike or walk as a tile: day and kind, its numbers, its chips and the
// corrections. The evidence (or why it is not a hike) rides on hover.
function ActivityTile({ a, routes, companions, act, busy }) {
  const [routeId, setRouteId] = useState('');
  const ember = companions[0] || null;
  const hasEmber = ember && a.companions.some((c) => c.id === ember.id);
  const planned = routes.filter((r) => r.status === 'planned');
  const why = a.kind === 'hike' ? a.evidence.join(' · ') : a.hike ? `Not a hike — ${a.hike.why}.` : a.evidence.join(' · ');
  return (
    <Tile testid="outdoor-activity" why={why} title={`${dayLabel(a.day)} · ${KIND_WORDS[a.kind] || a.kind}`} sub={facts(a) || null}
      foot={<>
        {a.kind === 'hike' && <span className="cn-chip">{STATE_WORDS[a.state] || a.state}</span>}
        {a.kind !== 'hike' && a.hike && <span className="cn-chip">not a hike</span>}
        {a.route && <span className="cn-chip" title="you linked it">route: {a.route.name || a.route.routeId}</span>}
        {act && ember && (hasEmber
          ? <button type="button" className="cn-btn cn-btn--tiny" disabled={busy} onClick={() => act(`/api/outdoor/activities/${encodeURIComponent(a.activityId)}/companion/remove`, { companionId: ember.id })}>{ember.name} wasn’t there</button>
          : <button type="button" className="cn-btn cn-btn--tiny" disabled={busy} onClick={() => act(`/api/outdoor/activities/${encodeURIComponent(a.activityId)}/companion`, { companionId: ember.id })}>{ember.name} came</button>)}
        {act && (a.route
          ? <button type="button" className="cn-btn cn-btn--tiny" disabled={busy} onClick={() => act(`/api/outdoor/activities/${encodeURIComponent(a.activityId)}/route/remove`, {})}>Unlink route</button>
          : planned.length > 0 && (
            <span>
              <select value={routeId} onChange={(e) => setRouteId(e.target.value)} aria-label="Planned route it followed">
                <option value="">it followed route…</option>
                {planned.map((r) => <option key={r.routeId} value={r.routeId}>{r.name}{r.plannedDate ? ` (${dayLabel(r.plannedDate)})` : ''}</option>)}
              </select>
              <button type="button" className="cn-btn cn-btn--tiny" disabled={busy || !routeId} onClick={() => act(`/api/outdoor/activities/${encodeURIComponent(a.activityId)}/route`, { routeId })}>Link</button>
            </span>
          ))}
      </>}>
      <LoggerConditions c={a.conditions} quietIfUnknown={a.kind !== 'hike'} />
    </Tile>
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

export function OutdoorView({ data, act = null, busy = false, hikeLoop = null, goalNote = null }) {
  const [planning, setPlanning] = useState(false);
  const s = data.summary;
  const g = data.goal;
  const routes = data.routes || [];
  const companions = data.companions || [];
  const refused = data.refused || [];
  const recent = [...(data.hikes || []), ...(data.walks || [])].sort((x, y) => y.day.localeCompare(x.day));
  const goalMeta = g ? `${GOAL_WORDS[g.state] || g.state}${g.lastConfirmed ? ` · last confirmed ${dayLabel(g.lastConfirmed)}` : ''}` : 'no active goal';
  const sourceProblems = (data.sources || []).filter((x) => !['healthy', 'proven', 'manual'].includes(x.state));
  const next = data.nextPlan;
  return (
    <section className="cn-section" data-testid="outdoor-card">
      <h3>Outdoor</h3>
      <Headline testid="outdoor-week" tone={g ? GOAL_TONE[g.state] : undefined} pill={g ? (GOAL_WORDS[g.state] || g.state) : 'no goal'}
        detail={data.atRisk && data.atRisk.atRisk ? <span data-testid="outdoor-at-risk">{data.atRisk.why}.</span> : null}>
        {g ? <>This week: <strong>{g.line}</strong></> : 'No active hike goal.'}
      </Headline>

      <StatTiles>
        <Stat v={s.confirmedHikes} l={`confirmed hike${s.confirmedHikes === 1 ? '' : 's'} this week`} />
        <Stat v={s.meaningfulWalks} l={`walk${s.meaningfulWalks === 1 ? '' : 's'} this week`} />
        {s.knownDurationMin != null && <Stat v={mins(s.knownDurationMin)} l="outside on those" />}
        {s.daylight && s.daylight.known && (
          <Stat v={mins(s.daylight.minutes)} title={s.daylight.line}
            l={`in daylight · ${s.daylight.daysWithReading} of ${s.daylight.daysElapsed} day${s.daylight.daysElapsed === 1 ? '' : 's'}${s.daylight.covered ? '' : ', today partial'}`} />
        )}
      </StatTiles>

      {/* A goal measured in hikes (any period) — its own line and top suggestion. */}
      {goalNote}

      {(data.now && data.now.needsYou || []).map((n, i) => <div key={i} className="cn-error" data-testid="outdoor-needs-you">{n.line}</div>)}

      {next && (
        <Group label="Next">
          <Tile as="div" accent testid="outdoor-next" title={`${next.label} · ${next.when}`}
            foot={next.routes.some((r) => r.emberPlanned) ? <span className="cn-chip">with Ember</span> : null}>
            <Weather w={next.weather} />
          </Tile>
        </Group>
      )}

      {act && (
        <div className="cn-actions">
          <PrimaryAction onClick={() => setPlanning((v) => !v)}>{planning ? 'Close the route form' : 'Plan a route'}</PrimaryAction>
        </div>
      )}
      {act && planning && <RouteForm act={act} busy={busy} />}

      <Fold title="Hike goal" meta={goalMeta}>
        {hikeLoop}
      </Fold>

      <Fold title="Recent hikes and walks" meta={`${recent.length} in ${data.weeksShown || 4} weeks${data.shortWalks ? ` · ${data.shortWalks} short walk${data.shortWalks === 1 ? '' : 's'} not listed` : ''}`}>
        {(data.hikeGaps || []).length > 0 && (
          <div className="cn-group-why">Hike workouts NEURO can’t confirm: {data.hikeGaps.map((a) => `${dayLabel(a.day)} (${a.hike.why})`).join('; ')}.</div>
        )}
        {recent.length ? <TileGrid>{recent.map((a) => <ActivityTile key={a.activityId} a={a} routes={routes} companions={companions} act={act} busy={busy} />)}</TileGrid>
          : <div className="cn-group-why">No hike or walk recorded in this window.</div>}
      </Fold>

      <Fold title="Not counted as a hike" meta={`${refused.length} day${refused.length === 1 ? '' : 's'}`}>
        {refused.some((r) => r.saw && r.saw.steps != null) && <div className="cn-group-why">Steps and distance never confirm a hike on their own — hover a day for why.</div>}
        <TileGrid testid="outdoor-refused">
          {refused.map((r) => (
            <Tile key={r.day} title={dayLabel(r.day)} why={`${r.day}: ${r.why}`}
              sub={r.saw && r.saw.steps != null ? `${r.saw.steps.toLocaleString('en-GB')} steps${r.saw.distanceKm != null ? ` · ${r.saw.distanceKm} km` : ''}` : r.why}
              foot={<><span className="cn-chip">{STATE_WORDS[r.state]}</span>{r.by === 'you' && <span>you said so</span>}</>} />
          ))}
        </TileGrid>
      </Fold>

      <Fold title="Route plans" meta={`${routes.filter((r) => r.status === 'planned').length} planned`}>
        {routes.length ? (
          <TileGrid>
            {routes.map((r) => (
              <Tile key={r.routeId} testid="outdoor-route" title={r.name}
                sub={[r.kind, r.plannedDate ? dayLabel(r.plannedDate) : 'no date', r.distanceKm ? `${r.distanceKm} km` : null, r.elevationGainM ? `${r.elevationGainM} m up` : null, r.source === 'gpx' ? 'GPX' : null].filter(Boolean).join(' · ')}
                foot={<>
                  {r.outcome && <span className="cn-chip">{r.outcome === 'completed' ? 'done (linked)' : r.outcome === 'not-linked' ? 'nothing linked' : r.outcome}</span>}
                  {r.emberPlanned && <span className="cn-chip">Ember planned</span>}
                  {act && r.status === 'planned' && <button type="button" className="cn-btn cn-btn--tiny" disabled={busy} onClick={() => act(`/api/outdoor/routes/${encodeURIComponent(r.routeId)}`, { status: 'cancelled' })}>Cancel</button>}
                  {act && r.status === 'cancelled' && <button type="button" className="cn-btn cn-btn--tiny" disabled={busy} onClick={() => act(`/api/outdoor/routes/${encodeURIComponent(r.routeId)}`, { status: 'planned' })}>Re-plan</button>}
                </>} />
            ))}
          </TileGrid>
        ) : <div className="cn-group-why">No route plans yet — Plan a route adds one.</div>}
      </Fold>

      <Fold title="Sources" meta={sourceProblems.length ? `${sourceProblems.length} to know about` : 'all working'}>
        <TileGrid testid="outdoor-sources">
          {(data.sources || []).map((x) => <Tile key={x.id} title={x.label} sub={SOURCE_WORDS[x.state] || x.state} why={x.line} />)}
        </TileGrid>
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
      <OutdoorView data={data} act={act} busy={busy} hikeLoop={<HikingLoopCard />} goalNote={<GoalNote kinds="hikes" />} />
      {msg && <div className="cn-error">Not saved — {msg}</div>}
    </>
  );
}
