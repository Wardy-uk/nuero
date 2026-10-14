// SAiM Alt v2 — the pure half.
//
// SAiM is the actionable daily front door; NEURO is the brain and control
// room. This module decides only how canonical NEURO data is SHOWN and where a
// notification LANDS. It ranks nothing, plans nothing and stores nothing:
//   * task blocks come from NEURO (`/api/adhd` → blockNow, `/api/task-blocks`);
//   * the attention decision, lifecycle verbs, transition and desk capabilities
//     come from `/api/canonical/now`;
//   * the daily briefing is NEURO's stored briefing, verbatim.
//
// PURE: no React, no fetch, no clock unless passed. Every rule the tests pin
// lives here.

// ── Navigation ──────────────────────────────────────────────────────────────

export const TABS = Object.freeze([
  Object.freeze({ id: 'saim', label: 'SAiM', icon: '✦' }),
  Object.freeze({ id: 'now', label: 'Now', icon: '◉' }),
  Object.freeze({ id: 'briefing', label: 'Briefing', icon: '☰' }),
  Object.freeze({ id: 'review', label: 'Review', icon: '◐' }),
  Object.freeze({ id: 'capture', label: 'Capture', icon: '+' }),
  Object.freeze({ id: 'controls', label: 'Controls', icon: '⚙' }),
]);
export const TAB_IDS = Object.freeze(TABS.map((t) => t.id));
export const DEFAULT_TAB = 'saim';

// Control-app ids with an obvious home here. Anything else is NEURO's.
const ALIASES = Object.freeze({ surface: 'saim', focus: 'saim', today: 'now', voice: 'capture', standup: 'review' });

/** One of the six, or a hand-off — never a seventh screen, never a silent default. */
export function resolveTab(id) {
  const key = typeof id === 'string' ? id.trim().toLowerCase() : '';
  if (TAB_IDS.includes(key)) return { tab: key, handoff: false };
  if (Object.prototype.hasOwnProperty.call(ALIASES, key)) return { tab: ALIASES[key], handoff: false };
  return { tab: null, handoff: true, requested: key || null };
}

/** NEURO's own `?view=` deep link (plus any extra params). */
export function neuroLink(base, view, params = null) {
  if (!base) return null;
  const root = String(base).replace(/\/+$/, '');
  if (!view) return `${root}/`;
  const q = new URLSearchParams({ view });
  if (params) for (const [k, v] of Object.entries(params)) if (v != null) q.set(k, String(v));
  return `${root}/?${q.toString()}`;
}

// ── Deep links into SAiM Alt ────────────────────────────────────────────────

const positiveInt = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};
/** Attention record ids are opaque strings (`att_mv830vj2_5`) — accepted only in a safe shape. */
const recordIdOf = (v) => {
  if (typeof v === 'number') return Number.isInteger(v) && v > 0 ? String(v) : null;
  return typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v) ? v : null;
};

/**
 * `?tab=<id>&record=<attention record id>&block=<task block id>` → where to
 * land and which canonical record to focus. Unknown tabs fall back to SAiM
 * only when a record or block is named (that is where those live); otherwise
 * null — no deep link.
 */
export function parseDeepLink(search) {
  if (typeof search !== 'string' || !search) return null;
  let q;
  try { q = new URLSearchParams(search); } catch { return null; }
  const recordId = recordIdOf(q.get('record'));
  const blockId = positiveInt(q.get('block'));
  const t = q.get('tab') ? resolveTab(q.get('tab')) : null;
  const tab = t && t.tab ? t.tab : (recordId || blockId ? 'saim' : null);
  if (!tab) return null;
  return { tab, recordId, blockId };
}

/** The SAiM Alt URL for a destination. */
export function altHref({ tab = 'saim', recordId = null, blockId = null } = {}) {
  const q = new URLSearchParams({ tab });
  if (recordId) q.set('record', String(recordId));
  if (blockId) q.set('block', String(blockId));
  return `/?${q.toString()}`;
}

// ── Notification routing ────────────────────────────────────────────────────

// Push types (webpush.sendToAll callers) whose action needs NEURO, by view.
const NEURO_BY_TYPE = Object.freeze({
  email: { view: 'inbox', params: { filter: 'urgent' }, why: 'email detail and replying live in NEURO' },
  escalation: { view: 'dashboard', params: { filter: 'escalations' }, why: 'ticket detail lives in NEURO' },
  escalation_alert: { view: 'dashboard', params: { filter: 'escalations' }, why: 'ticket detail lives in NEURO' },
  weekly_risk: { view: 'weekly-risk', why: 'the report is reviewed and sent from NEURO' },
  approval: { view: 'actions', why: 'approving or sending happens in NEURO' },
  prepared_action: { view: 'actions', why: 'approving or sending happens in NEURO' },
  121: { view: 'people', why: 'person detail lives in NEURO' },
  people: { view: 'people', why: 'person detail lives in NEURO' },
  teams_mention: { view: 'inbox', why: 'message detail lives in NEURO' },
  system_alert: { view: 'pi-health', why: 'system health is administration' },
  sense_alert: { view: 'pi-health', why: 'senses and sources are administration' },
  router_health: { view: 'pi-health', why: 'network health is administration' },
  capability_suggestions: { view: 'setup', why: 'set-up lives in NEURO' },
  vault_hygiene: { view: 'brain-health', why: 'vault maintenance is administration' },
  knowledge_reflection: { view: 'insights', why: 'knowledge review lives in NEURO' },
  plaud: { view: 'imports', why: 'recordings and imports live in NEURO' },
  sweep_complete: { view: 'imports', why: 'imports live in NEURO' },
  journeys: { view: 'transport', why: 'journeys are reviewed in NEURO' },
  hike_checkin: { view: 'hike-safety', why: 'the walk is managed in NEURO' },
  weekly_review: { view: 'insights', why: 'the weekly review lives in NEURO' },
  plan_milestone: { view: 'todos', why: 'detailed task editing lives in NEURO' },
});

