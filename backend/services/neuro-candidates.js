'use strict';

/**
 * NEURO's half of the attention contract — `neuro-candidates-v2` (15 Oct 2026; v2 = the risk/urgency
 * split on attention-item and home facts — a different shape from v1, so a different name, C6).
 * Contract: docs/saim-attention-policy-contract.md.
 *
 * NEURO owns FACTS and CONSTRAINTS. This module says what is true right now —
 * the running block, meetings, approvals and their deadlines, commitments,
 * attention items with their risk and urgency, what the gate held back, rituals, home
 * and family context — each with its provenance, whether it was read, and its
 * SPHERE (work / personal / home / family / unknown) with the basis for it.
 *
 * ⚠ IT CHOOSES NOTHING. No ranking, no lead, no "what to do now": that is the
 *   SAiM Attention Policy (`saim/policy/attention-policy.cjs`), which consumes
 *   this object. A field here that only makes sense as a judgement belongs there.
 *
 * ⚠ SPHERE IS EVIDENCE, NEVER A GUESS. A meeting's sphere is the classification
 *   Nick gave its calendar; a task's is its stored domain (with `basis:
 *   'default'` when that is only the store's default); an approval's is the
 *   mailbox it sends from. No evidence → `unknown`, and each scope decides what
 *   unknown means.
 *
 * ⚠ `attention.gate` is a NEURO-side gate that FEEDS this: its primary/secondary
 *   arrive as attention-item candidates and its `dropped` as held candidates.
 *   It is not SAiM policy (contract §6).
 *
 * `compose()` is PURE. `gather()` does the reads and never throws.
 */

const CONTRACT = require('../../shared/attention-contracts.cjs').NEURO_CANDIDATES;
const NH = require('./neuro-handoff');
const ND = require('./neuro-display');

