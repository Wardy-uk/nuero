'use strict';

/**
 * Leisure & media — the PURE half (Build 30, 9 Oct 2026). No DB, no network,
 * no clock: every "today" is passed in.
 *
 * What NEURO can actually see (measured on the Pi, 9 Oct 2026):
 *   • the iPhone's Music app (Apple Music + library) — one now-playing record,
 *     re-sent on track change and every wake. It cannot tell a chosen album
 *     from autoplay, and Spotify / Podcasts / video are invisible to it;
 *   • five HA media players — none reports a title, series or episode (Sky
 *     Glass gives power only), so they are HOUSEHOLD context, never Nick's taste;
 *   • Nick's own words: About Nick.md, and anything he adds or corrects here.
 *
 * Rules this file holds:
 *   • Playback is evidence, not preference. Passive listening can reach
 *     `interest` and never `strong_interest` — that needs Nick's word, because
 *     the only source cannot tell intent from autoplay.
 *   • Explicit beats passive, at the narrowest level he said it.
 *   • Completion needs evidence; inactivity is never abandonment.
 *   • Household / not-mine media never counts towards Nick's taste.
 */

const KINDS = Object.freeze(['tv_series', 'film', 'music_track', 'album', 'artist', 'playlist', 'podcast', 'audiobook', 'game', 'book', 'hobby', 'other']);
const KIND_LABELS = Object.freeze({
  tv_series: 'TV series', film: 'Film', music_track: 'Track', album: 'Album', artist: 'Artist', playlist: 'Playlist',
  podcast: 'Podcast', audiobook: 'Audiobook', game: 'Game', book: 'Book', hobby: 'Hobby', other: 'Other',
});
// `current` is never stored: it is a right-now fact from a fresh source.
const STATES = Object.freeze(['current', 'active', 'paused', 'completed', 'abandoned', 'saved', 'unknown']);
const STORED_STATES = Object.freeze(['active', 'paused', 'completed', 'abandoned', 'saved', 'unknown']);
const PREFERENCES = Object.freeze(['loved', 'liked', 'neutral', 'disliked', 'not-for-me']);
const OWNERSHIP = Object.freeze(['nick', 'household', 'not-mine']);
const AFFINITY = Object.freeze(['strong_interest', 'interest', 'unknown', 'disliked']);
const EVENT_KINDS = Object.freeze(['booked', 'release', 'session']);

// Kinds with a meaningful "next episode / chapter" progress.
const EPISODIC = new Set(['tv_series', 'podcast']);

/** Every correction Nick can make, and what it changes. */
const ACTIONS = Object.freeze({
  liked: { preference: 'liked' },
  loved: { preference: 'loved' },
  neutral: { preference: 'neutral' },
  disliked: { preference: 'disliked' },
  'not-for-me': { preference: 'not-for-me' },
  'clear-preference': { preference: null, wantMore: false },
  'want-more': { wantMore: true },
  'not-right-now': { snooze: true },
  completed: { state: 'completed' },
  paused: { state: 'paused' },
  dropped: { state: 'abandoned' },
  resume: { state: 'active' },
  save: { state: 'saved' },
  'not-mine': { ownership: 'not-mine' },
  'household-only': { ownership: 'household' },
  'this-was-me': { ownership: 'nick' },
  'remove-basis': { notBasis: true },
  'restore-basis': { notBasis: false },
  'next-episode': { nextEpisode: true },
});

// Thresholds — passive listening (see the header for why it caps at interest).
const INTEREST_MIN_DAYS = 3;            // distinct days heard in the last 30
const INTEREST_MIN_WEEKS = 2;           // …spread over at least two ISO weeks
const THREAD_MIN_DAYS = 2;              // an album heard on 2 of the last 7 days is a "listening thread"
const QUIET_AFTER_DAYS = 60;            // an active item untouched this long is "gone quiet" (not abandoned)
const CONTINUE_LIMIT = 5;
const RECENT_DAYS = 60;
const DAYS_KEPT = 90;                   // distinct days held per aggregate
const EPISODE_COMPLETE_FRACTION = 0.92; // a reliable source past this point finished the episode
const MIN_EPISODE_SECONDS = 300;