/**
 * Where a notification lands. `data` is the push payload's `data` as NEURO
 * sends it today (`type`, `key`, `url`, `tab`, `attentionRecordId`, …).
 *
 * Returns `{ surface: 'saim'|'neuro', href, tab|view, recordId, blockId, key,
 * exact, why }`. `exact` is true when a canonical record or a specific page is
 * named. A route that cannot name one says so in `why` — it is never quietly
 * a landing page.
 *
 * SAiM when the action is: the task block (start/continue), a lifecycle
 * action on an attention record, a meeting transition, capture, a ritual, or
 * the daily briefing. NEURO when it needs approval/sending, detail (email,
 * ticket, person), editing, administration or review.
 */
export function routeNotification(data, { neuroBase = null } = {}) {
  const d = data || {};
  const type = String(d.type || '').toLowerCase();
  const key = typeof d.key === 'string' ? d.key : null;
  const recordId = recordIdOf(d.attentionRecordId);
  const blockId = positiveInt(d.blockId) || (key && /^block:(\d+)$/.exec(key) ? positiveInt(/^block:(\d+)$/.exec(key)[1]) : null);

  const saim = (tab, why, extra = {}) => ({
    surface: 'saim', tab, view: null,
    recordId: extra.recordId || null, blockId: extra.blockId || null, key,
    href: altHref({ tab, recordId: extra.recordId || null, blockId: extra.blockId || null }),
    exact: Boolean(extra.recordId || extra.blockId || extra.exact), why,
  });
  const neuro = (view, why, params = null) => ({
    surface: 'neuro', tab: null, view, recordId, blockId: null, key,
    href: neuroLink(neuroBase, view, params), exact: true, why,
  });

  // NEURO first where the action itself can only happen there.
  if (Object.prototype.hasOwnProperty.call(NEURO_BY_TYPE, type)) {
    const r = NEURO_BY_TYPE[type];
    return neuro(r.view, r.why, r.params || null);
  }
  if (key && /^email:/.test(key)) return neuro('inbox', 'email detail and replying live in NEURO', { filter: 'urgent' });

  // SAiM.
  if (blockId || type === 'day_plan' || type === 'task_block') {
    return saim('saim', 'start or continue the task block', { blockId, exact: Boolean(blockId) });
  }
  if (type === 'meeting_alert' || type === 'meeting_prep' || type === 'meeting') {
    return saim('saim', 'respond to the meeting transition', { recordId, exact: true });
  }
  if (type === 'capture_failed' || type === 'capture') return saim('capture', 'capture', { exact: true });
  if (type === 'standup' || type === 'eod' || type === 'journal') return saim('review', 'the ritual is a Review', { exact: true });
  if (type === 'brief' || (key && /^briefing:daily:/.test(key))) return saim('briefing', 'the daily briefing is a SAiM destination', { exact: true });
  if (recordId) return saim('saim', 'act on the attention item', { recordId });

  // An explicit NEURO URL NEURO already chose.
  if (typeof d.url === 'string' && /^\/\?view=/.test(d.url) && neuroBase) {
    return { surface: 'neuro', tab: null, view: new URLSearchParams(d.url.slice(2)).get('view'), recordId: null, blockId: null, key, href: `${String(neuroBase).replace(/\/+$/, '')}${d.url}`, exact: true, why: 'NEURO named the page' };
  }
  // Nothing identifies a destination: say so, never pretend.
  return { surface: 'saim', tab: 'saim', view: null, recordId: null, blockId: null, key, href: altHref({ tab: 'saim' }), exact: false, why: `no canonical destination for "${type || 'unknown'}"` };
}

// ── Task blocks ─────────────────────────────────────────────────────────────

