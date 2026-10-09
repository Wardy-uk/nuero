'use strict';

/**
 * Build 28 — Home Intelligence. Fixtures are SHAPED like the live house of
 * 9 Oct 2026 (Hive TRVs per room, a Hive boiler thermostat in the Hall, Tuya
 * room sensors with humidity, two Hive motion sensors, an ASUS router WAN flag,
 * the Hive hub, no hazard/door/window/energy meter) but carry no real data.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

// ⚠ BEFORE ANY REQUIRE (Build 22's lesson): scratch DB, no real house.
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'b28-home-'));
process.env.NEURO_DB_PATH = path.join(SCRATCH, 'agent.db');
process.env.HA_TOKEN = '';
process.env.HA_URL = 'http://127.0.0.1:9';

const hi = require('./home-intelligence');
const home = require('./home');

const NOW = Date.parse('2026-10-09T14:20:00Z');
const MIN = 60000; const HOUR = 3600000;
const iso = (minAgo) => new Date(NOW - minAgo * MIN).toISOString();
const st = (entity_id, state, attributes = {}, changedMin = 10, updatedMin = changedMin) => ({ entity_id, state: String(state), attributes, last_changed: iso(changedMin), last_updated: iso(updatedMin) });

// ── the house ────────────────────────────────────────────────────────────────
const REG = {
  'climate.kitchen_rad': { area: 'Kitchen', device: 'Kitchen Rad' },
  'binary_sensor.kitchen_rad_state': { area: 'Kitchen', device: 'Kitchen Rad' },
  'binary_sensor.kitchen_rad_boost': { area: 'Kitchen', device: 'Kitchen Rad' },
  'sensor.kitchen_rad_target_temperature': { area: 'Kitchen', device: 'Kitchen Rad' },
  'sensor.kitchen_rad_current_temperature': { area: 'Kitchen', device: 'Kitchen Rad' },
  'sensor.kitchen_rad_battery_level': { area: 'Kitchen', device: 'Kitchen Rad' },
  'sensor.kitchen_sensor_temperature': { area: 'Kitchen', device: 'Kitchen Sensor' },
  'sensor.kitchen_sensor_humidity': { area: 'Kitchen', device: 'Kitchen Sensor' },
  'sensor.kitchen_sensor_battery_state': { area: 'Kitchen', device: 'Kitchen Sensor' },
  'climate.office_rad': { area: 'Office', device: 'Office Rad' },
  'binary_sensor.office_rad_state': { area: 'Office', device: 'Office Rad' },
  'sensor.office_rad_target_temperature': { area: 'Office', device: 'Office Rad' },
  'sensor.office_sensor_temperature': { area: 'Office', device: 'Office Sensor' },
  'sensor.office_sensor_humidity': { area: 'Office', device: 'Office Sensor' },
  'climate.lizzy_s_room': { area: "Lizzy's Room", device: "Lizzy's rad" },
  'climate.thermostat_1': { area: 'Hall', device: 'Thermostat 1', manufacturer: 'Computime' },
  'binary_sensor.thermostat_1_state': { area: 'Hall', device: 'Thermostat 1' },
  'sensor.thermostat_1_battery_level': { area: 'Hall', device: 'Thermostat 1' },
  'binary_sensor.motion_sensor_2': { area: 'Landing', device: 'Motion Sensor 2' },
  'sensor.motion_sensor_2_current_temperature': { area: 'Landing', device: 'Motion Sensor 2' },
  'binary_sensor.rt_ac68u_wan_status': { area: 'Kitchen', device: 'Router' },
  'binary_sensor.hub_hive_hub_status': { area: 'Kitchen', device: 'Hub' },
  'light.kitchen_1': { area: 'Kitchen', device: 'Kitchen 1' },
  'switch.office_plug_socket': { area: 'Office', device: 'Office plug' },
  'switch.kitchen_side_socket': { area: 'Kitchen', device: 'Kitchen side' },
  'sensor.bedroom_total_energy': { area: "Mum's Room", device: 'Bedroom' },
  'sensor.nicks_iphone_battery_level_2': { area: null, device: 'Nicks iPhone' },
  'media_player.living_room': { area: 'Living Room', device: 'Living Room' },
};
const house = (over = {}) => {
  const base = {
    'climate.kitchen_rad': st('climate.kitchen_rad', 'auto', { current_temperature: 20.2, temperature: 20, hvac_action: 'idle' }, 15),
    'binary_sensor.kitchen_rad_state': st('binary_sensor.kitchen_rad_state', 'off', {}, 90),
    'binary_sensor.kitchen_rad_boost': st('binary_sensor.kitchen_rad_boost', 'off', {}, 9000),
    'sensor.kitchen_rad_target_temperature': st('sensor.kitchen_rad_target_temperature', '20.0', { device_class: 'temperature', unit_of_measurement: '°C', state_class: 'measurement' }, 400),
    'sensor.kitchen_rad_current_temperature': st('sensor.kitchen_rad_current_temperature', '20.2', { device_class: 'temperature', unit_of_measurement: '°C', state_class: 'measurement' }, 15),
    'sensor.kitchen_rad_battery_level': st('sensor.kitchen_rad_battery_level', '100', { device_class: 'battery', unit_of_measurement: '%' }, 30000),
    'sensor.kitchen_sensor_temperature': st('sensor.kitchen_sensor_temperature', '22.1', { device_class: 'temperature', unit_of_measurement: '°C', state_class: 'measurement' }, 25),
    'sensor.kitchen_sensor_humidity': st('sensor.kitchen_sensor_humidity', '58.0', { device_class: 'humidity', unit_of_measurement: '%', state_class: 'measurement' }, 25),
    'sensor.kitchen_sensor_battery_state': st('sensor.kitchen_sensor_battery_state', 'high', {}, 700),
    'climate.office_rad': st('climate.office_rad', 'auto', { current_temperature: 21.8, temperature: 22, hvac_action: 'idle' }, 5),
    'binary_sensor.office_rad_state': st('binary_sensor.office_rad_state', 'on', {}, 12),
    'sensor.office_rad_target_temperature': st('sensor.office_rad_target_temperature', '22.0', { device_class: 'temperature', unit_of_measurement: '°C', state_class: 'measurement' }, 400),
    'sensor.office_sensor_temperature': st('sensor.office_sensor_temperature', '22.6', { device_class: 'temperature', unit_of_measurement: '°C', state_class: 'measurement' }, 40),
    'sensor.office_sensor_humidity': st('sensor.office_sensor_humidity', '60.0', { device_class: 'humidity', unit_of_measurement: '%', state_class: 'measurement' }, 40),
    'climate.lizzy_s_room': st('climate.lizzy_s_room', 'off', { current_temperature: 18.3, temperature: 7, hvac_action: 'idle' }, 30),
    'climate.thermostat_1': st('climate.thermostat_1', 'heat', { current_temperature: 21.2, temperature: 7, hvac_action: 'idle' }, 12),
    'binary_sensor.thermostat_1_state': st('binary_sensor.thermostat_1_state', 'off', {}, 42),
    'sensor.thermostat_1_battery_level': st('sensor.thermostat_1_battery_level', '40', { device_class: 'battery', unit_of_measurement: '%' }, 100),
    'binary_sensor.motion_sensor_2': st('binary_sensor.motion_sensor_2', 'on', { device_class: 'motion' }, 1),
    'sensor.motion_sensor_2_current_temperature': st('sensor.motion_sensor_2_current_temperature', '19.8', { device_class: 'temperature', unit_of_measurement: '°C', state_class: 'measurement' }, 110),
    'binary_sensor.rt_ac68u_wan_status': st('binary_sensor.rt_ac68u_wan_status', 'on', { device_class: 'connectivity' }, 7000),
    'binary_sensor.hub_hive_hub_status': st('binary_sensor.hub_hive_hub_status', 'on', { device_class: 'connectivity' }, 30000),
    'light.kitchen_1': st('light.kitchen_1', 'unavailable', {}, 900),
    'switch.office_plug_socket': st('switch.office_plug_socket', 'unavailable', { device_class: 'outlet' }, 34000),
    'switch.kitchen_side_socket': st('switch.kitchen_side_socket', 'on', { device_class: 'outlet' }, 50),
    'sensor.bedroom_total_energy': st('sensor.bedroom_total_energy', '5.8', { device_class: 'energy', unit_of_measurement: 'kWh', state_class: 'total_increasing' }, 1),
    'sensor.nicks_iphone_battery_level_2': st('sensor.nicks_iphone_battery_level_2', '12', { device_class: 'battery', unit_of_measurement: '%' }, 5),
    'media_player.living_room': st('media_player.living_room', 'idle', {}, 700),
    'device_tracker.redmi_note_15': st('device_tracker.redmi_note_15', 'home', {}, 10),
    'device_tracker.life360_helen': st('device_tracker.life360_helen', 'home', { battery_level: 57 }, 1),
    'person.nick': st('person.nick', 'home', {}, 50),
    'sensor.nick_room': st('sensor.nick_room', 'study', {}, 1),
    'sensor.weather_station_temperature': st('sensor.weather_station_temperature', '14.5', { device_class: 'temperature', unit_of_measurement: '°C', state_class: 'measurement' }, 1),
    'automation.pantry_light_on_motion': st('automation.pantry_light_on_motion', 'on', {}, 9000),
  };
  for (const [k, v] of Object.entries(over)) { if (v === null) delete base[k]; else base[k] = v; }
  return Object.values(base);
};
const regWith = (extra = {}) => ({ ...REG, ...extra });

/** Complete hourly statistics ending with the last complete hour before NOW, oldest first. */
const hours = (values, now = NOW) => {
  const base = Math.floor(now / HOUR) * HOUR;
  return values.map((v, i) => ({ start: base - (values.length - i) * HOUR, mean: v, min: v - 0.1, max: v + 0.1 }));
};
const flatThen = (n, flat, tail) => [...Array(n).fill(flat), ...tail];
const OCC = { state: 'occupied', who: ['Nick'], why: 'Nick is home' };
const model = (o = {}) => hi.compose({ states: house(), registry: REG, stats: {}, boilerHistory: [], occupancy: OCC, now: NOW, ...o });
const keys = (m) => m.exceptions.map((e) => e.key);

