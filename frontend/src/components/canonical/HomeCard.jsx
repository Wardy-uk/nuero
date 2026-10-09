import React from 'react';
import { useCanonical, Fold, HowItWorks } from './canonicalUi';

/**
 * Life → Home (Build 22, rebuilt Build 28).
 *
 * NOT a Home Assistant dashboard: no entity rows, no floorplan, no controls.
 * Occupancy, what is UNUSUAL (exceptions with their evidence), heating, rooms on
 * a fold, device problems only, hazard capability (absence is said, never
 * "safe"), the router and hub, and where each source stands. Every word about
 * state is the server's; this renders and never ranks or infers. "Can't tell"
 * is drawn as its own thing, never as empty or as fine.
 */

const OCCUPANCY_WORDS = { occupied: 'Occupied', empty: 'Empty', unknown: 'Can’t tell' };
const VERDICT_WORDS = {
  seeing: 'reading', partial: 'partly readable', stale: 'stale', failing: 'failing', unknown: 'not read yet',
  unavailable: 'can’t read', 'no-capability': 'no sensor',
};
const CAPABILITY_WORDS = { present: 'sensor present', absent: 'no sensor — not the same as safe', unknown: 'can’t tell', stale: 'sensor unreachable' };
const STATE_WORDS = { needs_you: 'needs you', context: 'for context', unknown: 'can’t tell now', resolved: 'resolved' };

const c = (v) => (v === null || v === undefined ? '—' : `${v} °C`);
const hrs = (min) => (min >= 1440 ? `${Math.round(min / 1440)} days` : min >= 60 ? `${Math.round(min / 60)} h` : `${Math.round(min)} min`);

function Exception({ e }) {
  return (
    <li data-testid="home-exception">
      <strong>{e.what}</strong> <span className="cn-chip">{STATE_WORDS[e.actionState] || e.actionState}</span>
      <div className="cn-muted cn-small">{e.evidence.join(' ')} {e.whyItMatters}{e.context ? ` ${e.context}` : ''}</div>
      <div className="cn-muted cn-small">Persistence: {e.persistence}{e.since ? ` · since ${new Date(e.since).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}` : ''}{e.unknownWhy ? ` · ${e.unknownWhy}` : ''}</div>
    </li>
  );
}

function Room({ r }) {
  const h = r.heating;
  const meta = [r.temperature ? c(r.temperature.c) : null, r.humidity ? `${r.humidity.pct}%` : null, r.exceptions.length ? `${r.exceptions.length} unusual` : null].filter(Boolean).join(' · ');
  return (
    <Fold title={r.area} meta={meta}>
      {r.temperature && <div>Temperature {c(r.temperature.c)} <span className="cn-muted cn-small">— {r.temperature.source}</span></div>}
      {r.humidity && <div>Humidity {r.humidity.pct}%{r.dewPointC !== null ? <span className="cn-muted cn-small"> · dew point {r.dewPointC} °C (context only)</span> : null}</div>}
      {h && <div>Heating: set to {h.targetC === null ? 'off' : c(h.targetC)}{h.wanted ? '' : ' (frost protection)'}{h.demand === true ? ' — calling for heat' : h.demand === false ? ' — not calling' : ''}</div>}
      {r.boiler && <div className="cn-muted">The boiler thermostat lives here ({r.boiler.action || 'state unknown'}).</div>}
      {r.openings.map((o) => <div key={o.id}>{o.label}: {o.state}{o.forMin ? ` for ${hrs(o.forMin)}` : ''}</div>)}
      {r.presence && (r.presence.nickHere || r.presence.motion) && (
        <div className="cn-muted cn-small">Right now: {[r.presence.nickHere ? 'Nick’s watch places him here' : null, r.presence.motion === 'active' ? 'motion' : r.presence.motion === 'quiet' ? 'no motion' : null].filter(Boolean).join(', ')}. Current state only — no history is kept.</div>
      )}
    </Fold>
  );
}

