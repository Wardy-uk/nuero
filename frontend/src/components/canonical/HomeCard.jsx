import React from 'react';
import { useCanonical } from './canonicalUi';

/**
 * Build 22 — Home, on Life, directly under who's in the house.
 *
 * NOT a sensor dashboard: occupancy in one line, household tasks you classified
 * as Home, dated household items from the Future Radar, Home Assistant's own
 * device watchdog, and whether NEURO can see household hazards at all. Every
 * word about state is the server's; this renders and never ranks or infers.
 * "Can't tell" is drawn as its own thing, never as empty or as fine.
 */

const OCCUPANCY_WORDS = { occupied: 'Occupied', empty: 'Empty', unknown: 'Can’t tell' };
const VERDICT_WORDS = {
  seeing: 'reading', partial: 'partly readable', stale: 'stale', failing: 'failing',
  unavailable: 'can’t read', 'no-capability': 'no sensor',
};

export function HomeView({ data }) {
  const o = data.occupancy;
  const d = data.devices;
  const s = data.safety;
  return (
    <section className="cn-section" data-testid="home-card">
      <h3>Home <span className="cn-chip">{OCCUPANCY_WORDS[o.state] || o.state}</span></h3>
      <div className="cn-muted">{o.why}</div>

      {data.needsYou.length > 0 && (
        <div className="cn-details" data-testid="home-needs-you">
          <div className="cn-subhead">Needs you</div>
          <ul className="cn-list">{data.needsYou.map((n) => <li key={n.id}>{n.title} <span className="cn-muted">— {n.why}</span></li>)}</ul>
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

      <div className="cn-details">
        <div className="cn-subhead">Devices</div>
        {!d.known
          ? <div className="cn-blind">Can’t read device health — {d.why}. This is not “all fine”.</div>
          : <>
              {d.lowBatteries.length > 0 && <div>Needs a battery: {d.lowBatteries.join(', ')}</div>}
              {d.offline.length > 0 && <div className="cn-muted">Home Assistant can’t reach: {d.offline.join(', ')} (it may be unplugged on purpose; HA reports these at 09:00).</div>}
              {d.lowBatteries.length === 0 && d.offline.length === 0 && <div className="cn-muted">Nothing offline, no low batteries.</div>}
            </>}
      </div>

      <div className="cn-details">
        <div className="cn-subhead">Hazards</div>
        {s.capability === 'none' && <div className="cn-muted" data-testid="home-no-hazard-sensors">{s.why}</div>}
        {s.capability === 'unknown' && <div className="cn-blind">{s.why}</div>}
        {s.capability === 'present' && (s.active.length
          ? <div className="cn-blind">{s.active.map((a) => `${a.label}: ${a.hazard}`).join(', ')}</div>
          : <div className="cn-muted">{s.sensors} hazard {s.sensors === 1 ? 'sensor' : 'sensors'}, none reporting.</div>)}
      </div>

      <div className="cn-muted cn-small" data-testid="home-sources">
        {data.sources.map((x) => `${x.label}: ${VERDICT_WORDS[x.verdict] || x.verdict}`).join(' · ')}
      </div>
    </section>
  );
}

export default function HomeCard() {
  const { data, error } = useCanonical('/api/household/home');
  if (error && !data) return <div className="cn-error">Couldn’t read the home — {error}</div>;
  if (!data) return <div className="cn-muted">Reading the home…</div>;
  return <HomeView data={data} />;
}
