'use strict';

/**
 * A personal deadline at risk — the first NON-WORK evaluator (Build 11H).
 *
 * Every evaluator before this one was about work: source blindness (whether
 * the senses work), commitment risk and meeting intelligence (promises and
 * meetings, overwhelmingly from Outlook and Plaud). Build 10 measured the
 * consequence: 0 personal tasks, 0 goals, and nothing that could ever notice
 * that something of Nick's own was about to slip.
 *
 * The question is deliberately narrow and groundable:
 *
 *   "Book Ember's booster" is in Reminders, due tomorrow, still open — and
 *    the list it is on is the one Nick classified as Ember.
 *
 * ── What qualifies (prefer false negatives) ────────────────────────────────
 *
 *   • an OPEN task or commitment from the world model
 *   • whose domain is EVIDENCED as non-work — declared on the item, the list
 *     or calendar Nick classified, a household flag, or a task Nick marked
 *     personal. Never "it came from the iPhone": source is not domain.
 *     Anything carrying the work domain is out, even alongside another.
 *   • with a date somebody STATED or SET (never NEURO's placeholder)
 *   • and one trigger:
 *       due-today      a stated/set date is today                 → high
 *       due-tomorrow   … is tomorrow                               → elevated
 *       overdue        a STATED date passed 1–14 days ago          → high
 *                      a SET date passed 1–2 days ago (recently;
 *                      a plan that slipped, not a broken promise)  → elevated
 *
 * Never on its own: age, the mere existence of an item, a missing date.
 * Held (recorded, not raised): a possible completion (a closed record with
 * the same wording — an inference, so the finding waits), a "not today" Nick
 * deferred in the lane.
 *
 * PersonalImportance is EXPLICIT only (the item's own, or an ACTIVE goal Nick
 * linked it to). It may lift elevated → high when he called it critical to
 * him; it never creates a finding by itself, and a paused goal lends nothing.
 *
 * ── Shadow only. There is no live path. ────────────────────────────────────
 *
 * PERSONAL_DEADLINE_MODE is `shadow` (default) or `off`; `live` reads as
 * shadow. At the moment it is found, the evaluator asks the EXISTING attention
 * policy (ambient-push.worthInterrupting, rule `personal-deadline`) what it
 * WOULD do, records the verdict, and stops. deliver() never offers this kind,
 * so the rule cannot win a push.
 *
 * ── Dedupe ─────────────────────────────────────────────────────────────────
 *
 * One finding per (subject, episode). Unchanged → nothing written. A higher
 * level → escalated, verdict asked again. Closed, completed or lapsed →
 * resolved. A later recurrence → a new episode. Every row stamps the
 * evaluator VERSION that produced it (Build 10 found nothing did).
 */

const crypto = require('crypto');
const db = require('../db/database');

const VERSION = 'build11h';
const OVERDUE_STATED_DAYS = 14;
const OVERDUE_SET_DAYS = 2;
const LEVELS = ['elevated', 'high'];
const EXPLICIT_NON_WORK = new Set(['declared', 'classified', 'set', 'intrinsic']);

function mode() {
  const m = String(process.env.PERSONAL_DEADLINE_MODE || 'shadow').toLowerCase();
  return m === 'off' ? 'off' : 'shadow';
}

/**
 * Is this item's domain EVIDENCED as non-work? PURE.
 * Returns { ok, why, basis } — the strongest basis that made it personal.
 */
function personalEvidence(domains) {
  if (!domains) return { ok: false, why: 'no domain evidence' };
  const list = domains.domains || [];
  if (list.some((d) => d.domain === 'work')) return { ok: false, why: 'carries the work domain' };
  const explicit = list.filter((d) => EXPLICIT_NON_WORK.has(d.basis));
  if (explicit.length) return { ok: true, basis: explicit[0].basis, domains: explicit.map((d) => d.domain) };
  // A task Nick (or the household link) marked personal: the sphere is known
  // even though which part of life is not.
  if (!list.length && domains.sphere === 'personal') return { ok: true, basis: 'sphere', domains: [] };
  return { ok: false, why: list.length ? 'its domain rests only on an inference' : 'domain unknown — not evidence it is personal' };
}

/**
 * The trigger for a due context (canonical-read.dueContext shape). PURE.
 * Returns { kind, level, detail } or null.
 */
