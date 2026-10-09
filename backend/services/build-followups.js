'use strict';

/**
 * Build 23AH — the open user-action ledger.
 *
 * From Build 23 on, anything a build leaves for Nick to do becomes (or
 * updates) a REAL NEURO task. A follow-up written only in a build note, a gap
 * analysis or a handoff is one nobody does — Build 21's "ten minutes" list sat
 * in a vault note for a day while its owner forgot it existed.
 *
 * Rules:
 *   • A follow-up has a stable `key`; the ledger (agent_state) maps key → task.
 *   • Before creating, match against existing tasks: an OPEN one is reused, a
 *     DONE/DROPPED one means it is already resolved and is never recreated.
 *   • A created task records its source build (source 'build-followup', the
 *     build and key in its notes and origin detail).
 *   • `verify` is the acceptance check: a follow-up with no task fails.
 */

const LEDGER_KEY = 'build_followups';
const OPEN = new Set(['open', 'in-progress']);

function _db() { return require('../db/database'); }
function _ledger() { try { return JSON.parse(_db().getState(LEDGER_KEY) || '{}') || {}; } catch { return {}; } }
function _setLedger(l) { _db().setState(LEDGER_KEY, JSON.stringify(l)); }

function validate(f) {
  if (!f || typeof f !== 'object') return 'a follow-up must be an object';
  if (!/^[a-z0-9][a-z0-9-]{2,80}$/.test(String(f.key || ''))) return 'a follow-up needs a key (lowercase, hyphens)';
  if (!(typeof f.title === 'string' && f.title.trim().length >= 5)) return `follow-up ${f.key}: a title is needed`;
  if (!/^Build \d+/.test(String(f.build || ''))) return `follow-up ${f.key}: the source build is needed ("Build 23")`;
  return null;
}

/**
 * Best existing match for a follow-up's wording (and any alternative wordings).
 * Exact wording first. The fuzzy scorer measures containment of the SHORTER
 * side, so "Reconnect my NatWest accounts…" scores 1.0 inside "Ask Helen to
 * reconnect her NatWest account…" — live 8 Oct 2026 it claimed Nick's task for
 * Helen's. So: exact first, and a task one follow-up claimed is not offered to
 * the next (`claimed`).
 */
function _match(f, rows, claimed = new Set()) {
  const dedupe = require('./task-dedupe');
  const { dedupeKey } = require('./task-store');
  const pool = rows.filter((r) => !claimed.has(r.id));
  const texts = [f.title, ...(f.alsoMatches || [])];
  for (const t of texts) {
    const k = dedupeKey(t);
    const exact = pool.find((r) => dedupeKey(r.text) === k);
    if (exact) return { row: exact, score: 1, exact: true };
  }
  let best = null;
  for (const t of texts) {
    const hit = dedupe.findEquivalent(t, pool.map((r) => r.text), { minScore: dedupe.INTERNAL_MIN_SCORE });
    if (hit && (!best || hit.score > best.score)) best = { row: pool[hit.index], score: hit.score };
  }
  return best;
}

/**
 * Reconcile a build's follow-ups into tasks. `apply:false` (the default)
 * reports what WOULD happen and writes nothing.
 * Outcome per follow-up: exists | reused | resolved | created | would-create | invalid.
 */