// ── occupancy (1–5) ──────────────────────────────────────────────────────────
const SRC_OK = { state: 'healthy', freshness: 'fresh' };
const roster = (s, src = SRC_OK) => ({ known: true, source: src, members: [
  { id: 'nick', name: 'Nick', role: 'self', state: s.nick }, { id: 'helen', name: 'Helen', role: 'resident', state: s.helen },
  { id: 'isaac', name: 'Isaac', role: 'resident', state: s.isaac }, { id: 'lizzy', name: 'Lizzy', role: 'visitor', state: s.lizzy || 'away' },
] });

test('1 one resident home => occupied', () => {
  assert.equal(home.occupancyFrom(roster({ nick: 'away', helen: 'home', isaac: 'away' })).state, 'occupied');
});
test('2 all known residents away => empty', () => {
  assert.equal(home.occupancyFrom(roster({ nick: 'away', helen: 'away', isaac: 'away' })).state, 'empty');
});
test('3 conflicting / insufficient evidence => unknown', () => {
  assert.equal(home.occupancyFrom(roster({ nick: 'away', helen: 'unknown', isaac: 'away' })).state, 'unknown');
  assert.equal(home.occupancyFrom(roster({ nick: 'home', helen: 'home', isaac: 'home' }, { state: 'failing', freshness: 'stale' })).state, 'unknown');
});
test('4 unknown is never treated as empty — a door open while unknown is context, not "nobody home"', () => {
  const door = { 'binary_sensor.front_door': st('binary_sensor.front_door', 'on', { device_class: 'door', friendly_name: 'Front door' }, 45) };
  const m = hi.compose({ states: house(door), registry: regWith({ 'binary_sensor.front_door': { area: 'Hall', device: 'Front door' } }), stats: {}, occupancy: { state: 'unknown', why: "can't tell" }, now: NOW });
  const e = m.exceptions.find((x) => x.key === 'opening:open-long:binary_sensor.front_door');
  assert.ok(e);
  assert.equal(e.actionState, 'context');
});
test('5 a router-only device at home never becomes a resident', () => {
  const c = hi.classifyEntity(st('device_tracker.redmi_note_15', 'home'), {});
  assert.equal(c.role, 'noise'); assert.equal(c.category, 'network');
  const h = home.compose({ household: roster({ nick: 'away', helen: 'away', isaac: 'away' }), states: house(), intel: model() });
  assert.equal(h.occupancy.state, 'empty');
  assert.deepEqual(h.occupancy.residentsHome, []);
});

