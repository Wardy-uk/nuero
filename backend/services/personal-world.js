'use strict';

/**
 * The personal half of the world model (Build 11E / 11F, 3 Oct 2026).
 *
 * Two entities the work model never needed, both DECLARED by Nick and folded
 * inside the `world-model` consumer (so a replay rebuilds them with everything
 * else, in log order):
 *
 *   companion   a non-human member of the household — Ember. From a vault
 *               note with frontmatter `type: pet`. NOT a Person: a dog has no
 *               address, team or 1-2-1, and a person rule must never reach her.
 *   goal        a goal or intention, from NEURO's own `goals` + `goal_links`
 *               tables (which only Nick writes, through /api/canonical/goals).
 *
 * ── Rules ───────────────────────────────────────────────────────────────────
 *  • Nothing here creates either. No goal is ever generated, suggested into
 *    existence or turned into a task; no pet is ever "detected" in a note.
 *  • A link from a goal to a task/commitment/person is explicit (goal_links).
 *    Wording never links anything.
 *  • Producers never throw (the obligation-sources contract): a failed publish
 *    costs the projection a refresh, never the write that triggered it.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../db/database');

const GOAL_STATUSES = Object.freeze(['active', 'paused', 'achieved', 'dropped']);
const COMPANION_FOLDERS = ['Companions', 'People'];

const slug = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const parse = (s, d = null) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

function _bus() { return require('./event-bus'); }
function _ck() { return require('./change-key'); }

function fingerprintOf(obj) {
  return crypto.createHash('sha256').update(_bus().canonicalJson(obj)).digest('hex').slice(0, 32);
}

function _safe(input, opts) {
  try { return _bus().publishEvent(input, opts); } catch (e) {
    console.warn(`[PersonalWorld] could not publish ${input && input.type}: ${e.message}`);
    return null;
  }
}

function _appendEvidence(json, eventId) {
  const list = parse(json, []);
  if (!list.includes(eventId)) list.push(eventId);
  return JSON.stringify(list.slice(-10));
}

// ── companions ──────────────────────────────────────────────────────────────

/** The declared payload for a pet note. PURE. Only what the note states. */
function companionPayload(name, notePath, fm) {
  const hh = String(fm.household || '').toLowerCase();
  const body = {
    companionId: `companion:${slug(name)}`,
    name,
    notePath,
    species: typeof fm.species === 'string' && fm.species ? fm.species : null,
    breed: typeof fm.breed === 'string' && fm.breed ? fm.breed : null,
    household: hh === 'true' ? true : hh === 'false' ? false : null,
    aliases: Array.isArray(fm.aliases) ? fm.aliases.filter(Boolean) : [],
  };
  return { ...body, fingerprint: fingerprintOf(body) };
}

/** Publish every pet note. An unreadable vault publishes NOTHING, with the reason. */
function publishCompanions({ vaultRoot = process.env.OBSIDIAN_VAULT_PATH, now = Date.now() } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : now;
  if (!vaultRoot) return { error: 'OBSIDIAN_VAULT_PATH is not set' };
  const { parseFrontmatter } = require('./world-sources');
  let notes = 0; let changed = 0; let readable = 0;
  for (const folder of COMPANION_FOLDERS) {
    let files;
    try { files = fs.readdirSync(path.join(vaultRoot, folder)).filter((f) => f.endsWith('.md') && !f.startsWith('_')); readable += 1; } catch { continue; }
    for (const f of files) {
      let text;
      try { text = fs.readFileSync(path.join(vaultRoot, folder, f), 'utf8').slice(0, 4000); } catch { continue; }
      const fm = parseFrontmatter(text);
      if (String(fm.type || '').toLowerCase() !== 'pet') continue;
      notes += 1;
      const payload = companionPayload(f.slice(0, -3), `${folder}/${f}`, fm);
      const held = _ck().latest('companion', payload.companionId, ['observation.companion.declared']);
      if (_ck().isUnchanged(held, payload.fingerprint)) continue;
      const r = _safe({
        type: 'observation.companion.declared',
        occurredAt: new Date(nowMs).toISOString(),
        source: { system: 'vault', recordId: payload.notePath },
        subject: { entityType: 'companion', entityId: payload.companionId },
        idempotencyKey: _ck().observationKey('companion-declared', payload.companionId, held, payload.fingerprint),
        payload,
      }, { now: nowMs });
      if (r && !r.duplicate) changed += 1;
    }
  }
  if (!readable) return { error: 'no companion folder readable (Companions/, People/)' };
  return { notes, changed };
}