function reconcile(followups = [], { apply = false, now = Date.now() } = {}) {
  const db = _db();
  const store = require('./task-store');
  const ledger = _ledger();
  const all = db.listTaskRows({ status: 'all' });
  const open = all.filter((r) => OPEN.has(r.status));
  const closed = all.filter((r) => !OPEN.has(r.status));
  const out = [];
  const claimed = new Set(Object.values(ledger).map((e) => e.taskId));
  // Exact wording claims first, for the whole list, so a fuzzy match for one
  // follow-up can never take the task another follow-up names exactly.
  const exactFor = new Map();
  const { dedupeKey } = store;
  for (const f of followups) {
    if (validate(f) || ledger[f.key]) continue;
    const keys = [f.title, ...(f.alsoMatches || [])].map(dedupeKey);
    const hit = open.find((r) => !claimed.has(r.id) && keys.includes(dedupeKey(r.text)));
    if (hit) { exactFor.set(f.key, { row: hit, score: 1, exact: true }); claimed.add(hit.id); }
  }
  for (const f of followups) {
    const bad = validate(f);
    if (bad) { out.push({ key: f && f.key, outcome: 'invalid', why: bad }); continue; }
    const held = ledger[f.key] ? db.getTaskRow(ledger[f.key].taskId) : null;
    if (held) {
      out.push({ key: f.key, outcome: OPEN.has(held.status) ? 'exists' : 'resolved', taskId: held.id, status: held.status, text: held.text });
      continue;
    }
    const o = exactFor.get(f.key) || _match(f, open, claimed);
    if (o && !o.exact) claimed.add(o.row.id);
    if (o) {
      if (apply) ledger[f.key] = { taskId: o.row.id, build: f.build, linkedAt: new Date(now).toISOString(), how: 'reused' };
      out.push({ key: f.key, outcome: 'reused', taskId: o.row.id, text: o.row.text, score: Math.round(o.score * 100) / 100 });
      continue;
    }
    const c = _match(f, closed, claimed);
    if (c) {
      claimed.add(c.row.id);
      if (apply) ledger[f.key] = { taskId: c.row.id, build: f.build, linkedAt: new Date(now).toISOString(), how: 'already-resolved' };
      out.push({ key: f.key, outcome: 'resolved', taskId: c.row.id, status: c.row.status, text: c.row.text });
      continue;
    }
    if (!apply) { out.push({ key: f.key, outcome: 'would-create', text: f.title }); continue; }
    const r = store.createTask({
      text: f.title.trim(), source: 'build-followup', domain: f.domain || 'personal', due_date: f.dueDate || null,
      notes: [f.why || null, `From ${f.build} (follow-up: ${f.key}).`].filter(Boolean).join('\n\n'),
      originDetail: { build: f.build, followup: f.key }, skipExport: false,
    });
    // Build 25V: a follow-up that is personal ADMIN says so, so it lands in
    // Personal admin rather than as a bare "personal" task. Only on a task this
    // call created — an existing task's domain is never overwritten.
    if (r.created && Array.isArray(f.lifeDomains) && f.lifeDomains.length) {
      try { require('./canonical-read').setAnnotation(`task:neuro:${r.id}`, { domains: f.lifeDomains }, { now }); } catch (e) { console.warn('[BuildFollowups] domain not set:', e.message); }
    }
    ledger[f.key] = { taskId: r.id, build: f.build, linkedAt: new Date(now).toISOString(), how: r.created ? 'created' : 'folded' };
    out.push({ key: f.key, outcome: r.created ? 'created' : 'reused', taskId: r.id, text: r.task && r.task.text });
  }
  if (apply) {
    _setLedger(ledger);
    // Build 24: a follow-up that names its project is LINKED to it — explicit,
    // so it reads as that project's task. The task keeps its own domain.
    for (const f of followups) {
      const held = f.projectId && ledger[f.key];
      if (!held) continue;
      db.run("INSERT OR IGNORE INTO project_task_links (project_id, task_id, state, set_at) VALUES (?, ?, 'linked', ?)", [f.projectId, held.taskId, new Date(now).toISOString()]);
    }
  }
  return { ok: true, applied: !!apply, results: out };
}

/** Acceptance: every follow-up must have a task (open, or resolved). */
function verify(followups = []) {
  const ledger = _ledger();
  const db = _db();
  const missing = followups.filter((f) => !(ledger[f.key] && db.getTaskRow(ledger[f.key].taskId))).map((f) => f.key);
  return { ok: missing.length === 0, missing };
}

/**
 * Nick-owned follow-ups known at the end of Build 23. Wording is what Nick
 * would see on his task list; `alsoMatches` catches tasks he already wrote in
 * his own words.
 */