// ── climate (6–10) ───────────────────────────────────────────────────────────
test('6 a stale temperature is not treated as current — it is said to have stopped', () => {
  const m = model({ states: house({ 'sensor.office_sensor_temperature': st('sensor.office_sensor_temperature', '22.6', { device_class: 'temperature', unit_of_measurement: '°C' }, 3100) }) });
  assert.ok(keys(m).includes('source:stale:sensor.office_sensor_temperature'));
  assert.equal(m.sourceHealth.find((s) => s.id === 'climate').verdict, 'partial');
});
const belowStats = (kitchenTemps, targets) => ({ 'sensor.kitchen_sensor_temperature': hours(kitchenTemps), 'sensor.kitchen_rad_target_temperature': hours(targets) });
test('7 one odd reading creates no exception', () => {
  const m = model({ stats: belowStats(flatThen(80, 20.5, [20.6, 16.0, 20.4]), Array(83).fill(20)) });
  assert.ok(!keys(m).some((k) => k.startsWith('climate:')));
});
test('8 a persistent deviation from its own setpoint becomes context', () => {
  const m = model({ stats: belowStats(flatThen(80, 20.5, [18.1, 18.0, 18.2]), Array(83).fill(20)) });
  const e = m.exceptions.find((x) => x.key === 'climate:below-target:Kitchen');
  assert.ok(e, 'opened');
  assert.equal(e.actionState, 'context');
  assert.match(e.evidence[0], /setpoint of 20/);
  assert.equal(m.needsYou.length, 0);
});
test('9 no global comfort threshold: a cold room on frost protection is not an exception', () => {
  const m = model({ stats: belowStats(flatThen(80, 5, [5, 5, 5]), Array(83).fill(7)) });
  assert.ok(!keys(m).some((k) => k.startsWith('climate:below-target')), '2 °C under a 7 °C frost setpoint is not "below its setpoint"');
  const frost = model({ states: house({ 'climate.kitchen_rad': st('climate.kitchen_rad', 'auto', { current_temperature: 12, temperature: 7, hvac_action: 'idle' }, 5) }) });
  assert.equal(frost.rooms.find((r) => r.area === 'Kitchen').heating.wanted, false);
  assert.ok(!Object.keys(hi.T).some((k) => /COMFORT|MIN_ROOM|MAX_ROOM/.test(k)), 'no comfort constant exists');
});
test('10 heating state is the boiler thermostat, distinct from room temperature', () => {
  const firing = model({ states: house({ 'climate.thermostat_1': st('climate.thermostat_1', 'heat', { current_temperature: 23, temperature: 25, hvac_action: 'heating' }, 2) }) });
  assert.equal(firing.heating.firing, true);
  assert.deepEqual(firing.heating.calling, ['Office']);
  const idle = model();
  assert.equal(idle.heating.firing, false);
  assert.match(idle.heating.summary, /idle/);
});

// ── humidity (11–14) ─────────────────────────────────────────────────────────
const rh = (series) => ({ 'sensor.kitchen_sensor_humidity': hours(series) });
const RH_BASE = Array.from({ length: 100 }, (_, i) => 55 + (i % 6));
test('11 persistently high RH, beyond the room’s own range, is surfaced', () => {
  const m = model({ stats: rh([...RH_BASE, 74, 75, 76, 75]) });
  const e = m.exceptions.find((x) => x.key === 'humidity:high:Kitchen');
  assert.ok(e);
  assert.match(e.what, /stayed unusually high for Kitchen/);
});
test('12 a brief spike is ignored', () => {
  const m = model({ stats: rh([...RH_BASE, 58, 78, 79, 57]) });
  assert.ok(!keys(m).some((k) => k.startsWith('humidity:')));
});
test('13 RH alone never diagnoses mould or damp, and never becomes a hazard', () => {
  const m = model({ stats: rh([...RH_BASE, 95, 96, 97, 96]) });
  const e = m.exceptions.find((x) => x.category === 'humidity');
  assert.ok(e);
  assert.doesNotMatch(`${e.what} ${e.evidence.join(' ')}`, /mould|mold|damp/i);
  assert.match(e.whyItMatters, /says nothing about damp or mould/);
  assert.ok(!m.exceptions.some((x) => x.category === 'hazard'));
});
test('14 dew point is deterministic (Magnus–Tetens, Sonntag 1990)', () => {
  assert.equal(hi.dewPoint(20, 50), 9.3);
  assert.equal(hi.dewPoint(20, 50), hi.dewPoint(20, 50));
  assert.equal(hi.dewPoint(20, 0), null);
  const kitchen = model().rooms.find((r) => r.area === 'Kitchen');
  assert.equal(kitchen.dewPointC, hi.dewPoint(22.1, 58), 'only from one device measuring both');
  assert.equal(model().rooms.find((r) => r.area === 'Landing').dewPointC, null);
  const stitched = model({ states: [...house(), st('sensor.landing_humidity', '60', { device_class: 'humidity', unit_of_measurement: '%' }, 5)], registry: regWith({ 'sensor.landing_humidity': { area: 'Landing', device: 'Landing RH' } }) });
  const landing = stitched.rooms.find((r) => r.area === 'Landing');
  assert.equal(landing.humidity.pct, 60);
  assert.equal(landing.dewPointC, null, 'never stitched from two devices');
});

