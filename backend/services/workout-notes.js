'use strict';

/**
 * A hiking diary in the vault (2 Nov 2026). One note per tracked hike, in
 * `Personal/Hikes/YYYY/`. Nick's call: NEURO writes the stats and photos; the
 * note is his to annotate.
 *
 * ⚠ NEURO OWNS ONLY THE BLOCK BETWEEN ITS MARKERS. Everything outside it —
 *   frontmatter edits, his own paragraphs, a renamed heading — is never touched
 *   after the note is first written (vault-hygiene's surgical-write rule).
 * ⚠ A NOTE NICK DELETED STAYS DELETED. The ledger (`workout_notes`) remembers
 *   writing it; a missing file is reported, never recreated. Removing the block
 *   markers likewise stops NEURO writing to that note.
 * ⚠ Photos are COPIED into `media/` and embedded only while the switch
 *   `hike_note_photos` is on — off by default, because every copy goes through
 *   Obsidian Sync and its storage is a plan limit Nick decides.
 * ⚠ It only rebuilds a note when an INPUT changed (photos, weather, links, the
 *   track), because a full page read per hike per pass would hold the event loop.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = 'Personal/Hikes';
const OPEN = '<!-- neuro:hike-note — NEURO rewrites this block; write your own notes outside it -->';
const CLOSE = '<!-- /neuro:hike-note -->';
const PER_PASS = 8;

function _db() { return require('../db/database'); }
function _view() { return require('./workout-view'); }
function _photosOn() { try { return require('./feature-flags').isEnabled('hike_note_photos'); } catch { return false; } }

function _vault() {
  const v = process.env.OBSIDIAN_VAULT_PATH || '';
  if (!v || !path.isAbsolute(v) || !fs.existsSync(v)) return null;
  return v;
}

function _safe(s) { return String(s || '').replace(/[\\/:*?"<>|#^[\]]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80); }
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function longDay(day) { const d = new Date(`${day}T12:00:00Z`); return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`; }
function hm(sec) { if (sec == null) return '—'; const m = Math.round(sec / 60); return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`; }
function pace(sec) { return sec == null ? '—' : `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')} /km`; }
function km(m) { return m == null ? '—' : `${(m / 1000).toFixed(2)} km`; }

/** PURE. The block NEURO owns, from a workout-view page. */
function renderBlock(v, { photoEmbeds = [], linkBase = 'https://nuero.nickward.co.uk' } = {}) {
  const w = v.watch; const t = v.track || {};
  const L = [OPEN, ''];
  const where = [v.places.start && v.places.start.name, v.places.end && v.places.end.name && v.places.end.name !== (v.places.start && v.places.start.name) ? `to ${v.places.end.name}` : null].filter(Boolean).join(' ');
  L.push(`**${v.workout.startLocal.slice(11)}–${v.workout.endLocal.slice(11)}**${where ? ` · ${where}` : ''}${v.companions.length ? ` · with ${v.companions.map((c) => c.name).join(', ')}` : ''}`);
  L.push('');
  L.push('| | |', '|---|---|');
  L.push(`| Distance | ${km(w.distanceM ?? t.distanceM)} |`);
  L.push(`| Time | ${hm(w.durationSeconds)} (moving ${hm(t.movingSeconds)}) |`);
  L.push(`| Moving pace | ${pace(t.movingPaceSecPerKm)} |`);
  L.push(`| Ascent / descent | ${w.ascentM ?? t.ascentM ?? '—'} m / ${t.descentM ?? '—'} m |`);
  if (t.highest) L.push(`| Highest point | ${Math.round(t.highest.eleM)} m |`);
  if (v.heartRate && v.heartRate.known) L.push(`| Heart rate | avg ${v.heartRate.avg}, max ${v.heartRate.max} bpm |`);
  if (w.activeKcal != null) L.push(`| Active energy | ${w.activeKcal} kcal |`);
  if (v.body && v.body.steps != null) L.push(`| Steps | ${v.body.steps.toLocaleString('en-GB')} |`);
  if (v.weather && v.weather.state === 'ok') {
    const s = v.weather.summary;
    L.push(`| Weather | ${s.words || ''} ${s.tempMinC}–${s.tempMaxC} °C, wind to ${s.windMaxMph ?? '—'} mph, rain ${s.rainMm} mm |`);
  }
  if (v.routePlan && v.routePlan.name) L.push(`| Route plan | ${v.routePlan.name} |`);
  if (v.verdict && v.verdict.day) L.push(`| Hike weekly | ${v.verdict.counts ? 'counted' : `not counted — ${v.verdict.why}`} |`);
  L.push('');
  if (v.splits && v.splits.length) {
    L.push('**Splits**', '', '| km | time | pace | up | down | HR |', '|---|---|---|---|---|---|');
    for (const s of v.splits) L.push(`| ${s.km}${s.partial ? ` (${s.lengthM} m)` : ''} | ${hm(s.seconds).replace('0h ', '')} | ${pace(s.paceSecPerKm)} | ${s.ascentM} | ${s.descentM} | ${s.avgHr ?? '—'} |`);
    L.push('');
  }
  if (v.comparison && v.comparison.others.length) {
    L.push(`**Same route before:** ${v.comparison.others.slice(0, 5).map((o) => `${o.day} (${hm(o.durationSeconds)})`).join(', ')}`, '');
  }
  L.push(`[Open in NEURO — map, charts and photos](${linkBase}/?view=workout&id=${v.workout.id})`, '');
  if (photoEmbeds.length) { L.push(...photoEmbeds.map((p) => `![[${p}]]`), ''); }
  L.push(CLOSE);
  return L.join('\n');
}

