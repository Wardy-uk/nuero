// SAiM Alt — the pure half of the A/B treatment.
//
// ⚠ WHAT THIS IS. An ALTERNATIVE desktop shell served on its own hostname
// (saim-alt.nickward.co.uk), built from the same source tree as the control
// (saim.nickward.co.uk) but from a separate entry. It reads the SAME canonical
// NEURO contracts (`/api/canonical/now`, `/api/session`, `/api/desktop/intents`)
// and adds no store, no second decision engine and no ranking of work. Delete
// `saim/app/alt/`, `vite.config.alt.js`, `.env.alt` and the `build:alt` script
// and the control is exactly as it was.
//
// ⚠ PURE: no React, no fetch, no clock unless passed. Every rule the tests pin
// lives here so it can be checked under plain node.
//
// What this module DECIDES, and what it must not:
//   * It decides which of FIVE destinations exist and where anything else goes.
//   * It decides how to SAY presence in a sentence, from NEURO's own signals —
//     and how to say that a signal is missing.
//   * It decides which desk tool to put first — a TOOL choice, never a choice
//     about which WORK matters. The work, its wording, its lifecycle verbs and
//     its uncertainty are NEURO's and are passed through verbatim.
//   * It never makes an unavailable capability look actionable.

// ── Navigation ──────────────────────────────────────────────────────────────

/**
 * Exactly five destinations, in this order, with the control's own icons
 * (`saim/shared-ui/tabs.jsx`). Nothing else is reachable here.
 */
export const ALT_TABS = Object.freeze([
  Object.freeze({ id: 'saim', label: 'SAiM', icon: '✦' }),
  Object.freeze({ id: 'now', label: 'Now', icon: '◉' }),
  Object.freeze({ id: 'review', label: 'Review', icon: '◐' }),
  Object.freeze({ id: 'capture', label: 'Capture', icon: '➕' }),
  Object.freeze({ id: 'controls', label: 'Controls', icon: '⚙' }),
]);

export const ALT_TAB_IDS = Object.freeze(ALT_TABS.map((t) => t.id));
export const ALT_DEFAULT_TAB = 'saim';
export const ALT_TAGLINE = 'SAiM stays with the thread. NEURO holds the detail.';

// The control's ids that have an obvious home among the five. Everything else
// (tasks, chat, prep, standup, household) is NEURO's detailed control room and
// is HANDED OFF rather than rebuilt here.
const ALIASES = Object.freeze({ surface: 'saim', voice: 'capture' });

/**
 * Where a navigation request lands. Returns `{ tab }` for one of the five, or
 * `{ handoff: true, tab: null }` for anything else — never a sixth screen and
 * never a silent fall-through to a default.
 */
export function resolveAltTab(id) {
  const key = typeof id === 'string' ? id.trim().toLowerCase() : '';
  if (ALT_TAB_IDS.includes(key)) return { tab: key, handoff: false };
  // Own keys only — `ALIASES.constructor` is Object, and a prototype key must
  // never resolve to a screen.
  if (Object.prototype.hasOwnProperty.call(ALIASES, key)) return { tab: ALIASES[key], handoff: false };
  return { tab: null, handoff: true, requested: key || null };
}

/**
 * A link into NEURO for something this shell deliberately does not hold.
 * `?view=` is NEURO's own deep-link parameter; unknown views fall through to
 * Now there, so a bad id costs a click, not a broken page.
 */
export function neuroLink(base, view) {
  if (!base) return null;
  const root = String(base).replace(/\/+$/, '');
  return view ? `${root}/?view=${encodeURIComponent(view)}` : `${root}/`;
}

/** "Updated 18:42" from the read's own timestamp, local time. Null when unknown. */
export function updatedLabel(at) {
  if (!at) return null;
  const t = new Date(at);
  if (Number.isNaN(t.getTime())) return null;
  const pad = (n) => String(n).padStart(2, '0');
  return `Updated ${pad(t.getHours())}:${pad(t.getMinutes())}`;
}

// ── Presence ────────────────────────────────────────────────────────────────

/** `living-room` → `living room`. A sensor slug is not a place name. */
const prettyRoom = (r) => String(r).replace(/[-_]+/g, ' ').trim();