// ── openings (15–20) ─────────────────────────────────────────────────────────
const DOOR_REG = regWith({ 'binary_sensor.front_door': { area: 'Hall', device: 'Front door' }, 'binary_sensor.office_window': { area: 'Office', device: 'Office window' } });
const door = (state, min) => ({ 'binary_sensor.front_door': st('binary_sensor.front_door', state, { device_class: 'door', friendly_name: 'Front door' }, min) });
const win = (state, min) => ({ 'binary_sensor.office_window': st('binary_sensor.office_window', state, { device_class: 'window', friendly_name: 'Office window' }, min) });
test('15 a door contact is tracked as an opening', () => {
  const m = model({ states: house(door('off', 300)), registry: DOOR_REG });
  assert.equal(m.openings.capability, 'present');
  assert.equal(m.rooms.find((r) => r.area === 'Hall').openings[0].state, 'closed');
});
test('16 a random binary sensor is not an opening', () => {
  assert.notEqual(hi.classifyEntity(st('binary_sensor.kitchen_rad_boost', 'on'), { heatingDevice: true }).category, 'openings');
  assert.equal(model().openings.capability, 'absent');
  assert.match(model().openings.why, /no door or window sensor/);
});
test('17 a brief opening is ignored', () => {
  assert.ok(!keys(model({ states: house(door('on', 5)), registry: DOOR_REG })).some((k) => k.startsWith('opening:')));
});
test('18 a prolonged opening becomes context', () => {
  const e = model({ states: house(door('on', 45)), registry: DOOR_REG }).exceptions.find((x) => x.key.startsWith('opening:open-long'));
  assert.ok(e); assert.equal(e.actionState, 'context');
});
test('19 a window open while the room calls for heat is context', () => {
  const e = model({ states: house(win('on', 15)), registry: DOOR_REG }).exceptions.find((x) => x.key.startsWith('opening:window-heating'));
  assert.ok(e); assert.match(e.evidence[0], /Office is calling for heat/);
  assert.ok(!keys(model({ states: house(win('on', 5)), registry: DOOR_REG })).some((k) => k.startsWith('opening:')));
});
test('20 openings never reach Activity', () => {
  assert.ok(!hi.ACTIVITY_CATEGORIES.has('opening'));
  const tracked = hi.trackExceptions({ open: {} }, model({ states: house(door('on', 45)), registry: DOOR_REG }).exceptions, { now: NOW });
  assert.ok(tracked.opened.some((e) => e.category === 'opening'));
  assert.equal(tracked.opened.filter((e) => hi.ACTIVITY_CATEGORIES.has(e.category)).length, 0);
});

// ── devices / batteries (21–25) ──────────────────────────────────────────────
test('21 healthy devices are counted, never listed', () => {
  const d = model().devices;
  assert.ok(d.healthy > 5);
  assert.equal(d.offline.length, 0);
  assert.ok(!JSON.stringify(d).includes('Kitchen Sensor'), 'a healthy device name does not appear');
});
test('22 a device offline for 40 minutes is surfaced; a 10-minute blip and an unplugged light are not', () => {
  const s40 = { 'switch.kitchen_side_socket': st('switch.kitchen_side_socket', 'unavailable', { device_class: 'outlet' }, 40) };
  assert.ok(keys(model({ states: house(s40) })).includes('device:offline:Kitchen side'));
  const s10 = { 'switch.kitchen_side_socket': st('switch.kitchen_side_socket', 'unavailable', { device_class: 'outlet' }, 10) };
  assert.ok(!keys(model({ states: house(s10) })).some((k) => k.startsWith('device:offline')));
  assert.ok(!keys(model()).includes('device:offline:Kitchen 1'), 'a bulb off at the wall is not judged');
  assert.equal(model().devices.longOffline[0].device, 'Office plug', 'over a week offline is listed as long-offline, not an exception');
});
test('23 a low battery is surfaced by HA’s own 20% rule or the device saying low; a phone is not household', () => {
  const m = model({ states: house({ 'sensor.thermostat_1_battery_level': st('sensor.thermostat_1_battery_level', '15', { device_class: 'battery', unit_of_measurement: '%' }, 10), 'sensor.kitchen_sensor_battery_state': st('sensor.kitchen_sensor_battery_state', 'low', {}, 10) }) });
  assert.deepEqual(m.batteries.low.map((b) => b.device).sort(), ['Kitchen Sensor', 'Thermostat 1']);
  assert.ok(!m.batteries.low.some((b) => /iphone/i.test(b.device)), 'the phone at 12% is not a household battery');
  assert.ok(!model().batteries.low.length, '40% is fine');
});
test('24 an unreadable battery is unreadable, never low', () => {
  const m = model({ states: house({ 'sensor.thermostat_1_battery_level': st('sensor.thermostat_1_battery_level', 'unavailable', { device_class: 'battery' }, 10) }) });
  assert.equal(m.batteries.low.length, 0);
  assert.deepEqual(m.batteries.unreadable.map((b) => b.device), ['Thermostat 1']);
});
test('25 a device whose readings stopped is explicitly stale', () => {
  const m = model({ states: house({ 'sensor.motion_sensor_2_current_temperature': st('sensor.motion_sensor_2_current_temperature', '19.8', { device_class: 'temperature', unit_of_measurement: '°C' }, 3100), 'binary_sensor.motion_sensor_2': st('binary_sensor.motion_sensor_2', 'off', { device_class: 'motion' }, 3200) }) });
  assert.ok(m.devices.stale.some((d) => d.device === 'Motion Sensor 2'));
});