/** PURE. A new note's full text. */
function renderNew(v, block) {
  const fm = [
    '---', 'type: hike', `date: ${v.workout.day}`, `workout_id: ${v.workout.id}`,
    `distance_km: ${v.watch.distanceM != null ? (v.watch.distanceM / 1000).toFixed(2) : ''}`,
    `ascent_m: ${v.watch.ascentM ?? (v.track && v.track.ascentM) ?? ''}`,
    `start: "${(v.places.start && v.places.start.name || '').replace(/"/g, '')}"`,
    'source: neuro', '---',
  ];
  return `${fm.join('\n')}\n# ${v.workout.title}, ${longDay(v.workout.day)}\n\n${block}\n\n## My notes\n\n`;
}

/** PURE. Replace NEURO's block inside existing text; null when the markers are gone. */
function replaceBlock(text, block) {
  const a = text.indexOf(OPEN.slice(0, 22));
  const b = text.indexOf(CLOSE);
  if (a < 0 || b < 0 || b < a) return null;
  return text.slice(0, a) + block + text.slice(b + CLOSE.length);
}

function _signature(id) {
  const db = _db();
  const photos = db.all('SELECT photo_id FROM workout_photos WHERE workout_id = ? AND removed_at IS NULL ORDER BY photo_id', [id]).map((r) => r.photo_id).join(',');
  const wx = db.get('SELECT state, fetched_at FROM workout_weather WHERE workout_id = ?', [id]);
  let links = '';
  try { links = db.all('SELECT relation, target_id FROM outdoor_activity_links WHERE activity_id = ? ORDER BY relation, target_id', [`workout:${id}`]).map((r) => `${r.relation}:${r.target_id}`).join(','); } catch { links = ''; }
  const w = db.get('SELECT h.distance_m, r.point_count FROM health_workouts h LEFT JOIN workout_routes r ON r.source_uuid = h.source_uuid WHERE h.id = ?', [id]);
  return crypto.createHash('sha256').update(JSON.stringify([photos, wx && wx.state, links, w && w.distance_m, w && w.point_count, _photosOn(), 2])).digest('hex').slice(0, 24);
}

