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
//   * It decides how to SAY the situation in a sentence, from NEURO's own
//     signals — and how to say that a signal is missing.
//   * It decides which desk tool to put first, and ONLY when there is a real
//     named next step. A TOOL choice, never a choice about which WORK matters.
//   * It never makes an unavailable capability look actionable, and never
//     invents a next step, an app, a location, a confidence or an urgency.

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
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

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
 * Presence: `Nick · Office|Home|Work|location unknown`, plus what SAiM is
 * doing (the operation phase, lower-case, beside it — never a badge).
 *
 * ⚠ The place comes from NEURO's place read (a named place) or its life read
 *   (home / work). A ROOM is never used here: the room comes from a sensor that
 *   hears a DEVICE, and is reported in the evidence trail as exactly that.
 */
export function presence(d) {
  const ctx = (d && d.context) || {};
  const place = ctx.place || null;
  const life = (d && d.life) || null;

  let where = null;
  if (place && place.known === true && place.name && place.name !== 'unknown') where = String(place.name);
  else if (life && life.place && life.place.kind === 'home') where = 'Home';
  else if (life && life.place && life.place.kind === 'work') where = 'Work';

  const op = (d && d.operation) || null;
  return {
    line1: `Nick · ${where || 'location unknown'}`,
    whereKnown: Boolean(where),
    operation: op && op.label ? String(op.label).toLowerCase() : null,
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

/** Is work being held back right now because of what he is doing? NEURO's word. */
const workHeld = (d) => Boolean(d && d.life && d.life.showWork === false);
// How NEURO's life read is said in the held line. Unknown kinds say nothing.
const LIFE_PHRASE = Object.freeze({ hobby: 'on your own project' });

/**
 * The current thread, and which of the two page modes it calls for.
 *
 * `mode`:
 *   'thread' — there IS a thread: an attention ITEM (NEURO's say/title
 *              verbatim), a focus session or live task block current-work
 *              names, or a step he has named. The compact card renders.
 *   'quiet'  — no thread and no named step (his own time, or a context NEURO
 *              cannot read). Uncertainty is a QUIET state: no card, no
 *              questions, the field dominant — see `statement`.
 *
 * `nextStep` is the step HE named on the session — never invented, never asked
 * for unprompted. `actions` are the server's lifecycle utterances, verbatim.
 */
export function currentThread(d, session = null) {
  const primary = (d && d.primary) || null;
  const work = (d && d.work) || null;
  const s = session && session.session ? session.session : null;
  const nextStep = s && s.nextStep ? { known: true, text: s.nextStep } : { known: false, text: null };
  const actions = ((d && d.utterances) || [])
    .filter((u) => u && u.intent && LIFECYCLE_KINDS.has(u.intent.kind) && u.say);

  let item = null;
  if (primary && primary.kind === 'item') {
    item = {
      kind: 'item',
      type: primary.type || null,
      title: primary.say || primary.title || null,
      sub: primary.say && primary.title && primary.title !== primary.say ? primary.title : null,
      reason: primary.reason && primary.reason !== primary.say ? primary.reason : null,
    };
  } else if (work && work.known && work.task) {
    item = { kind: 'work', type: null, title: work.task, sub: null, reason: work.why || null };
  } else if (nextStep.known) {
    // A named step on his own time: the context title is NEURO's, verbatim.
    item = { kind: 'context', type: null, title: (primary && primary.title) || (d && d.life && d.life.label) || null, sub: null, reason: null };
  }

  return {
    mode: item ? 'thread' : 'quiet',
    item,
    nextStep,
    actions,
  };
}

/**
 * The quiet statement — what SAiM says over her field when there is no thread.
 * Short, honest, and asks nothing of him.
 *
 *   lines      — `You’re home. VS Code is open.` / `I’m holding work for now.`
 *   qualifiers — small, honest caveats: a room heard via a DEVICE (never Nick
 *                placed in it), and anything NEURO could not read.
 *   actions    — at most two quiet links: tell her what you're doing; bring
 *                work back (only while work is actually held).
 */
export function statement(d) {
  const p = presence(d);
  const work = (d && d.work) || null;
  const place = d && d.context && d.context.place;
  const where = p.whereKnown ? p.line1.replace(/^Nick · /, '') : null;

  let placeSay;
  if (!where) placeSay = 'I can’t place you right now.';
  else if (where === 'Home') placeSay = 'You’re home.';
  else if (where === 'Work') placeSay = 'You’re at work.';
  else placeSay = `You’re at ${where}.`;

  let deskSay = null;
  if (!work || work.deskKnown === false) deskSay = 'I can’t see the laptop.';
  else if (work.atDesk && work.app) deskSay = `${appName(work.app)} is open.`;
  else if (!work.atDesk) deskSay = 'You’re away from the laptop.';

  const lines = [[placeSay, deskSay].filter(Boolean).join(' ')];
  const blind = silence(d);
  if (blind && blind.kind === 'blind') lines.push(blind.text);
  else if (workHeld(d)) lines.push('I’m holding work for now.');
  else if (d && d.context && d.context.activity === 'unknown') lines.push('I’m not sure what you’re doing.');

  const qualifiers = [];
  if (place && place.room) {
    const what = place.roomSubject ? cap(String(place.roomSubject)) : 'A device';
    qualifiers.push(`${what} heard in the ${prettyRoom(place.room)}.`);
  }
  const gaps = gapsOf(d);
  if (gaps.length) qualifiers.push(`Can’t read: ${gaps.join('; ')}.`);

  const actions = [{ id: 'tell', label: 'Tell me what you’re doing' }];
  if (workHeld(d)) actions.push({ id: 'bring', label: 'Bring work back' });

  return { lines, qualifiers, actions, operation: p.operation };
}

/** Every input NEURO says it could not read, named. */
function gapsOf(d) {
  const ctx = (d && d.context) || {};
  const gaps = [];
  const add = (g) => { if (g && !gaps.includes(g)) gaps.push(g); };
  if (Array.isArray(ctx.unknowns)) ctx.unknowns.forEach((u) => add(typeof u === 'string' ? u : (u && (u.input || u.why)) || null));
  if (Array.isArray(ctx.cannotSee)) ctx.cannotSee.forEach((u) => add(typeof u === 'string' ? u : (u && (u.label || u.input || u.why)) || null));
  if (Array.isArray(d && d.gaps)) d.gaps.forEach((g) => add(g && (g.input ? `${g.input}${g.why ? ` — ${g.why}` : ''}` : g.why)));
  return gaps;
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

// Words that point at a tool. Specific on purpose.
const TEXT_HINTS = Object.freeze([
  { id: 'nova', re: /\bnova\b/i },
  { id: 'vantage', re: /\bvantage\b/i },
  { id: 'plaud', re: /\b(plaud|transcript|recording)\b/i },
  { id: 'ssms', re: /\b(sql|query|database|stored procedure)\b/i },
  { id: 'excel', re: /\b(spreadsheet|excel|csv|xlsx)\b/i },
  { id: 'word', re: /\b(word doc|docx)\b/i },
  { id: 'outlook', re: /\b(email|e-mail|inbox|reply to)\b/i },
  { id: 'obsidian', re: /\b(vault|obsidian|write-up|write up|note)\b/i },
  { id: 'postman', re: /\b(postman|api call|endpoint)\b/i },
  { id: 'claude', re: /\b(claude|draft|outline|headings|summari[sz]e|rewrite)\b/i },
  { id: 'code', re: /\b(code|bug|deploy|commit|repo|refactor|test suite|script)\b/i },
  { id: 'terminal', re: /\b(ssh|terminal|pm2|server log|shell)\b/i },
  { id: 'browser', re: /\b(jira|confluence|ticket|portal|website|dashboard|grafana|netlify)\b/i },
]);

// The KIND of card in hand, when NEURO says what it is.
const TYPE_HINTS = Object.freeze({ email: 'outlook' });

/** The app id of what is in front of him, if the laptop says. */
export function foregroundId(d) {
  const work = d && d.work;
  if (!work || work.deskKnown === false || !work.atDesk || !work.app) return null;
  return FOREGROUND[String(work.app).toLowerCase().replace(/\.exe$/, '')] || null;
}

/**
 * The tool area.
 *
 * `mode`:
 *   'blocked' — laptop unseen / away / undeclared: nothing pressable, reason said.
 *   'browse'  — no named next step: NO recommendation. Only a compact row of
 *               other ways in, never including what is already in front.
 *   'step'    — a named next step: one recommendation, from the step's own
 *               words (then the card kind). If that app is ALREADY in front,
 *               `already` is set and there is no Open button. If the step names
 *               no tool, there is no recommendation — never a guess.
 *
 * A primary `top` (an Open button) exists ONLY when: a named step, a
 * recommended app that is NOT in front, and the laptop declared it.
 *
 * `row` = one AI tool, Music, up to three context apps (never the foreground
 * app, never the top); `more` = the rest of the declared apps.
 */
export function toolHandoff(d, thread = null) {
  const work = (d && d.work) || null;
  const offer = work && work.deskOffer ? work.deskOffer : null;
  const offered = offer && offer.known && Array.isArray(offer.apps) ? offer.apps.filter((a) => a && a.id) : [];
  const offeredIds = new Set(offered.map((a) => a.id));
  const label = (id) => (offered.find((a) => a.id === id) || {}).label || id;
  const host = (offer && offer.host) || (work && work.host) || null;
  const step = thread && thread.nextStep && thread.nextStep.known ? thread.nextStep.text : null;

  let blockedWhy = null;
  if (!work || work.deskKnown === false) blockedWhy = 'I can’t see your laptop';
  else if (!offer) blockedWhy = 'the laptop hasn’t said what it can open';
  else if (offeredIds.size === 0) blockedWhy = offer.why || 'nothing it can open is set up here';
  if (blockedWhy) return { mode: 'blocked', host, step, top: null, already: null, row: [], more: [], blockedWhy };

  const fg = foregroundId(d);
  const entry = (id) => ({ id, label: label(id), available: true, why: null });

  let top = null;
  let already = null;
  if (step) {
    const type = d && d.primary && d.primary.type ? TYPE_HINTS[d.primary.type] : null;
    const hinted = TEXT_HINTS.filter((h) => h.re.test(step) && offeredIds.has(h.id)).map((h) => h.id);
    const pick = hinted[0] || (type && offeredIds.has(type) ? type : null);
    if (pick && pick === fg) already = { ...entry(pick), because: `You’re already in ${label(pick)}.` };
    else if (pick) top = { ...entry(pick), because: hinted[0] ? 'The step names it.' : 'That’s where this kind of thing lives.' };
  }

  const used = new Set([fg, top && top.id, already && already.id].filter(Boolean));
  const row = [];
  const aiId = AI_IDS.find((id) => offeredIds.has(id) && !used.has(id));
  if (aiId) { row.push(entry(aiId)); used.add(aiId); }
  else if (!AI_IDS.some((id) => used.has(id))) row.push({ id: 'ai', label: 'AI', available: false, why: 'no AI tool set up on the laptop' });
  if (!used.has(MUSIC_ID)) {
    row.push(offeredIds.has(MUSIC_ID) ? entry(MUSIC_ID) : { id: MUSIC_ID, label: 'Music', available: false, why: 'not set up on the laptop' });
    used.add(MUSIC_ID);
  }
  const rest = [];
  const push = (id) => { if (offeredIds.has(id) && !used.has(id) && !rest.includes(id)) rest.push(id); };
  if (step) TEXT_HINTS.filter((h) => h.re.test(step)).forEach((h) => push(h.id));
  OTHER_ORDER.forEach(push);
  AI_IDS.forEach(push); // a second AI tool is a fallback, not context
  offered.forEach((a) => push(a.id));

  return {
    mode: step ? 'step' : 'browse',
    host,
    step,
    top,
    already,
    row: [...row, ...rest.slice(0, CONTEXT_LIMIT).map(entry)],
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
 *
 * `line` says it as held, never as failed or hidden: when NEURO's life read is
 * holding WORK because of what he is doing, it says so in those terms.
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
  const n = items.length;
  let line = null;
  if (n > 0) {
    const doing = d && d.life && d.life.doing;
    const phrase = workHeld(d) && doing ? LIFE_PHRASE[doing] : null;
    const noun = n === 1 ? 'item is' : 'items are';
    if (phrase) line = `${n} work ${noun} held while you’re ${phrase}.`;
    else line = `${n} ${noun} held${reasons.length ? `: ${reasons.join('; ')}` : ''}.`;
  }
  return { count: n, reasons, items, line };
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

// ── Field drive ─────────────────────────────────────────────────────────────

/**
 * What the field is told, in `useFieldDrive`'s exact shape, from a payload the
 * page already holds. The field, the drive function and the colour ramp are
 * the control's, UNCHANGED.
 *
 * ⚠ THE ONE TREATMENT DIFFERENCE (13 Oct 2026, Nick): the shared drive maps a
 *   confident, non-quiet read to intensity 0.60 — ORANGE — so a calm evening on
 *   his own project rendered in the colour reserved for pressure. NEURO already
 *   says when nothing needs him: `situation.calm`. When that is true and
 *   nothing is pressing, the drive is told `quiet`, which is its own existing
 *   low-intensity BLUE. Degraded and pressing still win exactly as before, so
 *   orange and red stay reserved for real pressure. No new colour is defined.
 */
export function driveFrom(d, isPressing) {
  if (!d) return { activity: undefined, confidenceLevel: 'low', quiet: false, degraded: true, pressing: false };
  const pressing = typeof isPressing === 'function' ? Boolean(isPressing(d.primary)) : false;
  const calm = Boolean(d.situation && d.situation.calm === true) && !pressing;
  return {
    activity: d.context && d.context.activity,
    confidenceLevel: (d.context && d.context.confidence && d.context.confidence.level) || 'low',
    quiet: d.quiet === true || calm,
    degraded: d.poolAvailable === false || d.available === false,
    pressing,
  };
}