export function HomeView({ data }) {
  const o = data.occupancy;
  const d = data.devices;
  const s = data.safety;
  const intel = !!data.intelligence && data.known !== false;
  const dh = data.deviceHealth;
  return (
    <section className="cn-section" data-testid="home-card">
      <h3>Home <span className="cn-chip">{OCCUPANCY_WORDS[o.state] || o.state}</span></h3>
      <div className="cn-muted">{o.why}{o.visitorsHome && o.visitorsHome.length ? ` · visiting: ${o.visitorsHome.join(', ')}` : ''}</div>
      {intel && data.heating && <div data-testid="home-heating">{data.heating.summary}{data.weather && data.weather.line ? <span className="cn-muted"> {data.weather.line}</span> : null}</div>}

      {data.needsYou.length > 0 && (
        <div className="cn-details" data-testid="home-needs-you">
          <div className="cn-subhead">Needs you</div>
          <ul className="cn-list">{data.needsYou.map((n) => <li key={n.id}>{n.title} <span className="cn-muted">— {n.why}</span></li>)}</ul>
        </div>
      )}

      {intel && (
        <div className="cn-details" data-testid="home-exceptions">
          <div className="cn-subhead">Unusual at home</div>
          {data.exceptions.length === 0
            ? <div className="cn-muted">Nothing unusual that NEURO can see{data.sourceHealth.some((x) => x.verdict === 'no-capability') ? ' — within what the house has sensors for (below)' : ''}.</div>
            : <ul className="cn-list">{data.exceptions.map((e) => <Exception key={e.key} e={e} />)}</ul>}
          {data.resolved && data.resolved.length > 0 && <div className="cn-muted cn-small">Resolved in the last day: {data.resolved.map((r) => r.what).join('; ')}</div>}
        </div>
      )}
      {data.intelligence && data.known === false && <div className="cn-blind">Can’t read Home Assistant right now — rooms, heating and devices are unknown, not fine.</div>}

      {intel && data.rooms && data.rooms.length > 0 && (
        <div className="cn-details" data-testid="home-rooms">
          <div className="cn-subhead">Rooms</div>
          {data.rooms.map((r) => <Room key={r.area} r={r} />)}
        </div>
      )}

      <div className="cn-details">
        <div className="cn-subhead">Household tasks</div>
        {data.obligations.length === 0
          ? <div className="cn-muted">Nothing classified as Home is open. Only reminders and tasks you classified as Home count here.</div>
          : <ul className="cn-list">{data.obligations.map((t) => <li key={t.id}>{t.what}{t.due ? <span className="cn-muted"> — {t.due.label}</span> : <span className="cn-muted"> — no date</span>}</li>)}</ul>}
      </div>

      {data.upcoming.length > 0 && (
        <div className="cn-details">
          <div className="cn-subhead">Coming up at home</div>
          <ul className="cn-list">{data.upcoming.map((u) => <li key={u.id}>{u.when ? `${u.when} — ` : ''}{u.title}</li>)}</ul>
        </div>
      )}

      <div className="cn-details" data-testid="home-devices">
        <div className="cn-subhead">Devices</div>
        {!d.known && !(intel && dh && dh.known)
          ? <div className="cn-blind">Can’t read device health — {d.why}. This is not “all fine”.</div>
          : <>
              {intel && data.batteries && data.batteries.low.length > 0 && <div>Needs a battery: {data.batteries.low.map((b) => `${b.device} (${b.level})`).join(', ')}</div>}
              {!intel && d.lowBatteries.length > 0 && <div>Needs a battery: {d.lowBatteries.join(', ')}</div>}
              {intel && dh && dh.longOffline.length > 0 && <div className="cn-muted">Offline for over a week (probably unplugged on purpose or retired): {dh.longOffline.map((x) => `${x.device} (${hrs(x.forMin)})`).join(', ')}.</div>}
              {!intel && d.offline.length > 0 && <div className="cn-muted">Home Assistant can’t reach: {d.offline.join(', ')} (it may be unplugged on purpose; HA reports these at 09:00).</div>}
              {intel && dh && <div className="cn-muted cn-small">{dh.healthy} of {dh.judged} devices healthy (not listed){data.batteries ? ` · ${data.batteries.ok} batteries fine` : ''}. Lights, TVs and phones are not judged — a bulb off at the wall reads unavailable.</div>}
              {!intel && d.lowBatteries.length === 0 && d.offline.length === 0 && <div className="cn-muted">Nothing offline, no low batteries.</div>}
            </>}
      </div>

      <div className="cn-details" data-testid="home-hazards">
        <div className="cn-subhead">Hazards</div>
        {s.capability === 'none' && <div className="cn-muted" data-testid="home-no-hazard-sensors">{s.why}</div>}
        {s.capability === 'unknown' && <div className="cn-blind">{s.why}</div>}
        {s.capability === 'present' && (s.active.length
          ? <div className="cn-blind">{s.active.map((a) => `${a.label}: ${a.hazard}`).join(', ')}</div>
          : <div className="cn-muted">{s.sensors} hazard {s.sensors === 1 ? 'sensor' : 'sensors'}, none reporting.</div>)}
        {intel && data.hazards && data.hazards.known && (
          <div className="cn-muted cn-small">{data.hazards.categories.map((h) => `${h.label}: ${CAPABILITY_WORDS[h.capability] || h.capability}`).join(' · ')}</div>
        )}
      </div>

      {intel && data.network && data.network.ha === 'reachable' && (
        <div className="cn-details" data-testid="home-network">
          <div className="cn-subhead">Network</div>
          <div>{data.network.wan ? `Router internet link ${data.network.wan.state}` : 'No router status in Home Assistant'}{data.network.hub ? ` · heating hub ${data.network.hub.state}` : ''}</div>
          <div className="cn-muted cn-small">{data.network.note}</div>
        </div>
      )}

      {intel && (
        <div className="cn-muted cn-small" data-testid="home-capability">
          Doors &amp; windows: {data.openings.capability === 'absent' ? 'no sensors' : `${data.openings.items.length} sensors`} · Appliances: {data.appliances.capability === 'absent' ? 'none report a useful state' : data.appliances.items.length} · Energy: {data.energy.available ? data.energy.label : data.energy.why}
        </div>
      )}

      <div className="cn-muted cn-small" data-testid="home-sources">
        {(intel ? data.sourceHealth : data.sources).map((x) => `${x.label}: ${VERDICT_WORDS[x.verdict] || x.verdict}`).join(' · ')}
      </div>

      {intel && (
        <HowItWorks>
          Home Assistant is a source, not the screen: NEURO reads its {data.audit ? data.audit.total : ''} entities and keeps the {data.audit ? data.audit.roles.inference : ''} that say something about the house. Occupied only when a resident is positively home; empty only when everyone who lives here is positively away; otherwise “can’t tell”. Something is “unusual” only with persistence — three or four consecutive hours for temperature and humidity (from Home Assistant’s own hourly statistics), a duration for doors and devices, against each room’s own last week rather than a comfort threshold. Hazards come only from hazard sensors, never from temperature or silence. NEURO changes nothing in the house from here.
        </HowItWorks>
      )}
    </section>
  );
}

export default function HomeCard() {
  const { data, error } = useCanonical('/api/household/home');
  if (error && !data) return <div className="cn-error">Couldn’t read the home — {error}</div>;
  if (!data) return <div className="cn-muted">Reading the home…</div>;
  return <HomeView data={data} />;
}
