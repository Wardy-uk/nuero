import React from 'react';
import { useCanonical, Fold, HowItWorks, Headline, StatTiles, Stat, TileGrid, Tile, Group } from './canonicalUi';

/**
 * Life → Home (Build 22, rebuilt Build 28; reshaped to docs/design-rules.md
 * 13 Oct 2026).
 *
 * NOT a Home Assistant dashboard: no entity rows, no floorplan, no controls.
 * Occupancy, what is UNUSUAL (exceptions with their evidence), heating, rooms,
 * device problems only, hazard capability (absence is said, never "safe"), the
 * router and hub, and where each source stands. Every word about state is the
 * server's; this renders and never ranks or infers. "Can't tell" is drawn as
 * its own thing, never as empty or as fine.
 *
 * Shape: one headline (the house's answer), the counts as tiles, then each
 * section as a group of small tiles — evidence and reasons on hover, sources
 * on a fold.
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
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const sinceWords = (iso) => new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

function Exception({ e }) {
  const why = [e.evidence.join(' '), e.whyItMatters, e.context, e.unknownWhy].filter(Boolean).join(' ');
  return (
    <Tile testid="home-exception" title={e.what} why={why}
      sub={`${e.persistence}${e.since ? ` · since ${sinceWords(e.since)}` : ''}`}
      foot={<span className="cn-chip">{STATE_WORDS[e.actionState] || e.actionState}</span>} />
  );
}

function Room({ r }) {
  const h = r.heating;
  const sub = [r.temperature ? c(r.temperature.c) : null, r.humidity ? `${r.humidity.pct}%` : null].filter(Boolean).join(' · ') || 'no reading';
  const why = [
    r.temperature ? `temperature from ${r.temperature.source}` : null,
    r.humidity && r.dewPointC !== null ? `dew point ${r.dewPointC} °C (context only)` : null,
    h ? `heating set to ${h.targetC === null ? 'off' : c(h.targetC)}${h.wanted ? '' : ' (frost protection)'}${h.demand === true ? ' — calling for heat' : h.demand === false ? ' — not calling' : ''}` : null,
    r.boiler ? `the boiler thermostat lives here (${r.boiler.action || 'state unknown'})` : null,
    ...r.openings.map((o) => `${o.label}: ${o.state}${o.forMin ? ` for ${hrs(o.forMin)}` : ''}`),
    r.presence && (r.presence.nickHere || r.presence.motion)
      ? `right now: ${[r.presence.nickHere ? 'Nick’s watch places him here' : null, r.presence.motion === 'active' ? 'motion' : r.presence.motion === 'quiet' ? 'no motion' : null].filter(Boolean).join(', ')} (current state only — no history is kept).`
      : null,
  ].filter(Boolean).join(' · ');
  const foot = (h || r.openings.length > 0 || r.exceptions.length > 0) ? (
    <>
      {h && <span className="cn-chip">{h.targetC === null ? 'heating off' : `set ${c(h.targetC)}`}{h.demand === true ? ' · calling' : ''}</span>}
      {r.openings.length > 0 && <span className="cn-chip cn-chip--soft">{plural(r.openings.length, 'opening', 'openings')}</span>}
      {r.exceptions.length > 0 && <span className="cn-chip cn-chip--firm">{r.exceptions.length} unusual</span>}
    </>
  ) : null;
  return <Tile title={r.area} sub={sub} foot={foot} why={why || undefined} />;
}

export function HomeView({ data }) {
  const o = data.occupancy;
  const d = data.devices;
  const s = data.safety;
  const intel = !!data.intelligence && data.known !== false;
  const blind = !!data.intelligence && data.known === false;
  const dh = data.deviceHealth;
  // ⚠ ONE task, ONE line (13 Oct 2026: "apparently I need to book my MOT…
  // 3 times"). The same open task is legitimately a Needs-you item, a
  // household task and a Radar item; the card says it once — in the highest
  // section — and the lower sections skip it. Matched by id and by normalised
  // wording, since the Radar names it with its own id.
  const key = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const shown = new Set((data.needsYou || []).flatMap((n) => [n.id, key(n.title)]));
  const tasks = (data.obligations || []).filter((t) => !shown.has(t.id) && !shown.has(key(t.what)));
  for (const t of data.obligations || []) shown.add(key(t.what));
  const upcoming = (data.upcoming || []).filter((u) => !shown.has(u.id) && !shown.has(key(u.title)));

  const occ = OCCUPANCY_WORDS[o.state] || o.state;
  const occLine = `${o.why}${o.visitorsHome && o.visitorsHome.length ? ` · visiting: ${o.visitorsHome.join(', ')}` : ''}`;
  const nNeeds = data.needsYou.length;
  const nUnusual = intel ? data.exceptions.length : null;
  const head = blind
    ? { tone: 'warn', pill: 'Can’t read', text: 'Can’t read Home Assistant right now — rooms, heating and devices are unknown, not fine.', detail: `${occ} — ${occLine}` }
    : nNeeds > 0
      ? { tone: 'warn', pill: 'Needs you', text: `${plural(nNeeds, 'thing needs', 'things need')} you at home.`, detail: `${occ} — ${occLine}` }
      : nUnusual
        ? { tone: 'warn', pill: 'Unusual', text: `${plural(nUnusual, 'thing', 'things')} unusual at home.`, detail: `${occ} — ${occLine}` }
        : { tone: 'neutral', pill: occ, text: occLine, detail: null };

  const devicesKnown = !!(d.known || (intel && dh && dh.known));
  const batteryTiles = intel && data.batteries
    ? data.batteries.low.map((b) => ({ k: b.device, title: b.device, sub: `battery ${b.level}` }))
    : !intel ? d.lowBatteries.map((b) => ({ k: b, title: b, sub: 'needs a battery' })) : [];
  const offlineTiles = intel && dh
    ? dh.longOffline.map((x) => ({ k: x.device, title: x.device, sub: `offline ${hrs(x.forMin)}` }))
    : !intel ? d.offline.map((x) => ({ k: x, title: x, sub: 'can’t reach' })) : [];
  const devicesWhy = [
    offlineTiles.length ? (intel
      ? 'Offline for over a week — probably unplugged on purpose or retired.'
      : 'Home Assistant can’t reach the offline ones — they may be unplugged on purpose; HA reports these at 09:00.') : null,
    intel && dh ? 'Lights, TVs and phones are not judged — a bulb off at the wall reads unavailable.' : null,
  ].filter(Boolean).join(' ');
  const srcRows = intel ? data.sourceHealth : data.sources;
  const srcOff = srcRows.filter((x) => x.verdict !== 'seeing').length;

  return (
    <section className="cn-section" data-testid="home-card">
      <h3>Home</h3>
      <Headline tone={head.tone} pill={head.pill} detail={head.detail}>{head.text}</Headline>
      {intel && data.heating && (
        <div className="cn-nowstrip" data-testid="home-heating">
          <span>{data.heating.summary}</span>
          {data.weather && data.weather.line ? <span>{data.weather.line}</span> : null}
        </div>
      )}

      <StatTiles>
        <Stat v={nNeeds} l="needs you" tone={nNeeds ? 'warn' : undefined} />
        <Stat v={nUnusual} l="unusual" tone={nUnusual ? 'warn' : undefined} title={intel ? undefined : 'Can’t tell without Home Assistant'} />
        <Stat v={data.obligations.length} l="household tasks" />
        <Stat v={devicesKnown && (!intel || data.batteries) ? batteryTiles.length : null} l="low batteries" />
        {intel && dh && dh.known && <Stat v={`${dh.healthy}/${dh.judged}`} l="devices healthy"
          title={`${dh.healthy} of ${dh.judged} devices healthy (not listed)${data.batteries ? ` · ${data.batteries.ok} batteries fine` : ''}`} />}
      </StatTiles>

      {nNeeds > 0 && (
        <div data-testid="home-needs-you">
          <Group label="Needs you">
            <TileGrid>{data.needsYou.map((n) => <Tile key={n.id} title={n.title} why={n.why} accent />)}</TileGrid>
          </Group>
        </div>
      )}

      {intel && (
        <div data-testid="home-exceptions">
          <Group label="Unusual at home">
            {data.exceptions.length === 0
              ? <div className="cn-muted">Nothing unusual that NEURO can see{data.sourceHealth.some((x) => x.verdict === 'no-capability') ? ' — within what the house has sensors for (below)' : ''}.</div>
              : <TileGrid>{data.exceptions.map((e) => <Exception key={e.key} e={e} />)}</TileGrid>}
            {data.resolved && data.resolved.length > 0 && (
              <Fold title="Resolved in the last day" meta={`${data.resolved.length}`}>
                <ul className="cn-act-lines">{data.resolved.map((r, i) => <li key={i}>{r.what}</li>)}</ul>
              </Fold>
            )}
          </Group>
        </div>
      )}

      {intel && data.rooms && data.rooms.length > 0 && (
        <div data-testid="home-rooms">
          <Group label="Rooms" why="Hover a room for where its readings come from, its heating, openings and whether you are in it.">
            <TileGrid>{data.rooms.map((r) => <Room key={r.area} r={r} />)}</TileGrid>
          </Group>
        </div>
      )}

      <Group label="Household tasks" why="Only reminders and tasks you classified as Home count here.">
        {data.obligations.length === 0
          ? <div className="cn-muted">Nothing classified as Home is open.</div>
          : tasks.length === 0
            ? <div className="cn-muted">Only what is under Needs you, above.</div>
            : <TileGrid>{tasks.map((t) => <Tile key={t.id} title={t.what} sub={t.due ? t.due.label : 'no date'} />)}</TileGrid>}
      </Group>

      {upcoming.length > 0 && (
        <Group label="Coming up at home">
          <TileGrid>{upcoming.map((u) => <Tile key={u.id} title={u.title} sub={u.when || null} />)}</TileGrid>
        </Group>
      )}

      <div data-testid="home-devices">
        <Group label="Devices" why={devicesKnown && devicesWhy ? devicesWhy : null}>
          {!devicesKnown
            ? <div className="cn-blind">Can’t read device health — {d.why}. This is not “all fine”.</div>
            : batteryTiles.length + offlineTiles.length === 0
              ? <div className="cn-muted">Nothing offline, no low batteries.</div>
              : <TileGrid>
                  {batteryTiles.map((t) => <Tile key={`b-${t.k}`} title={t.title} sub={t.sub} foot={<span className="cn-chip cn-chip--firm">needs a battery</span>} />)}
                  {offlineTiles.map((t) => <Tile key={`o-${t.k}`} title={t.title} sub={t.sub} foot={<span className="cn-chip cn-chip--soft">offline</span>} />)}
                </TileGrid>}
        </Group>
      </div>

      <div data-testid="home-hazards">
        <Group label="Hazards">
          {s.capability === 'none' && <div className="cn-muted" data-testid="home-no-hazard-sensors">{s.why}</div>}
          {s.capability === 'unknown' && <div className="cn-blind">{s.why}</div>}
          {s.capability === 'present' && (s.active.length
            ? <div className="cn-blind">{s.active.map((a) => `${a.label}: ${a.hazard}`).join(', ')}</div>
            : <div className="cn-muted">{plural(s.sensors, 'hazard sensor', 'hazard sensors')}, none reporting.</div>)}
          {intel && data.hazards && data.hazards.known && (
            <TileGrid>{data.hazards.categories.map((h) => <Tile key={h.label} title={h.label} sub={CAPABILITY_WORDS[h.capability] || h.capability} />)}</TileGrid>
          )}
        </Group>
      </div>

      {intel && data.network && data.network.ha === 'reachable' && (
        <div data-testid="home-network">
          <Group label="Network" why={data.network.note || null}>
            <TileGrid>
              {data.network.wan
                ? <Tile title="Router internet link" sub={data.network.wan.state} />
                : <Tile title="Router" sub="no status in Home Assistant" />}
              {data.network.hub && <Tile title="Heating hub" sub={data.network.hub.state} />}
            </TileGrid>
          </Group>
        </div>
      )}

      <Fold title="Sources" meta={srcOff ? `${srcOff} not fully read` : 'all reading'}>
        {intel && (
          <div className="cn-small" data-testid="home-capability">
            Doors &amp; windows: {data.openings.capability === 'absent' ? 'no sensors' : `${data.openings.items.length} sensors`} · Appliances: {data.appliances.capability === 'absent' ? 'none report a useful state' : data.appliances.items.length} · Energy: {data.energy.available ? data.energy.label : data.energy.why}
          </div>
        )}
        <div className="cn-small" data-testid="home-sources">
          {srcRows.map((x) => `${x.label}: ${VERDICT_WORDS[x.verdict] || x.verdict}`).join(' · ')}
        </div>
      </Fold>

      {intel && (
        <HowItWorks>
          Home Assistant is a source, not the screen: NEURO reads its {data.audit ? data.audit.total : ''} entities and keeps the {data.audit ? data.audit.roles.inference : ''} that say something about the house. Occupied only when a resident is positively home; empty only when everyone who lives here is positively away; otherwise “can’t tell”. Something is “unusual” only with persistence — three or four consecutive hours for temperature and humidity (from Home Assistant’s own hourly statistics), a duration for doors and devices, against each room’s own last week rather than a comfort threshold. Hazards come only from hazard sensors, never from temperature or silence. NEURO changes nothing in the house from here.
        </HowItWorks>
      )}
    </section>
  );
}

/** One line: yesterday's energy, linking to Home → Energy. Silent until Bright is connected. */
export function EnergyLine({ energy }) {
  if (!energy || !energy.connection || !energy.connection.configured) return null;
  const parts = Object.entries(energy.fuels || {})
    .filter(([, f]) => f.present && f.yesterday && f.yesterday.kwh != null)
    .map(([fuel, f]) => `${fuel} ${f.yesterday.kwh.toFixed(1)} kWh${f.yesterday.complete ? '' : ' (so far)'}`);
  const all = Object.values(energy.fuels || {}).filter((f) => f.present);
  const cost = all.length && all.every((f) => f.yesterday && f.yesterday.costP != null)
    ? all.reduce((s, f) => s + f.yesterday.costP, 0) : null;
  return (
    <a className="cn-muted" href="?view=energy" data-testid="home-energy-line">
      Energy yesterday: {parts.length ? parts.join(' · ') : 'no readings yet'}{cost != null ? ` · ~£${(cost / 100).toFixed(2)} est.` : ''} →
    </a>
  );
}

export default function HomeCard() {
  const { data, error } = useCanonical('/api/household/home');
  const { data: energy } = useCanonical('/api/energy?days=3');
  if (error && !data) return <div className="cn-error">Couldn’t read the home — {error}</div>;
  if (!data) return <div className="cn-muted">Reading the home…</div>;
  return (<><EnergyLine energy={energy} /><HomeView data={data} /></>);
}
