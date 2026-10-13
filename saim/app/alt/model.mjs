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
//   * It decides which desk tool to put first — a TOOL choice, never a choice
//     about which WORK matters. The work, its wording, its lifecycle verbs and
//     its uncertainty are NEURO's and are passed through verbatim.
//   * It never makes an unavailable capability look actionable.

// ── Navigation ──────────────────────────────────────────────────────────────

/** Exactly five destinations, in this order. Nothing else is reachable here. */
export const ALT_TABS = Object.freeze([
  Object.freeze({ id: 'saim', label: 'SAiM' }),
  Object.freeze({ id: 'now', label: 'Now' }),
  Object.freeze({ id: 'review', label: 'Review' }),
  Object.freeze({ id: 'capture', label: 'Capture' }),
  Object.freeze({ id: 'controls', label: 'Controls' }),
]);

export const ALT_TAB_IDS = Object.freeze(ALT_TABS.map((t) => t.id));
export const ALT_DEFAULT_TAB = 'saim';

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

// ── Presence ────────────────────────────────────────────────────────────────

/**
 * Where he is, whether the desk is visible, and what SAiM is doing — each with
 * an honest unknown. Wording that NEURO composed is carried verbatim; the only
 * words written here are the unknowns, which say which fact is missing.
 */
export function presence(d) {
  const ctx = (d && d.context) || {};
  const place = ctx.place || null;
  let where;
  if (!place || place.known !== true) {
    where = { known: false, text: 'I can’t tell where you are.' };
  } else {
    const room = place.room ? String(place.room) : null;
    const name = place.name && place.name !== 'unknown' ? String(place.name) : null;
    if (room || name) where = { known: true, text: [room, name].filter(Boolean).join(' · ') };
    else where = { known: false, text: 'I can’t tell where you are.', why: place.roomWhy || null };
  }

  const work = (d && d.work) || null;
  let desk;
  if (!work || work.deskKnown === false) {
    desk = { known: false, visible: null, text: 'I can’t see your laptop.' };
  } else if (work.atDesk) {
    desk = { known: true, visible: true, text: `At ${work.host || 'the laptop'}${work.app ? ` · ${work.app} in front` : ''}` };
  } else {
    desk = { known: true, visible: false, text: 'Not at the laptop.' };
  }

  const op = (d && d.operation) || null;
  const operation = op && op.label
    ? { known: true, label: op.label, detail: op.detail || null, phase: op.phase || null }
    : { known: false, label: null, detail: null, phase: null };

  return { where, desk, operation };
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

/**
 * The current work item, the next physical step and the permitted lifecycle
 * actions. Every word here is NEURO's:
 *   * the item is `primary` (title / say / reason) or, failing that, what
 *     current-work says he is on;
 *   * the next step is the step HE named on the session (`nextStep`) — never
 *     invented, so an absent one is said to be absent;
 *   * the actions are the server's utterances, which are already bounded by
 *     what the attention record allows.
 */
export function currentThread(d, session = null) {
  const primary = (d && d.primary) || null;
  const work = (d && d.work) || null;
  const s = session && session.session ? session.session : null;

  const item = primary
    ? {
      kind: primary.kind || null,
      title: primary.title || null,
      say: primary.say || null,
      reason: primary.reason && primary.reason !== primary.say ? primary.reason : null,
    }
    : (work && work.known && work.task
      ? { kind: 'work', title: work.task, say: null, reason: work.why || null }
      : null);

  const nextStep = s && s.nextStep ? { known: true, text: s.nextStep } : { known: false, text: null };

  const actions = ((d && d.utterances) || [])
    .filter((u) => u && u.intent && LIFECYCLE_KINDS.has(u.intent.kind) && u.say);

  return {
    item,
    nextStep,
    sessionActive: Boolean(s && s.active !== false && s.status !== 'finished'),
    actions,
    workWhy: work && work.why ? work.why : null,
    workConfidence: work && work.confidence ? work.confidence : null,
  };
}


// ── Tool handoff ────────────────────────────────────────────────────────────

/**
 * The desk-agent vocabulary this shell knows how to SHOW and ORDER. Whether any
 * of these is actually openable is decided by the agent's declared `canOpen`,
 * carried as `work.deskOffer.apps` — this list never makes something available.
 *
 * NEURO's `desk-intents.APPS` gained the AI tools and the work apps on 13 Oct
 * 2026 (Nick: the first four were only ever examples).
 */
export const AI_IDS = Object.freeze(['claude', 'chatgpt']);
/** Shown, disabled, when no AI tool is offered — the AI slot always appears. */
export const AI_SLOT = Object.freeze({ id: 'ai', label: 'AI assistant' });
export const MUSIC_SLOT = Object.freeze({ id: 'music', label: 'Music' });
// After AI and Music, in this order when offered.
const OTHER_ORDER = Object.freeze([
  'outlook', 'teams', 'obsidian', 'excel', 'word',
  'nova', 'vantage', 'neuro', 'plaud',
  'browser', 'code', 'terminal', 'ssms', 'postman',
]);

// Foreground process names the desk agent reports → the app id that reopens it.
// Process names only; never titles (the agent never sends them).
const FOREGROUND = Object.freeze({
  code: 'code',
  chrome: 'browser',
  msedge: 'browser',
  firefox: 'browser',
  safari: 'browser',
  windowsterminal: 'terminal',
  pwsh: 'terminal',
  powershell: 'terminal',
  cmd: 'terminal',
  terminal: 'terminal',
  iterm2: 'terminal',
  claude: 'claude',
  chatgpt: 'chatgpt',
  codex: 'chatgpt',
  olk: 'outlook',
  outlook: 'outlook',
  'ms-teams': 'teams',
  msteams: 'teams',
  teams: 'teams',
  obsidian: 'obsidian',
  excel: 'excel',
  winword: 'word',
  plaud: 'plaud',
  ssms: 'ssms',
  postman: 'postman',
});

// Words in the WORK's own text that point at a tool. Deliberately small and
// specific: a tool picked on a word is labelled uncertain, never stated as fact.
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
 * The one recommended tool plus the fixed alternatives.
 *
 * Rules:
 *   1. Only an app in `deskOffer.apps` can be pressable. Not at the desk, desk
 *      unseen, or a machine that has not declared → nothing pressable, and the
 *      offer's own `why` is said.
 *   2. The TOP candidate is chosen from offered apps only, by evidence in this
 *      order: the app he is already in → the kind of card in hand → a tool the
 *      work text names → none. With no evidence the first offered app is still
 *      OFFERED, marked `certain: false`, and the reason says SAiM is unsure.
 *   3. Alternatives, fixed order: AI tools (always — one disabled "AI
 *      assistant" when none is offered), Music (always), then the other
 *      offered apps in OTHER_ORDER — minus whichever is on top.
 */
export function toolHandoff(d, thread = null) {
  const work = (d && d.work) || null;
  const offer = work && work.deskOffer ? work.deskOffer : null;
  const offeredIds = new Set(
    offer && offer.known && Array.isArray(offer.apps) ? offer.apps.map((a) => a && a.id).filter(Boolean) : [],
  );
  const labelOf = (id) => {
    const a = offer && Array.isArray(offer.apps) ? offer.apps.find((x) => x && x.id === id) : null;
    if (a && a.label) return a.label;
    if (id === AI_SLOT.id) return AI_SLOT.label;
    if (id === MUSIC_SLOT.id) return MUSIC_SLOT.label;
    return id;
  };
  const host = (offer && offer.host) || (work && work.host) || null;

  let blockedWhy = null;
  if (!work || work.deskKnown === false) blockedWhy = 'I can’t see your laptop';
  else if (!offer) blockedWhy = 'the laptop hasn’t said what it can open';
  else if (offeredIds.size === 0) blockedWhy = offer.why || 'nothing it can open is set up here';

  const slot = (id) => {
    const available = offeredIds.has(id);
    let why = null;
    if (!available) {
      if (blockedWhy) why = blockedWhy;
      else if (id === AI_SLOT.id) why = 'no AI tool is set up on the desk agent';
      else why = 'not set up on this laptop';
    }
    return { id, label: labelOf(id), available, why };
  };

  const offeredAi = AI_IDS.filter((id) => offeredIds.has(id));
  const order = [...(offeredAi.length ? offeredAi : [AI_SLOT.id]), MUSIC_SLOT.id, ...OTHER_ORDER];

  // ── The top candidate ─────────────────────────────────────────────────
  let top = null;
  if (!blockedWhy) {
    const fg = work && work.app ? FOREGROUND[String(work.app).toLowerCase().replace(/\.exe$/, '')] : null;
    const type = d && d.primary && d.primary.type ? TYPE_HINTS[d.primary.type] : null;
    const text = [thread && thread.item && thread.item.title, work && work.task].filter(Boolean).join(' ');
    const hint = text ? TEXT_HINTS.find((h) => h.re.test(text) && offeredIds.has(h.id)) : null;
    if (fg && offeredIds.has(fg)) {
      top = { ...slot(fg), certain: true, because: `you’re already in ${work.app}` };
    } else if (type && offeredIds.has(type)) {
      top = { ...slot(type), certain: false, because: 'that’s where this kind of thing lives — I’m not certain' };
    } else if (hint) {
      top = { ...slot(hint.id), certain: false, because: 'the work mentions it — I’m not certain this is the right tool' };
    } else {
      const firstOffered = order.find((id) => offeredIds.has(id));
      if (firstOffered) top = { ...slot(firstOffered), certain: false, because: 'I’m not sure which tool this needs — this is my best guess' };
    }
  }

  const alternatives = [...(offeredAi.length ? offeredAi.map(slot) : [slot(AI_SLOT.id)]), slot(MUSIC_SLOT.id)];
  for (const id of OTHER_ORDER) if (offeredIds.has(id)) alternatives.push(slot(id));

  return {
    host,
    top,
    alternatives: alternatives.filter((a) => !top || a.id !== top.id),
    blockedWhy,
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
  if (count === 0) return { known: true, count: 0, text: null };
  return {
    known: true,
    count,
    text: a.say || `${count} waiting for your judgement.`,
    where: a.where || 'NEURO',
  };
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
