'use strict';

/**
 * Leisure & media (Build 30, 9 Oct 2026) — `leisure-v1`.
 *
 * Answers "what am I into, what am I partway through, what have I recently
 * enjoyed, what would be a good next thing" from what NEURO can actually see
 * (see leisure-model.js for the source audit). It is not a media library and
 * not a recommender: it holds Nick's explicit items and corrections
 * (leisure_items) and bounded per-day listening aggregates
 * (leisure_observations), and reads everything else live.
 *
 * ⚠ READS WRITE NOTHING. The only writers are: a now-playing report (folds a
 *   day into an aggregate), refresh() (a media player that states episode
 *   identity, pruning, source transitions), and Nick's own add/correct calls.
 * ⚠ NOTHING HERE NOTIFIES. Leisure reaches Needs You never on its own; a
 *   booking with a deadline is a task Nick makes, and personal obligations
 *   already decide when that needs him.
 */

const crypto = require('crypto');
const M = require('./leisure-model');

const CONTRACT = 'leisure-v1';
const SOURCE_STATE_KEY = 'leisure_source_state';
const PRUNE_AFTER_DAYS = 400;
const PHONE_SEEING_HOURS = 24;

function _db() { return require('../db/database'); }
const _iso = (ms) => new Date(ms).toISOString();
const _ms = (now) => (now instanceof Date ? now.getTime() : now);
const localDay = (ms) => require('./world-model').localMinute(ms).slice(0, 10);
const _json = (s, f) => { try { return s ? JSON.parse(s) : f; } catch { return f; } };

function _log(kind, detail, { subjectId = null, now, dedupeKey, actor = 'nick' } = {}) {
  return require('./personal-obligations').logEvent(kind, { subjectId, actor, detail, dedupeKey, now });
}

