'use strict';

/**
 * Build 18 — the server half of native proof and personal-data integrity:
 * build identity (X-Neuro-Build), capability assessment, visits/geofence as
 * capabilities of location, calendar coverage, personal-date confidence,
 * conflicts, explicit date editing and deletion that stays deleted.
 *
 * ⚠ None of this proves anything about a phone. These tests pin what the
 * SERVER does with what a phone sends; the native half is proven only on the
 * real device (see the Build 18 vault note).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-b18-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'b18.db');
process.env.NEURO_TIMEZONE = 'Europe/London';
const vault = path.join(tmp, 'vault');
fs.mkdirSync(path.join(vault, 'People'), { recursive: true });
fs.mkdirSync(path.join(vault, 'Companions'), { recursive: true });
process.env.OBSIDIAN_VAULT_PATH = vault;

const db = require('../db/database');
const nb = require('./native-build');
const place = require('./place-sensing');
const apple = require('./apple-ingest');
const pd = require('./personal-dates');
const setup = require('./setup-check');
const tl = require('./activity-timeline');

test.before(async () => { await db.init(); });

const NOW = Date.parse('2026-10-07T09:00:00Z');
const B18 = 'v=1.18;b=181;c=ABCDEF1234;p=18;cap=durable-location-queue,place-visits,geofence,device-status,workout-route-summary,calendar-window-60d,build-report';

// ── 18D: the header ─────────────────────────────────────────────────────────

test('1. build ID: a full header parses, commit lower-cased, caps sorted and bounded', () => {
  const b = nb.parseBuildHeader(B18);
  assert.equal(b.version, '1.18');
  assert.equal(b.build, '181');
  assert.equal(b.commit, 'abcdef1234');
  assert.equal(b.protocol, 18);
  assert.deepEqual(b.capabilities, [...b.capabilities].sort());
  assert.ok(b.capabilities.includes('workout-route-summary'));
});

test('1c. a build from uncommitted changes never passes for the clean commit', () => {
  const dirty = nb.parseBuildHeader('v=0.1;b=900;c=dbf53da;d=1');
  const clean = nb.parseBuildHeader('v=0.1;b=900;c=dbf53da');
  assert.equal(dirty.dirty, true);
  assert.notEqual(nb.buildKey('neuro-ios', dirty), nb.buildKey('neuro-ios', clean));
  assert.equal(nb.label(dirty), '0.1 (900) · dbf53da + uncommitted changes');
  assert.equal(nb.label(clean), '0.1 (900) · dbf53da');
});

test('1b. nothing about the device survives the parse — unknown keys dropped, junk refused', () => {
  const b = nb.parseBuildHeader('v=1.0;b=2;device=Nicks iPhone;serial=F2LXYZ;c=not-hex!;p=abc;cap=Bad Cap,ok-cap');
  assert.equal(b.commit, null, 'a non-hex commit is dropped, not kept');
  assert.equal(b.protocol, null);
  assert.deepEqual(b.capabilities, ['ok-cap']);
  assert.ok(!JSON.stringify(b).includes('Nicks iPhone'));
  assert.ok(!JSON.stringify(b).includes('F2LXYZ'));
  assert.equal(nb.parseBuildHeader('cap=x'), null, 'no version and no build = no build, never a half-object');
  assert.equal(nb.parseBuildHeader(''), null);
  assert.equal(nb.parseBuildHeader(undefined), null);
});

test('2. build ID reaches the store through the middleware, keyed by X-Neuro-Client, only once per 10 min', () => {
  nb._reset();
  const req = { headers: { 'x-neuro-client': 'neuro-ios', 'x-neuro-build': B18 } };
  let nexted = 0;
  nb.middleware(req, {}, () => { nexted += 1; });
  nb.middleware(req, {}, () => { nexted += 1; });
  assert.equal(nexted, 2, 'the middleware never blocks');
  const cur = nb.current();
  assert.equal(cur['neuro-ios'].build, '181');
  assert.equal(cur['neuro-ios'].label, '1.18 (181) · abcdef1');
  assert.equal(db.all('SELECT * FROM native_builds').length, 1);
  // No client header → nothing recorded (an unidentified build is not planted under a guess).
  nb.middleware({ headers: { 'x-neuro-build': 'v=9;b=9' } }, {}, () => {});
  assert.equal(db.all('SELECT * FROM native_builds').length, 1);
});

test('2b. a broken store never fails the request', () => {
  let called = false;
  nb.middleware({ headers: { 'x-neuro-client': 'neuro-ios', 'x-neuro-build': { not: 'a string' } } }, {}, () => { called = true; });
  assert.equal(called, true);
});

// ── 18U: capability assessment ──────────────────────────────────────────────

test('35. old-build warning: a reported build missing a capability is "old" and says what it predates', () => {
  const old = nb.parseBuildHeader('v=1.16;b=160;p=16;cap=durable-location-queue,place-visits,geofence,device-status');
  const a = nb.assessSource('healthkit.saim-ios', old);
  assert.equal(a.state, 'old');
  assert.deepEqual(a.missing, ['workout-route-summary']);
  assert.match(a.line, /predates: sends a GPS route SUMMARY/);
  assert.equal(nb.assessSource('location.neuro-ios', old).state, 'current');
});

test('35b. NO header is "unknown" (cannot confirm), never "old" (lacks)', () => {
  const a = nb.assessSource('location.neuro-ios', null);
  assert.equal(a.state, 'unknown');
  assert.match(a.line, /can't confirm/);
  assert.equal(nb.assessSource('microsoft.calendar', null).state, 'n/a');
});

// ── 18T: visits / geofence are capabilities of location, never stale ────────

test('33. visit capability: quiet != stale — a month without a visit is proven-quiet, not a fault', () => {
  const b = nb.parseBuildHeader(B18);
  const quiet = place.placeCapabilityState({ capability: 'place-visits', build: b, lastEventAt: '2026-09-01T10:00:00Z', parentVerdict: 'seeing', now: NOW });
  assert.equal(quiet.state, 'proven-quiet');
  assert.match(quiet.line, /quiet is normal, not a fault/);
  assert.equal(place.placeCapabilityState({ capability: 'place-visits', build: b, lastEventAt: '2026-10-06T10:00:00Z', now: NOW }).state, 'proven');
});

test('34. geofence capability: never seen = unproven; a build without it = unavailable; a dead parent is pointed at, not judged', () => {
  const b = nb.parseBuildHeader(B18);
  assert.equal(place.placeCapabilityState({ capability: 'geofence', build: b, lastEventAt: null, now: NOW }).state, 'unproven');
  assert.equal(place.placeCapabilityState({ capability: 'geofence', build: null, lastEventAt: null, now: NOW }).state, 'unproven');
  const noGeo = nb.parseBuildHeader('v=1;b=1;cap=place-visits');
  assert.equal(place.placeCapabilityState({ capability: 'geofence', build: noGeo, lastEventAt: null, now: NOW }).state, 'unavailable');
  assert.equal(place.placeCapabilityState({ capability: 'geofence', build: b, lastEventAt: '2026-09-01T00:00:00Z', parentVerdict: 'stale', now: NOW }).state, 'parent-stale');
});

test('34b. the reader sees stored visits and region events (no new source rows are invented)', () => {
  db.run(`INSERT INTO device_visits (device_id, visit_key, lat, lng, arrival_tst, received_at) VALUES ('neuro-ios', 'v:a:1', 1, 1, 1, '2026-10-06 08:00:00')`);
  const caps = place.placeCapabilities({ build: nb.parseBuildHeader(B18), parentVerdict: 'seeing', now: NOW });
  assert.equal(caps.parent, 'location.neuro-ios');
  assert.equal(caps.visits.state, 'proven');
  assert.equal(caps.geofence.state, 'unproven');
});

// ── 18M/N: calendar coverage ────────────────────────────────────────────────

test('19–21. coverage counts per calendar, including recurring occurrences and all-day events', () => {
  const at = '2026-10-07T09:00:00.000Z';
  const cov = apple.coverageOf({
    from: '2026-10-06T09:00:00Z', to: '2026-12-06T09:00:00Z', at,
    calendars: [{ id: 'c-home', title: 'Home', type: 'caldav' }, { id: 'c-bd', title: 'Birthdays', type: 'birthday' }, { id: 'c-empty', title: 'Open Uni', type: 'caldav' }],
    events: [
      { calendarId: 'c-home', calendar: 'Home', isAllDay: false, recurring: true },
      { calendarId: 'c-home', calendar: 'Home', isAllDay: false, recurring: true },
      { calendarId: 'c-bd', calendar: 'Birthdays', isAllDay: true, recurring: true },
    ],
  });
  assert.equal(cov.aheadDays, 60);
  assert.equal(cov.backDays, 1);
  const home = cov.perCalendar.find((c) => c.id === 'c-home');
  assert.deepEqual([home.events, home.recurring, home.allDay], [2, 2, 0]);
  const bd = cov.perCalendar.find((c) => c.id === 'c-bd');
  assert.deepEqual([bd.events, bd.allDay, bd.type], [1, 1, 'birthday']);
  assert.equal(cov.perCalendar.find((c) => c.id === 'c-empty').events, 0, 'an empty calendar is a 0 in this window, still listed');
});

test('19b. a real push records coverage per app; the audit lists every calendar with its classification and keep-state', () => {
  const r = apple.ingestCalendar({
    from: '2026-10-06T09:00:00Z', to: '2026-12-06T09:00:00Z', client: 'saim',
    calendars: [{ id: 'c-home', title: 'Home', type: 'caldav' }, { id: 'c-hol', title: 'UK Holidays', type: 'subscription' }],
    events: [{ id: 'e1', title: 'Dentist', start: '2026-10-10T09:00:00Z', end: '2026-10-10T10:00:00Z', isAllDay: false, calendar: 'Home', calendarId: 'c-home', recurring: false }],
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  const audit = apple.calendarCoverage({ now: NOW });
  const saim = audit.clients.find((c) => c.client === 'saim');
  assert.ok(saim, JSON.stringify(audit));
  assert.equal(saim.aheadDays >= 59, true);
  assert.equal(saim.calendars.find((c) => c.id === 'c-home').events, 1);
  assert.ok(audit.policy.recurring && audit.policy.deleted && audit.policy.hidden, 'the policy is stated, not left in two codebases');
});

// ── 18P: personal-date confidence follows source coverage ───────────────────

test('24/25. thin or stale coverage lowers completeness, with the reason named', () => {
  const v14 = pd.coverageVerdict({ calendar: [{ client: 'saim', fresh: true, aheadDays: 14, birthdays: 'seen' }], neededAhead: 30 });
  assert.equal(v14.state, 'partial');
  assert.equal(v14.heading, pd.HEADING_PARTIAL);
  assert.match(v14.reasons.join(' '), /only sends 14 days ahead/);

  const stale = pd.coverageVerdict({ calendar: [{ client: 'saim', fresh: false, aheadDays: 60, birthdays: 'seen' }], neededAhead: 14 });
  assert.equal(stale.state, 'partial');
  assert.match(stale.reasons.join(' '), /has not pushed recently/);

  const noBd = pd.coverageVerdict({ calendar: [{ client: 'saim', fresh: true, aheadDays: 60, birthdays: 'not-visible' }], neededAhead: 14 });
  assert.match(noBd.reasons.join(' '), /not showing NEURO a Birthdays calendar/);

  assert.equal(pd.coverageVerdict({ calendar: [], neededAhead: 14 }).state, 'unknown');

  // Positive control: everything seen in full → the complete heading.
  const full = pd.coverageVerdict({ calendar: [{ client: 'saim', fresh: true, aheadDays: 60, birthdays: 'seen' }], neededAhead: 30 });
  assert.equal(full.state, 'complete');
  assert.equal(full.heading, pd.HEADING_COMPLETE);
});

// ── 18S/R: conflicts and dedupe ─────────────────────────────────────────────

const sight = (date, basis, person = 'Helen Ward') => ({ title: `${person}'s birthday`, date, kind: 'birthday', person, source: { basis } });

test('31. an exact duplicate (same day, kind, FULL name) merges with both sources kept', () => {
  const d = pd.markConflicts(pd.dedupe([sight('2026-11-02', 'declared'), sight('2026-11-02', 'birthdays-calendar')]));
  assert.equal(d.length, 1);
  assert.equal(d[0].merged, true);
  assert.deepEqual(d[0].sources.map((s) => s.basis), ['declared', 'birthdays-calendar']);
  assert.equal(d[0].conflict, undefined);
});

test('30. conflicting sources do not silently overwrite — both stay, both marked', () => {
  const d = pd.markConflicts(pd.dedupe([sight('2026-11-02', 'declared'), sight('2026-11-03', 'birthdays-calendar')]));
  assert.equal(d.length, 2);
  for (const x of d) assert.match(x.conflict.note, /disagree.*has not picked one/);
});

test('32. a weak duplicate (first name only) stays separate and is NOT called a conflict', () => {
  const d = pd.markConflicts(pd.dedupe([sight('2026-11-02', 'title-label', 'Helen'), sight('2026-11-03', 'title-label', 'Helen')]));
  assert.equal(d.length, 2);
  assert.ok(d.every((x) => !x.conflict), 'a first name cannot make two dates one person');
});

// ── 18Q: explicit editing ───────────────────────────────────────────────────

function note(dir, name, fm) {
  fs.writeFileSync(path.join(vault, dir, `${name}.md`), `---\n${fm}\n---\n\n# ${name}\n`, 'utf8');
}

test('parse: YYYY-MM-DD and MM-DD only; real dates only; 29 Feb without a year is allowed', () => {
  assert.equal(pd.parseDeclaredDate('1990-10-16').value, '1990-10-16');
  assert.equal(pd.parseDeclaredDate('10-16').value, '10-16');
  assert.equal(pd.parseDeclaredDate('02-29').ok, true);
  assert.equal(pd.parseDeclaredDate('2023-02-29').ok, false);
  assert.equal(pd.parseDeclaredDate('16/10/1990').ok, false);
  assert.equal(pd.parseDeclaredDate('next tuesday').ok, false);
});

test('26–29. add, edit and remove a birthday; other frontmatter (lists included) is untouched', () => {
  note('People', 'Helen Ward', 'type: person\naliases:\n  - Helen\n  - H\nrelationship: partner');
  const add = pd.setDeclared({ entity: 'People/Helen Ward', kind: 'birthday', date: '1980-11-02' }, { now: NOW });
  assert.equal(add.ok, true); assert.equal(add.changed, true); assert.equal(add.previous, null);
  let text = fs.readFileSync(path.join(vault, 'People', 'Helen Ward.md'), 'utf8');
  assert.match(text, /^birthday: "1980-11-02"$/m);
  assert.match(text, /aliases:\n {2}- Helen\n {2}- H/, 'the aliases list survives');

  const same = pd.setDeclared({ entity: 'People/Helen Ward', kind: 'birthday', date: '1980-11-02' }, { now: NOW });
  assert.equal(same.changed, false, 'no write, no event, when nothing changes');

  const edit = pd.setDeclared({ entity: 'People/Helen Ward', kind: 'birthday', date: '11-03' }, { now: NOW + 1000 });
  assert.equal(edit.previous, '1980-11-02'); assert.equal(edit.value, '11-03');

  const ann = pd.setDeclared({ entity: 'People/Helen Ward', kind: 'anniversary', date: '2009-10-19' }, { now: NOW + 2000 });
  assert.equal(ann.ok, true);

  const rm = pd.setDeclared({ entity: 'People/Helen Ward', kind: 'birthday', date: null }, { now: NOW + 3000 });
  assert.equal(rm.changed, true);
  text = fs.readFileSync(path.join(vault, 'People', 'Helen Ward.md'), 'utf8');
  assert.doesNotMatch(text, /^birthday:/m, 'the LINE is removed, not blanked');
  assert.match(text, /^anniversary: "2009-10-19"$/m);
  const kinds = db.all("SELECT kind, actor FROM personal_date_events WHERE date_id LIKE 'declared:People/Helen Ward:%' ORDER BY id").map((r) => `${r.kind}/${r.actor}`);
  assert.deepEqual(kinds, ['declared-set/nick', 'declared-set/nick', 'declared-set/nick', 'declared-removed/nick']);
});

test('27b. a companion takes an explicit date; nothing creates a person or a note', () => {
  note('Companions', 'Ember', 'type: pet');
  assert.equal(pd.setDeclared({ entity: 'Companions/Ember', kind: 'birthday', date: '2021-05-04' }).ok, true);
  const missing = pd.setDeclared({ entity: 'People/Nobody Here', kind: 'birthday', date: '01-01' });
  assert.equal(missing.status, 404);
  assert.equal(fs.existsSync(path.join(vault, 'People', 'Nobody Here.md')), false);
  for (const bad of ['People/../secret', 'Personal/Someone', 'People/_about', 'People/a/b']) {
    assert.equal(pd.setDeclared({ entity: bad, kind: 'birthday', date: '01-01' }).status, 400, bad);
  }
  assert.equal(pd.setDeclared({ entity: 'Companions/Ember', kind: 'nameday', date: '01-01' }).status, 400);
  const ents = pd.declaredEntities();
  assert.equal(ents.entities.find((e) => e.entity === 'Companions/Ember').birthday, '2021-05-04');
});

// ── 18O: deletion stays deletion ────────────────────────────────────────────

function meeting(id, title, startLocal, { calendar = 'Birthdays', status = 'scheduled' } = {}) {
  db.run(`INSERT INTO wm_meetings (meeting_id, provider, provider_event_id, title, start_local, end_local, is_all_day, status, kind, provenance_kind, confidence,
            observed_at, received_at, evidence_json, fingerprint, updated_at, calendar_name, calendar_key)
          VALUES (?, 'apple', ?, ?, ?, ?, 1, ?, 'unknown', 'observation', 1, 'x', 'x', '[]', ?, 'x', ?, ?)`,
  [id, id, title, startLocal, `${startLocal.slice(0, 10)}T23:59`, status, id, calendar, `eventkit-cal:id:${calendar}`]);
}
const FULL = { state: 'complete', heading: pd.HEADING_COMPLETE, reasons: [] };

test('22/23. an event Nick deleted from the phone is gone, is not a failure, and is not recreated from history', () => {
  meeting('m-gone', 'Sam Jones', '2026-10-09T00:00', { status: 'removed' });
  meeting('m-kept', 'Pat Smith', '2026-10-10T00:00');
  // History of the deleted date exists in the append-only log …
  db.run(`INSERT INTO personal_date_events (date_id, kind, dedupe_key, actor, at, detail_json) VALUES ('pd:birthday:sam jones:2026-10-09', 'action-window', 'k-gone', 'neuro', 'x', '{}')`);
  const r = pd.read({ now: NOW, tasks: [], deps: { coverage: FULL } });
  const all = [...r.active, ...r.later];
  assert.ok(all.some((d) => d.person === 'Pat Smith'), 'positive control: a kept date is listed');
  assert.ok(!all.some((d) => d.person === 'Sam Jones'), '… but the deleted date is not brought back');
  assert.ok(!r.gaps.some((g) => /calendar/.test(g.input)), 'a disappearance is not a source failure');
});

test('29b. a removed declared date stays removed even though its history remains', () => {
  const r = pd.read({ now: NOW, tasks: [], deps: { coverage: FULL } });
  assert.ok(!r.later.concat(r.active).some((d) => d.person === 'Helen Ward' && d.kind === 'birthday'));
  assert.ok(r.later.concat(r.active).some((d) => d.person === 'Helen Ward' && d.kind === 'anniversary'), 'positive control');
  assert.equal(r.heading, pd.HEADING_COMPLETE);
});

// ── Setup and Activity ──────────────────────────────────────────────────────

function baseSnapshot(extra = {}) {
  return { microsoft: { configured: true, authenticated: true }, sources: [], reports: [], desktopHosts: [], clients: {}, ...extra };
}
const item = (r, id) => r.items.find((i) => i.id === id);

test('Setup: an unknown build is said ONCE on the build item; senses are not turned amber for it', () => {
  const src = { sourceId: 'healthkit.neuro-ios', verdict: 'seeing', transport: { lastSuccessAt: '2026-10-07T08:00:00Z' } };
  const native = nb.status({ sources: [src] });
  // The scratch DB has neuro-ios recorded from test 2 — use a status for an app with no build instead.
  const noBuild = { apps: native.apps.map((a) => ({ ...a, build: null, sources: a.sources.map((s) => ({ ...s, ...nb.assessSource(s.sourceId, null) })) })) };
  const r = setup.assess(baseSnapshot({ sources: [src], native: noBuild }), { now: NOW });
  assert.equal(item(r, 'iphone-neuro.health').status, 'done');
  assert.notEqual(item(r, 'iphone-neuro.build').status, 'done');
});

test('Setup: a KNOWN build that lacks a capability turns the sense to attention and says why', () => {
  const src = { sourceId: 'healthkit.saim-ios', verdict: 'seeing', transport: { lastSuccessAt: '2026-10-07T08:00:00Z' } };
  const old = nb.parseBuildHeader('v=1.16;b=160;cap=device-status');
  const native = { apps: [{ client: 'saim-ios', build: { ...old, label: nb.label(old), firstSeenAt: 'x', lastSeenAt: 'x' }, line: 'SAiM iOS 1.16 (160)', sources: ['healthkit.saim-ios', 'device.saim-ios', 'eventkit.saim-ios'].map((id) => ({ sourceId: id, ...nb.assessSource(id, old) })) }] };
  const r = setup.assess(baseSnapshot({ sources: [src], native }), { now: NOW });
  assert.equal(item(r, 'iphone-saim.health').status, 'attention');
  assert.match(item(r, 'iphone-saim.health').evidence, /predates: sends a GPS route SUMMARY/);
  assert.equal(item(r, 'iphone-saim.build').status, 'attention');
});

test('14. route permission is honest: asked ≠ allowed; only a route arriving is "done"', () => {
  const rep = (state) => ({ platform: 'ios', app: 'neuro', host: 'iPhone', at: new Date(NOW).toISOString(), checks: [{ id: 'workout-routes', ok: false, state }] });
  const st = (extra) => item(setup.assess(baseSnapshot(extra), { now: NOW }), 'iphone-neuro.workout-routes');
  assert.equal(st({ reports: [rep('asked')] }).status, 'unknown');
  assert.match(st({ reports: [rep('asked')] }).evidence, /iOS hides whether reading was allowed/);
  assert.equal(st({ reports: [rep('not-asked')] }).status, 'todo');
  assert.equal(st({ reports: [rep('unavailable')] }).status, 'attention');
  assert.equal(st({}).status, 'unknown');
  assert.equal(st({ reports: [rep('asked')], routesReceived: 2 }).status, 'done');
});

test('Setup: visits/geofence map proven-quiet to done and unproven to unknown — never "stale"', () => {
  const caps = { visits: { state: 'proven-quiet', line: 'q' }, geofence: { state: 'unproven', line: 'u' } };
  const r = setup.assess(baseSnapshot({ placeCaps: caps }), { now: NOW });
  assert.equal(item(r, 'iphone-neuro.visits').status, 'done');
  assert.equal(item(r, 'iphone-neuro.geofence').status, 'unknown');
  assert.ok(item(r, 'iphone-saim.device'), '18I: SAiM device status has its own item');
});

test('Setup report keeps a bounded state word and drops a junk one', () => {
  const kept = setup.report({ platform: 'ios', app: 'neuro', host: 'iPhone', checks: [{ id: 'workout-routes', ok: false, state: 'asked' }, { id: 'x', ok: true, state: 'DROP TABLE;' }] });
  assert.equal(kept.checks[0].state, 'asked');
  assert.equal(kept.checks[1].state, undefined);
});

test('18V. Activity: a build seen for the first time is ONE line; explicit date edits are Nick\'s', () => {
  const b = tl.fromNativeBuilds(db.all('SELECT * FROM native_builds'));
  assert.equal(b.length, 1);
  assert.match(b[0].headline, /NEURO iOS 1\.18 \(181\) is running/);
  assert.match(b[0].summary, /abcdef1/);
  const d = tl.fromPersonalDates(db.all("SELECT * FROM personal_date_events WHERE kind LIKE 'declared-%' ORDER BY id"));
  assert.ok(d.some((e) => /You added Helen Ward's birthday/.test(e.headline) && e.actor === 'nick'));
  assert.ok(d.some((e) => /You removed Helen Ward's birthday/.test(e.headline) && /will not bring it back/.test(e.summary)));
});

// ── cross-repo: the capability vocabulary is ONE list (skips without nuero-ios) ──
const IOS = path.resolve(__dirname, '..', '..', '..', 'nuero-ios');
test('the Swift capability names are exactly the server\'s, and every requirement is declarable', (t) => {
  const file = path.join(IOS, 'NeuroKit', 'Sources', 'NeuroKit', 'NeuroBuild.swift');
  if (!fs.existsSync(file)) { t.skip('no nuero-ios checkout beside this repo'); return; }
  const src = fs.readFileSync(file, 'utf8');
  const swiftCaps = [...src.matchAll(/"([a-z0-9-]+)",?\s*\/\/ Build/g)].map((m) => m[1])
    .concat(...[...src.matchAll(/caps \+= \[([^\]]+)\]/g)].map((m) => [...m[1].matchAll(/"([a-z0-9-]+)"/g)].map((x) => x[1])));
  assert.ok(swiftCaps.length >= 8, `positive control: parsed ${swiftCaps.join(',')}`);
  for (const c of swiftCaps) assert.ok(nb.CAPABILITIES[c], `Swift declares "${c}", which the server does not define`);
  for (const need of new Set(Object.values(nb.REQUIREMENTS).flat())) assert.ok(swiftCaps.includes(need), `the server requires "${need}" but no Swift build declares it`);
  assert.match(src, /protocolVersion = 18/);
});

test('a build that CAN report route permission but has not is told to open Setup, not called incapable', () => {
  const b = nb.parseBuildHeader('v=0.1;b=241;c=77f90fc369;cap=route-permission-report,workout-route-summary,device-status,calendar-window-60d');
  const native = { apps: [{ client: 'saim-ios', build: { ...b, label: nb.label(b), firstSeenAt: 'x', lastSeenAt: 'x' }, line: 'SAiM', sources: [] }] };
  const it = setup.assess(baseSnapshot({ native }), { now: NOW }).items.find((i) => i.id === 'iphone-saim.workout-routes');
  assert.equal(it.status, 'unknown');
  assert.match(it.evidence, /can report route permission but has not yet/);
  const old = setup.assess(baseSnapshot({}), { now: NOW }).items.find((i) => i.id === 'iphone-saim.workout-routes');
  assert.match(old.evidence, /does not report route permission/, 'positive control: an unknown build keeps the old wording');
});