// Foreground process names the desk agent reports → what a person calls them.
const APP_NAMES = Object.freeze({
  code: 'VS Code', chrome: 'Chrome', msedge: 'Edge', firefox: 'Firefox', olk: 'Outlook', outlook: 'Outlook',
  'ms-teams': 'Teams', msteams: 'Teams', winword: 'Word', excel: 'Excel', powerpnt: 'PowerPoint',
  windowsterminal: 'Terminal', pwsh: 'PowerShell', powershell: 'PowerShell', explorer: 'File Explorer',
  snippingtool: 'Snipping Tool', screensketch: 'Snipping Tool', claude: 'Claude', chatgpt: 'ChatGPT',
  obsidian: 'Obsidian', ssms: 'SSMS', postman: 'Postman', plaud: 'Plaud', notepad: 'Notepad',
});
export function appName(app) {
  if (!app) return null;
  const k = String(app).toLowerCase().replace(/\.exe$/, '');
  return APP_NAMES[k] || String(app);
}

/**
 * Presence as two short lines, from NEURO's own signals:
 *   line 1 — `Nick · Office` / `Nick · Home` / `Nick · location unknown`
 *   line 2 — `desk seen · VS Code open · standing by`
 *
 * ⚠ A ROOM is never stated as where Nick IS. The room comes from a sensor that
 *   hears a DEVICE (his watch), so it is said as that — "watch heard in the
 *   living room" — and only when NEURO says which device it heard.
 */
export function presence(d) {
  const ctx = (d && d.context) || {};
  const place = ctx.place || null;
  const life = (d && d.life) || null;

  let where = null;
  if (place && place.known === true && place.name && place.name !== 'unknown') where = String(place.name);
  else if (life && life.place && life.place.kind === 'home') where = 'Home';
  else if (life && life.place && life.place.kind === 'work') where = 'Work';
  const line1 = `Nick · ${where || 'location unknown'}`;

  let device = null;
  if (place && place.room) {
    const subject = place.roomSubject ? String(place.roomSubject) : null;
    device = subject
      ? `${subject} heard in the ${prettyRoom(place.room)}`
      : `a device heard in the ${prettyRoom(place.room)}`;
  }

  const work = (d && d.work) || null;
  let desk;
  if (!work || work.deskKnown === false) desk = { known: false, text: 'desk not seen' };
  else if (work.atDesk) desk = { known: true, text: 'desk seen', app: work.app ? `${appName(work.app)} open` : null };
  else desk = { known: true, text: 'away from the desk' };

  const op = (d && d.operation) || null;
  const operation = op && op.label ? String(op.label).toLowerCase() : null;

  const line2 = [desk.text, desk.app, operation].filter(Boolean).join(' · ');

  return {
    line1,
    line2,
    whereKnown: Boolean(where),
    device,
    deskKnown: desk.known,
    operation,
    operationDetail: op && op.detail ? op.detail : null,
  };
}

/**
 * Which of SAiM's three silences this is, kept apart because only the last one
 * is good news. Mirrors AttentionSurface's rule; it does not re-derive it.
 */
export function silence(d) {
  if (!d) return null;
  if (d.poolAvailable === false) return { kind: 'blind', text: 'I can’t see your work right now — this isn’t an all-clear.' };
  if (d.primary) return null;
  if (d.quiet === true) return { kind: 'quiet', text: 'Staying out of the way.' };
  return { kind: 'clear', text: 'Nothing pressing.' };
}

// ── The current thread ──────────────────────────────────────────────────────

/** The utterance kinds that are lifecycle actions on the thing in hand. */
const LIFECYCLE_KINDS = new Set(['act', 'session', 'meeting']);

export const UNKNOWN_THREAD = Object.freeze({
  title: 'I can’t recover the thread from what I can see.',
  prompt: 'Tell me what you were doing, or capture the next thing.',
});

/**
 * The current thread, the next physical step and the permitted lifecycle
 * actions. Every word about the work is NEURO's:
 *   * an attention ITEM (`primary.kind === 'item'`) is the thread;
 *   * else a focus session or live task block current-work names;
 *   * else NEURO's CONTEXT card, by its title — unless the context itself is
 *     unknown, which is the honest "I can't recover the thread" state;
 *   * the next step is the step HE named on the session — never invented;
 *   * the actions are the server's utterances, already bounded by what the
 *     attention record allows.
 *
 * `state` is 'item' | 'work' | 'context' | 'unknown'.
 */