const pad = (n) => String(n).padStart(2, '0');
const dayKey = (ms) => { const t = new Date(ms); return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`; };
const slice = (iso) => (typeof iso === 'string' && iso.length >= 16 ? iso.slice(11, 16) : null);
/** Local wall-clock instant for a day key + HH:MM (the backend's zone, as task-blocks uses). */
const instant = (key, hhmm) => {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || '')); const t = /^(\d{1,2}):(\d{2})/.exec(String(hhmm || ''));
  return d && t ? new Date(Number(d[1]), Number(d[2]) - 1, Number(d[3]), Number(t[1]), Number(t[2])).toISOString() : null;
};
const keyDays = (key) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ''));
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86400000 : null;
};

// ── Sphere ───────────────────────────────────────────────────────────────────

/** A life domain → the coarse sphere a scope filters on. */
function sphereOfDomain(domain) {
  if (!domain) return null;
  if (domain === 'work') return 'work';
  if (domain === 'home') return 'home';
  if (domain === 'family') return 'family';
  return 'personal';
}
const sphere = (value, basis, why) => ({ value: value || 'unknown', basis: value ? basis : 'none', why: value ? why : (why || 'no evidence of which part of life this belongs to') });

/** From a list of domain claims: one sphere when they agree, else unknown (never a vote). */
function sphereFromDomains(domains, basis, why) {
  const set = new Set((domains || []).map(sphereOfDomain).filter(Boolean));
  return set.size === 1 ? sphere([...set][0], basis, why) : sphere(null, null, set.size > 1 ? 'its evidence names more than one part of life' : null);
}

/**
 * A commitment's sphere from NEURO's domain resolution (`life-domains`): its
 * named domains when they agree, else its coarse sphere (work / personal).
 */
function commitmentSphere(d) {
  if (!d || !d.known) return sphere(null);
  const basis = d.basis || 'resolved';
  const fromDomains = sphereFromDomains((d.domains || []).map((x) => x.domain), basis, 'NEURO’s domain resolution for this commitment');
  if (fromDomains.value !== 'unknown') return fromDomains;
  return d.sphere ? sphere(d.sphere === 'work' ? 'work' : 'personal', basis, `NEURO resolved it as ${d.sphere}`) : sphere(null);
}

// ── Data quality: wording that contradicts the planned date ─────────────────

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const FULL_DATE = /\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{4})\b|\b(\d{4})-(\d{2})-(\d{2})\b/gi;
const RELATIVE = /\b(tomorrow|tonight|today)\b/i;
const longDate = (key) => { const [y, m, d] = key.split('-').map(Number); return `${d} ${MONTH_NAMES[m - 1]} ${y}`; };

/**
 * A fact about the RECORD: does its wording contradict its planned date? Judged
 * conservatively — a relative day that no longer matches, or a full date with a
 * year that differs. A bare "September 30" may be the deadline the task is about.
 */
function wordingConflict(text, dueDate, now) {
  const due = keyDays(dueDate);
  const today = keyDays(dayKey(now));
  if (due == null || today == null) return null;
  const t = String(text || '');
  const dueWord = due === today ? 'today' : due === today + 1 ? 'tomorrow' : longDate(dueDate);
  const rel = RELATIVE.exec(t);
  if (rel) {
    const word = rel[1].toLowerCase();
    if ((word === 'tomorrow' ? today + 1 : today) !== due) return `says “${word}” but it’s planned for ${dueWord}`;
  }
  FULL_DATE.lastIndex = 0;
  let m;
  while ((m = FULL_DATE.exec(t))) {
    const key = m[4] ? `${m[4]}-${m[5]}-${m[6]}` : `${m[3]}-${pad(MONTHS.indexOf(m[2].toLowerCase().slice(0, 3)) + 1)}-${pad(Number(m[1]))}`;
    if (keyDays(key) != null && keyDays(key) !== due) return `names ${longDate(key)} but it’s planned for ${dueWord}`;
  }
  return null;
}

// ── Compose (PURE) ───────────────────────────────────────────────────────────

const TASK_BLOCK_EVENT = /^task block:\s*/i;
const RITUAL = (title) => (/\beod\b|end.of.day/i.test(title || '') ? 'eod' : /stand-?up/i.test(title || '') ? 'standup' : null);
/**
 * decision-engine types whose `critical` means "the clock forces it now", never
 * "this can do harm". Measured 15 Oct 2026 — the five places decision-engine
 * says critical: unseen escalations, NOVA flags (risk ≥ 80 or legal) and a late
 * weekly-risk report are RISK; an imminent meeting with others (≤ 10 min) and the
 * pre-11 standup nudge are URGENCY. Anything not listed here keeps its word as
 * risk — reclassifying a type nobody looked at could hide real harm.
 */
const URGENCY_NOT_RISK = Object.freeze({ meeting: 'meeting-transition', nudge: 'ritual-due' });

/**
 * Every decision-engine item type NEURO has looked at and classified (15 Oct
 * 2026). A type NOT in this table is UNCLASSIFIED: its urgency word is carried
 * as potential risk with `riskBasis: 'unclassified'`, never silently trusted as
 * genuine risk, and SAiM surfaces it for review so it gets classified on purpose.
 */
const CLASSIFIED_TYPES = Object.freeze(new Set([
  'escalation', 'nova_flag', 'weekly_risk', 'source-blind', 'todo', 'email', 'capacity', 'imports', 'plan_closure',
  ...Object.keys(URGENCY_NOT_RISK),
]));

/** Household needs-you kinds (home.needsYouFrom / intelNeedsYou) and the risk each carries. */
const HOME_RISK = Object.freeze({ hazard: 'critical', 'hazard-blind': 'high', obligation: 'none', door: 'high', heating: 'high', network: 'medium' });
/** Graph wall-clock string → ISO instant in the backend's zone (sliced, not offset-shifted). */
const localInstant = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(s || ''));
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])).toISOString() : null;
};

// Attention-item types whose subject is the work itself (decision-engine sources).
const WORK_TYPES = new Set(['escalation', 'nova_flag', 'email', 'capacity', 'approval', 'weekly_risk', 'weekly-risk', 'source-blind']);

/**
 * @param {object} payload  the canonical Now payload (attention.gate decision + situation)
 * @param {object} live     { block, rows, session } — task-blocks.liveBlock, today's open block rows, focus session
 * @param {object} facts    { calendar, approvals, taskDomains, workingWindow } — read by gather()
 */
function compose(payload, live = {}, facts = {}, { now = Date.now() } = {}) {
  const p = payload || {};
  const today = dayKey(now);
  const readAt = new Date(now).toISOString();
  const taskDomains = facts.taskDomains || new Map();
  const taskSphere = (ids) => {
    const doms = (ids || []).map((id) => taskDomains.get(Number(id))).filter(Boolean);
    if (!doms.length) return sphere(null, null, 'no task domain recorded');
    const s = sphereFromDomains(doms.map((d) => d.domain), doms.every((d) => d.basis === 'default') ? 'default' : 'stored',
      doms.every((d) => d.basis === 'default') ? 'the task store’s default domain' : 'the task’s stored domain');
    return s;
  };
  const utter = ((p.utterances) || []).filter((u) => u && u.say && u.intent);
  const candidates = [];

  // Task blocks — the running one and the rest of today's open ones.
  const rows = Array.isArray(live.rows) ? live.rows : null;
  const session = live.session || null;
  const lb = live.block || null;
  for (const r of rows || []) {
    if (!r || r.dateKey !== today || r.passed) continue;
    const isLive = lb && lb.blockId === r.blockId;
    const tasks = (isLive ? lb.tasks : r.tasks) || [];
    let state = 'later';
    if (isLive) {
      state = lb.running ? 'running' : 'upcoming';
      if (lb.allTicked) state = 'complete';
      else if (lb.running && session && (session.status === 'paused' || session.status === 'interrupted')) state = 'interrupted';
    }
    candidates.push({
      kind: 'block', id: `block:${r.blockId}`, blockId: r.blockId, title: tasks.length === 1 ? tasks[0].text : `${tasks.length} tasks`,
      time: { start: r.startTime, end: r.endTime, startAt: instant(today, r.startTime), endAt: instant(today, r.endTime) },
      facts: {
        state,
        tasks: tasks.map((t) => ({ taskId: t.taskId, text: t.text, running: Boolean(t.running),
          wordingConflict: null })),
        session: isLive && session ? { status: session.status || null, taskId: session.taskId ?? null } : null,
      },
      sphere: taskSphere(tasks.map((t) => t.taskId)),
      actions: isLive ? utter.filter((u) => u.intent.kind === 'session').map((u) => ({ say: u.say, intent: u.intent })) : [],
      provenance: { source: 'task-blocks', readAt }, known: true,
    });
  }

  // Diary today: meetings (others in them), protected time (solo), and task-block events.
  const blockStarts = new Set((rows || []).map((r) => r.startTime));
  for (const e of facts.calendar || []) {
    const start = slice(e.start); const end = slice(e.end);
    if (!start || e.allDay || e.showAs === 'free' && e.attendeesOther !== true) continue;
    const startAt = Date.parse(e.startAt || ''); const endAt = Date.parse(e.endAt || '');
    const running = Number.isFinite(startAt) && Number.isFinite(endAt) ? startAt <= now && now < endAt : false;
    if (Number.isFinite(endAt) && endAt <= now) continue;
    const subject = String(e.subject || '');
    if (TASK_BLOCK_EVENT.test(subject)) {
      if (rows) continue; // shown from the block list
      candidates.push({ kind: 'block', id: `diary-block:${start}`, blockId: null, title: subject.replace(TASK_BLOCK_EVENT, ''),
        time: { start, end, startAt: e.startAt || null, endAt: e.endAt || null },
        facts: { state: running ? 'running' : 'later', tasks: [], fromDiary: true }, sphere: e.sphere || sphere(null),
        actions: [], provenance: { source: `calendar:${e.source}`, readAt }, known: true });
      continue;
    }
    if (blockStarts.has(start)) continue;
    const isMeeting = e.attendeesOther === true;
    candidates.push({
      kind: isMeeting ? 'meeting' : 'protected-time', id: `${isMeeting ? 'meeting' : 'protected'}:${start}:${subject}`, eventId: e.eventId || null, title: subject || (isMeeting ? 'Meeting' : 'Protected time'),
      time: { start, end, startAt: e.startAt || null, endAt: e.endAt || null },
      facts: { running, othersAttending: e.attendeesOther === true ? true : e.attendeesOther === false ? false : null, showAs: e.showAs || null },
      sphere: e.sphere || sphere(null),
      actions: isMeeting && running ? utter.filter((u) => u.intent.kind === 'meeting').map((u) => ({ say: u.say, intent: u.intent })) : [],
      provenance: { source: `calendar:${e.source}`, readAt }, known: true,
    });
  }

  // Approvals — one per waiting governed action, with its own deadline.
  const ap = p.approvals && p.approvals.known !== false ? p.approvals : null;
  for (const a of facts.approvals || []) {
    candidates.push({
      kind: 'approval', id: `approval:${a.actionId}`, title: a.title || a.type,
      time: { deadlineAt: a.expiresAt || null },
      facts: { type: a.type, status: a.status, subject: a.subject || null, where: ap && ap.where ? ap.where : 'Actions, in NEURO on the desktop', summary: ap ? ap.say || null : null },
      sphere: a.mailbox && a.mailbox !== 'work' ? sphere('personal', 'mailbox', `sends from your ${a.mailbox} mailbox`) : sphere('work', 'mailbox', 'sends from your work mailbox'),
      actions: [], provenance: { source: 'prepared_actions', readAt }, known: true,
    });
  }

  // Attention items (attention.gate's primary + secondary) and the ritual context card.
  const card = p.primary || null;
  const itemMeta = new Map(); // decision-engine meta per attention item — for the hand-off fields only
  const items = [...(card && card.kind === 'item' ? [{ ...card, gatePosition: 'primary' }] : []),
    ...(p.secondary || []).filter((s) => s && s.kind === 'item').map((s) => ({ ...s, gatePosition: 'secondary' }))];
  for (const it of items) {
    const raw = String(it.urgency || 'normal').toLowerCase();
    const notRisk = URGENCY_NOT_RISK[it.type] || null;
    const meta = it.meta || {};
    itemMeta.set(`item:${it.recordId || it.id}`, { ...meta, engineId: it.id || null });
    candidates.push({
      kind: 'attention-item', id: `item:${it.recordId || it.id}`, recordId: it.recordId || null, title: it.title || it.say || null,
      time: it.type === 'meeting' && meta.start ? { start: slice(meta.start), startAt: localInstant(meta.start), minutesAway: Number.isFinite(meta.minutesAway) ? meta.minutesAway : null } : undefined,
      facts: {
        type: it.type || null,
        // NEURO's one `urgency` word mixed two facts (15 Oct 2026). `risk` is how
        // much harm the thing can do; `urgency` is how soon the clock forces it.
        // An imminent meeting and the pre-11 standup are rated `critical` by
        // decision-engine for their CLOCK, not for harm — so they carry no risk.
        risk: notRisk ? 'none' : raw,
        riskBasis: CLASSIFIED_TYPES.has(it.type) ? 'classified' : 'unclassified',
        urgency: notRisk && raw === 'critical' ? notRisk : null,
        neuroUrgency: raw,
        othersAttending: it.type === 'meeting' ? (meta.withOthers === true ? true : meta.withOthers === false ? false : null) : undefined,
        reason: it.reason || it.say || null, gatePosition: it.gatePosition, lifecycle: it.lifecycle || null,
      },
      sphere: it.domain ? sphere(sphereOfDomain(it.domain), 'stated', 'the item states its domain')
        : WORK_TYPES.has(it.type) ? sphere('work', 'item-type', `a ${it.type} item is work by source`) : sphere(null),
      actions: utter.filter((u) => u.intent.recordId && u.intent.recordId === it.recordId).map((u) => ({ say: u.say, intent: u.intent })),
      provenance: { source: 'attention.gate', readAt }, known: true,
    });
  }
  const ritual = card && card.kind === 'context' ? RITUAL(card.title) : null;
  if (ritual) {
    candidates.push({ kind: 'ritual', id: `ritual:${ritual}`, title: card.title, facts: { ritual, outstanding: true, reason: card.reason || card.say || null },
      sphere: sphere('work', 'ritual', 'the standup and end-of-day wrap belong to the working day'), actions: [],
      provenance: { source: 'ritual-state', readAt }, known: true });
  }

  // Commitments NEURO holds, with their planned date and wording conflicts.
  const sections = p.situation && (p.situation.sections || p.situation);
  for (const c of (sections && sections.commitments) || []) {
    if (!c || c.state !== 'open' || c.direction !== 'i-owe' || !c.due || !c.due.date) continue;
    const m = /^task:neuro:(\d+)$/.exec(String(c.taskId || ''));
    const taskId = m ? Number(m[1]) : null;
    candidates.push({
      kind: 'commitment', id: c.id, taskId, title: c.description,
      time: { due: c.due.date, dueBasis: c.due.kind || null },
      facts: { daysLate: keyDays(today) - keyDays(c.due.date), counterpart: c.counterpart && c.counterpart.name || null, wordingConflict: wordingConflict(c.description, c.due.date, now) },
      sphere: commitmentSphere(c.domains),
      actions: [], provenance: { source: 'world-model', readAt }, known: true,
    });
  }
  // A block's task carries the same conflict fact as its commitment.
  for (const b of candidates.filter((x) => x.kind === 'block')) {
    for (const t of b.facts.tasks) {
      const c = candidates.find((x) => x.kind === 'commitment' && x.taskId === Number(t.taskId));
      if (c) t.wordingConflict = c.facts.wordingConflict;
    }
  }

  // What the gate held back, with its reason.
  for (const d of p.dropped || []) {
    candidates.push({ kind: 'held', id: `held:${d.id || d.type}`, title: d.title || d.type || 'Item', facts: { type: d.type || null, why: d.why || null },
      sphere: d.domain ? sphere(sphereOfDomain(d.domain), 'stated', 'the item states its domain') : WORK_TYPES.has(d.type) ? sphere('work', 'item-type', `a ${d.type} item is work by source`) : sphere(null),
      actions: [], provenance: { source: 'attention.gate', readAt }, known: true });
  }

  // Home and family context.
  const home = p.home;
  const taskDue = facts.taskDue || new Map();
  for (const n of (home && home.needsYou) || []) {
    const tm = /^task:neuro:(\d+)$/.exec(String(n.id || ''));
    const tid = tm ? Number(tm[1]) : null;
    const due = tid != null ? taskDue.get(tid) || null : null;
    candidates.push({ kind: 'home', id: `home:${n.id || n.title}`, taskId: tid, title: n.title || n.what || 'Home', time: due ? { due } : undefined,
      facts: { needsNow: true, homeKind: n.kind || null, entityId: n.entityId || null, risk: HOME_RISK[n.kind] || 'unknown', riskBasis: HOME_RISK[n.kind] ? 'classified' : 'unclassified', why: n.why || null, wordingConflict: due ? wordingConflict(n.title, due, now) : null },
      sphere: sphere('home', 'source', 'from the household model'), actions: [], provenance: { source: 'home', readAt }, known: true });
  }
  for (const e of (home && home.exceptions) || []) {
    candidates.push({ kind: 'home', id: `home-exception:${e.id}`, title: e.what, facts: { needsNow: e.actionState === 'needs_you', homeKind: e.category || null, risk: HOME_RISK[e.category] || 'unknown', riskBasis: HOME_RISK[e.category] ? 'classified' : 'unclassified', where: e.where || null, category: e.category },
      sphere: sphere('home', 'source', 'from the household model'), actions: [], provenance: { source: 'home', readAt }, known: true });
  }
  for (const d of (p.personalDates && p.personalDates.active) || []) {
    candidates.push({ kind: 'personal-date', id: d.id, title: d.line || `${d.person}’s ${d.kind}`, time: { date: d.date, away: d.away },
      facts: { state: d.state, importance: d.importance || null, needsNow: d.state === 'action-may-be-needed' },
      sphere: sphere('family', 'personal-date', 'a personal date Nick declared'), actions: [], provenance: { source: 'personal-dates', readAt }, known: true });
  }

  // Hand-off fields (structured intent + exact links + explicit gaps) — additive
  // v2 data, NEURO facts only. SAiM's resolver recommends; NEURO never does.
  // Display fields (C5): what a screen may show — safe words, never ids, ISO times or internal types.
  for (const c of candidates) c.display = ND.displayFor(c, { subject: c.facts && c.facts.subject, now });
  for (const c of candidates) Object.assign(c, NH.handoffFor(c, itemMeta.get(c.id) || null, { jiraBase: facts.jiraBase || null, taskActivity: facts.taskActivity || null }));

  return {
    contract: CONTRACT,
    readAt,
    today,
    candidates,
    constraints: {
      poolReadable: p.poolAvailable !== false && p.available !== false,
      // The household model: true read, false failed (`home: null`), null not asked.
      homeReadable: p.home ? true : p.home === null ? false : null,
      diaryReadable: Boolean(facts.calendarKnown),
      blocksReadable: Boolean(rows),
      approvalsReadable: Boolean(ap) && facts.approvals != null,
      // The world-model situation (commitments). Missing = could not read, never "none" (C3).
      commitmentsReadable: Boolean(p.situation && (p.situation.sections || p.situation)),
      activity: (p.context && p.context.activity) || null,
      duty: p.context && p.context.duty ? { onDuty: p.context.duty.onDuty ?? null } : null,
      desk: p.work && typeof p.work.atDesk === 'boolean' && p.work.deskKnown !== false ? { atDesk: p.work.atDesk } : null,
      place: (p.life && p.life.place) || null,
      workingWindow: facts.workingWindow || null,
      // Where to look when SAiM can't see — exists whatever else failed.
      targets: NH.constraintTargets(),
    },
    gaps: facts.gaps || [],
  };
}

// ── Gather (reads; never throws) ─────────────────────────────────────────────

function _workingWindow(now) {
  const settings = require('./attention-settings').read();
  const [startS, endS] = String(settings.workingHours || '08:00-18:00').split('-');
  const wd = require('./working-days');
  const t = new Date(now);
  const todayKey = dayKey(now);
  const working = wd.isWorkingDay(t);
  let next = new Date(t.getFullYear(), t.getMonth(), t.getDate() + 1);
  for (let i = 0; i < 14 && !wd.isWorkingDay(next); i++) next = new Date(next.getFullYear(), next.getMonth(), next.getDate() + 1);
  return {
    hours: `${startS}-${endS}`, source: settings.workingHoursSource || null,
    todayIsWorking: working,
    todayStart: working ? instant(todayKey, startS) : null,
    todayEnd: working ? instant(todayKey, endS) : null,
    nextStart: instant(dayKey(next.getTime()), startS),
  };
}

function gather({ now = Date.now() } = {}) {
  const db = require('../db/database');
  const out = { block: null, rows: null, session: null, facts: { calendar: null, calendarKnown: false, approvals: null, taskDomains: new Map(), workingWindow: null, gaps: [],
    // Jira's address, for a ticket's own page (hand-off control links). Config, not a read.
    jiraBase: process.env.JIRA_BASE_URL || null } };
  const gaps = out.facts.gaps;
  try { out.session = require('./focus-session').current(now) || null; } catch (e) { gaps.push({ input: 'session', why: e.message }); }
  try {
    const tb = require('./task-blocks');
    const r = tb.listOutstanding({ now: new Date(now) });
    if (r.error) gaps.push({ input: 'task-blocks', why: r.error });
    else out.rows = r.rows;
    out.block = tb.liveBlock(r.rows || [], new Date(now), { sessionTaskIds: out.session && out.session.taskId != null ? [out.session.taskId] : [] });
  } catch (e) { gaps.push({ input: 'task-blocks', why: e.message }); }
  try {
    const ids = [...new Set((out.rows || []).flatMap((r) => (r.tasks || []).map((t) => Number(t.taskId))))];
    for (const id of ids) {
      const row = db.getTaskRow(id);
      if (row) out.facts.taskDomains.set(id, { domain: row.domain || 'work', basis: row.domain ? 'stored' : 'default' });
    }
  } catch (e) { gaps.push({ input: 'task-domains', why: e.message }); }
  // Planned dates of household obligations that are tasks — so their wording can be checked against them.
  // Task activity (15 Oct 2026): Nick's stated choice per open task, and the
  // suggestions beside it (source, observed). Precedence: shared/task-activity.cjs.
  try { out.facts.taskActivity = require('./task-activity').forOpenTasks(); } catch (e) { out.facts.taskActivity = null; gaps.push({ input: 'task-activity', why: e.message }); }
  out.facts.taskDue = new Map();
  try {
    const home = require('./home').readCached({ now });
    for (const n of (home && home.needsYou) || []) {
      const m = /^task:neuro:(\d+)$/.exec(String(n.id || ''));
      const row = m ? db.getTaskRow(Number(m[1])) : null;
      if (row && row.due_date) out.facts.taskDue.set(row.id, String(row.due_date).slice(0, 10));
    }
  } catch (e) { gaps.push({ input: 'home-task-dates', why: e.message }); }
  try {
    const sc = require('./source-classification');
    const byKey = sc.classificationMap('calendar');
    const key = dayKey(now);
    const rows = db.all(`SELECT event_id, source, subject, start_time, end_time, is_all_day, show_as, attendees_other
      FROM calendar_cache WHERE substr(start_time,1,10) = ? ORDER BY start_time`, [key]);
    const seen = new Set();
    out.facts.calendar = [];
    for (const r of rows.sort((a, b) => (a.source === 'graph' ? -1 : 1) - (b.source === 'graph' ? -1 : 1))) {
      const dedupe = `${String(r.start_time).slice(0, 16)}|${String(r.subject || '').trim().toLowerCase()}`;
      if (seen.has(dedupe)) continue; // a phone copy of an Outlook event is one event
      seen.add(dedupe);
      let calKey = null;
      if (r.source === 'graph') calKey = 'graph-cal:primary';
      else {
        const m = db.get('SELECT calendar_key FROM wm_meetings WHERE meeting_id = ?', [`apple:${r.event_id}`]);
        calKey = m && m.calendar_key ? m.calendar_key : null;
      }
      const cls = calKey ? byKey.get(calKey) : null;
      const claims = sc.claimsFor(cls, { label: cls && cls.label }).claims.map((c) => c.domain);
      const sp = claims.length ? sphereFromDomains(claims, 'classified', `you classified ${calKey === 'graph-cal:primary' ? 'the Outlook calendar' : 'this calendar'}`) : sphere(null, null, calKey ? 'its calendar is not classified' : 'its calendar is not known');
      const startAt = new Date(String(r.start_time).slice(0, 19)).toISOString();
      const endAt = new Date(String(r.end_time).slice(0, 19)).toISOString();
      out.facts.calendar.push({ eventId: r.event_id, source: r.source, subject: r.subject, start: r.start_time, end: r.end_time, startAt, endAt,
        allDay: r.is_all_day === 1, showAs: r.show_as || null, attendeesOther: r.attendees_other === 1 ? true : r.attendees_other === 0 ? false : null, sphere: sp });
    }
    out.facts.calendarKnown = true;
  } catch (e) { gaps.push({ input: 'calendar', why: e.message }); }
  try {
    out.facts.approvals = db.all(`SELECT action_id, action_type, status, expires_at, target_json FROM prepared_actions WHERE status = 'prepared' ORDER BY expires_at`).map((r) => {
      let t = {}; try { t = JSON.parse(r.target_json || '{}'); } catch { t = {}; }
      return { actionId: r.action_id, type: r.action_type, status: r.status, expiresAt: r.expires_at || null, mailbox: t.mailbox || 'work', subject: t.subject || null,
        title: t.subject ? `${String(r.action_type).replace(/_/g, ' ')}: ${t.subject}` : String(r.action_type).replace(/_/g, ' ') };
    });
  } catch (e) { gaps.push({ input: 'approvals', why: e.message }); }
  try { out.facts.workingWindow = _workingWindow(now); } catch (e) { gaps.push({ input: 'working-hours', why: e.message }); }
  return out;
}

module.exports = { CONTRACT, compose, gather, wordingConflict, sphereOfDomain };
