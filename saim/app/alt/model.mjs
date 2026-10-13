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
 * How long a touch of THIS page counts as "Nick is at this desk now". A
 * memory-only signal, never stored: see `useLocalActivity` in SaimHome.jsx.
 */
export const LOCAL_ACTIVE_MS = 2 * 60 * 1000;
export function isLocallyActive(localActiveAt, now = Date.now()) {
  const t = typeof localActiveAt === 'number' ? localActiveAt : null;
  return t !== null && now - t >= 0 && now - t < LOCAL_ACTIVE_MS;
}

const AWAY_PLACES = new Set(['out', 'away', 'elsewhere']);

/**
 * Presence, by an explicit EVIDENCE PRIORITY:
 *   1. Recent interaction with this page — direct evidence he is at this desk.
 *   2. The desk agent — which app is in front on that machine.
 *   3. A room / watch signal — supporting only. It never overrides 1 or 2, and
 *      it never places Nick in a room: it is the WATCH that was heard.
 *
 *   line1    `Nick · Home` / `Nick · Office` / `Nick · location unknown`
 *   desk     `desk active · VS Code open` / `desk active` / `away from the laptop`
 *            / `laptop not seen` — "away" ONLY when nothing says he is here.
 *   disagree a compact qualifier when the signals contradict each other:
 *            `Signals disagree — desk active; watch last heard in the living room.`
 *   room     the supporting watch line, for the evidence rail.
 */