const pad = (n) => String(n).padStart(2, '0');
export const dayKeyOf = (now) => { const t = new Date(now); return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`; };
export const hhmmOf = (now) => { const t = new Date(now); return `${pad(t.getHours())}:${pad(t.getMinutes())}`; };
const toMin = (hhmm) => { const m = /^(\d{1,2}):(\d{2})/.exec(String(hhmm || '')); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
/** `2026-10-14T13:35:00.0000000` → `13:35` (sliced, never parsed: Graph gave wall-clock time). */
export const sliceTime = (iso) => (typeof iso === 'string' && iso.length >= 16 ? iso.slice(11, 16) : null);

/**
 * The block in front of him, from NEURO's `blockNow` (task-blocks.liveBlock).
 * `state`: 'active' | 'upcoming' | 'interrupted' | 'complete'.
 * Interrupted is the focus session saying so (paused / stepped away) — never
 * guessed from the clock.
 */
export function blockNow(adhd, session = null) {
  const b = adhd && adhd.blockNow;
  if (!b || !b.blockId) return null;
  const s = session && session.session;
  let state = b.running ? 'active' : 'upcoming';
  if (b.allTicked) state = 'complete';
  else if (b.running && s && (s.paused || s.status === 'paused' || s.status === 'interrupted')) state = 'interrupted';
  const tasks = Array.isArray(b.tasks) ? b.tasks : [];
  const named = tasks.length === 1 ? tasks[0] : tasks.find((t) => t.running) || null;
  return {
    blockId: b.blockId,
    startTime: b.startTime || null,
    endTime: b.endTime || null,
    state,
    startsInMinutes: typeof b.startsInMinutes === 'number' && b.startsInMinutes > 0 ? b.startsInMinutes : null,
    task: named ? { taskId: named.taskId, text: named.text } : null,
    taskCount: tasks.length,
    tasks: tasks.map((t) => ({ taskId: t.taskId, text: t.text, running: Boolean(t.running) })),
    minutesAssumed: Boolean(b.minutesAssumed),
  };
}

/**
 * Today's REMAINING OPEN blocks, in time order, from `/api/task-blocks`.
 * NEURO lists only open blocks (scheduled / awaiting a write-up), so finished
 * blocks are not here — the page says so. Order is the clock, not a ranking.
 */
export function todaysOpenBlocks(taskBlocks, { now = Date.now(), currentId = null } = {}) {
  const rows = Array.isArray(taskBlocks && taskBlocks.blocks) ? taskBlocks.blocks : [];
  const day = dayKeyOf(now);
  const nowMin = toMin(hhmmOf(now));
  return rows
    .filter((b) => b && b.dateKey === day && !b.passed)
    .map((b) => ({
      blockId: b.blockId,
      startTime: b.startTime,
      endTime: b.endTime,
      minutes: b.minutes,
      status: b.status,
      current: b.blockId === currentId || (toMin(b.startTime) <= nowMin && nowMin < toMin(b.endTime)),
      tasks: (b.tasks || []).map((t) => ({ taskId: t.taskId, text: t.text })),
      awaitingWriteup: b.status === 'awaiting-writeup',
    }))
    .sort((a, b) => (toMin(a.startTime) || 0) - (toMin(b.startTime) || 0));
}

/**
 * The day as a single time-ordered line: open task blocks, meetings (other
 * people in them) and protected time (solo diary blocks that are not task
 * blocks). Meetings and protected time come from the canonical agenda, which
 * NEURO caps at four events — `agendaLimited` says so.
 */
export function dayLine(canonical, taskBlocks, { now = Date.now(), currentId = null } = {}) {
  const blocks = todaysOpenBlocks(taskBlocks, { now, currentId });
  const blockStarts = new Set(blocks.map((b) => b.startTime));
  const agenda = canonical && canonical.agenda;
  // `known` = the diary was READ. A scope other than today means NEURO rolled
  // forward because nothing is left today — read, and empty for today, which is
  // not the same fact as "couldn't read".
  const known = Boolean(agenda && agenda.known);
  const today = known && agenda.scope === 'today';
  const events = today ? (agenda.events || []) : [];
  const items = blocks.map((b) => ({ kind: 'block', start: b.startTime, end: b.endTime, title: b.tasks.length === 1 ? b.tasks[0].text : `${b.tasks.length} tasks`, block: b, current: b.current }));
  for (const e of events) {
    const start = sliceTime(e.start);
    if (!start || e.allDay) continue;
    if (e.attendeesOther === true) items.push({ kind: 'meeting', start, end: sliceTime(e.end), title: e.subject || 'Meeting', current: Boolean(e.running) });
    else if (!blockStarts.has(start)) items.push({ kind: 'protected', start, end: sliceTime(e.end), title: e.subject || 'Protected time', current: Boolean(e.running) });
  }
  items.sort((a, b) => (toMin(a.start) || 0) - (toMin(b.start) || 0));
  return { items, agendaKnown: known, agendaToday: today, agendaLimited: today && (agenda.events || []).length >= 4 };
}

/**
 * Time the diary protects RIGHT NOW that is not a task block: a running solo
 * event (no one else in it). Returned so the page can say the time is held
 * while being honest that nothing names what it is for.
 */
export function protectedNow(canonical, taskBlocks, { now = Date.now() } = {}) {
  const agenda = canonical && canonical.agenda;
  if (!agenda || !agenda.known || agenda.scope !== 'today') return null;
  const blockStarts = new Set(todaysOpenBlocks(taskBlocks, { now }).map((b) => b.startTime));
  const e = (agenda.events || []).find((x) => x && x.running && !x.allDay && x.attendeesOther !== true
    && !blockStarts.has(sliceTime(x.start)) && !/^task block:/i.test(String(x.subject || '')));
  return e ? { title: e.subject || 'Protected time', start: sliceTime(e.start), end: sliceTime(e.end) } : null;
}

// ── The SAiM page ───────────────────────────────────────────────────────────

const LIFECYCLE_KINDS = new Set(['act', 'session', 'meeting']);

/**
 * The next relevant transition — only when it changes what he should do NOW:
 * NEURO's composed transition, else a meeting or the next block starting
 * within `withinMin` minutes.
 */
export function nextTransition(canonical, taskBlocks, { now = Date.now(), withinMin = 30, currentId = null } = {}) {
  const t = canonical && canonical.transition;
  if (t && t.prompt) return { kind: t.kind || 'transition', text: t.prompt, question: t.question || null, source: 'neuro' };
  const nowMin = toMin(hhmmOf(now));
  const nm = canonical && canonical.nextMeeting;
  if (nm && nm.time && toMin(nm.time) - nowMin >= 0 && toMin(nm.time) - nowMin <= withinMin) {
    return { kind: 'meeting', text: `“${nm.subject || 'A meeting'}” at ${nm.time}.`, question: null, source: 'agenda' };
  }
  const next = todaysOpenBlocks(taskBlocks, { now, currentId }).find((b) => !b.current && toMin(b.startTime) > nowMin);
  if (next && toMin(next.startTime) - nowMin <= withinMin) {
    const title = next.tasks.length === 1 ? next.tasks[0].text : `${next.tasks.length} tasks`;
    return { kind: 'block', text: `Next block at ${next.startTime}: ${title}`, question: null, source: 'task-blocks' };
  }
  return null;
}

/**
 * The SAiM page, composed: the block, the immediate action, the transition.
 * `uncertain` is the one honest line when there is no block and no item.
 */
export function saimView({ canonical = null, adhd = null, taskBlocks = null, session = null, now = Date.now() } = {}) {
  const block = blockNow(adhd, session);
  const s = session && session.session;
  const step = s && s.nextStep ? s.nextStep : null;
  const primary = canonical && canonical.primary;
  // A meeting-type card IS a transition — it is shown once, as the transition,
  // and its lifecycle sentences go with it rather than heading the action.
  const isTransitionCard = primary && primary.kind === 'item' && primary.type === 'meeting';
  const item = primary && primary.kind === 'item' && !isTransitionCard
    ? {
      recordId: primary.recordId || null,
      title: primary.title || primary.say || null,
      sub: primary.say && primary.title && primary.say !== primary.title ? primary.say : null,
      reason: primary.reason && primary.reason !== primary.say ? primary.reason : null,
      type: primary.type || null,
    }
    : null;
  const hidden = isTransitionCard ? primary.recordId : null;
  const lifecycle = ((canonical && canonical.utterances) || [])
    .filter((u) => u && u.intent && LIFECYCLE_KINDS.has(u.intent.kind) && u.say);
  const actions = lifecycle.filter((u) => !(hidden && u.intent.recordId === hidden));
  const transitionActions = hidden ? lifecycle.filter((u) => u.intent.recordId === hidden) : [];
  const transition = nextTransition(canonical, taskBlocks, { now, currentId: block && block.blockId });
  const held = block ? null : protectedNow(canonical, taskBlocks, { now });
  const blind = Boolean(canonical && (canonical.poolAvailable === false || canonical.available === false));
  const offDuty = Boolean(canonical && canonical.context && canonical.context.activity === 'off');
  let uncertain = null;
  if (!block && !item) {
    if (blind) uncertain = 'I can’t see your work right now — this isn’t an all-clear.';
    else if (held) uncertain = `The diary protects this time (“${held.title}”), but no task block names what it’s for.`;
    else if (offDuty) uncertain = 'Off duty — no task block now, and nothing NEURO is raising.';
    else if (transition) uncertain = 'No task block is running now — the next fixed point is below.';
    else uncertain = 'No task block is protecting this time, and I can’t name a current task.';
  } else if (block && !block.task && block.taskCount > 1) uncertain = `${block.taskCount} tasks share this block — I can’t tell which one you’re on.`;
  return { block, step, item, actions, transition, transitionActions, uncertain, protectedTime: held, offDuty, blind };
}

// ── Tools ───────────────────────────────────────────────────────────────────

const AI_IDS = ['claude', 'chatgpt'];
const FOREGROUND = Object.freeze({
  code: 'code', chrome: 'browser', msedge: 'browser', firefox: 'browser', windowsterminal: 'terminal', pwsh: 'terminal',
  powershell: 'terminal', claude: 'claude', chatgpt: 'chatgpt', olk: 'outlook', outlook: 'outlook', 'ms-teams': 'teams',
  msteams: 'teams', obsidian: 'obsidian', excel: 'excel', winword: 'word', plaud: 'plaud', ssms: 'ssms', postman: 'postman',
});
const HINTS = Object.freeze([
  { id: 'nova', re: /\bnova\b/i },
  { id: 'vantage', re: /\bvantage\b/i },
  { id: 'plaud', re: /\b(plaud|transcript|recording|podcast)\b/i },
  { id: 'ssms', re: /\b(sql|query|database)\b/i },
  { id: 'excel', re: /\b(spreadsheet|excel|csv|xlsx|breakdown)\b/i },
  { id: 'word', re: /\b(word doc|docx|letter|policy)\b/i },
  { id: 'outlook', re: /\b(email|e-mail|inbox|reply|send)\b/i },
  { id: 'obsidian', re: /\b(vault|obsidian|write-up|write up|notes?)\b/i },
  { id: 'claude', re: /\b(draft|outline|headings|summari[sz]e|rewrite)\b/i },
  { id: 'code', re: /\b(code|bug|deploy|commit|repo|refactor|script)\b/i },
  { id: 'browser', re: /\b(jira|nt-\d+|ticket|portal|website|survey)\b/i },
]);
const TYPE_HINTS = Object.freeze({ email: 'outlook' });

export function foregroundId(canonical) {
  const w = canonical && canonical.work;
  if (!w || w.deskKnown === false || !w.atDesk || !w.app) return null;
  return FOREGROUND[String(w.app).toLowerCase().replace(/\.exe$/, '')] || null;
}

/**
 * Zero to three-and-a-bit tools, ONLY for a meaningful named step:
 *   1. the recommended tool (from the step's words, then the item's kind) —
 *      offered only if the laptop declares it and it is NOT already in front;
 *      if it IS in front, `already` says so and there is no Open;
 *   2. an AI tool, if declared;
 *   3. Music, if declared;
 *   4. at most ONE more context-relevant declared app.
 * No step → no tools. Undeclared → never a tool. Never an inventory.
 */
export function tools(canonical, view) {
  const step = view && view.step;
  const empty = { recommended: null, already: null, others: [], why: step ? null : 'no named step' };
  if (!step) return empty;
  const w = canonical && canonical.work;
  const offer = w && w.deskOffer;
  if (!w || w.deskKnown === false || !offer || !offer.known || !Array.isArray(offer.apps) || !offer.apps.length) {
    return { ...empty, why: (offer && offer.why) || 'the laptop hasn’t offered any apps' };
  }
  const label = (id) => (offer.apps.find((a) => a.id === id) || {}).label || id;
  const declared = new Set(offer.apps.map((a) => a.id));
  const fg = foregroundId(canonical);
  const text = [step, view.block && view.block.task && view.block.task.text, view.item && view.item.title].filter(Boolean).join(' ');
  const hinted = HINTS.filter((h) => h.re.test(text) && declared.has(h.id)).map((h) => h.id);
  const typed = view.item && TYPE_HINTS[view.item.type] && declared.has(TYPE_HINTS[view.item.type]) ? TYPE_HINTS[view.item.type] : null;
  const pick = hinted[0] || typed;

  let recommended = null;
  let already = null;
  if (pick && pick === fg) already = { id: pick, label: label(pick) };
  else if (pick) recommended = { id: pick, label: label(pick) };

  const used = new Set([pick, fg].filter(Boolean));
  const others = [];
  const ai = AI_IDS.find((id) => declared.has(id) && !used.has(id));
  if (ai) { others.push({ id: ai, label: label(ai) }); used.add(ai); }
  if (declared.has('music') && !used.has('music')) { others.push({ id: 'music', label: label('music') }); used.add('music'); }
  const extra = hinted.find((id) => !used.has(id));
  if (extra) others.push({ id: extra, label: label(extra) });
  return { recommended, already, others, why: null };
}

/** The lifecycle a desk request reports — the server's words. */
export function deskStateText(state) {
  switch (state) {
    case 'waiting': return 'waiting for the laptop';
    case 'claimed': return 'the laptop has taken it';
    case 'opened': return 'opened';
    case 'failed': return 'failed';
    case 'expired': return 'expired — you weren’t at the laptop in time';
    default: return null;
  }
}
export const deskStateSettled = (s) => s === 'opened' || s === 'failed' || s === 'expired';
export const deskStateBusy = (s) => s === 'waiting' || s === 'claimed';

// ── Briefing ────────────────────────────────────────────────────────────────

/**
 * NEURO's stored daily briefing, verbatim. `isToday` is false when the latest
 * stored briefing is from an earlier day — said, never passed off as today's.
 */
export function briefingView(resp, { now = Date.now() } = {}) {
  const b = resp && resp.briefing;
  if (!resp || resp.ok === false || !b || !b.payload) return { known: false, why: (resp && resp.error) || 'NEURO has no daily briefing stored' };
  const p = b.payload;
  return {
    known: true,
    id: b.id,
    date: b.date,
    isToday: b.date === dayKeyOf(now),
    dayLabel: p.dayLabel || b.date,
    context: p.context || null,
    sections: Array.isArray(p.sections) ? p.sections.filter((s) => s && Array.isArray(s.items) && s.items.length) : [],
    close: p.close || null,
    gaps: Array.isArray(p.gaps) ? p.gaps : [],
    deliveredAt: b.delivery && b.delivery.at ? b.delivery.at : null,
  };
}

// ── Controls ────────────────────────────────────────────────────────────────

/** Minutes from `now` to local midnight, at least 1 — NEURO caps a pause at 24h. */
export function pauseMinutesToEndOfDay(now = Date.now()) {
  const t = new Date(now);
  const mid = new Date(t.getFullYear(), t.getMonth(), t.getDate() + 1).getTime();
  return Math.max(1, Math.ceil((mid - now) / 60000));
}

// ── Field drive ─────────────────────────────────────────────────────────────

/**
 * Exactly `useFieldDrive`'s mapping, from a payload already held — the field
 * and its colour logic are the control's, unchanged.
 */
export function driveFrom(d, isPressing) {
  if (!d) return { activity: undefined, confidenceLevel: 'low', quiet: false, degraded: true, pressing: false };
  return {
    activity: d.context && d.context.activity,
    confidenceLevel: (d.context && d.context.confidence && d.context.confidence.level) || 'low',
    quiet: d.quiet === true,
    degraded: d.poolAvailable === false || d.available === false,
    pressing: typeof isPressing === 'function' ? Boolean(isPressing(d.primary)) : false,
  };
}

// ── The `working` desktop composition (approved layout, 14 Oct 2026) ────────
//
// One view-model for the whole SAiM page. Each part is FROM canonical data or
// is ABSENT — a missing part hides that part only; the surface never falls
// back to a generic card, and nothing is invented to fill a slot.

const DOING = Object.freeze({
  working: 'working', steady: 'working', 'in-focus-session': 'focused', firefighting: 'firefighting',
  'in-meeting': 'in a meeting', 'pre-meeting': 'meeting soon', ritual: 'ritual time', off: 'off duty', away: 'away',
});
const HELD_WORD = Object.freeze({
  todo: 'Tasks', capacity: 'Capacity', email: 'Email', escalation: 'Escalation', meeting: 'Meeting',
  nudge: 'Reminder', approval: 'Approval', 'source-blind': 'A sense', commitment: 'Commitment',
});

// While a block runs, these resting/ritual readings are not what he is doing —
// the block is (rule 1). A focus session, a meeting or firefighting still say so.
const BLOCK_OUTRANKS = new Set(['ritual', 'steady', 'working']);

/** `SAiM · desk active · working` — only the parts that are known. */
export function presenceLine(canonical, { blockActive = false } = {}) {
  const parts = ['SAiM'];
  const w = canonical && canonical.work;
  if (w && w.deskKnown !== false && typeof w.atDesk === 'boolean') parts.push(w.atDesk ? 'desk active' : 'away from the desk');
  const act = canonical && canonical.context && canonical.context.activity;
  if (blockActive && (!act || BLOCK_OUTRANKS.has(act))) parts.push('in a task block');
  else if (act && DOING[act]) parts.push(DOING[act]);
  return parts.join(' · ');
}

/** "In 49 minutes", "In 1 h 12 min", "Now". Minutes from wall-clock HH:MM. */
export function untilText(minutes) {
  if (minutes == null || !Number.isFinite(minutes)) return null;
  if (minutes <= 0) return 'Now';
  if (minutes < 60) return `In ${minutes} minute${minutes === 1 ? '' : 's'}`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `In ${h} h ${m} min` : `In ${h} h`;
}

const TASK_BLOCK_EVENT = /^task block:\s*/i;
const blocksRead = (taskBlocks) => Array.isArray(taskBlocks && taskBlocks.blocks);

/**
 * A diary entry as an upcoming transition (rule 3). A solo task block IS a
 * transition — having no other attendees never removes it. When the block list
 * was read, a task block's own diary event is skipped (the block is shown from
 * the block list, by its task); when it was not, the diary entry stands in.
 */
function agendaEntry(e, haveBlocks) {
  const subject = String(e.subject || '');
  if (TASK_BLOCK_EVENT.test(subject)) {
    if (haveBlocks) return null;
    const task = subject.replace(TASK_BLOCK_EVENT, '');
    return { title: displayTaskTitle(task), fullTitle: task, kind: 'block' };
  }
  return { title: subject || 'Meeting', kind: e.attendeesOther === true ? 'meeting' : 'protected' };
}

const runningMeeting = (canonical) => {
  const a = canonical && canonical.agenda;
  if (!a || !a.known || a.scope !== 'today') return null;
  const e = (a.events || []).find((x) => x && x.running && !x.allDay && x.attendeesOther === true);
  return e ? { start: sliceTime(e.start), end: sliceTime(e.end), title: e.subject || 'Meeting' } : null;
};

/**
 * What is next TODAY after now: a meeting, a task block or protected diary
 * time — whichever starts first. A task block's own event is shown by its
 * task, never twice. Null when nothing is left or the diary was not read.
 */
export function nextUp(canonical, taskBlocks, { now = Date.now(), currentBlockId = null } = {}) {
  const nowMin = toMin(hhmmOf(now));
  const items = [];
  const blocks = todaysOpenBlocks(taskBlocks, { now, currentId: currentBlockId });
  for (const b of blocks) {
    if (b.current || b.blockId === currentBlockId) continue;
    if (toMin(b.startTime) > nowMin) items.push({ start: b.startTime, title: b.tasks.length === 1 ? displayTaskTitle(b.tasks[0].text) : `${b.tasks.length} tasks`, fullTitle: b.tasks.length === 1 ? b.tasks[0].text : null, kind: 'block' });
  }
  const starts = new Set(items.map((i) => i.start));
  const a = canonical && canonical.agenda;
  if (a && a.known && a.scope === 'today') {
    for (const e of a.events || []) {
      const s = sliceTime(e.start);
      if (!s || e.allDay || e.running || toMin(s) <= nowMin) continue;
      const ae = agendaEntry(e, blocksRead(taskBlocks));
      if (starts.has(s) || !ae) continue;
      items.push({ start: s, ...ae });
    }
  }
  if (!items.length) return null;
  items.sort((x, y) => toMin(x.start) - toMin(y.start));
  const n = items[0];
  return { label: 'Next', title: n.title, fullTitle: n.fullTitle || null, time: n.start, kind: n.kind, inText: untilText(toMin(n.start) - nowMin) };
}

export function workingView({ canonical = null, adhd = null, taskBlocks = null, session = null, now = Date.now() } = {}) {
  const base = saimView({ canonical, adhd, taskBlocks, session, now });
  const b = base.block;
  const s = session && session.session;
  const sessionLive = Boolean(s && !['done', 'abandoned'].includes(s.status));
  const meeting = runningMeeting(canonical);

  // The current slot — explicit precedence (Nick, 14 Oct 2026):
  //   1. a running meeting (other people are in the room);
  //   2. the task block — a RUNNING block wins over a ritual (EOD/standup)
  //      and over due-today work, which are held instead (rule 2);
  //   3. protected diary time with no block;
  //   4. the one thing NEURO is raising.
  // Otherwise none — said in one line.
  let current = null;
  let note = null;
  if (meeting) current = { label: 'In a meeting', start: meeting.start, end: meeting.end, title: meeting.title, kind: 'meeting' };
  else if (b) {
    const word = { active: 'Active', upcoming: 'Up next', interrupted: 'Interrupted', complete: 'Complete' }[b.state];
    current = { label: word, start: b.startTime, end: b.endTime, title: b.task ? displayTaskTitle(b.task.text) : null, fullTitle: b.task ? b.task.text : null, kind: 'block', blockId: b.blockId };
    if (!b.task) note = base.uncertain;
  } else if (base.protectedTime) {
    current = { label: 'Protected', start: base.protectedTime.start, end: base.protectedTime.end, title: base.protectedTime.title, kind: 'protected' };
    note = 'No task block names what this time is for.';
  } else if (base.item) {
    current = { label: 'Now', start: null, end: null, title: base.item.title, kind: 'item' };
  } else note = base.uncertain;
  if (current && current.title == null && !note) note = base.uncertain;

  // Actions: NEURO's own lifecycle sentences; plus starting the block's named
  // task, which is the one way to say "I'm on it" to NEURO.
  const actions = [];
  if (!meeting && b && b.task && !sessionLive && (b.state === 'active' || b.state === 'upcoming')) {
    actions.push({ say: 'I’m on it', intent: { kind: 'start-block', taskId: b.task.taskId, text: b.task.text } });
  }
  for (const u of [...base.actions, ...base.transitionActions]) actions.push({ say: u.say, intent: u.intent });

  const step = base.step || null;
  const t = tools(canonical, base);
  const toolsView = step && (t.recommended || t.already || t.others.length)
    ? { recommended: t.recommended, already: t.already, others: t.others, why: `For “${step}”` }
    : null;

  // Rule 4: the block's own wording, checked against its planned date.
  if (current && current.kind === 'block' && b && b.task) {
    const due = dueFor(canonical, b.task.taskId);
    const stale = due ? staleWording(b.task.text, due.date, now) : null;
    if (stale) { current.stale = { taskId: b.task.taskId, reason: stale }; current.fullTitle = null; }
  }

  // Rule 2: what the current slot holds with him is the slot; everything else
  // NEURO is raising — a displaced ritual, overdue and due-today work, and the
  // items the gate held back — is held, never the main situation.
  const blockTaskIds = new Set(b ? b.tasks.map((t) => t.taskId) : []);
  const displaced = current && current.kind !== 'item' ? displacedPrimary(canonical) : null;
  const owed = current && current.kind !== 'item' ? owedToday(canonical, { now, exclude: blockTaskIds }) : null;
  const dropped = Array.isArray(canonical && canonical.dropped) ? canonical.dropped : null;
  let held = null;
  if (dropped || displaced || (owed && owed.length)) {
    const items = [];
    if (displaced) items.push({ title: displaced.title, why: displaced.why, kind: 'ritual' });
    for (const o of owed || []) items.push(o);
    for (const d of dropped || []) items.push({ title: HELD_WORD[d.type] || d.type || 'Item', why: d.why || null, kind: d.type || 'other' });
    held = { count: items.length, items };
  }

  const ap = canonical && canonical.approvals;
  const judgement = ap && ap.known
    ? { count: (ap.needsApproval || 0) + (ap.needsReview || 0), say: ap.say || null, where: ap.where || null }
    : null;

  const moment = current && current.kind === 'meeting' ? meetingMoment(meeting, canonical, taskBlocks, { now }) : null;
  if (held) {
    const phrase = holdPhrase(displaced, owed, dropped);
    const lead = moment ? 'Held until you’re out' : current && current.kind === 'block' && b && b.state === 'active' ? 'Held while this block runs' : 'Held for now';
    held.summary = phrase ? `${lead}: ${phrase}.` : 'Nothing held back.';
  }

  return {
    presence: presenceLine(canonical, { blockActive: Boolean(current && current.kind === 'block' && b && b.state === 'active') }),
    current,
    meeting: moment,
    note,
    step,
    actions,
    tools: toolsView,
    next: moment ? moment.then : nextUp(canonical, taskBlocks, { now, currentBlockId: b && b.blockId }),
    held: held && held.count ? held : (held ? { count: 0, items: [] } : null),
    judgement,
    blind: base.blind,
  };
}

// ── In a meeting: SAiM holding the moment (14 Oct 2026) ─────────────────────

// NEURO's own Plaud admin block (plaud-admin-blocks.SUBJECT_PREFIX) — booked to
// process the recording of the meeting it is named after.
const WRITE_UP_PREFIX = 'Plaud admin — ';

/** Everything still to start today, in clock order, each with its end. */
export function upcoming(canonical, taskBlocks, { now = Date.now(), currentBlockId = null } = {}) {
  const nowMin = toMin(hhmmOf(now));
  const items = [];
  for (const b of todaysOpenBlocks(taskBlocks, { now, currentId: currentBlockId })) {
    if (b.current || b.blockId === currentBlockId || toMin(b.startTime) <= nowMin) continue;
    items.push({ start: b.startTime, end: b.endTime, title: b.tasks.length === 1 ? displayTaskTitle(b.tasks[0].text) : `${b.tasks.length} tasks`, fullTitle: b.tasks.length === 1 ? b.tasks[0].text : null, kind: 'block' });
  }
  const starts = new Set(items.map((i) => i.start));
  const a = canonical && canonical.agenda;
  if (a && a.known && a.scope === 'today') {
    for (const e of a.events || []) {
      const s = sliceTime(e.start);
      if (!s || e.allDay || e.running || toMin(s) <= nowMin) continue;
      const ae = agendaEntry(e, blocksRead(taskBlocks));
      if (starts.has(s) || !ae) continue;
      items.push({ start: s, end: sliceTime(e.end), ...ae });
    }
  }
  return items.sort((x, y) => toMin(x.start) - toMin(y.start));
}

/** "21 minutes left", "1 h 5 min left", "Due to end now". */
export function remainingText(endHHMM, now = Date.now()) {
  const left = toMin(endHHMM) - toMin(hhmmOf(now));
  if (!Number.isFinite(left)) return null;
  if (left <= 0) return 'Due to end now';
  const t = untilText(left);
  return t ? `${t.replace(/^In /, '')} left` : null;
}

/**
 * The meeting state's extra parts: time remaining, the immediate transition
 * after it, a continuity cue ONLY when NEURO has booked write-up time for this
 * very meeting, and what comes after that (the rail's card).
 */
export function meetingMoment(meeting, canonical, taskBlocks, { now = Date.now() } = {}) {
  const items = upcoming(canonical, taskBlocks, { now });
  const after = items.find((i) => toMin(i.start) >= toMin(meeting.end)) || null;
  let cue = null;
  if (after && after.kind === 'protected' && after.title === `${WRITE_UP_PREFIX}${meeting.title}`) {
    after.title = 'Write-up time for this meeting';
    after.writeUp = true;
    cue = 'Already in the diary, so nothing from this meeting needs holding in your head.';
  }
  const thenItem = after ? items[items.indexOf(after) + 1] || null : null;
  return {
    remaining: remainingText(meeting.end, now),
    after,
    cue,
    then: thenItem ? { label: 'Then', title: thenItem.title, fullTitle: thenItem.fullTitle || null, time: thenItem.start, inText: untilText(toMin(thenItem.start) - toMin(hhmmOf(now))) } : null,
  };
}

const HELD_PHRASE = Object.freeze({
  todo: (n) => (n === 1 ? 'overdue tasks' : `${n} task prompts`),
  capacity: (n) => (n === 1 ? 'a capacity check' : `${n} capacity checks`),
  meeting: (n) => (n === 1 ? 'a diary reminder' : `${n} diary reminders`),
  email: (n) => (n === 1 ? 'an email' : `${n} emails`),
  escalation: (n) => (n === 1 ? 'an escalation' : `${n} escalations`),
  nudge: (n) => (n === 1 ? 'a reminder' : `${n} reminders`),
  approval: (n) => (n === 1 ? 'an approval' : `${n} approvals`),
  commitment: (n) => (n === 1 ? 'a commitment' : `${n} commitments`),
});

/** "overdue tasks, 2 capacity checks and 2 diary reminders" — what is protected, by kind. */
export function heldPhrase(dropped) {
  if (!Array.isArray(dropped) || !dropped.length) return null;
  const counts = new Map();
  for (const d of dropped) counts.set(d.type || 'other', (counts.get(d.type || 'other') || 0) + 1);
  const parts = [...counts].map(([t, n]) => (HELD_PHRASE[t] ? HELD_PHRASE[t](n) : `${n} ${t}`));
  return parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

// ── Task titles for display (14 Oct 2026) ───────────────────────────────────

// A bracket holding only a date: "(8 October 2026)", "(October 8)", "(2026-10-08)", "(8/10)".
const BRACKET_DATE = /\s*\((?:\d{1,2}(?:st|nd|rd|th)?\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*(?:\s+\d{4})?|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?|\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\)/gi;
const TRAILING_WHEN = /\s+(?:tomorrow|today|tonight|this (?:morning|afternoon|evening|week))\s*$/i;

/**
 * A task's wording, tidied for a time-labelled slot — DISPLAY ONLY, never
 * stored. A task captured from a meeting carries the scheduling talk of the
 * moment it was said ("…tomorrow (8 October 2026). Must do tomorrow."), which
 * reads as a contradiction beside the slot's own time. Keeps the first
 * sentence, drops a bracketed date and a trailing relative day. If tidying
 * would leave too little, the original is kept.
 */
export function displayTaskTitle(text) {
  const raw = String(text || '').trim();
  if (!raw) return raw;
  let t = raw.split(/(?<=[.!?])\s+(?=[A-Z])/)[0];
  t = t.replace(BRACKET_DATE, '');
  t = t.replace(/[.!?]+$/, '').trim();
  t = t.replace(TRAILING_WHEN, '').trim();
  t = t.replace(/[\s,;:–—-]+$/, '').trim();
  return t.length >= 8 ? t : raw;
}

// ── Precedence helpers: what is held, and stale task wording (14 Oct 2026) ───

const commitmentsOf = (canonical) => {
  const s = canonical && canonical.situation && canonical.situation.sections;
  return Array.isArray(s && s.commitments) ? s.commitments : [];
};
const neuroTaskId = (c) => {
  const m = /^task:neuro:(\d+)$/.exec(String((c && c.taskId) || ''));
  return m ? Number(m[1]) : null;
};
const keyDays = (key) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ''));
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86400000 : null;
};

/** The planned date NEURO holds for a task, from the canonical commitments. */
export function dueFor(canonical, taskId) {
  const c = commitmentsOf(canonical).find((x) => neuroTaskId(x) === Number(taskId));
  return c && c.due && c.due.date ? { date: c.due.date, kind: c.due.kind || null } : null;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const FULL_DATE = /\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{4})\b|\b(\d{4})-(\d{2})-(\d{2})\b/gi;
const RELATIVE = /\b(tomorrow|tonight|today)\b/i;
const longDate = (key) => { const [y, m, d] = key.split('-').map(Number); return `${d} ${['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][m - 1]} ${y}`; };

/**
 * Does a task's wording contradict its CURRENT planned date? (rule 4)
 * Only two things are judged, both conservatively: a relative day ("tomorrow",
 * "today", "tonight") that no longer matches, and a FULL date (with a year) that
 * differs. A bare "September 30" is left alone — it may be a deadline the task
 * is about, not when it was planned. Returns the reason, or null.
 */
export function staleWording(text, dueDate, now = Date.now()) {
  const due = keyDays(dueDate);
  const today = keyDays(dayKeyOf(now));
  if (due == null || today == null) return null;
  const t = String(text || '');
  const rel = RELATIVE.exec(t);
  const dueWord = due === today ? 'today' : due === today + 1 ? 'tomorrow' : `on ${longDate(dueDate)}`;
  if (rel) {
    const word = rel[1].toLowerCase();
    const says = word === 'tomorrow' ? today + 1 : today;
    if (says !== due) return `says “${word}” but it’s planned for ${dueWord}`;
  }
  FULL_DATE.lastIndex = 0;
  let m;
  while ((m = FULL_DATE.exec(t))) {
    const key = m[4]
      ? `${m[4]}-${m[5]}-${m[6]}`
      : `${m[3]}-${String(MONTHS.indexOf(m[2].toLowerCase().slice(0, 3)) + 1).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
    if (keyDays(key) != null && keyDays(key) !== due) return `names ${longDate(key)} but it’s planned for ${dueWord}`;
  }
  return null;
}

const RITUAL_WORD = (title) => (/\beod\b|end.of.day/i.test(title) ? 'the end-of-day wrap' : /standup|stand-up/i.test(title) ? 'the morning standup' : null);

/** NEURO's top item when the current slot has displaced it (a ritual, a card). */
export function displacedPrimary(canonical) {
  const p = canonical && canonical.primary;
  if (!p || !p.title) return null;
  if (p.kind === 'context') {
    const word = RITUAL_WORD(p.title);
    if (!word) return null; // "In a meeting" and the like describe the slot itself
    return { title: word.replace(/^the /, '').replace(/^./, (c) => c.toUpperCase()), why: p.reason || p.say || null, phrase: word };
  }
  if (p.kind === 'item' && p.type !== 'meeting') return { title: p.title, why: p.reason || null, phrase: 'the top prompt' };
  return null;
}

/** Overdue and due-today work NEURO holds, minus what the current block is for. */
export function owedToday(canonical, { now = Date.now(), exclude = new Set() } = {}) {
  const today = keyDays(dayKeyOf(now));
  const out = [];
  for (const c of commitmentsOf(canonical)) {
    if (!c || c.state !== 'open' || c.direction !== 'i-owe' || !c.due || !c.due.date) continue;
    const id = neuroTaskId(c);
    if (id != null && exclude.has(id)) continue;
    const d = keyDays(c.due.date);
    if (d == null || d > today) continue;
    const days = today - d;
    const stale = staleWording(c.description, c.due.date, now);
    out.push({
      title: displayTaskTitle(c.description),
      fullTitle: stale ? null : c.description,
      why: days === 0 ? 'due today' : `${days} day${days === 1 ? '' : 's'} overdue`,
      kind: days === 0 ? 'due-today' : 'overdue',
      taskId: id,
      stale: stale ? { taskId: id, reason: stale } : null,
    });
  }
  return out.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'overdue' ? -1 : 1));
}

/** "the end-of-day wrap, 1 overdue task and 4 tasks due today and a capacity check" — what is held, by kind. */
export function holdPhrase(displaced, owed, dropped) {
  const parts = [];
  if (displaced) parts.push(displaced.phrase);
  const over = (owed || []).filter((o) => o.kind === 'overdue').length;
  const todayN = (owed || []).filter((o) => o.kind === 'due-today').length;
  if (over) parts.push(over === 1 ? '1 overdue task' : `${over} overdue tasks`);
  if (todayN) parts.push(todayN === 1 ? '1 task due today' : `${todayN} tasks due today`);
  const rest = heldPhrase(dropped);
  if (rest) parts.push(rest);
  if (!parts.length) return null;
  return parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}