const BUILD_23 = Object.freeze([
  { key: 'reconnect-nick-natwest', build: 'Build 23', title: 'Reconnect my NatWest accounts to Tally via TrueLayer',
    why: "Both NatWest connections stopped refreshing on 27 Jun 2026. Finance in NEURO shows reconnect required until the feed is re-approved at NatWest. Tally backfills from each account's newest transaction; NEURO then measures relink, backfill and gaps." },
  { key: 'helen-reconnect-natwest', build: 'Build 23', title: 'Ask Helen to reconnect her NatWest account in Tally via TrueLayer',
    why: "Helen's account needs her own approval. Until then household finance stays partial." },
  { key: 'classify-personal-admin-list', build: 'Build 23', title: 'Classify and track the new Personal Admin Apple Reminders list in NEURO',
    why: 'The list reached NEURO on 8 Oct 2026. Life → Reminder lists: set it as Admin and Track it. NEURO never infers that from the name.' },
  { key: 'captur-basics', build: 'Build 23', title: 'Fill in the Captur basics in NEURO: registration, current mileage, MOT, tax and insurance',
    why: 'Life → Vehicle. Real or official values only.' },
  { key: 'link-mot-task-captur', build: 'Build 23', title: 'Link the existing car MOT booking task to the Renault Captur in NEURO' },
  { key: 'review-vehicle-spend', build: 'Build 23', title: "Review and confirm Tally's pending vehicle-spend transactions and merchant rules" },
  { key: 'build18-native-proof', build: 'Build 23', title: 'Complete the remaining Build 18 native iPhone proof with Claude',
    why: 'docs/build-18-mac-runbook.md: rebuild NEURO iOS from a clean tree, confirm /api/setup/native, read the CLMonitor assertion before re-enabling geofences.' },
]);

/**
 * Nick-owned follow-ups at the end of Build 24 (personal projects). Only what
 * NEURO genuinely cannot do for him: saying whose a project is, and confirming
 * repo links it could only call `likely`. Personal domain, never work.
 */
const BUILD_24 = Object.freeze([
  { key: 'classify-projects', build: 'Build 24', title: 'Say whose each project is (personal, work or other) on NEURO Life → Personal projects',
    why: 'NEURO only knows NOVA is work (your rule) and Hill Bagging is a side project (its tag). Every other project stays out of Personal projects until you classify it. One tap each, under "Whose are these?".' },
  { key: 'confirm-project-repo-links', build: 'Build 24', title: 'Confirm or reject the likely repo links on NEURO Life → Personal projects',
    why: 'A repo whose name only matches a project (One More Hill ↔ onemorehill, VANTAGE ↔ vantage, D&D ↔ DandD) is shown as likely and never drives a project\'s state until you confirm it.' },
]);

/**
 * Build 25 (personal admin). The Personal Admin Reminders list has been
 * tracked since 8 Oct 2026 and holds nothing, so NEURO has no admin of
 * Nick's own to show — only build follow-ups. Filling it is his; NEURO never
 * invents a renewal. The Captur dates and the MOT task link are Build 23's
 * (#383, #384) and are reused, not repeated.
 */
const BUILD_25 = Object.freeze([
  { key: 'fill-personal-admin-list', build: 'Build 25', lifeDomains: ['admin'],
    title: 'Put your real personal admin into the Personal Admin Reminders list, with due dates',
    why: 'Renewals, bookings, forms, appointments — one reminder each, with its date. NEURO reads that list (tracked since 8 Oct 2026) and shows it on Life → Personal admin; it is empty today, so there is nothing of yours to show. Car dates go on the Vehicle card instead (#383).' },
]);

// Build 26 (9 Oct 2026) — Tally finance intelligence. Only what Tally cannot know or do without Nick;
// a passive observation (spending up, a price change, an unusual payment) is never a task.
const BUILD_26 = Object.freeze([
  { key: 'categorise-summer-spending', build: 'Build 26', lifeDomains: ['finance'],
    title: 'Categorise the uncategorised July–August spending in Tally (Outlook → Category trends needs 70%)',
    why: 'Tally compares categories only when at least 70% of a month\'s spending carries one. September is 88%, but July (29%) and August (34%) are mostly uncategorised, so Tally cannot say which kinds of spending changed. Categorising in Tally — "Always" makes a merchant rule — fixes it for good.' },
  { key: 'record-annual-bills-tally', build: 'Build 26', lifeDomains: ['finance'],
    title: 'Record the household\'s known annual bills and renewals as planned payments in Tally → Outlook',
    why: 'Tally\'s forward view only knows a payment once it has seen it three times, so an annual bill (car insurance, TV licence, breakdown cover) is invisible to it until it lands. A planned payment puts it in the 7/14/30-day view and stops it being called unusual when it arrives.' },
]);