function applyCompanion(ev) {
  const p = ev.payload;
  const cur = db.get('SELECT * FROM wm_companions WHERE companion_id = ?', [p.companionId]);
  db.run(`INSERT INTO wm_companions (companion_id, name, species, breed, note_path, household, aliases_json, provenance_kind,
            observed_at, evidence_json, fingerprint, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'fact', ?, ?, ?, ?)
          ON CONFLICT(companion_id) DO UPDATE SET name = excluded.name, species = excluded.species, breed = excluded.breed,
            note_path = excluded.note_path, household = excluded.household, aliases_json = excluded.aliases_json,
            observed_at = excluded.observed_at, evidence_json = excluded.evidence_json, fingerprint = excluded.fingerprint,
            updated_at = excluded.updated_at`,
  [p.companionId, p.name, p.species || null, p.breed || null, p.notePath,
    typeof p.household === 'boolean' ? (p.household ? 1 : 0) : null, JSON.stringify(p.aliases || []),
    ev.occurredAt, _appendEvidence(cur && cur.evidence_json, ev.eventId), p.fingerprint, ev.receivedAt]);
}

function shapeCompanion(r) {
  if (!r) return null;
  return {
    id: r.companion_id, kind: 'companion', entityType: 'pet', name: r.name, species: r.species, breed: r.breed,
    household: r.household === null ? null : r.household === 1, aliases: parse(r.aliases_json, []), notePath: r.note_path,
    provenance: { kind: r.provenance_kind, evidence: parse(r.evidence_json, []), notePath: r.note_path },
    observedAt: r.observed_at,
  };
}

function listCompanions() {
  return db.all('SELECT * FROM wm_companions ORDER BY name').map(shapeCompanion);
}

/**
 * Which companions an item MENTIONS, by exact whole-word name or alias. An
 * INFERENCE, labelled as one: it says "this mentions Ember", never "this is
 * Ember's" — a link Nick makes is the only fact. PURE.
 */
function mentions(text, companions) {
  const t = String(text || '');
  const out = [];
  for (const c of companions || []) {
    const names = [c.name, ...(c.aliases || [])].filter(Boolean);
    if (names.some((n) => new RegExp(`(^|[^A-Za-z])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z]|$)`, 'i').test(t))) {
      out.push({ id: c.id, name: c.name, basis: 'inference', rule: 'exact-name-mention' });
    }
  }
  return out;
}

// ── goals ───────────────────────────────────────────────────────────────────

/** The declared payload for one goal row and its links. PURE. */
function goalPayload(row, links = []) {
  const body = {
    goalId: row.goal_id,
    title: row.title,
    description: row.description || row.note || null,
    domains: parse(row.domains_json, []) || [],
    status: row.status === 'done' ? 'achieved' : row.status,
    importance: row.importance || null,
    startDate: row.start_date || null,
    reviewDate: row.review_date || null,
    lastReviewedAt: row.last_reviewed_at || null,
    links: [...links].map((l) => ({ entityId: l.entity_id, relation: l.relation || 'serves' }))
      .sort((a, b) => a.entityId.localeCompare(b.entityId)),
    provenance: row.provenance || 'nick',
  };
  return { ...body, fingerprint: fingerprintOf(body) };
}

/** Publish every goal (unchanged ones fold). Never throws. */
function publishGoals({ now = Date.now() } = {}) {
  try {
    const nowMs = now instanceof Date ? now.getTime() : now;
    const rows = db.all('SELECT * FROM goals ORDER BY created_at');
    const links = db.all('SELECT * FROM goal_links');
    let changed = 0;
    for (const r of rows) {
      const payload = goalPayload(r, links.filter((l) => l.goal_id === r.goal_id));
      const held = _ck().latest('goal', r.goal_id, ['intent.goal.declared']);
      if (_ck().isUnchanged(held, payload.fingerprint)) continue;
      const res = _safe({
        type: 'intent.goal.declared',
        occurredAt: new Date(nowMs).toISOString(),
        source: { system: 'neuro-goals', recordId: r.goal_id },
        subject: { entityType: 'goal', entityId: r.goal_id },
        idempotencyKey: _ck().observationKey('goal-declared', r.goal_id, held, payload.fingerprint),
        payload,
      }, { now: nowMs });
      if (res && !res.duplicate) changed += 1;
    }
    return { goals: rows.length, changed };
  } catch (e) {
    console.warn(`[PersonalWorld] goals not recorded: ${e.message}`);
    return { error: e.message };
  }
}

function applyGoal(ev) {
  const p = ev.payload;
  const cur = db.get('SELECT * FROM wm_goals WHERE goal_id = ?', [p.goalId]);
  db.run(`INSERT INTO wm_goals (goal_id, title, description, domains_json, status, importance, start_date, review_date,
            last_reviewed_at, links_json, provenance_kind, observed_at, evidence_json, fingerprint, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'fact', ?, ?, ?, ?)
          ON CONFLICT(goal_id) DO UPDATE SET title = excluded.title, description = excluded.description,
            domains_json = excluded.domains_json, status = excluded.status, importance = excluded.importance,
            start_date = excluded.start_date, review_date = excluded.review_date, last_reviewed_at = excluded.last_reviewed_at,
            links_json = excluded.links_json, observed_at = excluded.observed_at, evidence_json = excluded.evidence_json,
            fingerprint = excluded.fingerprint, updated_at = excluded.updated_at`,
  [p.goalId, p.title, p.description || null, JSON.stringify(p.domains || []), GOAL_STATUSES.includes(p.status) ? p.status : 'active',
    p.importance || null, p.startDate || null, p.reviewDate || null, p.lastReviewedAt || null, JSON.stringify(p.links || []),
    ev.occurredAt, _appendEvidence(cur && cur.evidence_json, ev.eventId), p.fingerprint, ev.receivedAt]);
}