// ── hazards (26–30) ──────────────────────────────────────────────────────────
test('26 no smoke sensor => capability absent, not safe', () => {
  const m = model();
  assert.ok(m.hazards.categories.every((c) => c.capability === 'absent'));
  assert.equal(m.sourceHealth.find((s) => s.id === 'hazards').verdict, 'no-capability');
  assert.match(m.sourceHealth.find((s) => s.id === 'hazards').why, /absence is not safety/);
  assert.doesNotMatch(JSON.stringify(m.hazards), /all clear|"safe"/i);
});
const SMOKE_REG = regWith({ 'binary_sensor.hall_smoke': { area: 'Hall', device: 'Smoke alarm' } });
const smoke = (state) => ({ 'binary_sensor.hall_smoke': st('binary_sensor.hall_smoke', state, { device_class: 'smoke', friendly_name: 'Hall smoke alarm' }, 0) });
test('27 an authoritative smoke alarm escalates immediately to needs_you, once', () => {
  const m = model({ states: house(smoke('on')), registry: SMOKE_REG });
  const e = m.exceptions.find((x) => x.category === 'hazard');
  assert.ok(e); assert.equal(e.actionState, 'needs_you');
  const h = home.compose({ household: roster({ nick: 'home', helen: 'home', isaac: 'home' }), states: house(smoke('on')), intel: m });
  assert.equal(h.needsYou.filter((n) => /smoke/.test(n.title)).length, 1, 'one alarm, not two');
});
test('28 humidity can never become a smoke or leak alarm', () => {
  const m = model({ stats: rh([...RH_BASE, 99, 99, 99, 99]) });
  assert.ok(!m.exceptions.some((e) => e.category === 'hazard'));
  assert.equal(hi.classifyEntity(st('sensor.kitchen_sensor_humidity', '99', { device_class: 'humidity' }), {}).category, 'humidity');
});
test('29 a hazard sensor that cannot be reached stays explicit', () => {
  const m = model({ states: house(smoke('unavailable')), registry: SMOKE_REG });
  const smokeCat = m.hazards.categories.find((c) => c.id === 'smoke');
  assert.equal(smokeCat.capability, 'stale');
  assert.ok(m.exceptions.some((e) => e.key.startsWith('hazard-blind:smoke')));
});
test('30 no hazard capability is invented', () => {
  const m = model();
  assert.equal(m.hazards.categories.filter((c) => c.capability !== 'absent').length, 0);
  assert.ok(m.audit.gaps.includes('no smoke sensor'));
  assert.ok(m.audit.gaps.includes('no carbon monoxide sensor'));
});

// ── network (31–33) ──────────────────────────────────────────────────────────
const wan = (state, min) => ({ 'binary_sensor.rt_ac68u_wan_status': st('binary_sensor.rt_ac68u_wan_status', state, { device_class: 'connectivity', friendly_name: 'Router WAN status' }, min) });
test('31 an internet outage (router WAN down 10 min) surfaces', () => {
  assert.ok(keys(model({ states: house(wan('off', 10)) })).includes('network:wan-down'));
});
test('32 transient drops and client disappearances are ignored', () => {
  assert.ok(!keys(model({ states: house(wan('off', 2)) })).includes('network:wan-down'));
  const gone = model({ states: house({ 'device_tracker.redmi_note_15': st('device_tracker.redmi_note_15', 'not_home', {}, 1) }) });
  assert.equal(gone.exceptions.length, 0);
});
test('33 Home Assistant down is distinguished from internet down — and "not read yet" is neither', () => {
  const down = hi.compose({ states: null, registry: REG, now: NOW });
  assert.ok(keys(down).includes('source:ha-unreachable'));
  assert.ok(!keys(down).includes('network:wan-down'));
  assert.equal(down.network.ha, 'unreachable');
  const notRead = hi.compose({ states: null, registry: REG, haStatus: 'not-read', now: NOW });
  assert.equal(notRead.exceptions.length, 0);
  assert.equal(notRead.network.ha, 'not-read');
});

// ── appliances (34–37) ───────────────────────────────────────────────────────
test('34 a meaningful appliance state is accepted', () => {
  const s = st('sensor.washing_machine_state', 'running', { friendly_name: 'Washing machine' }, 5);
  assert.equal(hi.classifyEntity(s, {}).category, 'appliances');
  assert.equal(model({ states: [...house(), s] }).appliances.capability, 'present');
});
test('35 a random plug is not an appliance', () => {
  assert.equal(hi.classifyEntity(st('switch.kitchen_side_socket', 'on', { device_class: 'outlet' }), {}).category, 'plugs');
  assert.equal(model().appliances.capability, 'absent');
});
test('36 an appliance finishing creates nothing', () => {
  const m = model({ states: [...house(), st('sensor.washing_machine_state', 'finished', { friendly_name: 'Washing machine' }, 1)] });
  assert.equal(m.exceptions.length, 0);
});
test('37 an appliance’s own fault state surfaces', () => {
  const m = model({ states: [...house(), st('binary_sensor.dishwasher_problem', 'on', { device_class: 'problem', friendly_name: 'Dishwasher problem' }, 3)] });
  assert.ok(keys(m).includes('appliance:fault:Dishwasher problem'));
});

// ── exceptions (38–42) ───────────────────────────────────────────────────────
test('38 persistence is required: two hours below target is not three', () => {
  const m = model({ stats: belowStats(flatThen(81, 20.5, [18.0, 18.0]), Array(83).fill(20)) });
  assert.ok(!keys(m).includes('climate:below-target:Kitchen'));
});
test('39 a hazard bypasses ordinary persistence (0 minutes old)', () => {
  assert.ok(model({ states: house(smoke('on')), registry: SMOKE_REG }).exceptions.some((e) => e.category === 'hazard'));
});
test('40 a resolved exception clears — but a blind pass does not resolve it', () => {
  const opened = hi.trackExceptions(null, model({ states: house(wan('off', 10)) }).exceptions, { now: NOW });
  const cleared = hi.trackExceptions({ open: opened.open }, model().exceptions, { now: NOW + HOUR });
  assert.deepEqual(cleared.resolvedNow.map((e) => e.key), ['network:wan-down']);
  assert.equal(cleared.resolved[0].actionState, 'resolved');
  const blind = hi.trackExceptions({ open: opened.open }, [], { now: NOW + HOUR, blindCategories: new Set(['network']) });
  assert.equal(blind.resolvedNow.length, 0);
  assert.equal(blind.open['network:wan-down'].actionState, 'unknown');
  const blindModel = hi.compose({ states: null, registry: REG, held: { open: opened.open }, now: NOW + HOUR });
  assert.ok(blindModel.exceptions.some((e) => e.key === 'network:wan-down' && e.actionState === 'unknown'), 'HA down never reads as fixed');
});
test('41 duplicate evidence collapses to one exception', () => {
  const twoBatteries = { 'sensor.thermostat_1_battery_level': st('sensor.thermostat_1_battery_level', '10', { device_class: 'battery' }, 10),
    'sensor.thermostat_1_battery_state': st('sensor.thermostat_1_battery_state', 'low', {}, 10) };
  const m = model({ states: house(twoBatteries), registry: regWith({ 'sensor.thermostat_1_battery_state': { area: 'Hall', device: 'Thermostat 1' } }) });
  assert.equal(m.exceptions.filter((e) => e.key === 'device:battery:Thermostat 1').length, 1);
});
test('42 every exception carries what / where / since / evidence / confidence / persistence / why / actionability / state', () => {
  const m = model({ states: house({ ...wan('off', 10), ...door('on', 45), ...smoke('on') }), registry: { ...DOOR_REG, ...SMOKE_REG }, stats: belowStats(flatThen(80, 20.5, [18, 18, 18]), Array(83).fill(20)) });
  assert.ok(m.exceptions.length >= 4);
  for (const e of m.exceptions) {
    for (const k of ['key', 'category', 'what', 'where', 'evidence', 'confidence', 'persistence', 'whyItMatters', 'actionability', 'actionState']) assert.ok(e[k] !== undefined && e[k] !== '', `${e.key} has ${k}`);
    assert.ok('since' in e);
    assert.ok(Array.isArray(e.evidence) && e.evidence.length);
  }
});