export function currentThread(d, session = null) {
  const primary = (d && d.primary) || null;
  const work = (d && d.work) || null;
  const activity = d && d.context ? d.context.activity : null;
  const s = session && session.session ? session.session : null;

  let state;
  let item = null;
  if (primary && primary.kind === 'item') {
    state = 'item';
    item = {
      kind: 'item',
      type: primary.type || null,
      title: primary.say || primary.title || null,
      sub: primary.say && primary.title && primary.title !== primary.say ? primary.title : null,
      reason: primary.reason && primary.reason !== primary.say ? primary.reason : null,
    };
  } else if (work && work.known && work.task) {
    state = 'work';
    item = { kind: 'work', type: null, title: work.task, sub: null, reason: work.why || null };
  } else if (primary && primary.kind === 'context' && activity && activity !== 'unknown') {
    // The context card's `say`/`reason` repeat the place ("… · living-room");
    // the place is said once, in the presence line, so only the title is used.
    state = 'context';
    item = { kind: 'context', type: null, title: primary.title || null, sub: null, reason: null };
  } else {
    state = 'unknown';
  }

  const nextStep = s && s.nextStep ? { known: true, text: s.nextStep } : { known: false, text: null };
  const actions = ((d && d.utterances) || [])
    .filter((u) => u && u.intent && LIFECYCLE_KINDS.has(u.intent.kind) && u.say);

  return {
    state,
    item,
    unknown: state === 'unknown' ? UNKNOWN_THREAD : null,
    nextStep,
    sessionActive: Boolean(s && s.active !== false && s.status !== 'finished'),
    actions,
  };
}

// ── Tool handoff ────────────────────────────────────────────────────────────

/**
 * The desk-agent vocabulary this shell knows how to ORDER. Whether any of these
 * is actually openable is decided by the agent's declared `canOpen`, carried as
 * `work.deskOffer.apps` — this list never makes something available.
 */
export const AI_IDS = Object.freeze(['claude', 'chatgpt']);
export const MUSIC_ID = 'music';
export const CONTEXT_LIMIT = 3;
// After AI and Music, in this order when offered and nothing ranks them higher.
const OTHER_ORDER = Object.freeze([
  'outlook', 'teams', 'obsidian', 'excel', 'word',
  'nova', 'vantage', 'neuro', 'plaud',
  'browser', 'code', 'terminal', 'ssms', 'postman',
]);

// Foreground process names → the app id that reopens it. Names only, never titles.
const FOREGROUND = Object.freeze({
  code: 'code', chrome: 'browser', msedge: 'browser', firefox: 'browser', safari: 'browser',
  windowsterminal: 'terminal', pwsh: 'terminal', powershell: 'terminal', cmd: 'terminal', terminal: 'terminal', iterm2: 'terminal',
  claude: 'claude', chatgpt: 'chatgpt', codex: 'chatgpt',
  olk: 'outlook', outlook: 'outlook', 'ms-teams': 'teams', msteams: 'teams', teams: 'teams',
  obsidian: 'obsidian', excel: 'excel', winword: 'word', plaud: 'plaud', ssms: 'ssms', postman: 'postman',
});

// Words in the WORK's own text that point at a tool. Specific on purpose: a
// tool picked on a word is labelled uncertain, never stated as fact.
const TEXT_HINTS = Object.freeze([
  { id: 'nova', re: /\bnova\b/i },
  { id: 'vantage', re: /\bvantage\b/i },
  { id: 'plaud', re: /\b(plaud|transcript|recording)\b/i },
  { id: 'ssms', re: /\b(sql|query|database|stored procedure)\b/i },
  { id: 'excel', re: /\b(spreadsheet|excel|csv|xlsx)\b/i },
  { id: 'word', re: /\b(word doc|docx)\b/i },
  { id: 'outlook', re: /\b(email|e-mail|inbox|reply to)\b/i },
  { id: 'obsidian', re: /\b(vault|obsidian|write-up|write up)\b/i },
  { id: 'postman', re: /\b(postman|api call|endpoint)\b/i },
  { id: 'code', re: /\b(code|bug|deploy|commit|repo|refactor|test suite|script)\b/i },
  { id: 'terminal', re: /\b(ssh|terminal|pm2|server log|shell)\b/i },
  { id: 'browser', re: /\b(jira|confluence|ticket|portal|website|dashboard|grafana|netlify)\b/i },
]);

// The KIND of card in hand, when NEURO says what it is. Only kinds that name
// their own tool; a meeting does not say whether it is in Teams.
const TYPE_HINTS = Object.freeze({ email: 'outlook' });