function triggerFor(due) {
  if (!due || !due.date || due.days === null || due.days === undefined) return null;
  if (due.kind !== 'stated' && due.kind !== 'set') return null; // placeholder / unknown never
  const d = due.days;
  if (d === 0) return { kind: 'due-today', level: 'high', detail: 'due today' };
  if (d === 1) return { kind: 'due-tomorrow', level: 'elevated', detail: 'due tomorrow' };
  if (d < 0 && due.kind === 'stated' && -d <= OVERDUE_STATED_DAYS) return { kind: 'overdue', level: 'high', detail: `${-d} day${d === -1 ? '' : 's'} past a stated date` };
  if (d < 0 && due.kind === 'set' && -d <= OVERDUE_SET_DAYS) return { kind: 'overdue', level: 'elevated', detail: `${-d} day${d === -1 ? '' : 's'} past the date you set` };
  return null;
}

/**
 * Judge one canonical item (a shaped task or commitment). PURE given `extra`
 * (held facts the reader gathered: possible completion, a lane deferral).
 */
function assess(item, extra = {}) {
  if (!item) return { finding: false, why: 'nothing' };
  if (item.state !== 'open') return { finding: false, why: `not open (${item.state})` };
  const ev = personalEvidence(item.domains);
  if (!ev.ok) return { finding: false, excluded: true, why: ev.why };
  const trig = triggerFor(item.due);
  if (!trig) {
    const why = !item.due || !item.due.date ? 'no date' : item.due.kind === 'placeholder' ? 'NEURO placeholder date — not a deadline' : `no trigger (${item.due.label})`;
    return { finding: false, why };
  }
  if (extra.possibleCompletion) return { finding: false, held: true, why: 'a record with the same wording is closed — a possible completion, not raised until confirmed' };
  if (extra.deferral) return { finding: false, held: true, why: `deferred by Nick (${extra.deferral.reason || 'not today'})` };
  let level = trig.level;
  // Explicit importance may lift a finding; it never makes one.
  if (item.importance === 'critical-to-me' && level === 'elevated') level = 'high';
  const unavailable = extra.unavailable || [];
  const base = ev.basis === 'declared' ? 0.8 : ev.basis === 'classified' ? 0.75 : ev.basis === 'sphere' ? 0.6 : 0.7;
  const confidence = Math.max(0.3, Math.min(0.9, base - 0.05 * unavailable.length));
  return {
    finding: true, level, trigger: trig, evidenceBasis: ev.basis, domains: ev.domains,
    confidence: Math.round(confidence * 100) / 100, unavailable,
  };
}

/** One sentence, deterministic. States the facts; draws no conclusion, no advice. */
function summarise(item, a) {
  const what = `"${String(item.description || '').slice(0, 120)}"`;
  const where = item.container && item.container.name ? ` (${item.container.name})` : item.sourceLabel ? ` (${item.sourceLabel})` : '';
  const when = a.trigger.kind === 'overdue' ? `was due ${item.due.date}` : a.trigger.kind === 'due-today' ? 'is due today' : 'is due tomorrow';
  return `${what}${where} ${when}${item.due.time ? ` at ${item.due.time}` : ''} and is still open.`;
}