// ── actionability (43–46) ────────────────────────────────────────────────────
test('43 context never becomes Needs You by itself', () => {
  const m = model({ stats: belowStats(flatThen(80, 20.5, [18, 18, 18]), Array(83).fill(20)) });
  assert.ok(m.exceptions.length);
  assert.equal(m.needsYou.length, 0);
  const h = home.compose({ household: roster({ nick: 'home', helen: 'home', isaac: 'home' }), states: house(), intel: m });
  assert.equal(h.needsYou.length, 0);
});
test('44 an explicit critical household fault may: door open with everyone away, the heating hub offline', () => {
  const doorEmpty = model({ states: house(door('on', 45)), registry: DOOR_REG, occupancy: { state: 'empty', why: 'all away' } });
  assert.ok(doorEmpty.needsYou.some((e) => e.key.startsWith('opening:open-long')));
  const hub = model({ states: house({ 'binary_sensor.hub_hive_hub_status': st('binary_sensor.hub_hive_hub_status', 'off', { device_class: 'connectivity', friendly_name: 'Hive hub' }, 40) }) });
  assert.ok(hub.needsYou.some((e) => e.key === 'heating:hub-offline'));
  const h = home.compose({ household: roster({ nick: 'away', helen: 'away', isaac: 'away' }), states: house(), intel: hub });
  assert.ok(h.needsYou.some((n) => n.id === 'heating:hub-offline'));
});
const src = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
test('45 no new notification policy: nothing here can push', () => {
  for (const f of ['home-intelligence.js', 'home.js']) {
    assert.doesNotMatch(src(f), /sendToAll|webpush|ambient-push|notification-policy|pushNotification/, f);
  }
  assert.match(src('ambient-push.js'), /worthInterrupting/, 'positive control: the scan reads real code');
});
test('46 no autonomous home control is introduced', () => {
  const s = src('home-intelligence.js');
  assert.doesNotMatch(s, /\/api\/services|haService|turnOnLights|setClimateTarget|ha-rooms/);
  assert.equal((s.match(/method: 'POST'/g) || []).length, 1, 'the only POST is the read-only template render');
  assert.match(s, /\/api\/template/);
  assert.match(src('ha-rooms.js'), /\/api\/services/, 'positive control: the one write door exists elsewhere');
});