// A calendar title that SAYS it is a night out. Bounded on purpose: a title
// that merely contains "show" or "match" says nothing (work has "show-and-tell").
const EVENT_WORDS = [
  ['cinema', 'cinema'], ['theatre', 'theatre'], ['theater', 'theatre'], ['concert', 'concert'], ['gig', 'gig'],
  ['festival', 'festival'], ['panto', 'panto'], ['d&d', 'D&D'], ['dnd', 'D&D'], ['dungeons', 'D&D'],
  ['comedy club', 'comedy'], ['stand-up', 'comedy'], ['musical', 'musical'], ['opera', 'opera'], ['ballet', 'ballet'],
];

// Lines from About Nick.md shown VERBATIM as stated interests. Selecting which
// lines to show is all this does — it never turns a line into a preference.
const PROFILE_SECTIONS = ['outside work', 'what i care about', 'preferences'];
const PROFILE_WORDS = /\b(d&d|dnd|music|musical|album|albums|song|songs|band|marillion|film|films|movie|movies|tv|series|reading|read|book|books|novel|game|games|gaming|aquarium|aquariums|retro|maker|raspberry|cosplay|podcast|podcasts|audiobook|concert|gig)\b/i;

const norm = (s) => String(s || '').toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9&]+/g, ' ').trim();
const clip = (v, n) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null);
const isDay = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T12:00:00Z`))
  && new Date(`${s}T12:00:00Z`).toISOString().slice(0, 10) === s;
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400000);
const addDays = (d, n) => { const t = new Date(`${d}T12:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };

function isoWeek(day) {
  const d = new Date(`${day}T12:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dow + 3);
  const firstThu = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const wk = 1 + Math.round(((d - firstThu) / 86400000 - 3 + ((firstThu.getUTCDay() + 6) % 7)) / 7);
  return `${d.getUTCFullYear()}-W${String(wk).padStart(2, '0')}`;
}

// ── observations (aggregates) ────────────────────────────────────────────────

/** The aggregate keys a now-playing report touches. Track titles never key anything. */
function musicKeys({ artist, album } = {}) {
  const a = norm(artist);
  if (!a) return [];
  const out = [{ key: `music:artist:${a}`, kind: 'artist', title: clip(artist, 200), creator: null }];
  const al = norm(album);
  if (al) out.push({ key: `music:album:${a}|${al}`, kind: 'album', title: clip(album, 200), creator: clip(artist, 200) });
  return out;
}

/** Fold one sighting into a held list of distinct days. Idempotent per day; bounded. */
function foldDay(days = [], day) {
  if (!isDay(day)) return days.slice();
  const set = new Set(days.filter(isDay));
  set.add(day);
  return [...set].sort().slice(-DAYS_KEPT);
}

/**
 * Whether a now-playing report is a SIGHTING. Only `playing` counts: a paused
 * or stopped report says what was last loaded, not what was heard. A report
 * marked autoplay/background (no current source sets it, but a future one may)
 * is context, never evidence.
 */
function isSighting(report) {
  if (!report || report.state !== 'playing') return false;
  if (report.autoplay === true || report.background === true) return false;
  return !!(report.artist && String(report.artist).trim());
}

/**
 * An HA media_player read as a TV/speaker observation. Identity only when the
 * entity states series + numeric season + numeric episode; otherwise it is
 * context ("the TV is on") and never an item. Always HOUSEHOLD — a shared
 * screen cannot say who is watching.
 */
function tvObservation(entity) {
  if (!entity || typeof entity.entity_id !== 'string' || !entity.entity_id.startsWith('media_player.')) return null;
  const a = entity.attributes || {};
  const series = clip(a.media_series_title, 200);
  const season = Number.isInteger(Number(a.media_season)) && a.media_season !== '' && a.media_season != null ? Number(a.media_season) : null;
  const episode = Number.isInteger(Number(a.media_episode)) && a.media_episode !== '' && a.media_episode != null ? Number(a.media_episode) : null;
  const identity = !!(series && season != null && episode != null && season >= 0 && episode >= 1);
  const position = Number(a.media_position); const duration = Number(a.media_duration);
  return {
    entityId: entity.entity_id, name: a.friendly_name || entity.entity_id, state: entity.state,
    playing: entity.state === 'playing',
    identity,
    series: identity ? series : null, season: identity ? season : null, episode: identity ? episode : null,
    title: clip(a.media_title, 200),
    position: Number.isFinite(position) ? position : null, duration: Number.isFinite(duration) ? duration : null,
    positionUpdatedAt: a.media_position_updated_at || null,
    reportedComplete: a.media_completed === true,
    ownership: 'household',
    why: identity ? 'the player states series, season and episode' : 'the player reports no series/episode identity — context only',
  };
}

/**
 * Did an episode FINISH? Only on strong evidence from a reliable source.
 * Never: playback started, N minutes elapsed, the next episode appeared.
 */
function episodeCompletion({ reliable = false, reportedComplete = false, position = null, duration = null } = {}) {
  if (!reliable) return { complete: false, basis: 'unreliable', why: 'the source cannot identify the episode' };
  if (reportedComplete) return { complete: true, basis: 'source-reported', why: 'the player reported the episode complete' };
  if (Number.isFinite(position) && Number.isFinite(duration) && duration >= MIN_EPISODE_SECONDS && position / duration >= EPISODE_COMPLETE_FRACTION) {
    return { complete: true, basis: 'progress', why: `played to ${Math.round((100 * position) / duration)}% of the episode` };
  }
  return { complete: false, basis: 'in-progress', why: Number.isFinite(position) && Number.isFinite(duration) && duration > 0
    ? `${Math.round((100 * position) / duration)}% played — not enough to call it finished` : 'no reliable progress' };
}

/**
 * Nick's affinity for an artist / album. Explicit wins; ownership that is not
 * his excludes it; passive listening reaches `interest` at most.
 */
function affinity({ explicit = null, days = [], today } = {}) {
  if (explicit && explicit.ownership && explicit.ownership !== 'nick') {
    return { state: 'excluded', basis: explicit.ownership, why: explicit.ownership === 'household' ? 'you said this was household listening, not yours' : 'you said this was not yours' };
  }
  const pref = explicit && explicit.preference;
  if (pref === 'disliked' || pref === 'not-for-me') return { state: 'disliked', basis: 'you', why: pref === 'disliked' ? 'you said you dislike it' : 'you said it is not for you' };
  if (pref === 'loved' || pref === 'liked' || (explicit && explicit.wantMore)) {
    return { state: 'strong_interest', basis: 'you', why: pref === 'loved' ? 'you said you love it' : pref === 'liked' ? 'you said you like it' : 'you asked for more like it' };
  }
  const recent = (days || []).filter((d) => isDay(d) && today && daysBetween(d, today) >= 0 && daysBetween(d, today) < 30);
  const weeks = new Set(recent.map(isoWeek));
  const total = (days || []).filter(isDay).length;
  if (recent.length >= INTEREST_MIN_DAYS && weeks.size >= INTEREST_MIN_WEEKS) {
    return { state: 'interest', basis: 'repeated-listening', why: `heard on ${recent.length} days across ${weeks.size} weeks in the last 30 days — interest, not proof you like it` };
  }
  if (pref === 'neutral') return { state: 'unknown', basis: 'you', why: 'you said you are neutral on it' };
  if (total === 0) return { state: 'unknown', basis: 'none', why: 'never heard on a source NEURO can read' };
  return { state: 'unknown', basis: 'too-little', why: total === 1 ? 'heard on one day — one play is not interest' : `heard on ${recent.length || total} day${(recent.length || total) === 1 ? '' : 's'} — not yet repeated over time` };
}

// ── items ────────────────────────────────────────────────────────────────────

/** Validate an add/update. Returns { ok, fields } or { ok:false, error }. Omitted ≠ null. */
function validateItem(body = {}, { creating = false } = {}) {
  const f = {};
  if (creating || body.kind !== undefined) {
    if (!KINDS.includes(body.kind)) return { ok: false, error: `kind must be one of ${KINDS.join(', ')}` };
    f.kind = body.kind;
  }
  if (creating || body.title !== undefined) {
    const t = clip(body.title, 200);
    if (!t) return { ok: false, error: 'title is required' };
    f.title = t;
  }
  if (body.creator !== undefined) f.creator = body.creator === null ? null : clip(body.creator, 200);
  if (body.state !== undefined) {
    if (!STORED_STATES.includes(body.state)) return { ok: false, error: `state must be one of ${STORED_STATES.join(', ')} (current is never stored — it comes from a live source)` };
    f.state = body.state;
  }
  if (body.preference !== undefined) {
    if (body.preference !== null && !PREFERENCES.includes(body.preference)) return { ok: false, error: `preference must be one of ${PREFERENCES.join(', ')} or null` };
    f.preference = body.preference;
  }
  if (body.progress !== undefined) {
    if (body.progress === null) f.progress = null;
    else {
      const p = body.progress || {};
      const out = {};
      for (const k of ['season', 'episode', 'chapter']) {
        if (p[k] === undefined || p[k] === null) continue;
        if (!Number.isInteger(p[k]) || p[k] < 0 || p[k] > 10000) return { ok: false, error: `progress.${k} must be a whole number` };
        out[k] = p[k];
      }
      if (p.percent !== undefined && p.percent !== null) {
        if (!Number.isFinite(p.percent) || p.percent < 0 || p.percent > 100) return { ok: false, error: 'progress.percent must be 0–100' };
        out.percent = Math.round(p.percent);
      }
      f.progress = Object.keys(out).length ? out : null;
    }
  }
  if (body.eventDate !== undefined) {
    if (body.eventDate !== null && !isDay(body.eventDate)) return { ok: false, error: 'eventDate must be a real YYYY-MM-DD date' };
    f.eventDate = body.eventDate;
  }
  if (body.eventKind !== undefined) {
    if (body.eventKind !== null && !EVENT_KINDS.includes(body.eventKind)) return { ok: false, error: `eventKind must be one of ${EVENT_KINDS.join(', ')}` };
    f.eventKind = body.eventKind;
  }
  if (body.projectId !== undefined) {
    if (body.projectId !== null && (typeof body.projectId !== 'string' || !/^p:[a-z0-9-]{1,120}$/.test(body.projectId))) return { ok: false, error: 'projectId must be a project id (p:…)' };
    f.projectId = body.projectId;
  }
  if (body.notes !== undefined) f.notes = body.notes === null ? null : clip(body.notes, 1000);
  if (f.eventDate && !f.eventKind && body.eventKind === undefined && creating) f.eventKind = 'booked';
  return { ok: true, fields: f };
}

/** The state shown for a stored item — explicit, except that a long-quiet active item reads unknown. */
function effectiveState(item, { today } = {}) {
  if (!item) return { state: 'unknown', basis: 'none', why: 'nothing held' };
  if (item.state === 'active' && item.kind !== 'hobby' && today && item.lastTouchedAt) {
    const quiet = daysBetween(String(item.lastTouchedAt).slice(0, 10), today);
    if (quiet >= QUIET_AFTER_DAYS) {
      return { state: 'unknown', basis: 'gone-quiet', why: `you marked it active, and nothing has moved for ${quiet} days — NEURO does not call that abandoned` };
    }
  }
  const why = {
    active: 'you marked it as something you are into', paused: 'you paused it', completed: 'you marked it finished',
    abandoned: 'you dropped it', saved: 'you saved it for later', unknown: 'no state set',
  }[item.state] || 'no state set';
  return { state: item.state, basis: item.state === 'unknown' ? 'none' : 'you', why };
}

/**
 * A hobby's state. Nick's word wins when he gave one; an UNKNOWN hobby is
 * lifted to active only by real evidence — a linked project that is itself
 * active (meaningful progress in 30 days, per Build 24, never one file edit)
 * or a session he scheduled in the next fortnight.
 */
function hobbyState(item, { today, project = null } = {}) {
  if (item.state && item.state !== 'unknown') return effectiveState(item, { today });
  if (project && project.status === 'active') return { state: 'active', basis: 'project', why: `your linked project ${project.name} has meaningful progress in the last 30 days` };
  if (item.eventDate && item.eventKind === 'session' && today) {
    const d = daysBetween(today, item.eventDate);
    if (d >= 0 && d <= 14) return { state: 'active', basis: 'scheduled', why: `you have a session on ${item.eventDate}` };
  }
  if (project) return { state: 'unknown', basis: 'project-quiet', why: `your linked project ${project.name} shows no meaningful progress in the last 30 days (${project.status || 'status unknown'})` };
  return { state: 'unknown', basis: 'none', why: 'no state set and no linked evidence' };
}

function progressLine(kind, p) {
  if (!p) return null;
  if (p.season != null && p.episode != null) return `S${p.season} E${p.episode}`;
  if (p.episode != null) return `Episode ${p.episode}`;
  if (p.chapter != null) return `Chapter ${p.chapter}`;
  if (p.percent != null) return `${p.percent}%`;
  return null;
}

/** The next-episode progress after Nick says he watched the next one. */
function nextEpisode(progress) {
  const p = progress || {};
  return { ...p, episode: (Number.isInteger(p.episode) ? p.episode : 0) + 1 };
}

const snoozed = (item, today) => !!(item && item.snoozedUntil && today && item.snoozedUntil > today);

/**
 * Continue: a small list of what is genuinely in progress. Explicit active /
 * paused items Nick touched recently, plus an album he has been playing on
 * several of the last seven days. Completed, dropped, unknown, gone-quiet,
 * snoozed and not-his items never appear.
 */
function continueList({ items = [], albums = [], today, nowPlaying = null, limit = CONTINUE_LIMIT } = {}) {
  const out = [];
  for (const it of items) {
    if (it.kind === 'hobby' || it.ownership !== 'nick' || snoozed(it, today)) continue;
    const st = effectiveState(it, { today });
    if (st.state !== 'active' && st.state !== 'paused') continue;
    if (st.state === 'paused' && it.lastTouchedAt && daysBetween(String(it.lastTouchedAt).slice(0, 10), today) > RECENT_DAYS) continue;
    out.push({ ref: it.itemId, kind: it.kind, title: it.title, creator: it.creator || null, state: st.state,
      progress: progressLine(it.kind, it.progress), lastSeen: it.lastTouchedAt || null,
      why: st.state === 'paused' ? `you paused it${it.progress ? ` at ${progressLine(it.kind, it.progress)}` : ''}` : `you marked it active${it.progress ? `, at ${progressLine(it.kind, it.progress)}` : ''}`,
      basis: 'you' });
  }
  for (const al of albums) {
    if (al.affinity && (al.affinity.state === 'excluded' || al.affinity.state === 'disliked')) continue;
    if (al.explicit && (al.explicit.state === 'completed' || al.explicit.state === 'abandoned')) continue;
    const week = (al.days || []).filter((d) => isDay(d) && daysBetween(d, today) >= 0 && daysBetween(d, today) < 7);
    if (week.length < THREAD_MIN_DAYS) continue;
    if (out.some((o) => o.ref === al.ref || (al.explicit && o.ref === al.explicit.itemId))) continue;
    out.push({ ref: al.ref, kind: 'album', title: al.title, creator: al.creator, state: 'active', progress: null, lastSeen: al.lastSeen,
      why: `heard on the phone on ${week.length} of the last 7 days`, basis: 'listening' });
  }
  // Rank: what is playing right now first, then most recently touched.
  const playingAlbum = nowPlaying && nowPlaying.album ? norm(nowPlaying.album) : null;
  out.sort((a, b) => {
    const pa = playingAlbum && a.kind === 'album' && norm(a.title) === playingAlbum ? 1 : 0;
    const pb = playingAlbum && b.kind === 'album' && norm(b.title) === playingAlbum ? 1 : 0;
    if (pa !== pb) return pb - pa;
    return String(b.lastSeen || '').localeCompare(String(a.lastSeen || ''));
  });
  return out.slice(0, limit);
}

/** Recently finished or explicitly enjoyed — explicit only. Bounded. */
function recentlyEnjoyed({ items = [], today, limit = 8 } = {}) {
  return items
    .filter((it) => it.ownership === 'nick' && it.kind !== 'hobby')
    .map((it) => {
      const done = it.state === 'completed' && it.completedAt && daysBetween(String(it.completedAt).slice(0, 10), today) <= RECENT_DAYS;
      const liked = (it.preference === 'loved' || it.preference === 'liked') && it.updatedAt && daysBetween(String(it.updatedAt).slice(0, 10), today) <= RECENT_DAYS;
      if (!done && !liked) return null;
      return { ref: it.itemId, kind: it.kind, title: it.title, creator: it.creator || null, at: done ? it.completedAt : it.updatedAt,
        finished: !!done, preference: it.preference || null,
        why: [done ? 'you marked it finished' : null, it.preference === 'loved' ? 'you loved it' : it.preference === 'liked' ? 'you liked it' : null].filter(Boolean).join('; ') };
    })
    .filter(Boolean)
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))
    .slice(0, limit);
}

/** Nick's dislikes, at the narrowest level he gave: a creator he dislikes, or one exact title. */
function dislikeIndex(items = []) {
  const creators = new Set(); const titles = new Set();
  for (const it of items) {
    if (it.preference !== 'disliked' && it.preference !== 'not-for-me') continue;
    if (it.kind === 'artist') creators.add(norm(it.title));
    else titles.add(`${it.kind}|${norm(it.title)}`);
  }
  return { creators, titles };
}

/** Would a candidate be a close match to something Nick said he dislikes? */
function excludedByDislike(candidate, idx) {
  if (!candidate) return false;
  if (candidate.creator && idx.creators.has(norm(candidate.creator))) return true;
  if (candidate.kind === 'artist' && idx.creators.has(norm(candidate.title))) return true;
  return idx.titles.has(`${candidate.kind}|${norm(candidate.title)}`);
}

/**
 * Suggestions: sparse, explained, only from what NEURO already holds. NEURO has
 * no media catalogue, so it never invents a title — "discovery" is SAiM's job
 * when Nick asks, from the evidence returned beside this.
 *
 * Offered only when (a) Nick asked, or (b) there is a natural continuation:
 * the next episode of a series he marked active, or — right after he finished
 * something — the thing he saved for later. Never a feed; at most three.
 */
function suggestions({ items = [], today, asked = false, limit = 3 } = {}) {
  const idx = dislikeIndex(items);
  const usable = items.filter((it) => it.ownership === 'nick' && !it.notBasis && !snoozed(it, today) && it.kind !== 'hobby');
  const out = [];
  for (const it of usable) {
    if (!EPISODIC.has(it.kind) || effectiveState(it, { today }).state !== 'active') continue;
    if (!it.progress || it.progress.episode == null) continue;
    const next = nextEpisode(it.progress);
    out.push({ ref: it.itemId, kind: it.kind, title: it.title, creator: it.creator || null, type: 'continuation',
      line: `${it.title}: ${progressLine(it.kind, next)} next`,
      why: `you marked ${progressLine(it.kind, it.progress)} watched`, confidence: 'high' });
  }
  const justFinished = usable.some((it) => it.state === 'completed' && it.completedAt && daysBetween(String(it.completedAt).slice(0, 10), today) <= 3);
  if (asked || justFinished) {
    const saved = usable.filter((it) => it.state === 'saved').sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    for (const it of saved) {
      out.push({ ref: it.itemId, kind: it.kind, title: it.title, creator: it.creator || null, type: 'saved',
        line: `${it.title}${it.creator ? ` — ${it.creator}` : ''}`,
        why: justFinished ? 'you just finished something, and you saved this for later' : 'you saved this for later',
        confidence: 'medium' });
    }
  }
  return out.filter((s) => !excludedByDislike(s, idx)).slice(0, limit);
}

/** A calendar title that SAYS it is leisure. Returns the label it found, or null. */
function leisureEventFromTitle(title) {
  const t = ` ${String(title || '').toLowerCase()} `;
  for (const [w, label] of EVENT_WORDS) {
    const re = new RegExp(`(^|[^a-z])${w.replace(/[&-]/g, (c) => `\\${c}`)}([^a-z]|$)`);
    if (re.test(t)) return label;
  }
  return null;
}

/** Leisure-related lines from the profile, verbatim, with where they came from. */
function profileInterests(profile) {
  if (!profile || !profile.facts) return [];
  const seen = new Set(); const out = [];
  for (const [section, facts] of Object.entries(profile.facts)) {
    if (!PROFILE_SECTIONS.includes(section)) continue;
    for (const f of facts || []) {
      if (!PROFILE_WORDS.test(f.text) || seen.has(f.text)) continue;
      seen.add(f.text);
      out.push({ text: f.text, section, source: f.source, at: f.at || null });
    }
  }
  return out;
}

/** Can a correction apply to this thing? (Episode progress only on episodic kinds.) */
function correctionFits(kind, action) {
  if (!ACTIONS[action]) return `action must be one of ${Object.keys(ACTIONS).join(', ')}`;
  if (action === 'next-episode' && !EPISODIC.has(kind)) return 'next-episode only applies to a TV series or podcast';
  if (kind === 'artist' && ['completed', 'paused', 'dropped', 'resume', 'save'].includes(action)) {
    return 'an artist is not something you finish or pause — say how you feel about them instead';
  }
  return null;
}

module.exports = {
  KINDS, KIND_LABELS, STATES, STORED_STATES, PREFERENCES, OWNERSHIP, AFFINITY, EVENT_KINDS, ACTIONS,
  INTEREST_MIN_DAYS, INTEREST_MIN_WEEKS, THREAD_MIN_DAYS, QUIET_AFTER_DAYS, CONTINUE_LIMIT, DAYS_KEPT,
  EPISODE_COMPLETE_FRACTION,
  norm, isDay, daysBetween, addDays, isoWeek,
  musicKeys, foldDay, isSighting, tvObservation, episodeCompletion, affinity,
  validateItem, effectiveState, hobbyState, progressLine, nextEpisode, continueList, recentlyEnjoyed,
  dislikeIndex, excludedByDislike, suggestions, leisureEventFromTitle, profileInterests, correctionFits,
};