// Build 27: the Captur's remaining facts. The first REUSES #383 (same words);
// registration and the MOT date are already in, mileage, tax and insurance are not.
const BUILD_27 = Object.freeze([
  { key: 'captur-basics', build: 'Build 27', lifeDomains: ['travel', 'admin'],
    title: 'Fill in the Captur basics in NEURO: registration, current mileage, MOT, tax and insurance',
    why: 'Registration and the MOT date are recorded. Without the current mileage nothing per mile can be worked out; without the tax and insurance dates the car\'s health reads "incomplete", and neither can reach the Radar before it is due.' },
  { key: 'mot-booking-as-action', build: 'Build 27', lifeDomains: ['travel', 'admin'],
    title: 'Make "Book my car in for its MOT" the Captur MOT\'s action in Life → Transport → Dates (or tick it if the MOT is booked)',
    why: 'The booking task is linked to the Captur but not to its MOT date, so Personal Admin shows both. One press ("Make it the MOT\'s action") folds them into one item; ticking the booking never closes the MOT itself.' },
]);

// Build 28 (9 Oct 2026): home intelligence. The audit found four sockets offline
// since 15–27 Sep — a decision only Nick can make (reconnect or remove). Nothing
// else is a task: no hazard sensor is a capability gap he has not decided to fill,
// and a quiet house is not work.
const BUILD_28 = Object.freeze([
  { key: 'ha-long-offline-sockets', build: 'Build 28', lifeDomains: ['home'],
    title: 'Reconnect or remove the four Home Assistant sockets offline since September (extension lead, Office plug, Work, bedroom tv)',
    why: 'Every entity of each has been unavailable for 12–24 days. NEURO lists them under Life → Home as "offline for over a week" rather than as faults; HA\'s own watchdog still counts them every morning. If they are retired, removing them from Home Assistant makes "offline" mean something again.' },
]);

// Build 29 (9 Oct 2026): outdoor life. The phone can now send a workout's GPS
// route, but none has ever arrived — so today only Nick's word can confirm a
// hike. Two things only he can do. "Go hiking" is NOT a task and never will be.
const BUILD_29 = Object.freeze([
  { key: 'prove-workout-route', build: 'Build 29', lifeDomains: ['fitness'],
    title: 'Record your next planned hike as a Hiking workout on the Watch, so its GPS route reaches NEURO',
    why: 'NEURO iOS build 243 can send a workout\'s route, but none has arrived yet (no hike or walk workout since 6 Aug). Until one does, a hike can only be confirmed by you pressing "I hiked that day" in Life → Outdoor.' },
  { key: 'hiking-workout-minimum', build: 'Build 29', lifeDomains: ['fitness'],
    title: 'Decide whether a Hiking workout needs a minimum length to count as a hike (e.g. 60 minutes, like a walk)',
    why: 'Today a Hiking workout with its GPS route counts whatever its length. Five "Hiking" workouts between 25 Feb and 2 Mar lasted 13–25 minutes and about 1 km each — they would have counted. Your call; NEURO has not changed the rule.' },
]);

// Build 30: Leisure is only as good as what Nick tells it. NEURO reads one
// passive source (the phone's Music app); everything else — what he is
// watching, reading, playing, his hobbies — is his to add. One task, not one
// per show: "watch X" is never a task.
const BUILD_30 = Object.freeze([
  { key: 'seed-leisure', build: 'Build 30', lifeDomains: ['leisure'],
    title: 'Add what you are into right now in Life → Leisure (current series/book/game, and hobbies like D&D or the aquariums)',
    why: 'NEURO can only see what the iPhone Music app plays. Your profile mentions D&D, the aquariums, retro tech, maker builds and Marillion, but NEURO will not turn a profile line into a tracked hobby for you. Nothing here becomes a reminder.' },
]);

module.exports = { LEDGER_KEY, BUILD_23, BUILD_24, BUILD_25, BUILD_26, BUILD_27, BUILD_28, BUILD_29, BUILD_30, validate, reconcile, verify };
