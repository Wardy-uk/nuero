'use strict';

/**
 * Build 30 — Leisure & Media Intelligence (9 Oct 2026).
 *
 * Fixtures are LIVE shapes, copied off the Pi on 9 Oct 2026: the phone's
 * now-playing report (Enigma, "The Eyes Of Truth", The Cross Of Changes),
 * Home Assistant's media players as they really are (Sky Glass `on` with no
 * title, Living Room `idle` with no title), the one leisure calendar entry
 * ("cinema to see the hunger games", Apple, all-day) and real lines from
 * Me/About Nick.md. A media player that states series/season/episode does
 * not exist in the house today; where a test needs one it is named as
 * hypothetical, and the rule it pins is that even then it stays household.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-b30-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'l.db');
process.env.NEURO_TIMEZONE = 'Europe/London';
process.env.HA_TOKEN = '';
process.env.HA_URL = 'http://127.0.0.1:9';
process.env.OBSIDIAN_VAULT_PATH = path.join(tmp, 'vault');

const db = require('../db/database');
const M = require('./leisure-model');
const leisure = require('./leisure');
const np = require('./now-playing');
const radar = require('./future-radar');
const tl = require('./activity-timeline');
const matrix = require('./authority-matrix');

const NOW = Date.parse('2026-10-09T15:00:00Z');   // Friday 16:00 BST
const TODAY = '2026-10-09';
const day = (n) => M.addDays(TODAY, n);
const isoAt = (d, hm = '20:00') => new Date(`${d}T${hm}:00+01:00`).toISOString();

// Live, 9 Oct 2026 15:16Z — the one now-playing record on the Pi.
const ENIGMA = { state: 'playing', title: 'The Eyes Of Truth', artist: 'Enigma', album: 'The Cross Of Changes', app: 'Music', client: 'neuro' };
// Live HA media players (no title, series or episode on any of them).
const SKY = { entity_id: 'media_player.sky_glass', state: 'on', attributes: { friendly_name: 'Sky Glass', supported_features: 1977, device_class: 'receiver' } };
const LIVING = { entity_id: 'media_player.living_room', state: 'idle', attributes: { friendly_name: 'Living Room', supported_features: 448439 } };
const BEDROOM = { entity_id: 'media_player.main_bedroom', state: 'on', attributes: { friendly_name: 'Main bedroom', supported_features: 1977, device_class: 'receiver' } };
// HYPOTHETICAL: a player that DID state episode identity (none does today).
const tvPlaying = (episode, position, duration = 2700) => ({ entity_id: 'media_player.lounge_tv', state: 'playing',
  attributes: { friendly_name: 'Lounge TV', media_series_title: 'Slow Horses', media_season: 2, media_episode: episode, media_title: `Episode ${episode}`, media_position: position, media_duration: duration } });
// HYPOTHETICAL: the living-room speaker playing music for the household.
const SPEAKER_MUSIC = { entity_id: 'media_player.living_room', state: 'playing', attributes: { friendly_name: 'Living Room', media_artist: 'Bellowhead', media_title: 'New York Girls', media_album_name: 'Hedonism' } };

const PROFILE = `---
type: profile
---

# About Nick

## Outside work

- Enjoys hillwalking and hiking, preferring dramatic rocky terrain over moorland. <!--p:seed 2026-08-31-->
- Enjoys long-form D&D with persistent, consistent world state where actions have consequences. <!--p:seed 2026-08-31-->
- Interested in retro technology. <!--p:seed 2026-08-31-->
- Enjoys building with Raspberry Pis and maker equipment. <!--p:seed 2026-08-31-->
- Building NOVA, a support agent, alongside Neuro and the SARA external surface. <!--p:interview 2026-08-31-->

## What I care about

- Wife is Helen; she looks after the 60-litre aquarium. <!--p:interview 2026-08-31-->
- Marillion's Misplaced Childhood is a long-running deep obsession. <!--p:seed 2026-08-31-->
- Enjoys interrogating the boundary between fiction and reality while reading. <!--p:seed 2026-08-31-->

## Preferences

- Appreciates thematic reprises and musical structure rather than treating songs as isolated tracks. <!--p:seed 2026-08-31-->
- Pragmatic rather than brand-loyal. <!--p:seed 2026-08-31-->
`;

function meeting(id, title, startLocal, { allDay = 1, provider = 'apple', key = 'eventkit-cal:id:home', name = 'Home' } = {}) {
  const ts = '2026-10-09T10:00:00Z';
  db.run(`INSERT OR REPLACE INTO wm_meetings (meeting_id, provider, provider_event_id, title, start_local, end_local, is_all_day, status, kind, provenance_kind,
          observed_at, received_at, evidence_json, updated_at, calendar_key, calendar_name)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'scheduled', 'unknown', 'observation', ?, ?, '{}', ?, ?, ?)`,
  [id, provider, id, title, startLocal, startLocal, allDay, ts, ts, ts, key, name]);
}
function heard(dayKey, report = ENIGMA) { return leisure.observeNowPlaying({ ...report, at: isoAt(dayKey) }, { now: NOW }); }
const count = (t) => db.get(`SELECT COUNT(*) n FROM ${t}`).n;
const resetLeisure = () => { db.run('DELETE FROM leisure_items'); db.run('DELETE FROM leisure_observations'); };

test.before(async () => {
  fs.mkdirSync(path.join(tmp, 'vault', 'Me'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'vault', 'Me', 'About Nick.md'), PROFILE);
  await db.init();
});

// ── CURRENT MEDIA (1–4) ────────────────────────────────────────────────────

test('1. stale playback is never shown as current', () => {
  np.record({ ...ENIGMA, at: new Date(NOW - 20 * 60000).toISOString() }, { now: NOW });
  assert.equal(np.current({ now: NOW }), null);
  const r = leisure.read({ now: NOW, haStates: [] });
  assert.equal(r.now.playing, null);
  assert.equal(r.now.lastReport.state, 'playing', 'the last report is still shown — as a report, not as now');
  assert.equal(leisure.nowBlock({ now: NOW }).playing, null);
});

test('2. phone playback stays source-specific; the TV is a separate, household line', () => {
  np.record({ ...ENIGMA, at: new Date(NOW - 2 * 60000).toISOString() }, { now: NOW });
  const r = leisure.read({ now: NOW, haStates: [SKY, LIVING, BEDROOM] });
  assert.equal(r.now.playing.source, 'phone-music');
  assert.equal(r.now.playing.ownership, 'nick-device');
  assert.equal(r.now.playing.title, 'The Eyes Of Truth');
  assert.deepEqual(r.now.tv.map((t) => t.entityId).sort(), ['media_player.main_bedroom', 'media_player.sky_glass']);
  assert.ok(r.now.tv.every((t) => t.ownership === 'household' && t.identity === false && t.title === null));
});

test('3. shared TV playback is not automatically Nick\'s preference (hypothetical identity player)', () => {
  resetLeisure();
  leisure.observeMediaPlayers([tvPlaying(4, 600)], { now: NOW });
  const r = leisure.read({ now: NOW, haStates: [] });
  assert.equal(r.household.length, 1);
  assert.equal(r.household[0].title, 'Slow Horses');
  assert.equal(r.continue.length, 0, 'not in Nick\'s Continue');
  assert.equal(r.listening.artists.length + r.listening.albums.length, 0);
  const cv = leisure.chatView({ now: NOW });
  assert.ok(!JSON.stringify(cv.liked).includes('Slow Horses') && !JSON.stringify(cv.listeningInterest).includes('Slow Horses'));
});

test('4. reading current media and many reports create no Activity', () => {
  const before = count('personal_ops_events');
  for (let i = 0; i < 20; i += 1) np.record({ ...ENIGMA, title: `Track ${i}`, at: new Date(NOW - (20 - i) * 1000).toISOString() }, { now: NOW });
  leisure.read({ now: NOW, haStates: [SKY] }); leisure.nowBlock({ now: NOW });
  assert.equal(count('personal_ops_events'), before);
});

// ── SERIES (5–9) ───────────────────────────────────────────────────────────

test('5. episode identity is tracked only when the source states it — the live Sky Glass does not', () => {
  assert.equal(M.tvObservation(SKY).identity, false);
  assert.match(M.tvObservation(SKY).why, /no series\/episode identity/);
  assert.equal(M.tvObservation(LIVING).identity, false);
  const o = M.tvObservation(tvPlaying(5, 100));
  assert.deepEqual([o.identity, o.series, o.season, o.episode], [true, 'Slow Horses', 2, 5]);
  assert.equal(M.tvObservation({ ...tvPlaying(5, 100), attributes: { ...tvPlaying(5, 100).attributes, media_episode: 'Five' } }).identity, false, 'no numeric episode, no identity');
  resetLeisure();
  leisure.observeMediaPlayers([SKY, LIVING, BEDROOM], { now: NOW });
  assert.equal(count('leisure_observations'), 0, 'live players fold nothing');
});

test('6. playback start does not mark an episode complete', () => {
  resetLeisure();
  leisure.observeMediaPlayers([tvPlaying(5, 60)], { now: NOW });
  const p = JSON.parse(db.get('SELECT progress_json FROM leisure_observations').progress_json);
  assert.equal(p.completedThrough, null);
  assert.equal(M.episodeCompletion({ reliable: true, position: 1200, duration: 2700 }).complete, false, '20 minutes in is not finished');
});

test('7. a reliable source past the threshold marks it complete; an unreliable one never', () => {
  leisure.observeMediaPlayers([tvPlaying(5, 2600)], { now: NOW });
  const p = JSON.parse(db.get('SELECT progress_json FROM leisure_observations').progress_json);
  assert.deepEqual(p.completedThrough, { season: 2, episode: 5, basis: 'progress' });
  assert.equal(M.episodeCompletion({ reliable: false, position: 2690, duration: 2700 }).complete, false);
  assert.equal(M.episodeCompletion({ reliable: true, reportedComplete: true }).basis, 'source-reported');
  leisure.observeMediaPlayers([tvPlaying(6, 30)], { now: NOW });
  const p2 = JSON.parse(db.get('SELECT progress_json FROM leisure_observations').progress_json);
  assert.deepEqual(p2.completedThrough, { season: 2, episode: 5, basis: 'progress' }, 'the next episode appearing completes nothing');
});

test('8. inactivity never marks a series abandoned', () => {
  const it = { itemId: 'x', kind: 'tv_series', state: 'active', lastTouchedAt: `${day(-120)}T20:00:00Z` };
  const s = M.effectiveState(it, { today: TODAY });
  assert.equal(s.state, 'unknown');
  assert.equal(s.basis, 'gone-quiet');
  assert.match(s.why, /does not call that abandoned/);
  assert.notEqual(M.effectiveState({ ...it, lastTouchedAt: `${day(-10)}T20:00:00Z` }).state, 'abandoned');
});

test('9. an explicit "dropped" wins over later playback', () => {
  resetLeisure();
  leisure.observeMediaPlayers([tvPlaying(5, 100)], { now: NOW });
  const ref = 'tv:series:slow horses';
  assert.equal(leisure.correct(ref, 'this-was-me', { now: NOW }).ok, true);
  const item = leisure.correct(ref, 'dropped', { now: NOW }).item;
  assert.equal(item.state, 'abandoned');
  leisure.observeMediaPlayers([tvPlaying(6, 2650)], { now: NOW });
  const r = leisure.read({ now: NOW, haStates: [] });
  assert.equal(leisure.listItems().find((i) => i.sourceRef === ref).state, 'abandoned');
  assert.ok(!r.continue.some((c) => c.title === 'Slow Horses'));
});

// ── FILMS (10–12) ──────────────────────────────────────────────────────────

test('10–12. a film completes only on Nick\'s word, stays paused/unknown otherwise, and is never auto-abandoned', () => {
  resetLeisure();
  const f = leisure.addItem({ kind: 'film', title: 'Dune: Part Two', state: 'paused' }, { now: NOW }).item;
  assert.equal(f.state, 'paused');
  assert.equal(M.effectiveState({ ...f, lastTouchedAt: `${day(-200)}T20:00:00Z` }, { today: TODAY }).state, 'paused', '11. paused stays paused');
  const a = leisure.updateItem(f.itemId, { state: 'active' }, { now: NOW }).item;
  assert.equal(M.effectiveState({ ...a, lastTouchedAt: `${day(-200)}T20:00:00Z` }, { today: TODAY }).state, 'unknown', '12. long-quiet is unknown, never abandoned');
  assert.equal(a.completedAt, null, '10. not completed without evidence');
  const done = leisure.correct(f.itemId, 'completed', { now: NOW }).item;
  assert.equal(done.state, 'completed');
  assert.ok(done.completedAt);
  assert.equal(M.validateItem({ kind: 'film', title: 'x', state: 'current' }, { creating: true }).ok, false, 'current is never stored');
});

// ── MUSIC (13–17) ──────────────────────────────────────────────────────────

test('13. one play is not interest — the live Enigma report', () => {
  resetLeisure();
  np.record({ ...ENIGMA, at: new Date(NOW + 60000).toISOString() }, { now: NOW + 60000 });
  const r = leisure.read({ now: NOW, haStates: [] });
  const e = r.listening.artists.find((a) => a.title === 'Enigma');
  assert.equal(e.affinity, 'unknown');
  assert.match(e.why, /one play is not interest/);
});

test('14. repeated listening over weeks supports interest — and only interest', () => {
  resetLeisure();
  for (const d of [day(-20), day(-12), day(-5), day(-1)]) heard(d);
  const e = leisure.read({ now: NOW, haStates: [] }).listening.artists.find((a) => a.title === 'Enigma');
  assert.equal(e.affinity, 'interest');
  assert.match(e.why, /not proof you like it/);
  for (let i = 1; i <= 29; i += 1) heard(day(-i));
  assert.equal(leisure.read({ now: NOW, haStates: [] }).listening.artists.find((a) => a.title === 'Enigma').affinity, 'interest', 'a month of daily plays is still not "you like it"');
  assert.equal(M.affinity({ days: [day(-1), day(-2), day(-3)], today: TODAY }).state, 'unknown', 'three days in one week is not over time');
});

test('15. an explicit like outranks passive evidence, and an explicit dislike outranks heavy listening', () => {
  assert.equal(leisure.correct('music:artist:enigma', 'not-for-me', { now: NOW }).ok, true);
  assert.equal(leisure.read({ now: NOW, haStates: [] }).listening.artists.find((a) => a.title === 'Enigma').affinity, 'disliked');
  leisure.correct('music:artist:enigma', 'liked', { now: NOW });
  const e = leisure.read({ now: NOW, haStates: [] }).listening.artists.find((a) => a.title === 'Enigma');
  assert.equal(e.affinity, 'strong_interest');
  assert.equal(e.affinityBasis, 'you');
  heard(TODAY, { ...ENIGMA, artist: 'Marillion', album: 'Misplaced Childhood' });
  assert.equal(leisure.read({ now: NOW, haStates: [] }).listening.artists.find((a) => a.title === 'Marillion').affinity, 'unknown');
});

test('16. an explicit dislike stays at the level it was given', () => {
  resetLeisure();
  heard(day(-1), { ...ENIGMA, artist: 'Bellowhead', album: 'Hedonism' });
  heard(day(-1), { ...ENIGMA, artist: 'The Longest Johns', album: 'Smoke & Oakum' });
  leisure.correct('music:artist:bellowhead', 'disliked', { now: NOW });
  const r = leisure.read({ now: NOW, haStates: [] });
  assert.equal(r.listening.artists.find((a) => a.title === 'Bellowhead').affinity, 'disliked');
  assert.notEqual(r.listening.artists.find((a) => a.title === 'The Longest Johns').affinity, 'disliked', 'not "dislikes folk"');
  assert.equal(r.listening.albums.find((a) => a.title === 'Hedonism').affinity, 'unknown', 'the artist dislike is not copied onto the album record');
  assert.match(r.preferences.disliked[0].scope, /this artist only — not the genre/);
  leisure.correct('music:album:the longest johns|smoke & oakum', 'not-for-me', { now: NOW });
  assert.notEqual(leisure.read({ now: NOW, haStates: [] }).listening.artists.find((a) => a.title === 'The Longest Johns').affinity, 'disliked', 'one album is not the artist');
});

test('17. autoplay / background play never becomes evidence', () => {
  assert.equal(M.isSighting({ ...ENIGMA, autoplay: true }), false);
  assert.equal(M.isSighting({ ...ENIGMA, background: true }), false);
  assert.equal(M.isSighting({ ...ENIGMA, state: 'paused' }), false, 'a paused report is what was loaded, not what was heard');
  resetLeisure();
  for (let i = 1; i <= 25; i += 1) leisure.observeNowPlaying({ ...ENIGMA, autoplay: true, at: isoAt(day(-i)) });
  assert.equal(count('leisure_observations'), 0);
});

// ── HOUSEHOLD (18–20) ──────────────────────────────────────────────────────

test('18–19. shared TV and a household speaker never become Nick\'s preference', () => {
  resetLeisure();
  leisure.observeMediaPlayers([SPEAKER_MUSIC, tvPlaying(3, 100)], { now: NOW });
  const r = leisure.read({ now: NOW, haStates: [SPEAKER_MUSIC] });
  assert.equal(r.listening.artists.length, 0, 'the speaker playing Bellowhead created no artist record');
  assert.ok(!JSON.stringify(r.listening).includes('Bellowhead'));
  assert.equal(r.household[0].title, 'Slow Horses');
  assert.match(r.household[0].why, /household viewing, not counted as yours/);
});

test('20. "this was me" reclassifies household viewing as Nick\'s', () => {
  const ref = 'tv:series:slow horses';
  leisure.correct(ref, 'this-was-me', { now: NOW });
  leisure.correct(ref, 'resume', { now: NOW });
  const r = leisure.read({ now: NOW, haStates: [] });
  assert.equal(r.household.length, 0);
  const c = r.continue.find((x) => x.title === 'Slow Horses');
  assert.ok(c);
  assert.equal(c.progress, 'S2 E3', 'it carries the episode the player stated');
});

// ── HOBBIES (21–24) ────────────────────────────────────────────────────────

test('21–24. hobbies are explicit; a project or one edit does not make one; a scheduled session does', () => {
  resetLeisure();
  assert.equal(leisure.read({ now: NOW, haStates: [] }).hobbies.length, 0, '22. no hobby without Nick adding one, whatever projects exist');
  const h = leisure.addItem({ kind: 'hobby', title: 'D&D' }, { now: NOW }).item;
  const r = leisure.read({ now: NOW, haStates: [] });
  assert.equal(r.hobbies[0].state, 'active');
  assert.equal(r.hobbies[0].stateBasis, 'you', '21. explicit classification');
  const unknown = { ...h, state: 'unknown', projectId: 'p:d-and-d' };
  assert.equal(M.hobbyState(unknown, { today: TODAY, project: { name: 'D&D', status: 'unknown' } }).state, 'unknown', '23. one edit (activity, not progress) proves nothing');
  assert.equal(M.hobbyState(unknown, { today: TODAY, project: { name: 'D&D', status: 'active' } }).basis, 'project');
  assert.equal(M.hobbyState({ ...unknown, projectId: null, eventDate: day(5), eventKind: 'session' }, { today: TODAY }).state, 'active', '24. a scheduled session');
  assert.equal(M.hobbyState({ ...unknown, projectId: null, eventDate: day(40), eventKind: 'session' }, { today: TODAY }).state, 'unknown', 'a session six weeks out does not');
  assert.equal(M.hobbyState({ ...h, state: 'paused' }, { today: TODAY, project: { name: 'D&D', status: 'active' } }).state, 'paused', 'his word beats project evidence');
});

// ── RECOMMENDATIONS (25–29) ────────────────────────────────────────────────

test('25–29. suggestions need evidence, explain themselves, honour dislikes, never feed, never need you', () => {
  resetLeisure();
  assert.deepEqual(leisure.read({ now: NOW, haStates: [] }).suggestions, [], '25. nothing held, nothing suggested');
  assert.deepEqual(leisure.read({ now: NOW, asked: true, haStates: [] }).suggestions, [], '25. not even when asked');
  leisure.addItem({ kind: 'tv_series', title: 'Slow Horses', state: 'active', progress: { season: 2, episode: 4 } }, { now: NOW });
  leisure.addItem({ kind: 'album', title: 'Hedonism', creator: 'Bellowhead', state: 'saved' }, { now: NOW });
  leisure.addItem({ kind: 'album', title: 'Smoke & Oakum', creator: 'The Longest Johns', state: 'saved' }, { now: NOW });
  heard(day(-1), { ...ENIGMA, artist: 'Bellowhead', album: 'Hedonism' });
  leisure.correct('music:artist:bellowhead', 'disliked', { now: NOW });
  let s = leisure.read({ now: NOW, haStates: [] }).suggestions;
  assert.equal(s.length, 1, '28. unasked: only the natural continuation');
  assert.equal(s[0].line, 'Slow Horses: S2 E5 next');
  assert.ok(s[0].why && s[0].confidence, '26. explained');
  s = leisure.read({ now: NOW, asked: true, haStates: [] }).suggestions;
  assert.ok(s.some((x) => x.title === 'Smoke & Oakum'));
  assert.ok(!s.some((x) => x.creator === 'Bellowhead'), '27. an explicitly disliked artist is never suggested');
  // 27, narrow: disliking ONE album by an artist leaves that artist's other albums suggestible.
  const soa = leisure.listItems().find((i) => i.title === 'Smoke & Oakum');
  leisure.addItem({ kind: 'album', title: 'Shanties for the Deep', creator: 'The Longest Johns', state: 'saved' }, { now: NOW });
  leisure.correct(soa.itemId, 'not-for-me', { now: NOW });
  s = leisure.read({ now: NOW, asked: true, haStates: [] }).suggestions;
  assert.ok(!s.some((x) => x.title === 'Smoke & Oakum'), 'the disliked album is out');
  assert.ok(s.some((x) => x.title === 'Shanties for the Deep'), 'the same artist\'s other album is not');
  const rd = radar.read({ now: NOW, horizonDays: 30 });
  assert.ok(!rd.items.some((i) => i.kind === 'leisure'), '29. undated saved items do not reach the Radar');
  for (const f of ['leisure.js', 'leisure-model.js']) {
    const src = fs.readFileSync(path.join(__dirname, f), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    assert.ok(!/webpush|sendToAll|ambient-push|notification-policy|setInterval/.test(src), `28/49. ${f} never pushes or schedules`);
  }
  assert.ok(/sendToAll/.test(fs.readFileSync(path.join(__dirname, 'date-nags.js'), 'utf8')), 'positive control');
});

// ── CONTINUE (30–33) ───────────────────────────────────────────────────────

test('30–33. Continue: reliable active items, nothing stale or unknown, bounded, finished removed', () => {
  resetLeisure();
  const series = leisure.addItem({ kind: 'tv_series', title: 'Slow Horses', state: 'active', progress: { season: 2, episode: 4 } }, { now: NOW }).item;
  const old = leisure.addItem({ kind: 'book', title: 'Old book', state: 'active' }, { now: NOW - 100 * 86400000 }).item;
  leisure.addItem({ kind: 'game', title: 'No state', state: 'unknown' }, { now: NOW });
  let c = leisure.read({ now: NOW, haStates: [] }).continue;
  assert.deepEqual(c.map((x) => x.title), ['Slow Horses'], '30/31. the active series, not the gone-quiet book or the unknown game');
  assert.ok(leisure.read({ now: NOW, haStates: [] }).quiet.some((q) => q.ref === old.itemId));
  for (let i = 0; i < 8; i += 1) leisure.addItem({ kind: 'book', title: `Book ${i}`, state: 'active' }, { now: NOW });
  assert.equal(leisure.read({ now: NOW, haStates: [] }).continue.length, M.CONTINUE_LIMIT, '32. bounded');
  leisure.correct(series.itemId, 'completed', { now: NOW });
  c = leisure.read({ now: NOW, haStates: [] }).continue;
  assert.ok(!c.some((x) => x.title === 'Slow Horses'), '33. finished leaves Continue');
  assert.ok(leisure.read({ now: NOW, haStates: [] }).recentlyEnjoyed.some((x) => x.title === 'Slow Horses' && x.finished));
});

test('Continue also carries an album on 2 of the last 7 days — never a one-off', () => {
  resetLeisure();
  heard(day(-6));
  assert.equal(leisure.read({ now: NOW, haStates: [] }).continue.length, 0);
  heard(day(-1));
  const c = leisure.read({ now: NOW, haStates: [] }).continue;
  assert.equal(c[0].title, 'The Cross Of Changes');
  assert.equal(c[0].basis, 'listening');
});

// ── PRIVACY (34–37) ────────────────────────────────────────────────────────

test('34–37. no play log, reading writes nothing, household never a resident, aggregates only', () => {
  resetLeisure();
  for (let i = 0; i < 50; i += 1) leisure.observeNowPlaying({ ...ENIGMA, title: `Secret track ${i}`, at: new Date(NOW - i * 30000).toISOString() });
  assert.equal(count('leisure_observations'), 2, '34. one artist + one album row, not 50 plays');
  const row = db.get("SELECT * FROM leisure_observations WHERE kind = 'artist'");
  assert.deepEqual(JSON.parse(row.days_json), [TODAY]);
  for (const t of ['leisure_items', 'leisure_observations', 'personal_ops_events']) {
    assert.ok(!JSON.stringify(db.all(`SELECT * FROM ${t}`)).includes('Secret track'), `37. no track title in ${t}`);
  }
  const cols = db.all("PRAGMA table_info(leisure_observations)").map((c) => c.name);
  assert.ok(!cols.some((c) => /room|position|at$|time/.test(c) && c !== 'first_seen' && c !== 'last_seen'), `37. aggregate columns only: ${cols}`);
  // 35: reading writes nothing anywhere.
  const tables = db.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").map((r) => r.name);
  const snap = () => Object.fromEntries(tables.map((t) => [t, count(t)]));
  const stateBefore = JSON.stringify(db.all('SELECT * FROM agent_state ORDER BY key'));
  const before = snap();
  // total_changes() counts EVERY row written on this connection — an identical
  // re-write too, which a content comparison cannot see.
  const writes = () => db.get('SELECT total_changes() n').n;
  const w0 = writes();
  leisure.read({ now: NOW, haStates: [SKY, LIVING] }); leisure.read({ now: NOW, asked: true, haStates: [] });
  leisure.nowBlock({ now: NOW }); leisure.chatView({ now: NOW }); leisure.detail('music:artist:enigma', { now: NOW });
  assert.equal(writes(), w0, '35. a read writes no row anywhere');
  assert.deepEqual(snap(), before);
  assert.equal(JSON.stringify(db.all('SELECT * FROM agent_state ORDER BY key')), stateBefore, '35. no state written by a read');
  leisure.observeNowPlaying({ ...ENIGMA, at: isoAt(day(-3)) });
  assert.ok(writes() > w0, 'positive control: the counter sees a real write');
  // 36: household observations carry no person.
  leisure.observeMediaPlayers([tvPlaying(2, 100)], { now: NOW });
  const hh = db.get("SELECT * FROM leisure_observations WHERE kind = 'tv_series'");
  assert.equal(hh.ownership, 'household');
  assert.ok(!/Helen|Isaac|nick/i.test(JSON.stringify(leisure.read({ now: NOW, haStates: [] }).household)), '36. no resident named');
});

// ── NOW / RADAR / NEEDS YOU (44–49) ────────────────────────────────────────

test('44–45. Now: what is playing and a leisure booking today/tomorrow — never the backlog', () => {
  resetLeisure();
  leisure.addItem({ kind: 'book', title: 'A backlog book', state: 'active' }, { now: NOW });
  leisure.addItem({ kind: 'film', title: 'Saved film', state: 'saved' }, { now: NOW });
  db.run('DELETE FROM agent_state WHERE key = ?', [np.KEY]);   // a clean phone: earlier tests held a newer report
  np.record({ ...ENIGMA, at: new Date(NOW - 30 * 60000).toISOString() }, { now: NOW });
  let n = leisure.nowBlock({ now: NOW });
  assert.equal(n.relevant, false, '45. an inactive backlog earns no place on Now');
  assert.deepEqual(Object.keys(n).sort(), ['playing', 'relevant', 'soon']);
  np.record({ ...ENIGMA, at: new Date(NOW - 60000).toISOString() }, { now: NOW });
  n = leisure.nowBlock({ now: NOW });
  assert.equal(n.relevant, true);
  assert.equal(n.playing.source, 'phone-music');
  meeting('apple:cinema-tonight', 'cinema to see the hunger games', `${TODAY}T19:30`, { allDay: 0 });
  n = leisure.nowBlock({ now: NOW });
  assert.equal(n.soon[0].when, 'today');
  const pres = require('./presentation-intent').composePresentation({ contract: 'canonical-v1', situation: { calm: true, sections: {} }, leisure: n }, { now: NOW });
  const line = (pres.context || []).find((c) => c.kind === 'leisure');
  assert.equal(line.label, 'cinema to see the hunger games today at 19:30');
  assert.ok(!(pres.observations || []).some((o) => o.kind === 'leisure'), 'context, never promoted');
  db.run("DELETE FROM wm_meetings WHERE meeting_id = 'apple:cinema-tonight'");
});

test('46–49. Radar: a booked event enters (and folds into its calendar entry); a suggestion never does; nothing needs you; no push', () => {
  resetLeisure();
  meeting('apple:cinema', 'cinema to see the hunger games', `${day(12)}T00:00`);
  leisure.addItem({ kind: 'film', title: 'The Hunger Games', state: 'saved', eventDate: day(12), eventKind: 'booked' }, { now: NOW });
  leisure.addItem({ kind: 'other', title: 'Folk night at the Fox', eventDate: day(5) }, { now: NOW });
  leisure.addItem({ kind: 'game', title: 'Release I care about', state: 'saved', eventDate: day(20), eventKind: 'release' }, { now: NOW });
  leisure.addItem({ kind: 'album', title: 'Saved album', state: 'saved' }, { now: NOW });
  const rd = radar.read({ now: NOW, horizonDays: 30 });
  const cinema = rd.items.filter((i) => i.date === day(12));
  assert.equal(cinema.length, 1, '46. the booking folds into the calendar entry — one item, not two');
  assert.equal(cinema[0].domain, 'leisure');
  assert.ok(cinema[0].whyVisible.some((w) => /Life → Leisure/.test(w)));
  const folk = rd.items.find((i) => i.title === 'Folk night at the Fox');
  assert.equal(folk.kind, 'leisure'); assert.equal(folk.actionState, 'planned');
  assert.equal(rd.items.find((i) => i.title === 'Out: Release I care about').actionState, 'none');
  assert.ok(!rd.items.some((i) => i.title === 'Saved album'), '47. no recommendation or undated item on the Radar');
  assert.ok(rd.items.filter((i) => i.kind === 'leisure' || i.domain === 'leisure').every((i) => i.actionState !== 'needs_you'), '48. leisure never needs you');
  db.run("DELETE FROM wm_meetings WHERE meeting_id = 'apple:cinema'");
});

test('leisure calendar words: the live entry is recognised; work entries never are', () => {
  assert.equal(M.leisureEventFromTitle('cinema to see the hunger games'), 'cinema');
  assert.equal(M.leisureEventFromTitle('D&D session — Phandelver'), 'D&D');
  for (const t of ['Maintenance Tickets Group', 'Single Customer Front Door - What do we mean and what do we want?', 'TPFG Internal Ticketing ',
    'Team show-and-tell', 'Football match planning with Chris', 'Musicals review Q3 budget']) {
    assert.equal(M.leisureEventFromTitle(t), null, t);
  }
});

test('profile interests are the profile\'s own lines, verbatim — never turned into items', () => {
  const r = leisure.read({ now: NOW, haStates: [] });
  const texts = r.profile.interests.map((i) => i.text);
  assert.ok(texts.includes("Marillion's Misplaced Childhood is a long-running deep obsession."));
  assert.ok(texts.some((t) => /D&D/.test(t)) && texts.some((t) => /retro technology/.test(t)));
  assert.ok(!texts.some((t) => /NOVA|brand-loyal|hillwalking/.test(t)), `no work builds, no shopping, no hiking (Outdoor owns it): ${texts}`);
  assert.ok(!texts.some((t) => /Wife is Helen/.test(t)), 'live false positive: a People fact that mentions the aquarium is not an interest');
  assert.equal(r.hobbies.length, 0, 'a profile line is not a tracked hobby');
});

test('sources stay separate, and the unavailable ones say why', () => {
  const r = leisure.read({ now: NOW, haStates: [SKY, LIVING, BEDROOM] });
  const by = Object.fromEntries(r.sources.map((s) => [s.id, s]));
  assert.deepEqual(Object.keys(by).sort(), ['apple-music-library', 'calendar', 'games', 'hobby-projects', 'phone-music', 'podcasts-audiobooks', 'profile', 'tv-media']);
  assert.equal(by['tv-media'].state, 'context-only');
  assert.match(by['tv-media'].detail, /none reports a title, series or episode/);
  assert.equal(by.games.state, 'unavailable');
  assert.equal(by['podcasts-audiobooks'].state, 'unavailable');
  assert.equal(by['apple-music-library'].state, 'unavailable');
  assert.equal(leisure.read({ now: NOW, haStates: null }).sources.find((s) => s.id === 'tv-media').state, 'unreadable', 'not read is not "none"');
});

test('refresh: first run is a baseline; a source change is ONE Activity line', async () => {
  db.run('DELETE FROM agent_state WHERE key = ?', [leisure.SOURCE_STATE_KEY]);
  const before = count('personal_ops_events');
  assert.equal((await leisure.refresh({ now: NOW, haStates: [SKY] })).baseline, true);
  assert.equal(count('personal_ops_events'), before);
  await leisure.refresh({ now: NOW, haStates: [SKY] });
  assert.equal(count('personal_ops_events'), before, 'no change, nothing');
  await leisure.refresh({ now: NOW, haStates: [SKY, tvPlaying(1, 10)] });
  const rows = db.all("SELECT * FROM personal_ops_events WHERE kind = 'leisure-source-changed'");
  assert.equal(rows.length, 1);
  assert.match(tl.fromPersonalOps(rows)[0].headline, /TV & speakers \(Home Assistant\): context only → identity/);
});

// ── CORRECTIONS (38–43) over real HTTP ─────────────────────────────────────

let server; let base;
test('38–43. corrections over real HTTP: liked, disliked, completed, dropped, not mine — audited, machine-refused', async () => {
  resetLeisure();
  heard(day(-1));
  const express = require('express');
  const app = express(); app.use(express.json());
  app.use('/api/leisure', require('../routes/leisure'));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const post = async (p, body) => { const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }); return { status: r.status, body: await r.json() }; };
  const evBefore = count('personal_ops_events');

  const added = await post('/api/leisure/items', { kind: 'tv_series', title: 'Slow Horses', state: 'active', progress: { season: 2, episode: 4 } });
  assert.equal(added.status, 200);
  const id = added.body.itemId;
  assert.equal((await post('/api/leisure/correct', { ref: id, action: 'liked' })).body.item.preference, 'liked', '38');
  assert.equal((await post('/api/leisure/correct', { ref: 'music:artist:enigma', action: 'disliked' })).body.item.preference, 'disliked', '39');
  assert.equal((await post('/api/leisure/correct', { ref: id, action: 'next-episode' })).body.item.progress.episode, 5);
  assert.equal((await post('/api/leisure/correct', { ref: id, action: 'completed' })).body.item.state, 'completed', '40');
  const film = await post('/api/leisure/items', { kind: 'film', title: 'Abandoned film', state: 'active' });
  assert.equal((await post('/api/leisure/correct', { ref: film.body.itemId, action: 'dropped' })).body.item.state, 'abandoned', '41');
  assert.equal((await post('/api/leisure/correct', { ref: 'music:album:enigma|the cross of changes', action: 'not-mine' })).body.item.ownership, 'not-mine', '42');
  // Refusals, never quiet normalising.
  assert.equal((await post('/api/leisure/correct', { ref: id, action: 'adore' })).status, 400);
  assert.equal((await post('/api/leisure/correct', { ref: 'music:artist:enigma', action: 'completed' })).status, 400, 'an artist is not finished');
  assert.equal((await post('/api/leisure/correct', { ref: film.body.itemId, action: 'next-episode' })).status, 400);
  assert.equal((await post('/api/leisure/correct', { ref: 'music:artist:nobody', action: 'liked' })).status, 404);
  assert.equal((await post('/api/leisure/items', { kind: 'film', title: 'x', eventDate: '2026-02-31' })).status, 400, 'refused, never rolled');
  assert.equal((await post('/api/leisure/items', { kind: 'podcastz', title: 'x' })).status, 400);
  assert.equal((await post(`/api/leisure/items/${encodeURIComponent(id)}`, { kind: 'film' })).status, 400, 'kind cannot change');
  const get = await (await fetch(`${base}/api/leisure`)).json();
  assert.equal(get.contract, 'leisure-v1');
  assert.equal((await fetch(`${base}/api/leisure?ask=yes`)).status, 400);
  const det = await (await fetch(`${base}/api/leisure/items/${encodeURIComponent('music:artist:enigma')}`)).json();
  assert.equal(det.item.affinity, 'disliked');

  // 43: auditable — append-only lines by Nick; Activity names them; an episode tick is audited, not Activity.
  const rows = db.all("SELECT * FROM personal_ops_events WHERE kind LIKE 'leisure-%' ORDER BY id");
  assert.ok(count('personal_ops_events') > evBefore);
  assert.ok(rows.filter((r) => r.kind !== 'leisure-source-changed').every((r) => r.actor === 'nick'));
  assert.ok(rows.some((r) => JSON.parse(r.detail_json).action === 'next-episode'), 'the tick is in the audit');
  assert.throws(() => db.run("UPDATE personal_ops_events SET kind = 'x' WHERE id = ?", [rows[0].id]), /append-only/);
  const lines = tl.fromPersonalOps(rows).map((e) => e.headline);
  assert.ok(lines.includes('You finished "Slow Horses"') && lines.includes('You dropped "Abandoned film"') && lines.includes('You said "The Cross Of Changes" was not yours'));
  assert.ok(lines.includes('You marked "Enigma" as disliked'));
  assert.ok(!lines.some((l) => /episode/i.test(l)), 'no Activity line per episode');

  for (const p of ['/api/leisure/items', '/api/leisure/items/leisure:x', '/api/leisure/correct']) assert.equal(matrix.machineDecision('POST', p).allow, false, p);
  assert.equal(matrix.machineDecision('GET', '/api/leisure').allow, true);
});

test.after(async () => {
  if (!server) return;
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});

// ── the card, rendered for real, from the REAL read ────────────────────────

test('Life → Leisure renders the live shape: playing, continue, listening as evidence, household, sources — no feed, no score', async () => {
  const React = require('react');
  const { renderToString } = require('react-dom/server');
  const esbuild = require('esbuild');
  const out = await esbuild.build({
    entryPoints: [path.join(__dirname, '..', '..', 'frontend', 'src', 'components', 'canonical', 'LeisureCard.jsx')],
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
  assert.equal(typeof m.exports.LeisureView, 'function', 'positive control: the view is exported');
  resetLeisure();
  heard(day(-1));
  leisure.addItem({ kind: 'tv_series', title: 'Slow Horses', state: 'active', progress: { season: 2, episode: 4 } }, { now: NOW });
  leisure.observeMediaPlayers([tvPlaying(3, 100)], { now: NOW });
  np.record({ ...ENIGMA, at: new Date(NOW - 60000).toISOString() }, { now: NOW });
  const data = leisure.read({ now: NOW, haStates: [SKY, LIVING] });
  const html = renderToString(React.createElement(m.exports.LeisureView, { data, act: () => true }));
  assert.match(html, /data-testid="leisure-card"/);
  assert.match(html, /Playing <strong>The Eyes Of Truth<\/strong>/);
  assert.match(html, /Sky Glass is on(<!-- -->)? — household, not counted as yours/);
  assert.ok(!/-\d+ min ago/.test(html), 'never a negative age');
  assert.match(html, /Slow Horses: S2 E5 next/);
  assert.match(html, /Watched next episode<\/button>/, 'correction controls are mounted');
  assert.match(html, /This was me<\/button>/);
  assert.match(html, /heard on 2 days — not yet repeated over time/, 'a refused inference is shown with its reason');
  assert.match(html, /not enough to say/);
  assert.match(html, /Marillion/);
  assert.match(html, /Podcasts &amp; audiobooks<\/strong>: (<!-- -->)?no source/);
  assert.ok(!/<svg|<canvas|<img|\bscore\s*[:=]?\s*\d|\d+\s*-?day streak|recommended for you/i.test(html), 'no art wall, charts, scores, streaks or feed');
});