function shapeGoal(r) {
  if (!r) return null;
  return {
    id: r.goal_id, kind: 'goal', title: r.title, description: r.description || null, status: r.status,
    domains: parse(r.domains_json, []).map((d) => ({ domain: d, basis: 'declared' })),
    importance: r.importance || null, startDate: r.start_date || null, reviewDate: r.review_date || null,
    lastReviewedAt: r.last_reviewed_at || null, links: parse(r.links_json, []),
    provenance: { kind: r.provenance_kind, declaredBy: 'nick', evidence: parse(r.evidence_json, []) },
    observedAt: r.observed_at, updatedAt: r.updated_at,
  };
}

function listWorldGoals({ status = 'active' } = {}) {
  const rows = status === 'all' ? db.all('SELECT * FROM wm_goals ORDER BY title')
    : db.all('SELECT * FROM wm_goals WHERE status = ? ORDER BY title', [status]);
  return rows.map(shapeGoal);
}

/** Active goals an entity is EXPLICITLY linked to. Paused/achieved/dropped never drive anything. */
function activeGoalsFor(entityId) {
  return listWorldGoals({ status: 'active' }).filter((g) => g.links.some((l) => l.entityId === entityId));
}

const TABLES = ['wm_goals', 'wm_companions'];
function reset() { for (const t of TABLES) db.run(`DELETE FROM ${t}`); }

// A write to goals schedules a publish shortly after (debounced), so the
// projection follows Nick's edit in seconds. Off in tests unless asked for.
let goalTimer = null;
function scheduleGoalPublish(delayMs = 1500) {
  if (process.env.NODE_TEST_CONTEXT && !process.env.OBLIGATION_PUBLISH_IN_TESTS) return;
  if (goalTimer) return;
  goalTimer = setTimeout(() => { goalTimer = null; publishGoals(); }, delayMs);
  if (goalTimer.unref) goalTimer.unref();
}

/**
 * Create a companion note from the Life page (5 Oct 2026). The vault note is
 * still the ONE source of truth — this only writes it for Nick, in the shape
 * publishCompanions already reads, then publishes. It never overwrites a note
 * that exists (a pet note is his writing), and an unreadable vault refuses.
 */
function yamlStr(s) { return JSON.stringify(String(s)); }
function createCompanion({ name, species, breed, household, vaultRoot = process.env.OBSIDIAN_VAULT_PATH, now = Date.now(), publish = true } = {}) {
  const clean = typeof name === 'string' ? name.trim().replace(/\s+/g, ' ') : '';
  if (!clean) return { ok: false, status: 400, error: 'a name is required' };
  if (clean.length > 60 || /[\\/:*?"<>|#^[\]\u0000-\u001f]/.test(clean) || clean.startsWith('.') || clean.startsWith('_')) {
    return { ok: false, status: 400, error: 'that name cannot be a note title' };
  }
  if (!vaultRoot || !path.isAbsolute(vaultRoot) || !fs.existsSync(vaultRoot)) {
    return { ok: false, status: 503, error: 'the vault is not reachable' };
  }
  const dir = path.join(vaultRoot, 'Companions');
  const file = path.join(dir, `${clean}.md`);
  if (fs.existsSync(file)) return { ok: false, status: 409, error: `Companions/${clean}.md already exists` };
  const opt = (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 60) : null);
  const lines = ['---', 'type: pet'];
  if (opt(species)) lines.push(`species: ${yamlStr(opt(species))}`);
  if (opt(breed)) lines.push(`breed: ${yamlStr(opt(breed))}`);
  if (household === true || household === false) lines.push(`household: ${household}`);
  lines.push(`created: ${new Date(now instanceof Date ? now.getTime() : now).toISOString().slice(0, 10)}`, '---', '', `# ${clean}`, '');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, lines.join('\n'), { flag: 'wx' });
  const published = publish ? publishCompanions({ vaultRoot, now }) : null;
  return { ok: true, notePath: `Companions/${clean}.md`, published };
}

module.exports = {
  GOAL_STATUSES, TABLES, createCompanion,
  companionPayload, goalPayload, mentions,
  publishCompanions, publishGoals, scheduleGoalPublish,
  applyCompanion, applyGoal, reset,
  listCompanions, shapeCompanion, listWorldGoals, shapeGoal, activeGoalsFor,
};