/**
 * The best next place, plus a SHORT set of other ways in.
 *
 *   top      — the one recommended tool (offered apps only), with `because`:
 *              app already in front (certain) → card kind → a word in the work
 *              → first offered (a stated guess).
 *   ai       — ONE AI tool other than the top (or a not-available note).
 *   music    — Music, unless it is the top (or a not-available note).
 *   context  — up to three more offered apps, those the work points at first.
 *   more     — every remaining offered app, for a "More available apps" fold.
 *
 * ⚠ Only OFFERED apps ever appear as entries with `available: true`. The AI and
 *   Music slots, when not offered, carry `available: false` and a reason — the
 *   view renders those as text, never as buttons.
 */
export function toolHandoff(d, thread = null) {
  const work = (d && d.work) || null;
  const offer = work && work.deskOffer ? work.deskOffer : null;
  const offered = offer && offer.known && Array.isArray(offer.apps) ? offer.apps.filter((a) => a && a.id) : [];
  const offeredIds = new Set(offered.map((a) => a.id));
  const label = (id) => (offered.find((a) => a.id === id) || {}).label || id;
  const host = (offer && offer.host) || (work && work.host) || null;

  let blockedWhy = null;
  if (!work || work.deskKnown === false) blockedWhy = 'I can’t see your laptop';
  else if (!offer) blockedWhy = 'the laptop hasn’t said what it can open';
  else if (offeredIds.size === 0) blockedWhy = offer.why || 'nothing it can open is set up here';
  if (blockedWhy) return { host, top: null, ai: null, music: null, context: [], more: [], blockedWhy };

  const entry = (id) => ({ id, label: label(id), available: true, why: null });

  // Evidence, strongest first. Everything here is restricted to offered ids.
  const fg = work && work.app ? FOREGROUND[String(work.app).toLowerCase().replace(/\.exe$/, '')] : null;
  const type = d && d.primary && d.primary.type ? TYPE_HINTS[d.primary.type] : null;
  const text = [thread && thread.item && thread.item.title, work && work.task].filter(Boolean).join(' ');
  const hinted = text ? TEXT_HINTS.filter((h) => h.re.test(text) && offeredIds.has(h.id)).map((h) => h.id) : [];

  let top;
  if (fg && offeredIds.has(fg)) {
    top = { ...entry(fg), certain: true, because: `You’re already in ${appName(work.app)}.` };
  } else if (type && offeredIds.has(type)) {
    top = { ...entry(type), certain: false, because: 'That’s where this kind of thing lives — I’m not certain.' };
  } else if (hinted.length) {
    top = { ...entry(hinted[0]), certain: false, because: 'The work mentions it — I’m not certain it’s the right place.' };
  } else {
    const first = [...AI_IDS, MUSIC_ID, ...OTHER_ORDER].find((id) => offeredIds.has(id))
      || offered[0].id;
    top = { ...entry(first), certain: false, because: 'I’m not sure where this needs to happen — this is my best guess.' };
  }

  const used = new Set([top.id]);
  const aiId = AI_IDS.find((id) => offeredIds.has(id) && !used.has(id));
  let ai = null;
  if (aiId) { ai = entry(aiId); used.add(aiId); }
  else if (!AI_IDS.includes(top.id)) ai = { id: 'ai', label: 'AI', available: false, why: 'no AI tool set up on the laptop' };

  let music = null;
  if (top.id !== MUSIC_ID) {
    music = offeredIds.has(MUSIC_ID) ? entry(MUSIC_ID) : { id: MUSIC_ID, label: 'Music', available: false, why: 'not set up on the laptop' };
    used.add(MUSIC_ID);
  }

  // The rest of the offered apps: those the work points at first, then a fixed
  // order, then anything else the laptop declared. Never re-orders NEURO's work.
  const rest = [];
  const push = (id) => { if (offeredIds.has(id) && !used.has(id) && !rest.includes(id)) rest.push(id); };
  if (fg) push(fg);
  if (type) push(type);
  hinted.forEach(push);
  OTHER_ORDER.forEach(push);
  AI_IDS.forEach(push); // a second AI tool is a fallback, not context
  offered.forEach((a) => push(a.id));

  return {
    host,
    top,
    ai,
    music,
    context: rest.slice(0, CONTEXT_LIMIT).map(entry),
    more: rest.slice(CONTEXT_LIMIT).map(entry),
    blockedWhy: null,
  };
}

