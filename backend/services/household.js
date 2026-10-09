'use strict';

/**
 * Who's in the house — the roster behind the household card (7 Oct 2026).
 *
 * Everyone comes from somewhere NEURO already holds; nothing is typed here:
 *   • Nick       — `person.nick`, via the presence projection (Build 13H).
 *   • residents  — Helen, Isaac  } HA's household sensor, which names each
 *   • visitors   — Lizzy, Daniel } member with a role and a state CLASS.
 *   • companions — Ember, from `wm_companions` (household) — not tracked.
 *
 * ⚠ States are home | away | unknown | untracked, and only as good as the
 * source: a failing or stale presence source makes everyone `unknown`, never
 * "away". No place name is ever returned — "At work" is the one exception, and
 * only for Nick, from the configured work-zone class.
 *
 * ⚠ PHOTOS NEVER GO IN THE REPO (it is public). They live in
 * HOUSEHOLD_PHOTO_DIR (default: a sibling of the checkout,
 * /mnt/data/neuro-household-photos on the Pi) as `<id>.jpg|png|webp`, and are
 * served only behind the PIN. A missing photo is `photo: null` and the card
 * draws an initial.
 */

const fs = require('fs');
const path = require('path');

const PHOTO_EXT = ['jpg', 'jpeg', 'png', 'webp'];

// People Nick wants on the card whom NOTHING tracks yet (9 Oct 2026). Matt is
// in the Life360 circle but deliberately outside HA's household sensor, so the
// house can never say he is in. Nick's call: show him, as out. ⚠ The moment HA
// reports a member with the same first name, the tracked entry wins and this
// one is dropped — a typed "out" must never overrule a measured "home".
const UNTRACKED_MEMBERS = [
  { id: 'matt', name: 'Matt', role: 'visitor', state: 'away' },
];
const ROLE_ORDER = { self: 0, resident: 1, visitor: 2, companion: 3 };

function photoDir() {
  return process.env.HOUSEHOLD_PHOTO_DIR || path.resolve(__dirname, '..', '..', '..', 'neuro-household-photos');
}

const slug = (s) => String(s || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** The photo file for an id, or null. Never throws. */
function photoFile(id) {
  if (!/^[a-z0-9-]{1,40}$/.test(String(id || ''))) return null;
  for (const ext of PHOTO_EXT) {
    const f = path.join(photoDir(), `${id}.${ext}`);
    try { const st = fs.statSync(f); if (st.isFile()) return { path: f, ext, version: Math.round(st.mtimeMs) }; } catch { /* next */ }
  }
  return null;
}

/**
 * PURE. Presence read + companions → the card's members, in a stable order.
 */
function compose(presence, companions = []) {
  const p = presence || {};
  const members = [];
  const nickClass = p.nick || 'unknown';
  members.push({
    id: 'nick', name: 'Nick', role: 'self',
    state: nickClass === 'home' ? 'home' : nickClass === 'unknown' ? 'unknown' : 'away',
    detail: nickClass === 'work' ? 'At work' : null,
  });
  for (const m of p.householdMembers || []) {
    if (!m || !m.name) continue;
    members.push({ id: slug(m.name), name: m.name, role: m.role, state: m.state, detail: null });
  }
  const firstNames = new Set(members.map((m) => String(m.name).trim().split(/\s+/)[0].toLowerCase()));
  for (const u of UNTRACKED_MEMBERS) {
    if (firstNames.has(u.name.toLowerCase())) continue;
    members.push({ ...u, detail: null, tracked: false });
  }
  for (const c of companions) {
    if (!c || !c.name) continue;
    members.push({ id: slug(c.name), name: c.name, role: 'companion', state: 'untracked', detail: c.species || null });
  }
  const seen = new Set();
  return members
    .filter((m) => m.id && !seen.has(m.id) && seen.add(m.id))
    .sort((a, b) => (ROLE_ORDER[a.role] - ROLE_ORDER[b.role]) || a.name.localeCompare(b.name));
}

function read({ now = Date.now() } = {}) {
  let presence = null;
  try { presence = require('./ha-presence').read({ now }); } catch { presence = null; }
  let companions = [];
  try {
    companions = require('../db/database').all('SELECT name, species FROM wm_companions WHERE household = 1 ORDER BY name');
  } catch { companions = []; }
  const members = compose(presence, companions).map((m) => {
    const f = photoFile(m.id);
    return { ...m, photo: f ? { version: f.version } : null };
  });
  const home = members.filter((m) => m.state === 'home');
  return {
    at: new Date(now).toISOString(),
    source: presence ? presence.source : { state: 'unknown', freshness: 'unknown' },
    known: !!(presence && presence.source && presence.source.state === 'healthy'),
    homeCount: home.length,
    members,
  };
}

module.exports = { UNTRACKED_MEMBERS, compose, read, photoFile, photoDir, slug };