export function presence(d, { localActiveAt = null, now = Date.now() } = {}) {
  const ctx = (d && d.context) || {};
  const place = ctx.place || null;
  const life = (d && d.life) || null;
  const work = (d && d.work) || null;
  const local = isLocallyActive(localActiveAt, now);

  let where = null;
  if (place && place.known === true && place.name && place.name !== 'unknown') where = String(place.name);
  else if (life && life.place && life.place.kind === 'home') where = 'Home';
  else if (life && life.place && life.place.kind === 'work') where = 'Work';

  const agentSees = Boolean(work && work.deskKnown !== false && work.atDesk);
  const deskActive = local || agentSees;
  const app = agentSees && work.app ? appName(work.app) : null;

  let desk;
  if (deskActive) desk = app ? `desk active · ${app} open` : 'desk active';
  else if (!work || work.deskKnown === false) desk = 'laptop not seen';
  else desk = 'away from the laptop';

  const room = place && place.room
    ? `${place.roomSubject ? String(place.roomSubject) : 'a device'} last heard in the ${prettyRoom(place.room)}`
    : null;

  // Disagreement is only claimed when two signals genuinely contradict: this
  // page is being used, but the agent or the place read says otherwise.
  let disagree = null;
  if (local) {
    const agentDisagrees = work && (work.deskKnown === false || work.atDesk === false);
    const placeDisagrees = life && life.place && AWAY_PLACES.has(life.place.kind);
    if (agentDisagrees || placeDisagrees) {
      const other = room
        || (work && work.deskKnown === false ? 'the laptop agent can’t be seen' : null)
        || (work && work.atDesk === false ? 'the laptop agent reports no activity' : null)
        || 'the place read says you’re out';
      disagree = `Signals disagree — desk active; ${other}.`;
    }
  }

  const op = (d && d.operation) || null;
  return {
    line1: `Nick · ${where || 'location unknown'}`,
    whereKnown: Boolean(where),
    desk,
    deskActive,
    local,
    app,
    disagree,
    room: room ? cap(room) + '.' : null,
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

/** Is work being held back right now because of what he is doing? NEURO's word. */
const workHeld = (d) => Boolean(d && d.life && d.life.showWork === false);
// NEURO life reads that cannot be true of someone using this desk right now.
// Life reads that are his own time, when work is held.
const OFF_DUTY_DOING = new Set(['relaxing', 'winding-down', 'off', 'watching-tv', 'out']);
const NON_DESK_DOING = new Set(['watching-tv', 'sleeping', 'driving', 'walking', 'exercising', 'out', 'in-meeting-room']);
// How NEURO's life read is said in the held line. Unknown kinds say nothing.
const LIFE_PHRASE = Object.freeze({ hobby: 'on your own project' });

/**
 * The current thread. The work surface is ALWAYS rendered; uncertainty only
 * changes the wording inside it.
 *
 * `state`:
 *   'item'    — an attention ITEM (NEURO's say/title verbatim);
 *   'work'    — a focus session or live task block current-work names;
 *   'context' — NEURO's context read (his own project, a meeting…) by its
 *               title, verbatim;
 *   'unknown' — NEURO cannot read the context, or there is nothing at all.
 *
 * `uncertain` is the ONE compact line saying what is not known, written from
 * what IS observed — never a request that he reconstruct the system's state.
 * `nextStep` is the step HE named — never invented, never asked for.
 */
export function currentThread(d, session = null, { localActiveAt = null, now = Date.now() } = {}) {
  const primary = (d && d.primary) || null;
  const work = (d && d.work) || null;
  const activity = d && d.context ? d.context.activity : null;
  const s = session && session.session ? session.session : null;
  const nextStep = s && s.nextStep ? { known: true, text: s.nextStep } : { known: false, text: null };
  const actions = ((d && d.utterances) || [])
    .filter((u) => u && u.intent && LIFECYCLE_KINDS.has(u.intent.kind) && u.say);

  let state;
  let item = null;
  if (primary && primary.kind === 'item') {
    state = 'item';
    item = {
      type: primary.type || null,
      title: primary.say || primary.title || null,
      sub: primary.say && primary.title && primary.title !== primary.say ? primary.title : null,
      reason: primary.reason && primary.reason !== primary.say ? primary.reason : null,
    };
  } else if (work && work.known && work.task) {
    state = 'work';
    // `work.why` is provenance (how NEURO knows), not part of the thread.
    item = { type: null, title: work.task, sub: null, reason: null };
  } else if (primary && primary.kind === 'context' && activity && activity !== 'unknown'
    && !(isLocallyActive(localActiveAt, now) && d.life && NON_DESK_DOING.has(d.life.doing))) {
    // The context card's `say` repeats the place ("… · living-room"); only its
    // title is NEURO's description of the situation.
    state = 'context';
    item = { type: null, title: primary.title || null, sub: null, reason: null };
  } else if (primary && primary.kind === 'context' && activity && activity !== 'unknown') {
    // NEURO reads him as doing something away from a desk (watching TV, out…)
    // while he is USING this desk. The read is contradicted, so it is not the
    // thread: say what is not known, and name NEURO's read as a read.
    state = 'unknown';
    item = {
      type: null,
      title: 'I can’t tell what you’re working on from what I can see.',
      sub: null,
      reason: primary.title ? `NEURO last read you as “${primary.title}”.` : null,
    };
  } else {
    state = 'unknown';
    item = { type: null, title: 'I can’t tell what you’re working on from what I can see.', sub: null, reason: null };
  }

  // His own time (home, off duty): work is held, and "I don't know the next
  // step" would be a work question asked at the wrong moment.
  const offDuty = state === 'context' && workHeld(d) && Boolean(d.life && OFF_DUTY_DOING.has(d.life.doing));
  let uncertain = null;
  if (!offDuty && !nextStep.known && (state === 'context' || state === 'unknown')) {
    const p = presence(d, { localActiveAt, now });
    uncertain = p.app ? `${p.app} is open — I don’t know the next step yet.` : 'I don’t know the next step yet.';
  }

  return {
    state,
    item,
    uncertain,
    nextStep,
    actions,
    canBringWork: workHeld(d),
    offDuty,
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
  // Nothing waiting is not content: no text, and the rail renders nothing.
  if (count === 0) return { known: true, count: 0, text: null };
  return {
    known: true,
    count,
    text: a.say || `${count} waiting for your judgement.`,
    where: a.where || 'NEURO',
  };
}

// ── What leads the main area ────────────────────────────────────────────────

/**
 * ONE coherent state leads the work surface; everything else is subordinate.
 *
 *   'transition' — a genuine transition NEURO composed (a meeting about to
 *                  start, one just ended): it leads; the thread is held below.
 *   'judgement'  — something waits on his judgement and there is no item or
 *                  live work thread competing with it.
 *   'thread'     — an attention item, live work, or a named step.
 *   'calm'       — NEURO says nothing needs him, there is no thread, and no
 *                  work is held: a compact line, never a big empty card.
 *   'context'    — his context (own project, evening at home) or an honest
 *                  "I can't tell".
 *
 * ⚠ Ordered so contradictions cannot render: an item (EOD outstanding, say)
 *   always outranks `calm`, so "Nothing needs you right now" can never head a
 *   surface that has something needing him.
 */
export function leadOf(d, thread) {
  if (d && d.transition && d.transition.prompt) return 'transition';
  const j = judgement(d);
  const hasThread = thread && (thread.state === 'item' || thread.state === 'work');
  if (j.count > 0 && !hasThread) return 'judgement';
  if (hasThread || (thread && thread.nextStep && thread.nextStep.known)) return 'thread';
  const calm = Boolean(d && d.situation && d.situation.calm === true);
  if (calm && thread && thread.state === 'unknown' && !workHeld(d) && heldWork(d).count === 0) return 'calm';
  return 'context';
}

/**
 * Contradictions a payload must not carry together — used to validate the
 * scenario fixtures, and the reason `leadOf` is ordered as it is. Returns a
 * list of named problems; empty means coherent.
 */
export function checkCoherence(d, session = null, { localActiveAt = null, now = Date.now() } = {}) {
  const problems = [];
  const calm = Boolean(d && d.situation && d.situation.calm === true);
  const primary = d && d.primary;
  if (calm && primary && primary.kind === 'item') problems.push('calm while an item needs him');
  const j = judgement(d);
  if (calm && j.count > 0) problems.push('calm while something waits on his judgement');
  if (calm && d && d.transition && d.transition.prompt) problems.push('calm while a transition leads');
  const work = d && d.work;
  if (work && work.deskOffer && work.deskOffer.known && work.atDesk === false && (work.deskOffer.apps || []).length) {
    problems.push('the laptop offers apps while it says he is not at it');
  }
  const t = currentThread(d, session, { localActiveAt, now });
  const tools = toolHandoff(d, t);
  if (tools.top && tools.top.id === foregroundId(d)) problems.push('recommends opening the app already in front');
  if (tools.top && !t.nextStep.known) problems.push('recommends a tool without a named step');
  const p = presence(d, { localActiveAt, now });
  if (p.local && p.desk === 'away from the laptop') problems.push('says away while the page is in use');
  return problems;
}

// ── Development scenarios ───────────────────────────────────────────────────

export const SCENARIO_IDS = Object.freeze(['working', 'stuck', 'transition', 'judgement', 'calm', 'home', 'conflict']);

/**
 * `?scenario=<id>` → the id, or null. Only an exact, known id is accepted; an
 * unknown or empty value means LIVE data, never a guess.
 */
export function scenarioFromUrl(search) {
  if (typeof search !== 'string' || !search) return null;
  let v = null;
  try { v = new URLSearchParams(search).get('scenario'); } catch { return null; }
  return v && SCENARIO_IDS.includes(v) ? v : null;
}

// ── Context for the rail ────────────────────────────────────────────────────

/**
 * Concise evidence, shown ONLY when it helps resolve uncertainty: the thread is
 * not known, the signals disagree, or NEURO could not read something. A settled
 * state with a known thread gets nothing — absence of a problem is not content.
 *
 * Each line is a different KIND of fact, never merged into a claim about Nick.
 */
export function evidence(d, thread, p) {
  const gaps = [];
  const add = (g) => { if (g && !gaps.includes(g)) gaps.push(g); };
  const ctx = (d && d.context) || {};
  if (Array.isArray(ctx.unknowns)) ctx.unknowns.forEach((u) => add(typeof u === 'string' ? u : (u && (u.input || u.why)) || null));
  if (Array.isArray(ctx.cannotSee)) ctx.cannotSee.forEach((u) => add(typeof u === 'string' ? u : (u && (u.label || u.input || u.why)) || null));
  if (Array.isArray(d && d.gaps)) d.gaps.forEach((g) => add(g && (g.input ? `${g.input}${g.why ? ` — ${g.why}` : ''}` : g.why)));

  const useful = Boolean(p.disagree) || gaps.length > 0 || (thread && (thread.state === 'context' || thread.state === 'unknown'));
  if (!useful) return null;

  const lines = [];
  lines.push(cap(p.desk) + '.');
  if (p.room && !p.disagree) lines.push(p.room);
  if (!p.whereKnown) lines.push('Location unknown.');
  if (workHeld(d)) lines.push('Work context held.');
  return { lines, gaps };
}

// ── Field drive ─────────────────────────────────────────────────────────────

/**
 * What the field is told, in `useFieldDrive`'s exact shape, from a payload the
 * page already holds. The field, the drive function and the colour ramp are
 * the control's, UNCHANGED.
 *
 * ⚠ THE ONE TREATMENT DIFFERENCE (Nick, 13 Oct 2026: "orange or red must remain
 *   reserved for real pressure, uncertainty that needs attention, or an
 *   approaching demand"). The shared drive maps any confident, non-quiet read to
 *   intensity 0.60 — ORANGE — so a calm evening or ordinary focused work
 *   rendered in the colour of pressure. Here, a read with nothing pressing, no
 *   approaching transition/firefighting and nothing waiting on his judgement is
 *   told `quiet`, which is the drive's own low-intensity BLUE. Pressing (red),
 *   an approaching demand or a waiting approval (orange) and degraded (grey)
 *   are exactly as before. No new colour is defined. Trade-off: `quiet` also
 *   gives the drive's gentler settle, so a restful read settles less deeply
 *   than the control would draw it.
 */
export function driveFrom(d, isPressing) {
  if (!d) return { activity: undefined, confidenceLevel: 'low', quiet: false, degraded: true, pressing: false };
  const pressing = typeof isPressing === 'function' ? Boolean(isPressing(d.primary)) : false;
  const ctx = d.context || {};
  const a = d.approvals || {};
  const approaching = Boolean(d.transition && d.transition.prompt) || ctx.activity === 'pre-meeting' || ctx.activity === 'firefighting';
  const waiting = a.known === true && ((a.needsApproval || 0) + (a.needsReview || 0)) > 0;
  // Orange and red are reserved for pressure, an approaching demand, or
  // something waiting on his judgement. Anything else is restful → the drive's
  // own low-intensity blue.
  const restful = !pressing && !approaching && !waiting;
  return {
    activity: ctx.activity,
    confidenceLevel: (ctx.confidence && ctx.confidence.level) || 'low',
    quiet: d.quiet === true || restful,
    degraded: d.poolAvailable === false || d.available === false,
    pressing,
  };
}