function rowToItem(r) {
  if (!r) return null;
  return {
    itemId: r.item_id, kind: r.kind, title: r.title, creator: r.creator || null, state: r.state,
    progress: _json(r.progress_json, null), preference: r.preference || null, wantMore: r.want_more === 1,
    ownership: r.ownership, notBasis: r.not_basis === 1, snoozedUntil: r.snoozed_until || null,
    eventDate: r.event_date || null, eventKind: r.event_kind || null, projectId: r.project_id || null,
    sourceRef: r.source_ref || null, notes: r.notes || null, completedAt: r.completed_at || null,
    lastTouchedAt: r.last_touched_at, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}
function rowToObs(r) {
  return {
    ref: r.obs_key, source: r.source, kind: r.kind, title: r.title, creator: r.creator || null, ownership: r.ownership,
    days: _json(r.days_json, []), firstSeen: r.first_seen, lastSeen: r.last_seen, progress: _json(r.progress_json, null),
  };
}

function listItems() { return _db().all('SELECT * FROM leisure_items ORDER BY updated_at DESC').map(rowToItem); }
function listObservations() { return _db().all('SELECT * FROM leisure_observations ORDER BY last_seen DESC').map(rowToObs); }

// ── writers: evidence ────────────────────────────────────────────────────────

/**
 * Fold a now-playing report into the per-day aggregates. Called by
 * now-playing.record AFTER it stored the report. Only a `playing` report with
 * an artist is a sighting; the track title is never kept here.
 */
function observeNowPlaying(report, { now = Date.now() } = {}) {
  if (!M.isSighting(report)) return { ok: true, folded: 0, why: 'not a sighting (only a playing report with an artist counts)' };
  const at = Date.parse(report.at);
  if (!Number.isFinite(at)) return { ok: false, folded: 0, why: 'no time on the report' };
  const day = localDay(at);
  const db = _db();
  let folded = 0;
  for (const k of M.musicKeys(report)) {
    const held = db.get('SELECT * FROM leisure_observations WHERE obs_key = ?', [k.key]);
    if (!held) {
      db.run(`INSERT INTO leisure_observations (obs_key, source, kind, title, creator, ownership, days_json, first_seen, last_seen)
              VALUES (?, 'phone-music', ?, ?, ?, 'nick-device', ?, ?, ?)`, [k.key, k.kind, k.title, k.creator, JSON.stringify([day]), day, day]);
      folded += 1; continue;
    }
    const days = _json(held.days_json, []);
    if (days.includes(day)) continue;
    const next = M.foldDay(days, day);
    db.run('UPDATE leisure_observations SET days_json = ?, last_seen = ? WHERE obs_key = ?',
      [JSON.stringify(next), next[next.length - 1] > held.last_seen ? next[next.length - 1] : held.last_seen, k.key]);
    folded += 1;
  }
  void now;
  return { ok: true, folded };
}

/**
 * Fold HA media players that state episode identity (none does today). Always
 * household. Records the day seen and, only when a reliable completion is
 * evidenced, the furthest episode finished.
 */
function observeMediaPlayers(states = [], { now = Date.now() } = {}) {
  const db = _db();
  const day = localDay(_ms(now));
  const seen = []; let folded = 0;
  for (const e of states || []) {
    const o = M.tvObservation(e);
    if (!o) continue;
    seen.push(o);
    if (!o.identity || !o.playing) continue;
    const key = `tv:series:${M.norm(o.series)}`;
    const done = M.episodeCompletion({ reliable: true, reportedComplete: o.reportedComplete, position: o.position, duration: o.duration });
    const held = db.get('SELECT * FROM leisure_observations WHERE obs_key = ?', [key]);
    const prev = held ? _json(held.progress_json, {}) : {};
    const progress = { season: o.season, episode: o.episode, completedThrough: prev.completedThrough || null };
    if (done.complete) {
      const c = prev.completedThrough;
      if (!c || o.season > c.season || (o.season === c.season && o.episode > c.episode)) progress.completedThrough = { season: o.season, episode: o.episode, basis: done.basis };
    }
    if (!held) {
      db.run(`INSERT INTO leisure_observations (obs_key, source, kind, title, creator, ownership, days_json, first_seen, last_seen, progress_json)
              VALUES (?, ?, 'tv_series', ?, NULL, ?, ?, ?, ?, ?)`, [key, `ha:${o.entityId}`, o.series, o.ownership, JSON.stringify([day]), day, day, JSON.stringify(progress)]);
    } else {
      db.run('UPDATE leisure_observations SET days_json = ?, last_seen = ?, progress_json = ? WHERE obs_key = ?',
        [JSON.stringify(M.foldDay(_json(held.days_json, []), day)), day, JSON.stringify(progress), key]);
    }
    folded += 1;
  }
  return { seen, folded };
}

// ── writers: Nick ────────────────────────────────────────────────────────────

function addItem(body = {}, { now = Date.now() } = {}) {
  const v = M.validateItem(body, { creating: true });
  if (!v.ok) return { ok: false, status: 400, error: v.error };
  const f = v.fields;
  const nowIso = _iso(_ms(now));
  const state = f.state || (f.kind === 'hobby' ? 'active' : 'unknown');
  const itemId = `leisure:${crypto.randomUUID()}`;
  _db().run(`INSERT INTO leisure_items (item_id, kind, title, creator, state, progress_json, preference, ownership, event_date, event_kind, project_id, notes, completed_at, last_touched_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'nick', ?, ?, ?, ?, ?, ?, ?, ?)`,
  [itemId, f.kind, f.title, f.creator || null, state, f.progress ? JSON.stringify(f.progress) : null, f.preference || null,
    f.eventDate || null, f.eventDate ? f.eventKind || 'booked' : null, f.projectId || null, f.notes || null,
    state === 'completed' ? nowIso : null, nowIso, nowIso, nowIso]);
  _log('leisure-item-added', { kind: f.kind, title: f.title, state, eventDate: f.eventDate || null, projectId: f.projectId || null },
    { subjectId: itemId, now: _ms(now), dedupeKey: `leisure-item-added:${itemId}` });
  return { ok: true, itemId, item: rowToItem(_db().get('SELECT * FROM leisure_items WHERE item_id = ?', [itemId])) };
}

/** Change fields on an item Nick owns (title, creator, progress, date, notes, project, state, preference). */
function updateItem(itemId, body = {}, { now = Date.now() } = {}) {
  const held = rowToItem(_db().get('SELECT * FROM leisure_items WHERE item_id = ?', [itemId]));
  if (!held) return { ok: false, status: 404, error: 'no such leisure item' };
  const v = M.validateItem(body, { creating: false });
  if (!v.ok) return { ok: false, status: 400, error: v.error };
  const f = v.fields;
  if (!Object.keys(f).length) return { ok: false, status: 400, error: 'nothing to change' };
  if (f.kind && f.kind !== held.kind) return { ok: false, status: 400, error: 'kind cannot change — add a new item instead' };
  const nowIso = _iso(_ms(now));
  const col = { title: 'title', creator: 'creator', state: 'state', preference: 'preference', eventDate: 'event_date', eventKind: 'event_kind', projectId: 'project_id', notes: 'notes' };
  const sets = []; const vals = [];
  for (const [k, c] of Object.entries(col)) if (f[k] !== undefined) { sets.push(`${c} = ?`); vals.push(f[k]); }
  if (f.progress !== undefined) { sets.push('progress_json = ?'); vals.push(f.progress ? JSON.stringify(f.progress) : null); }
  if (f.state === 'completed' && held.state !== 'completed') { sets.push('completed_at = ?'); vals.push(nowIso); }
  if (f.state && f.state !== 'completed') { sets.push('completed_at = NULL'); }
  if (f.eventDate === null) { sets.push('event_kind = NULL'); }
  else if (f.eventDate && !f.eventKind && !held.eventKind) { sets.push('event_kind = ?'); vals.push('booked'); }
  sets.push('last_touched_at = ?', 'updated_at = ?'); vals.push(nowIso, nowIso, itemId);
  _db().run(`UPDATE leisure_items SET ${sets.join(', ')} WHERE item_id = ?`, vals);
  const changed = Object.keys(f);
  _log('leisure-item-updated', { kind: held.kind, title: f.title || held.title, fields: changed, from: { state: held.state, preference: held.preference }, to: { state: f.state, preference: f.preference } },
    { subjectId: itemId, now: _ms(now), dedupeKey: `leisure-item-updated:${itemId}:${nowIso}` });
  return { ok: true, item: rowToItem(_db().get('SELECT * FROM leisure_items WHERE item_id = ?', [itemId])) };
}

/**
 * Apply one of Nick's corrections (liked, completed, not mine, …) to an item,
 * or to a listening aggregate — which then becomes an item bound to it, so his
 * word survives the aggregate changing. Audited every time.
 */
function correct(ref, action, { now = Date.now() } = {}) {
  const db = _db();
  const nowMs = _ms(now); const nowIso = _iso(nowMs);
  let item = null;
  if (typeof ref !== 'string' || !ref) return { ok: false, status: 400, error: 'ref is required' };
  if (ref.startsWith('leisure:')) {
    item = rowToItem(db.get('SELECT * FROM leisure_items WHERE item_id = ?', [ref]));
    if (!item) return { ok: false, status: 404, error: 'no such leisure item' };
  } else {
    const obs = db.get('SELECT * FROM leisure_observations WHERE obs_key = ?', [ref]);
    if (!obs) return { ok: false, status: 404, error: 'NEURO holds no listening or viewing record with that ref' };
    item = rowToItem(db.get('SELECT * FROM leisure_items WHERE source_ref = ?', [ref]));
    const bad0 = M.correctionFits(obs.kind, action);
    if (bad0) return { ok: false, status: 400, error: bad0 };
    if (!item) {
      const itemId = `leisure:${crypto.randomUUID()}`;
      const progress = obs.kind === 'tv_series' ? _json(obs.progress_json, null) : null;
      db.run(`INSERT INTO leisure_items (item_id, kind, title, creator, state, progress_json, ownership, source_ref, last_touched_at, created_at, updated_at)
              VALUES (?, ?, ?, ?, 'unknown', ?, ?, ?, ?, ?, ?)`,
      [itemId, obs.kind, obs.title, obs.creator, progress ? JSON.stringify({ season: progress.season, episode: progress.episode }) : null,
        obs.ownership === 'household' ? 'household' : 'nick', ref, nowIso, nowIso, nowIso]);
      item = rowToItem(db.get('SELECT * FROM leisure_items WHERE item_id = ?', [itemId]));
    }
  }
  const bad = M.correctionFits(item.kind, action);
  if (bad) return { ok: false, status: 400, error: bad };
  const a = M.ACTIONS[action];
  const sets = []; const vals = [];
  if (a.preference !== undefined) { sets.push('preference = ?'); vals.push(a.preference); }
  if (a.wantMore !== undefined) { sets.push('want_more = ?'); vals.push(a.wantMore ? 1 : 0); }
  if (a.state) {
    sets.push('state = ?'); vals.push(a.state);
    sets.push('completed_at = ?'); vals.push(a.state === 'completed' ? nowIso : null);
    sets.push('snoozed_until = NULL');
  }
  if (a.ownership) { sets.push('ownership = ?'); vals.push(a.ownership); }
  if (a.notBasis !== undefined) { sets.push('not_basis = ?'); vals.push(a.notBasis ? 1 : 0); }
  if (a.snooze) { sets.push('snoozed_until = ?'); vals.push(M.addDays(localDay(nowMs), 30)); }
  if (a.nextEpisode) { sets.push('progress_json = ?', 'state = ?'); vals.push(JSON.stringify(M.nextEpisode(item.progress)), item.state === 'completed' ? 'completed' : 'active'); }
  sets.push('last_touched_at = ?', 'updated_at = ?'); vals.push(nowIso, nowIso, item.itemId);
  db.run(`UPDATE leisure_items SET ${sets.join(', ')} WHERE item_id = ?`, vals);
  const after = rowToItem(db.get('SELECT * FROM leisure_items WHERE item_id = ?', [item.itemId]));
  _log('leisure-correction', {
    action, kind: item.kind, title: item.title, creator: item.creator,
    from: { state: item.state, preference: item.preference, ownership: item.ownership },
    to: { state: after.state, preference: after.preference, ownership: after.ownership },
    progress: a.nextEpisode ? M.progressLine(after.kind, after.progress) : undefined,
  }, { subjectId: item.itemId, now: nowMs, dedupeKey: `leisure-correction:${item.itemId}:${action}:${nowIso}` });
  return { ok: true, item: after };
}

// ── readers ──────────────────────────────────────────────────────────────────

function _projects(items, nowMs) {
  if (!items.some((i) => i.projectId)) return { map: new Map(), ok: true, needed: false };
  try {
    const m = require('./projects').read({ now: nowMs });
    return { map: new Map(m.projects.map((p) => [p.projectId, { name: p.name, status: p.status && p.status.status }])), ok: true, needed: true };
  } catch (e) { return { map: new Map(), ok: false, needed: true, why: e.message }; }
}

function _calendar(today, last) {
  try {
    const events = require('./future-radar').calendarEvents(today, last);
    return { ok: true, events: events.map((e) => ({ ...e, leisure: M.leisureEventFromTitle(e.title) })).filter((e) => e.leisure) };
  } catch (e) { return { ok: false, events: [], why: e.message }; }
}

function _sources({ nowMs, np, haStates, projects, profile, cal }) {
  const latest = np.latest;
  const ageH = latest && Number.isFinite(Date.parse(latest.at)) ? (nowMs - Date.parse(latest.at)) / 3600000 : null;
  const mp = (haStates || []).filter((e) => String(e.entity_id).startsWith('media_player.'));
  const withIdentity = mp.filter((e) => (M.tvObservation(e) || {}).identity);
  return [
    { id: 'phone-music', label: 'iPhone Music app', state: !latest ? 'never' : ageH <= PHONE_SEEING_HOURS ? 'seeing' : 'quiet',
      detail: !latest ? 'No now-playing report has ever arrived.'
        : `Last report ${ageH < 1 ? `${Math.max(0, Math.round(ageH * 60))} min` : `${Math.round(ageH)}h`} ago (${latest.state}). It reports only when the Music app plays, so quiet is normal — it cannot see Spotify, Podcasts or video.` },
    { id: 'tv-media', label: 'TV & speakers (Home Assistant)', state: haStates == null ? 'unreadable' : !mp.length ? 'none' : withIdentity.length ? 'identity' : 'context-only',
      detail: haStates == null ? 'Home Assistant states not read yet.'
        : `${mp.length} media player${mp.length === 1 ? '' : 's'}; ${withIdentity.length ? `${withIdentity.length} state episode identity` : 'none reports a title, series or episode'}. Shared screens are household context, never your taste.` },
    { id: 'apple-music-library', label: 'Apple Music library / history', state: 'unavailable', detail: 'NEURO has no Apple Music API connection. Only the phone\'s now-playing reaches it.' },
    { id: 'podcasts-audiobooks', label: 'Podcasts & audiobooks', state: 'unavailable', detail: 'No source: iOS apps cannot read the Podcasts app or Audible.' },
    { id: 'games', label: 'Games', state: 'unavailable', detail: 'No source: no console or game launcher reports to NEURO.' },
    { id: 'hobby-projects', label: 'Personal projects (for hobbies you link)', state: !projects.needed ? 'not-needed' : projects.ok ? 'ok' : 'unreadable',
      detail: !projects.needed ? 'No hobby is linked to a project.' : projects.ok ? 'Read for linked hobbies only.' : projects.why },
    { id: 'profile', label: 'About Nick (your stated interests)', state: profile.ok ? 'ok' : 'unreadable', detail: profile.ok ? 'Me/About Nick.md' : profile.why },
    { id: 'calendar', label: 'Phone calendars (bookings)', state: cal.ok ? 'ok' : 'unreadable', detail: cal.ok ? 'Entries whose title says cinema, theatre, gig, D&D…' : cal.why },
  ];
}

/** The whole Leisure view. Reads only. */
function read({ now = Date.now(), asked = false, haStates } = {}) {
  const nowMs = _ms(now);
  const today = localDay(nowMs);
  const gaps = [];
  let items = []; let observations = [];
  try { items = listItems(); } catch (e) { gaps.push({ input: 'items', why: e.message }); }
  try { observations = listObservations(); } catch (e) { gaps.push({ input: 'listening', why: e.message }); }
  const np = { current: null, latest: null };
  try { const n = require('./now-playing'); np.current = n.current({ now: nowMs }); np.latest = n.latest(); } catch (e) { gaps.push({ input: 'now-playing', why: e.message }); }
  let states = haStates;
  if (states === undefined) { try { states = require('./ha').cachedStates(); } catch { states = null; } }
  const projects = _projects(items, nowMs);
  let profile = { ok: false, why: 'not read' };
  try { profile = require('./profile').read(); } catch (e) { profile = { ok: false, why: e.message }; }
  const cal = _calendar(today, M.addDays(today, 60));

  const byRef = new Map(items.filter((i) => i.sourceRef).map((i) => [i.sourceRef, i]));
  const listen = observations.filter((o) => o.kind !== 'tv_series').map((o) => {
    const explicit = byRef.get(o.ref) || null;
    const aff = M.affinity({ explicit, days: o.days, today });
    return { ...o, explicit, affinity: aff, daysHeard: o.days.length, daysLast30: o.days.filter((d) => M.daysBetween(d, today) < 30).length };
  });
  const rank = { strong_interest: 0, interest: 1, unknown: 2, disliked: 3, excluded: 4 };
  const sortListen = (a, b) => (rank[a.affinity.state] - rank[b.affinity.state]) || (b.daysLast30 - a.daysLast30) || String(b.lastSeen).localeCompare(String(a.lastSeen));
  const artists = listen.filter((o) => o.kind === 'artist').sort(sortListen);
  const albums = listen.filter((o) => o.kind === 'album').sort(sortListen);
  const household = observations.filter((o) => o.ownership === 'household' && !(byRef.get(o.ref) && byRef.get(o.ref).ownership === 'nick'))
    .map((o) => ({ ref: o.ref, title: o.title, source: o.source, lastSeen: o.lastSeen, progress: o.progress, why: 'a shared screen — household viewing, not counted as yours until you say "this was me"' }));

  const shape = (it) => {
    const st = it.kind === 'hobby' ? M.hobbyState(it, { today, project: it.projectId ? projects.map.get(it.projectId) || null : null }) : M.effectiveState(it, { today });
    return { ref: it.itemId, kind: it.kind, kindLabel: M.KIND_LABELS[it.kind], title: it.title, creator: it.creator, state: st.state, stateBasis: st.basis, stateWhy: st.why,
      progress: M.progressLine(it.kind, it.progress), preference: it.preference, wantMore: it.wantMore, ownership: it.ownership, notBasis: it.notBasis,
      snoozedUntil: it.snoozedUntil, eventDate: it.eventDate, eventKind: it.eventKind, projectId: it.projectId,
      project: it.projectId ? projects.map.get(it.projectId) || null : null, sourceRef: it.sourceRef, lastSeen: it.lastTouchedAt, notes: it.notes };
  };
  const mine = items.filter((i) => i.ownership === 'nick');
  const hobbies = mine.filter((i) => i.kind === 'hobby').map(shape);
  const nonHobby = mine.filter((i) => i.kind !== 'hobby');
  const saved = nonHobby.filter((i) => i.state === 'saved').map(shape);
  const quiet = nonHobby.map(shape).filter((s) => s.state === 'unknown' && s.stateBasis === 'gone-quiet');
  const cont = M.continueList({ items: nonHobby, albums, today, nowPlaying: np.current });
  const enjoyed = M.recentlyEnjoyed({ items: nonHobby, today });
  const sugg = M.suggestions({ items: nonHobby, today, asked });

  const comingUp = [
    ...cal.events.map((e) => ({ ref: e.meetingId, title: e.title, date: e.day, time: e.time, kind: e.leisure, source: 'calendar', why: `in your "${e.calendarName || 'phone'}" calendar; its title says ${e.leisure}` })),
    ...items.filter((i) => i.ownership === 'nick' && i.eventDate && i.eventDate >= today && !['completed', 'abandoned'].includes(i.state))
      .map((i) => ({ ref: i.itemId, title: i.title, date: i.eventDate, time: null, kind: i.eventKind, source: 'you', why: i.eventKind === 'release' ? 'you are tracking its release' : i.eventKind === 'session' ? 'you scheduled a session' : 'you added this booking' })),
  ].sort((a, b) => `${a.date}${a.time || ''}`.localeCompare(`${b.date}${b.time || ''}`)).slice(0, 8);

  const preferences = {
    liked: items.filter((i) => ['loved', 'liked'].includes(i.preference) || i.wantMore).map((i) => ({ ref: i.itemId, kind: i.kind, title: i.title, creator: i.creator, preference: i.preference, wantMore: i.wantMore })),
    disliked: items.filter((i) => ['disliked', 'not-for-me'].includes(i.preference)).map((i) => ({ ref: i.itemId, kind: i.kind, title: i.title, creator: i.creator, preference: i.preference,
      scope: i.kind === 'artist' ? `this artist only — not the genre` : `this ${M.KIND_LABELS[i.kind].toLowerCase()} only` })),
  };

  const sources = _sources({ nowMs, np, haStates: states, projects, profile, cal });
  const tv = (states || []).filter((e) => String(e.entity_id).startsWith('media_player.')).map((e) => M.tvObservation(e))
    .filter((o) => o && ['on', 'playing', 'paused'].includes(o.state))
    .map((o) => ({ entityId: o.entityId, name: o.name, state: o.state, identity: o.identity, title: o.identity ? `${o.series} S${o.season}E${o.episode}` : null, ownership: o.ownership, why: o.why }));

  return {
    ok: true, contract: CONTRACT, asOf: _iso(nowMs), today,
    now: {
      // A phone clock a little ahead makes the age negative; it is "just now", never "-1 min".
      playing: np.current ? { title: np.current.title, artist: np.current.artist, album: np.current.album, app: np.current.app, source: 'phone-music', ageMinutes: Math.max(0, np.current.ageMinutes), ownership: 'nick-device' } : null,
      lastReport: np.latest ? { state: np.latest.state, at: np.latest.at, source: 'phone-music' } : null,
      tv,
    },
    comingUp,
    continue: cont,
    recentlyEnjoyed: enjoyed,
    hobbies,
    saved,
    quiet,
    listening: {
      artists: artists.slice(0, 12).map((o) => _listenOut(o)), albums: albums.slice(0, 12).map((o) => _listenOut(o)),
      counts: { artists: artists.length, albums: albums.length },
      since: observations.length ? observations.reduce((m, o) => (o.firstSeen < m ? o.firstSeen : m), observations[0].firstSeen) : null,
    },
    household,
    preferences,
    profile: { known: !!profile.ok, interests: profile.ok ? M.profileInterests(profile.profile) : [], why: profile.ok ? null : profile.why },
    suggestions: sugg,
    sources,
    gaps,
    rule: 'Playback is evidence, not preference. Only what you said, or what a source can actually identify, is shown; listening on its own never becomes "you love it", shared screens are never your taste, and nothing here interrupts you.',
  };
}

function _listenOut(o) {
  return { ref: o.ref, kind: o.kind, title: o.title, creator: o.creator, daysHeard: o.daysHeard, daysLast30: o.daysLast30, lastSeen: o.lastSeen,
    affinity: o.affinity.state, affinityBasis: o.affinity.basis, why: o.affinity.why, itemRef: o.explicit ? o.explicit.itemId : null };
}

/** One item or aggregate with only its relevant fields and why NEURO believes its state. */
function detail(ref, { now = Date.now() } = {}) {
  const v = read({ now });
  const all = [...v.continue, ...v.recentlyEnjoyed, ...v.hobbies, ...v.saved, ...v.quiet, ...v.listening.artists, ...v.listening.albums, ...v.household];
  const hit = all.find((x) => x.ref === ref);
  if (hit) return { ok: true, item: hit };
  const it = rowToItem(_db().get('SELECT * FROM leisure_items WHERE item_id = ?', [ref]));
  if (it) {
    const st = M.effectiveState(it, { today: v.today });
    return { ok: true, item: { ref: it.itemId, kind: it.kind, title: it.title, creator: it.creator, state: st.state, stateWhy: st.why, progress: M.progressLine(it.kind, it.progress), preference: it.preference, ownership: it.ownership, lastSeen: it.lastTouchedAt } };
  }
  return { ok: false, status: 404, error: 'no such leisure item' };
}

/** Radar: only dated things Nick told NEURO about — a booking, a tracked release, a hobby session. */
function radar({ today, last } = {}) {
  try {
    const rows = _db().all("SELECT * FROM leisure_items WHERE ownership = 'nick' AND event_date IS NOT NULL AND event_date >= ? AND event_date <= ? AND state NOT IN ('completed','abandoned')", [today, last]).map(rowToItem);
    return { items: rows.map((i) => ({ id: `radar:leisure:${i.itemId}`, itemId: i.itemId, title: i.eventKind === 'release' ? `Out: ${i.title}` : i.title, date: i.eventDate, eventKind: i.eventKind || 'booked',
      whyVisible: [i.eventKind === 'release' ? 'you are tracking its release in Life → Leisure' : i.eventKind === 'session' ? 'you scheduled this session in Life → Leisure' : 'you added this booking in Life → Leisure'] })) };
  } catch (e) { return { items: [], error: e.message }; }
}

/**
 * Now: what is playing (source-specific, fresh only) and a leisure booking
 * today or tomorrow. Never a backlog, never "you haven't watched anything".
 */
function nowBlock({ now = Date.now() } = {}) {
  const nowMs = _ms(now);
  const today = localDay(nowMs);
  const tomorrow = M.addDays(today, 1);
  let playing = null;
  try { const c = require('./now-playing').current({ now: nowMs }); if (c) playing = { title: c.title, artist: c.artist, source: 'phone-music' }; } catch { playing = null; }
  const soon = [];
  try {
    for (const e of require('./future-radar').calendarEvents(today, tomorrow)) {
      const l = M.leisureEventFromTitle(e.title);
      if (l && (e.day === today || e.day === tomorrow)) soon.push({ title: e.title, day: e.day, time: e.time, when: e.day === today ? 'today' : 'tomorrow', basis: `title says ${l}` });
    }
    for (const it of radar({ today, last: tomorrow }).items) soon.push({ title: it.title, day: it.date, time: null, when: it.date === today ? 'today' : 'tomorrow', basis: 'you added it' });
  } catch { /* calendar unreadable: nothing claimed */ }
  return { playing, soon, relevant: !!(playing || soon.length) };
}

/** What SAiM may lean on when Nick asks for a suggestion. Explicit first; dislikes travel with it. */
function chatView({ now = Date.now() } = {}) {
  const v = read({ now, asked: true });
  return {
    contract: CONTRACT, playing: v.now.playing, continue: v.continue, recentlyEnjoyed: v.recentlyEnjoyed, saved: v.saved,
    hobbies: v.hobbies.map((h) => ({ title: h.title, state: h.state, why: h.stateWhy })),
    liked: v.preferences.liked, disliked: v.preferences.disliked,
    listeningInterest: v.listening.artists.filter((a) => a.affinity === 'interest' || a.affinity === 'strong_interest').map((a) => ({ title: a.title, affinity: a.affinity, why: a.why })),
    statedInProfile: v.profile.interests.map((i) => i.text),
    suggestionsFromHeldItems: v.suggestions,
    notAvailable: v.sources.filter((s) => s.state === 'unavailable').map((s) => s.label),
    rules: [
      'Explain every suggestion: which liked item, listening or profile line it rests on, and how confident it is.',
      'Never suggest anything by a creator Nick disliked, and keep a dislike at the level he gave it (one artist is not a genre).',
      'Listening counts are interest, not proof he likes something. Household viewing is not his taste.',
      'Offer at most three, mixing a close continuation with one adjacent idea; only add a wildcard when he has several explicit likes.',
      'Do not turn any of this into a task or a reminder unless he asks.',
    ],
  };
}

// ── refresh (inside the personal-ops job) ────────────────────────────────────

async function refresh({ now = Date.now(), haStates } = {}) {
  const nowMs = _ms(now);
  const db = _db();
  let states = haStates;
  if (states === undefined) {
    try { states = await require('./ha').getStates(); } catch { try { states = require('./ha').cachedStates(); } catch { states = null; } }
  }
  const tv = states ? observeMediaPlayers(states, { now: nowMs }) : { seen: [], folded: 0 };
  const cutoff = M.addDays(localDay(nowMs), -PRUNE_AFTER_DAYS);
  const pruned = db.run('DELETE FROM leisure_observations WHERE last_seen < ?', [cutoff]);

  // Source transitions → Activity, on change only. The first run is a baseline.
  const v = read({ now: nowMs, haStates: states });
  const cur = Object.fromEntries(v.sources.map((s) => [s.id, s.state === 'quiet' ? 'seeing' : s.state]));
  const prev = _json(db.getState(SOURCE_STATE_KEY), null);
  let logged = 0;
  if (prev) {
    for (const [id, st] of Object.entries(cur)) {
      if (prev[id] === undefined || prev[id] === st) continue;
      const label = (v.sources.find((s) => s.id === id) || {}).label || id;
      if (_log('leisure-source-changed', { source: id, label, from: prev[id], to: st }, { actor: 'neuro', now: nowMs, dedupeKey: `leisure-source-changed:${id}:${prev[id]}>${st}:${_iso(nowMs).slice(0, 13)}` })) logged += 1;
    }
  }
  db.setState(SOURCE_STATE_KEY, JSON.stringify(cur));
  return { ok: true, tvFolded: tv.folded, pruned: pruned && pruned.changes ? pruned.changes : 0, logged, baseline: !prev };
}

module.exports = {
  CONTRACT, SOURCE_STATE_KEY,
  observeNowPlaying, observeMediaPlayers, addItem, updateItem, correct,
  read, detail, radar, nowBlock, chatView, refresh, listItems, listObservations,
};