function _fp(x) { return crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex').slice(0, 24); }

const DEFAULT_DEPS = {
  items: (nowMs) => {
    const cr = require('./canonical-read');
    const tasks = cr.tasks({ now: nowMs }).items;
    const commitments = cr.commitments({ now: nowMs }).items;
    // A NEURO task that realises a commitment is evaluated once, as the commitment.
    const realised = new Set(commitments.map((c) => c.taskId).filter(Boolean));
    return [...commitments, ...tasks.filter((t) => !realised.has(t.id))];
  },
  task: (id) => require('./world-obligations').getTask(id),
  laneDeferral: (title) => {
    try {
      const lc = require('./attention-lifecycle');
      return lc.deferredKeys().get(lc.dedupeKeyFor({ type: 'todo', title })) || null;
    } catch { return undefined; }
  },
  readMoment: (nowMs) => require('./ambient-push').readMoment({ now: new Date(nowMs) }),
  projection: () => {
    const st = require('./event-bus').getStatus().consumers.find((x) => x.name === 'world-model');
    return { lag: st ? st.lag : null, retrying: st ? st.retrying : null };
  },
};

function _active(subjectId) {
  return db.get(`SELECT * FROM personal_deadline_findings WHERE subject_id = ? AND status = 'active'`, [subjectId]);
}

/** One pass. Returns counts. Never sends anything. */
async function evaluate({ now = Date.now(), deps = {} } = {}) {
  const d = { ...DEFAULT_DEPS, ...deps };
  const nowMs = now instanceof Date ? now.getTime() : now;
  const iso = new Date(nowMs).toISOString();
  const out = { mode: mode(), version: VERSION, considered: 0, excluded: 0, created: 0, escalated: 0, updated: 0, resolved: 0, decided: 0, held: 0, skipped: [] };
  if (out.mode === 'off') return out;

  let items;
  try { items = d.items(nowMs); } catch (e) { out.error = `world model unreadable: ${e.message}`; return out; }
  const unavailable = [];
  try {
    const p = d.projection();
    if (p.lag === null) unavailable.push({ input: 'projection', why: 'world-model consumer status unreadable' });
    else if (p.lag > 0 || p.retrying > 0) unavailable.push({ input: 'projection', why: `world model is ${p.lag} event(s) behind` });
  } catch { unavailable.push({ input: 'projection', why: 'unreadable' }); }

  const seen = new Set();
  for (const item of items) {
    out.considered += 1;
    seen.add(item.id);
    let possibleCompletion = null;
    if (item.kind === 'task') { try { const t = d.task(item.id); possibleCompletion = t ? t.possibleCompletion : null; } catch { /* unknown: not held */ } }
    const deferral = d.laneDeferral(item.description);
    const extraUnavailable = deferral === undefined ? [...unavailable, { input: 'lane-deferrals', why: 'attention lifecycle unreadable' }] : unavailable;
    const a = assess(item, { possibleCompletion, deferral: deferral || null, unavailable: extraUnavailable });
    if (a.excluded) out.excluded += 1;
    const existing = _active(item.id);
    if (!a.finding) {
      if (a.held) out.held += 1;
      if (existing) {
        db.run(`UPDATE personal_deadline_findings SET status = 'resolved', resolution = ?, resolved_at = ?, updated_at = ? WHERE finding_id = ?`,
          [a.held ? `held: ${a.why}` : `lapsed: ${a.why}`, iso, iso, existing.finding_id]);
        out.resolved += 1;
      }
      if ((a.held || existing) && out.skipped.length < 50) out.skipped.push({ subjectId: item.id, why: a.why });
      continue;
    }
    const summary = summarise(item, a);
    const why = `${a.trigger.kind}: ${a.trigger.detail}; personal on ${a.evidenceBasis} evidence`;
    const domainsJson = JSON.stringify(item.domains);
    const deadlineJson = JSON.stringify({ date: item.due.date, time: item.due.time || null, basis: item.due.kind, source: item.sourceLabel || item.provenance && item.provenance.source || null });
    const evidenceJson = JSON.stringify({ subject: { id: item.id, kind: item.kind, system: item.system || null }, container: item.container || null,
      evidenceBasis: a.evidenceBasis, importanceBasis: item.importanceBasis || null, goalIds: item.goalIds || [] });
    const fp = _fp([a.trigger.kind, a.level, item.due.date, item.importance || null, a.unavailable.map((u) => u.input)]);

    if (!existing) {
      const prior = db.get('SELECT MAX(episode) e FROM personal_deadline_findings WHERE subject_id = ?', [item.id]);
      const episode = (prior && prior.e ? prior.e : 0) + 1;
      db.run(`INSERT INTO personal_deadline_findings (finding_id, subject_id, episode, status, level, trigger_kind, summary, why,
                domains_json, deadline_json, importance, importance_basis, evidence_json, unavailable_json, confidence,
                evidence_fingerprint, novelty, evaluator_version, first_created_at, updated_at, decisions)
              VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?, ?, 0)`,
      [`personal-deadline:${item.id}:${episode}`, item.id, episode, a.level, a.trigger.kind, summary, why, domainsJson, deadlineJson,
        item.importance || null, item.importanceBasis || null, evidenceJson, JSON.stringify(a.unavailable), a.confidence, fp, VERSION, iso, iso]);
      out.created += 1;
      console.log(`[PersonalDeadline] (shadow) ${a.level}: ${summary}`);
    } else if (LEVELS.indexOf(a.level) > LEVELS.indexOf(existing.level)) {
      db.run(`UPDATE personal_deadline_findings SET level = ?, trigger_kind = ?, summary = ?, why = ?, domains_json = ?, deadline_json = ?,
                importance = ?, importance_basis = ?, evidence_json = ?, unavailable_json = ?, confidence = ?, evidence_fingerprint = ?,
                novelty = 'escalated', evaluator_version = ?, updated_at = ?, attention_decided_at = NULL WHERE finding_id = ?`,
      [a.level, a.trigger.kind, summary, why, domainsJson, deadlineJson, item.importance || null, item.importanceBasis || null, evidenceJson,
        JSON.stringify(a.unavailable), a.confidence, fp, VERSION, iso, existing.finding_id]);
      out.escalated += 1;
    } else if (existing.evidence_fingerprint !== fp) {
      db.run(`UPDATE personal_deadline_findings SET trigger_kind = ?, summary = ?, why = ?, domains_json = ?, deadline_json = ?,
                importance = ?, importance_basis = ?, evidence_json = ?, unavailable_json = ?, confidence = ?, evidence_fingerprint = ?,
                novelty = CASE WHEN novelty = 'new' THEN 'repeated' ELSE novelty END, evaluator_version = ?, updated_at = ? WHERE finding_id = ?`,
      [a.trigger.kind, summary, why, domainsJson, deadlineJson, item.importance || null, item.importanceBasis || null, evidenceJson,
        JSON.stringify(a.unavailable), a.confidence, fp, VERSION, iso, existing.finding_id]);
      out.updated += 1;
    }
    // Unchanged: nothing written. The same risk does not become a new finding.
  }

  // A subject that is no longer in the world model at all (removed, or now
  // closed and filtered out): its active finding is resolved by its own state.
  for (const f of db.all(`SELECT * FROM personal_deadline_findings WHERE status = 'active'`)) {
    if (seen.has(f.subject_id)) continue;
    db.run(`UPDATE personal_deadline_findings SET status = 'resolved', resolution = ?, resolved_at = ?, updated_at = ? WHERE finding_id = ?`,
      ['no-longer-open', iso, iso, f.finding_id]);
    out.resolved += 1;
  }

  // What the EXISTING attention policy would do — once per finding per level.
  // Shadow: recorded, never sent.
  const due = db.all(`SELECT * FROM personal_deadline_findings WHERE status = 'active' AND attention_decided_at IS NULL`);
  let moment = null; let momentErr = null;
  if (due.length) { try { ({ moment } = await d.readMoment(nowMs)); } catch (e) { momentErr = e.message; } }
  for (const f of due) {
    let decision;
    if (!moment) decision = { push: false, why: `could not read the moment: ${momentErr}` };
    else {
      const v = require('./ambient-push').worthInterrupting({ kind: 'personal-deadline', text: f.summary, level: f.level, findingId: f.finding_id }, moment);
      decision = { push: !!v.push, why: v.why || null, urgency: v.urgency || null, wouldSay: v.push ? v.message : null };
    }
    db.run(`UPDATE personal_deadline_findings SET attention_decided_at = ?, attention_json = ?, attention_mode = 'shadow',
              attention_level = level, decisions = decisions + 1, updated_at = ? WHERE finding_id = ?`,
    [iso, JSON.stringify({ ...decision, shadow: true, sent: false }), iso, f.finding_id]);
    out.decided += 1;
  }
  return out;
}

function findings({ status = null, limit = 50 } = {}) {
  const rows = status
    ? db.all('SELECT * FROM personal_deadline_findings WHERE status = ? ORDER BY updated_at DESC LIMIT ?', [status, limit])
    : db.all('SELECT * FROM personal_deadline_findings ORDER BY updated_at DESC LIMIT ?', [limit]);
  const j = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
  return rows.map((r) => ({
    findingId: r.finding_id, subjectId: r.subject_id, episode: r.episode, status: r.status, level: r.level,
    trigger: r.trigger_kind, novelty: r.novelty, summary: r.summary, why: r.why,
    domains: j(r.domains_json), deadline: j(r.deadline_json), importance: r.importance, importanceBasis: r.importance_basis,
    evidence: j(r.evidence_json), unavailable: j(r.unavailable_json), confidence: r.confidence,
    evaluatorVersion: r.evaluator_version,
    attention: r.attention_json ? { mode: r.attention_mode, decidedAt: r.attention_decided_at, level: r.attention_level, ...j(r.attention_json) } : null,
    firstCreatedAt: r.first_created_at, updatedAt: r.updated_at, resolvedAt: r.resolved_at, resolution: r.resolution,
  }));
}

module.exports = { VERSION, mode, personalEvidence, triggerFor, assess, summarise, evaluate, findings, OVERDUE_STATED_DAYS, OVERDUE_SET_DAYS };