function _mediaFor(vault, v) {
  if (!_photosOn() || !v.photos.length) return [];
  const rel = `${ROOT}/${v.workout.day.slice(0, 4)}/media`;
  fs.mkdirSync(path.join(vault, rel), { recursive: true });
  const out = [];
  for (const p of v.photos) {
    const src = _view().photoFile(p.id, 'full');
    if (!src) continue;
    const name = `${v.workout.day}-${p.id}.jpg`;
    const dest = path.join(vault, rel, name);
    if (!fs.existsSync(dest)) fs.copyFileSync(src, dest);
    out.push(`${rel}/${name}`);
  }
  return out;
}

/** Remove a removed photo's vault copy (it is Nick's decision that it goes everywhere). */
function dropMedia(workoutDay, photoId) {
  const vault = _vault();
  if (!vault || !workoutDay) return;
  try { fs.unlinkSync(path.join(vault, ROOT, workoutDay.slice(0, 4), 'media', `${workoutDay}-${photoId}.jpg`)); } catch { /* not copied */ }
}

/** Write or refresh one hike's note. */
function syncOne(id, { force = false } = {}) {
  const vault = _vault();
  if (!vault) return { ok: false, why: 'the vault path is not configured' };
  const db = _db();
  const sig = _signature(id);
  const led = db.get('SELECT path, block_hash FROM workout_notes WHERE workout_id = ?', [id]);
  if (led && led.block_hash === sig && !force) return { ok: true, unchanged: true, path: led.path };
  const v = _view().read(id);
  if (!v.ok || !v.workout.hike) return { ok: false, why: v.error || 'not a hike' };
  const block = renderBlock(v, { photoEmbeds: _mediaFor(vault, v) });
  const now = new Date().toISOString();
  if (led) {
    const file = path.join(vault, led.path);
    if (!fs.existsSync(file)) return { ok: false, gone: true, path: led.path, why: 'the note was deleted — NEURO does not recreate it' };
    const text = fs.readFileSync(file, 'utf8');
    const next = replaceBlock(text, block);
    if (next == null) return { ok: false, path: led.path, why: 'NEURO’s block markers were removed — the note is left alone' };
    if (next !== text) fs.writeFileSync(file, next);
    db.run('UPDATE workout_notes SET block_hash = ?, written_at = ? WHERE workout_id = ?', [sig, now, id]);
    return { ok: true, updated: next !== text, path: led.path };
  }
  const rel = `${ROOT}/${v.workout.day.slice(0, 4)}/${v.workout.day} ${_safe(v.workout.title)}.md`;
  const file = path.join(vault, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) {
    // A note already at that path (written by hand, or a previous NEURO install): adopt it only if it has our block.
    const text = fs.readFileSync(file, 'utf8');
    const next = replaceBlock(text, block);
    if (next == null) return { ok: false, path: rel, why: 'a note of that name already exists without NEURO’s block — left alone' };
    fs.writeFileSync(file, next);
  } else {
    fs.writeFileSync(file, renderNew(v, block), { flag: 'wx' });
  }
  db.run('INSERT INTO workout_notes (workout_id, path, block_hash, written_at) VALUES (?, ?, ?, ?)', [id, rel, sig, now]);
  return { ok: true, created: true, path: rel };
}

/** One pass over every tracked hike, oldest first, at most PER_PASS rebuilds. */
function sync({ max = PER_PASS } = {}) {
  if (!_vault()) return { ok: false, skipped: 'vault not configured' };
  const hikes = _view()._tracked().filter((w) => _view().isHike(w.activity_type, w.duration_seconds)).reverse();
  let rebuilt = 0; const out = [];
  for (const h of hikes) {
    if (rebuilt >= max) break;
    const r = syncOne(h.id);
    if (!r.unchanged) { rebuilt++; out.push({ id: h.id, ...r }); }
  }
  return { ok: true, hikes: hikes.length, rebuilt, results: out };
}

module.exports = { ROOT, OPEN, CLOSE, renderBlock, renderNew, replaceBlock, syncOne, sync, dropMedia };