// ── privacy (47–50) ──────────────────────────────────────────────────────────
const db = require('../db/database');
test('scratch DB', async () => {
  await db.init();
  assert.equal(path.resolve(process.env.NEURO_DB_PATH).startsWith(path.resolve(SCRATCH)), true, 'the scratch DB is the one in use');
});
const counts =() => Object.fromEntries(db.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").map((t) => [t.name, db.get(`SELECT COUNT(*) AS n FROM "${t.name}"`).n]));
const refreshDeps = (states, extra = {}) => ({
  ha: { fetchStates: async () => states },
  readRegistry: async () => REG,
  readStatistics: async (ids) => Object.fromEntries(ids.map((id) => [id, hours(Array(30).fill(20))])),
  readBoilerHistory: async () => [{ state: 'off', last_changed: iso(200) }, { state: 'on', last_changed: iso(150) }, { state: 'off', last_changed: iso(140) }],
  ...extra,
});
test('47 a refresh stores no room movement, presence or people — only climate and the open exceptions', async () => {
  const before = counts();
  await hi.refresh({ now: NOW, occupancy: OCC, deps: refreshDeps(house()) });
  const after = counts();
  for (const [t, n] of Object.entries(after)) if (t !== 'agent_state') assert.equal(n, before[t] || 0, `${t} unchanged`);
  const stored = (db.getState(hi.INPUTS_KEY) || '') + (db.getState(hi.STATE_KEY) || '');
  assert.ok(stored.length > 100, 'positive control: something was stored');
  // The boiler's on/off history IS stored (heating evidence, ~8 days). Nothing about a person is.
  assert.doesNotMatch(stored, /"study"|nickHere|"presence"|"motion":|"state":"home"|"state":"not_home"|"who"/);
  const inputs = JSON.parse(db.getState(hi.INPUTS_KEY));
  assert.ok(inputs.boilerHistory.every((r) => ['on', 'off'].includes(r.state)), 'only the boiler call-for-heat history');
});
test('47b the real registry reader keeps no people, trackers, room classifier or phone', async () => {
  const realFetch = global.fetch;
  process.env.HA_URL = 'http://ha.test:8123'; process.env.HA_TOKEN = 'tok';
  global.fetch = async () => ({ ok: true, text: async () => JSON.stringify([['person.nick', '', '', ''], ['device_tracker.redmi_note_15', '', '', ''], ['sensor.nick_room', '', '', ''], ['sensor.nicks_iphone_steps', '', 'Nicks iPhone', 'Apple'], ['climate.kitchen_rad', 'Kitchen', 'Kitchen Rad', 'Danfoss']]) });
  try {
    assert.deepEqual(Object.keys(await hi.readRegistry()), ['climate.kitchen_rad']);
  } finally { global.fetch = realFetch; process.env.HA_URL = 'http://127.0.0.1:9'; process.env.HA_TOKEN = ''; }
});
test('48 no route or location is stored', () => {
  const stored = (db.getState(hi.INPUTS_KEY) || '') + (db.getState(hi.STATE_KEY) || '');
  assert.doesNotMatch(stored, /latitude|longitude|gps|geocoded|zone\./i);
  const statIds = Object.keys(JSON.parse(db.getState(hi.INPUTS_KEY)).stats);
  assert.ok(statIds.every((id) => /temperature|humidity/.test(id)), statIds.join(','));
});
test('49 a visitor at home is not turned into a resident', () => {
  const h = home.compose({ household: roster({ nick: 'away', helen: 'away', isaac: 'away', lizzy: 'home' }), states: house(), intel: model() });
  assert.deepEqual(h.occupancy.residentsHome, []);
  assert.deepEqual(h.occupancy.visitorsHome, ['Lizzy']);
});
test('50 reading Home state writes nothing (no surveillance log)', async () => {
  const before = counts();
  const stateBefore = db.getState(hi.STATE_KEY);
  hi.readWith({ states: house(), occupancy: OCC, now: NOW + 5 * HOUR });
  await home.read({ now: NOW, states: house() });
  assert.deepEqual(counts(), before);
  assert.equal(db.getState(hi.STATE_KEY), stateBefore);
});

// ── the rest: units, audit, heating runs, divergence, wiring ────────────────
test('units are read per entity: a declared °F converts, an undeclared 68 is refused', () => {
  assert.equal(hi.toCelsius(68, '°F'), 20);
  assert.equal(hi.toCelsius(20.5, '°C'), 20.5);
  assert.equal(hi.toCelsius(68, ''), null);
  const m = model({ states: house({ 'sensor.office_sensor_temperature': st('sensor.office_sensor_temperature', '72.0', { device_class: 'temperature', unit_of_measurement: '°F' }, 5) }) });
  assert.equal(m.rooms.find((r) => r.area === 'Office').temperature.c, 22.2);
});
test('the audit reduces entities to household concepts and names the noise', () => {
  const a = model().audit;
  assert.equal(a.total, house().length);
  assert.equal(a.byCategory.phone, 1);
  assert.ok(a.noisy.some((n) => /router/.test(n.why)));
  assert.ok(a.roles.inference > 10);
  assert.equal(model().rooms.some((r) => r.area === 'Living Room'), false, 'an area holding only a TV is not a room in the model');
});
test('the boiler running far beyond its own week is a heating exception; an ordinary run is not', () => {
  const series = []; let t = NOW - 7 * 24 * HOUR;
  for (let i = 0; i < 30; i++) { series.push({ state: 'on', last_changed: new Date(t).toISOString() }); series.push({ state: 'off', last_changed: new Date(t + (i === 0 ? 55 : 10) * MIN).toISOString() }); t += 4 * HOUR; }
  const firingNow = (runMin) => ({ 'climate.thermostat_1': st('climate.thermostat_1', 'heat', { current_temperature: 19, temperature: 25, hvac_action: 'heating' }, 1) , 'binary_sensor.thermostat_1_state': st('binary_sensor.thermostat_1_state', 'on', {}, runMin) });
  const long = model({ states: house(firingNow(80)), boilerHistory: [...series, { state: 'on', last_changed: iso(80) }] });
  assert.equal(long.heating.runs.longestMinutes, 55);
  assert.ok(keys(long).includes('heating:long-run'));
  const ordinary = model({ states: house(firingNow(65)), boilerHistory: [...series, { state: 'on', last_changed: iso(65) }] });
  assert.ok(!keys(ordinary).includes('heating:long-run'), '65 min is under 1.25× the week’s longest (55)');
  assert.ok(hi.ACTIVITY_CATEGORIES.has('heating'));
});
test('a room drifting from the rest of the house, against its own usual offset, is context with weather attached', () => {
  const n = 100;
  const stats = {
    'sensor.kitchen_sensor_temperature': hours([...Array(n - 3).fill(21), 16, 16, 16]),
    'sensor.office_sensor_temperature': hours(Array(n).fill(22)),
    'sensor.motion_sensor_2_current_temperature': hours(Array(n).fill(20)),
    'sensor.weather_station_temperature': hours([...Array(n - 3).fill(13), 8, 8, 8]),
  };
  const states = house({ 'sensor.weather_station_temperature': st('sensor.weather_station_temperature', '8', { device_class: 'temperature', unit_of_measurement: '°C' }, 1) });
  const e = model({ states, stats }).exceptions.find((x) => x.key === 'climate:diverging:Kitchen');
  assert.ok(e);
  assert.match(e.what, /colder than usual/);
  assert.match(e.context || '', /colder outside/);
});

test('refresh with NO injected reader reaches HA through fetch + WebSocket (the real defaults)', async () => {
  const realFetch = global.fetch; const realWS = global.WebSocket;
  process.env.HA_URL = 'http://ha.test:8123'; process.env.HA_TOKEN = 'tok';
  db.setState(hi.INPUTS_KEY, 'null'); // no cached registry: the real reader must run
  const calls = [];
  global.fetch = async (url, opts = {}) => {
    calls.push(String(url));
    if (/\/api\/states$/.test(url)) return { ok: true, json: async () => house() };
    if (/\/api\/template$/.test(url)) return { ok: true, text: async () => JSON.stringify(Object.entries(REG).map(([id, r]) => [id, r.area || '', r.device || '', ''])) };
    if (/\/api\/history\/period\//.test(url)) { assert.match(url, /end_time=/, 'end_time is sent'); return { ok: true, json: async () => [[{ state: 'off', last_changed: iso(100) }]] }; }
    throw new Error('unexpected ' + url);
  };
  global.WebSocket = class {
    constructor(u) { this.u = u; setImmediate(() => this.onmessage({ data: JSON.stringify({ type: 'auth_required' }) })); }
    send(m) {
      const d = JSON.parse(m);
      if (d.type === 'auth') setImmediate(() => this.onmessage({ data: JSON.stringify({ type: 'auth_ok' }) }));
      else setImmediate(() => this.onmessage({ data: JSON.stringify({ id: 1, success: true, result: Object.fromEntries(d.statistic_ids.map((id) => [id, hours([20, 20.1])])) }) }));
    }
    close() {}
  };
  try {
    const realHa = require('./ha');
    const r = await hi.refresh({ now: NOW + 2 * HOUR, occupancy: OCC, deps: { ha: { fetchStates: async () => (await global.fetch('http://ha.test:8123/api/states')).json() } } });
    assert.equal(typeof realHa.fetchStates, 'function', 'the real ha.fetchStates is exported');
    assert.equal(r.gaps.length, 0, JSON.stringify(r.gaps));
    assert.ok(calls.some((u) => /api\/template/.test(u)), 'the registry was read through the real readRegistry');
    assert.ok(calls.some((u) => /api\/history/.test(u)), 'the boiler history was read through the real readBoilerHistory');
    const stored = JSON.parse(db.getState(hi.INPUTS_KEY));
    assert.ok(Object.keys(stored.stats).length >= 5, 'statistics arrived over the websocket');
    assert.equal(stored.boilerHistory.length, 1);
  } finally { global.fetch = realFetch; global.WebSocket = realWS; process.env.HA_URL = 'http://127.0.0.1:9'; process.env.HA_TOKEN = ''; }
});

test('home.refresh logs heating/network/source exceptions to Activity and nothing else, after a baseline', async () => {
  db.run('DELETE FROM personal_ops_events');
  db.setState(hi.STATE_KEY, JSON.stringify({ open: {}, resolved: [] }));
  // Drive the intel pass through home.refresh with the real wiring but a stubbed HA module.
  const ha = require('./ha');
  const realFetchStates = ha.fetchStates;
  const states = house({ ...wan('off', 10), ...door('on', 45) });
  ha.fetchStates = async () => states;
  const realRefresh = hi.refresh;
  hi.refresh = (o) => realRefresh({ ...o, deps: refreshDeps(states, { readRegistry: async () => DOOR_REG }) });
  try {
    await home.refresh({ now: NOW });
    const kinds = db.all('SELECT kind, detail_json FROM personal_ops_events').map((r) => [r.kind, JSON.parse(r.detail_json).category]);
    assert.ok(kinds.some(([k, c]) => k === 'home-exception-opened' && c === 'network'), JSON.stringify(kinds));
    assert.ok(!kinds.some(([, c]) => c === 'opening'), 'a door never reaches Activity');
  } finally { ha.fetchStates = realFetchStates; hi.refresh = realRefresh; }
  const entries = require('./activity-timeline').fromPersonalOps(db.all('SELECT * FROM personal_ops_events')).filter(Boolean);
  const wanLine = entries.find((e) => /internet link down/.test(e.headline));
  assert.ok(wanLine, JSON.stringify(entries.map((e) => e.headline)));
  assert.equal(wanLine.type, 'home.network');
});

test('GET /api/household/home answers over real HTTP with HA unreachable: unknown, never fine', async () => {
  const express = require('express');
  const app = express();
  app.use('/api/household', require('../routes/household'));
  const server = app.listen(0);
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api/household/home`);
    const j = await r.json();
    assert.equal(r.status, 200);
    assert.equal(j.intelligence, 'home-intel-v1');
    assert.equal(j.known, false);
    assert.ok(j.exceptions.some((e) => e.key === 'source:ha-unreachable'));
    assert.equal(j.hazards.categories[0].capability, 'unknown');
  } finally { server.close(); }
});

test('Now carries home only as context, with relevance said', () => {
  const s = fs.readFileSync(path.join(__dirname, 'canonical-read.js'), 'utf8');
  assert.match(s, /relevant: h\.needsYou\.length > 0 \|\| \(h\.exceptions \|\| \[\]\)\.length > 0/);
  assert.doesNotMatch(s.slice(s.indexOf('payload.home = {'), s.indexOf('payload.home = {') + 1200), /temperature|rooms:/);
});

test('the Life → Home view renders exceptions, rooms on a fold, hazard absence, and no entity ids', async () => {
  const React = require('react');
  const { renderToString } = require('react-dom/server');
  const esbuild = require('esbuild');
  const out = await esbuild.build({
    entryPoints: [path.join(__dirname, '..', '..', 'frontend', 'src', 'components', 'canonical', 'HomeCard.jsx')],
    bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic', external: ['react', 'react-dom'], logLevel: 'silent',
    plugins: [{ name: 'stub', setup(b) {
      b.onResolve({ filter: /\.css$/ }, (a) => ({ path: a.path, namespace: 'css' }));
      b.onLoad({ filter: /.*/, namespace: 'css' }, () => ({ contents: '', loader: 'js' }));
      b.onResolve({ filter: /(^|\/)api$/ }, () => ({ path: 'api', namespace: 'stub' }));
      b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const apiFetch = async () => ({ ok: true, json: async () => ({}) });', loader: 'js' }));
    } }],
  });
  const m = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(m, m.exports, require);
  const intel = model({ states: house(wan('off', 10)) });
  const data = home.compose({ household: roster({ nick: 'home', helen: 'home', isaac: 'away' }), states: house(wan('off', 10)), intel });
  const html = renderToString(React.createElement(m.exports.HomeView, { data }));
  assert.match(html, /Unusual at home/);
  assert.match(html, /router reports its internet link down/);
  assert.match(html, /Kitchen/);
  assert.match(html, /no sensor — not the same as safe/);
  assert.match(html, /Heating is idle/);
  assert.doesNotMatch(html, /sensor\.|binary_sensor\.|climate\./, 'no entity id reaches the screen');
  const quiet = renderToString(React.createElement(m.exports.HomeView, { data: home.compose({ household: roster({ nick: 'home', helen: 'home', isaac: 'home' }), states: house(), intel: model() }) }));
  assert.match(quiet, /Nothing unusual that NEURO can see/);
  const blind = renderToString(React.createElement(m.exports.HomeView, { data: home.compose({ household: { known: false }, states: null, intel: hi.compose({ states: null, now: NOW }) }) }));
  assert.match(blind, /unknown, not fine/);
});