/** The lifecycle a desk request reports — the server's words, nothing assumed. */
export const DESK_STATES = Object.freeze(['waiting', 'claimed', 'opened', 'failed', 'expired']);
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

// ── Next context change ─────────────────────────────────────────────────────

/** Only when relevant: the server's transition, else the next real meeting today. */
export function nextChange(d) {
  if (d && d.transition && d.transition.prompt) {
    return { kind: d.transition.kind || 'transition', text: d.transition.prompt, question: d.transition.question || null };
  }
  const nm = d && d.nextMeeting;
  if (nm && (nm.subject || nm.time)) {
    return { kind: 'next-meeting', text: `${nm.subject ? `“${nm.subject}”` : 'A meeting'}${nm.time ? ` at ${nm.time}` : ''}.`, question: null };
  }
  return null;
}

// ── Holding the day ─────────────────────────────────────────────────────────

const TYPE_LABELS = Object.freeze({
  todo: 'A task',
  capacity: 'A capacity check',
  meeting: 'A meeting',
  email: 'Email',
  escalation: 'An escalation',
  nudge: 'A nudge',
  health: 'A health note',
});

/**
 * What the gate held back, and why. ⚠ NON-DESTRUCTIVE: it reads `dropped` in
 * the server's order, never sorts, never filters and never mutates — expanding
 * the disclosure must not rerank or change any canonical state. Raw ids (a
 * Graph event id is 150 characters of base64) are never used as a label.
 */
export function heldWork(d) {
  const dropped = Array.isArray(d && d.dropped) ? d.dropped : [];
  const items = dropped.map((x) => ({
    type: x && x.type ? x.type : null,
    label: (x && x.title) || TYPE_LABELS[x && x.type] || 'Something',
    why: (x && x.why) || null,
  }));
  const reasons = [];
  for (const it of items) if (it.why && !reasons.includes(it.why)) reasons.push(it.why);
  return { count: items.length, reasons, items };
}

// ── Needs your judgement ────────────────────────────────────────────────────

/** Pending approvals, as a statement. There is deliberately no approve here. */
export function judgement(d) {
  const a = d && d.approvals;
  if (!a || a.known !== true) return { known: false, count: null, text: 'I couldn’t check what’s waiting for approval.' };
  const count = (a.needsApproval || 0) + (a.needsReview || 0);
  if (count === 0) return { known: true, count: 0, text: 'Nothing waiting for your judgement.' };
  return {
    known: true,
    count,
    text: a.say || `${count} waiting for your judgement.`,
    where: a.where || 'NEURO',
  };
}

// ── What SAiM can see ───────────────────────────────────────────────────────

/**
 * Concise evidence and NAMED gaps, from what NEURO already reports. Nothing is
 * inferred here: the confidence rationale, the life read's own evidence lines,
 * and every input NEURO says it could not read.
 */
export function evidence(d) {
  const ctx = (d && d.context) || {};
  const seen = [];
  if (ctx.confidence && ctx.confidence.rationale) seen.push(ctx.confidence.rationale);
  const life = d && d.life;
  if (life && Array.isArray(life.evidence)) for (const e of life.evidence.slice(0, 2)) if (e) seen.push(String(e));

  const gaps = [];
  const add = (g) => { if (g && !gaps.includes(g)) gaps.push(g); };
  if (Array.isArray(ctx.unknowns)) ctx.unknowns.forEach((u) => add(typeof u === 'string' ? u : (u && (u.input || u.why)) || null));
  if (Array.isArray(ctx.cannotSee)) ctx.cannotSee.forEach((u) => add(typeof u === 'string' ? u : (u && (u.label || u.input || u.why)) || null));
  if (Array.isArray(d && d.gaps)) d.gaps.forEach((g) => add(g && (g.input ? `${g.input}${g.why ? ` — ${g.why}` : ''}` : g.why)));
  if (d && d.poolAvailable === false) add('your work queue');

  return { seen, gaps, level: ctx.confidence && ctx.confidence.level ? ctx.confidence.level : null };
}

// ── Field drive ─────────────────────────────────────────────────────────────

/**
 * The same mapping `useFieldDrive` applies, from a payload the page already
 * holds — so the field is driven live on the SAiM page without a second poll.
 * `isPressing` is passed in (it lives in the shared field module) so this file
 * stays dependency-free.
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
