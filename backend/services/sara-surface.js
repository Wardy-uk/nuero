'use strict';

/**
 * What SARA SHOWS, and what Nick could SAY next.
 *
 * ⚠ WHY THIS EXISTS. Nick, 31 Aug 2026, on what SARA actually is:
 *
 *   "if we start with the principle that SARA is a manifestation so shouldn't be
 *    bogged down in menus — she should be a series of dashboards, and everything
 *    she can do should be achievable conversationally. She should adapt what
 *    she's showing me, but she isn't a click here to do this interface... we
 *    should allow that when I can't speak to her, but that's the principle."
 *
 * Three things follow, and this module is all three:
 *
 *   1. THE DASHBOARD IS AN ANSWER, NOT A DESTINATION. It changes because the
 *      situation changed or because he asked something — never because he went
 *      looking. So which one to show is a DECISION, and decisions are composed
 *      here, server-side, beside `say` / `speech` / `tab`. Three surfaces
 *      already render one attention decision; they must not each invent a
 *      fourth thing about it.
 *   2. EVERY ACTION IS A SENTENCE. `utterances` are the literal words — "make it
 *      smaller", "not now, an hour", "that's done" — each carrying a STRUCTURED
 *      intent so no client ever parses language. The mute path and the spoken
 *      path are then one vocabulary rather than two competing ones.
 *   3. THE BUTTONS ARE THE FALLBACK, NOT THE PRODUCT. They exist for when he
 *      cannot speak, which is why every one of them reads as the thing he would
 *      have said.
 *
 * ── PURE ────────────────────────────────────────────────────────────────────
 * No DB, no clock, no I/O, no fetching. It takes the payload `attention.build()`
 * already assembled and returns a view of it — the `pi-health.assess()` /
 * `state-of-play.assess()` / `context-state` split, for the same reason: the
 * decision IS the product, so it has to pin without a Pi, a vault or a network.
 *
 * ⚠ IT ADDS NO CANDIDATES AND RE-RANKS NOTHING. `decision-engine` stays the one
 * place something becomes worth surfacing and `attention.gate()` the one place
 * it is filtered. This only decides how to FRAME what those two already
 * decided. That boundary is not stylistic: `sara/backend/src/state/inference.js`
 * was retired for computing its own activity enum, confidence model and
 * recommended-view map — a second brain — and the strip that rendered its
 * suggestion was removed for putting a second account of Nick's state on screen
 * beside the canonical one. The difference here is that there is ONE brain, the
 * choice is RENDERED rather than advised, and `surface` follows
 * `context.activity` rather than re-deriving it.
 *
 * ⚠ NOTHING HERE LEAVES THE BUILDING. No utterance sends an email, books a
 * meeting, or chases a person. Those all queue behind the approval gate on the
 * desktop, and `action-presenter` is the one place that judges what counts as
 * outbound. An ambient surface that can send is an ambient surface that can send
 * by accident.
 *
 * CommonJS.
 */

// The bounded surface set. One per situation, and adding one is a deliberate
// act — this is a fixed list, never derived from the data, or a screen nobody
// designed appears the first time an input takes an unexpected shape.
const SURFACES = {
  BLIND: 'blind',
  IN_MEETING: 'in-meeting',
  FIREFIGHTING: 'firefighting',
  PRE_MEETING: 'pre-meeting',
  SESSION: 'session',
  RITUAL: 'ritual',
  OFF_DUTY: 'off-duty',
  STEADY: 'steady',
  // Reachable only by ASKING. It has no activity of its own — "what's in my
  // inbox" is a question, not a situation — which is exactly why the dashboards
  // and the activities are not the same list.
  INBOX: 'inbox',
};

// context-state's activity → the surface that frames it. A DIRECT MAP, on
// purpose: the moment this starts adding conditions of its own it has become a
// second opinion about what kind of moment this is.
const BY_ACTIVITY = {
  'in-meeting': SURFACES.IN_MEETING,
  'pre-meeting': SURFACES.PRE_MEETING,
  firefighting: SURFACES.FIREFIGHTING,
  'in-focus-session': SURFACES.SESSION,
  ritual: SURFACES.RITUAL,
  off: SURFACES.OFF_DUTY,
  away: SURFACES.STEADY,
  steady: SURFACES.STEADY,
  unknown: SURFACES.STEADY,
};

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Which dashboard frames this moment. PURE.
 *
 * ⚠ Exactly ONE thing outranks the activity: an unreadable pool. A dashboard
 * drawn over work SARA could not see is a confident picture of a day nobody
 * read — the failure every honesty rule in this codebase exists to prevent. So
 * `blind` wins outright, and it is the only override.
 *
 * ⚠ An UNRECOGNISED activity resolves to `steady`, never to nothing. A missing
 * surface renders as a blank screen, and "silence is a valid answer for a
 * notification; it is never one for a screen".
 */
function surfaceFor(payload) {
  if (!isObj(payload)) return SURFACES.BLIND;
  if (payload.poolAvailable === false) return SURFACES.BLIND;
  const activity = payload.context && payload.context.activity;
  return BY_ACTIVITY[activity] || SURFACES.STEADY;
}

/**
 * Which dashboard a QUESTION implies. PURE, deterministic, no model call.
 *
 * ⚠ WHY THIS EXISTS. Nick's principle is that everything she can do should be
 * achievable conversationally, and until now asking her something streamed an
 * answer and left the screen showing whatever it was showing. So "what have I
 * got on" produced words where it should produce words AND the day — which made
 * the conversation a chat window sitting on top of a dashboard, rather than the
 * thing that drives it.
 *
 * ⚠ DETERMINISTIC ON PURPOSE — `event-parser`'s regex-first rule. This runs on
 * a path polled by three surfaces and has to be instant, free, identical every
 * time, and work with the Pi's models offline. A model call to decide which
 * panel to draw would spend latency making the screen less predictable.
 *
 * ⚠ NO MATCH RETURNS NULL, and null means "leave the dashboard where it is".
 * Guessing a panel from a question it does not understand is how she starts
 * answering a different question from the one asked — and the streamed answer
 * is still shown either way, so a miss costs nothing.
 */
const ASK_ROUTES = [
  { re: /\b(inbox|e-?mails?|mail)\b/i, surface: SURFACES.INBOX },
  { re: /\b(escalat\w*|breach\w*|on fire|firefight\w*)\b/i, surface: SURFACES.FIREFIGHTING },
  { re: /\b(diary|calendar|agenda|schedule|meetings?|got on|my day|today)\b/i, surface: SURFACES.STEADY },
  { re: /\b(finish\w*|done|wins?|this week|target|progress)\b/i, surface: SURFACES.OFF_DUTY },
  { re: /\b(session|focus|smaller|stuck)\b/i, surface: SURFACES.SESSION },
];

function surfaceForQuestion(text) {
  const q = typeof text === 'string' ? text.trim() : '';
  if (!q) return null;
  for (const r of ASK_ROUTES) if (r.re.test(q)) return r.surface;
  return null;
}

// ── Dashboard rows ──────────────────────────────────────────────────────────
//
// One uniform row shape across every dashboard, so a client renders any of them
// without a switch per kind. A renderer that knows the kinds is a renderer that
// has to be edited every time a dashboard is added.
function row(when, what, opts = {}) {
  return {
    when: when === null || when === undefined ? null : String(when),
    what: String(what),
    // How long until this one starts, in words, composed HERE — a client
    // subtracting two times is a fourth opinion about the same minute, and one
    // that keeps counting down against a payload that stopped refreshing.
    countdown: opts.countdown ? String(opts.countdown) : null,
    meta: opts.meta ? String(opts.meta) : null,
    // The evidence line. Meeting prep's rule, generalised: a row whose source
    // is unknown must not look identical to a sourced one.
    note: opts.note ? String(opts.note) : null,
    level: opts.level || null, // null | 'warn' | 'crit'
  };
}

function timeOf(event) {
  const s = event && (event.start || event.startTime || event.when);
  if (typeof s !== 'string') return null;
  // ⚠ SLICED out of the string, never parsed into a Date. The backend already
  // asked Graph for Europe/London wall-clock times; re-parsing re-applies an
  // offset and shows every BST event an hour out — the bug NEURO's calendar had
  // once already, and VESTA's had after it.
  const m = s.match(/\d{2}:\d{2}/);
  return m ? m[0] : null;
}

/** The end of an event, sliced out of the string exactly as `timeOf` slices the start. */
function endTimeOf(event) {
  const s = event && (event.end || event.endTime);
  if (typeof s !== 'string') return null;
  const m = s.match(/\d{2}:\d{2}/);
  return m ? m[0] : null;
}

// Two titles name the same thing. Case and surrounding space only — nothing
// fuzzy, because the cost of a wrong match here is a real item HIDDEN from a
// list Nick uses to find what he owes, and the cost of a miss is only that he
// sees it twice, which is the state we are already in.
function normTitle(v) {
  return typeof v === 'string' ? v.trim().toLowerCase().replace(/\s+/g, ' ') : null;
}

// ⚠ THE COUNTDOWN STARTS AT HALF AN HOUR, and that is Nick's number (8 Sep
// 2026). Beyond it the clock time IS the useful fact — "in 3 hours" reads as
// something to react to when it is not — and a countdown on every row would
// make none of them mean anything.
const COUNTDOWN_MINUTES = 30;

function countdownFor(event) {
  if (!isObj(event) || event.allDay === true) return null;
  const m = event.minutesAway;
  // ⚠ `null` is "across a day boundary" and is NOT zero. Printing "now" over
  // tomorrow's first meeting is a placeholder shown as a fact.
  if (!Number.isFinite(m) || m < 0 || m > COUNTDOWN_MINUTES) return null;
  if (m === 0) return 'now';
  return m === 1 ? 'in 1 min' : `in ${m} min`;
}

/**
 * The agenda, as rows. `known:false` yields NO rows and a stated gap.
 *
 * ⚠ A RUNNING event is NOT a row — it is the `now` slot above them, because
 * "what am I in" and "what is coming" are different questions and answering
 * both with one list is what made the same meeting appear twice.
 *
 * @param {object} [opts.countdownHandledFor] a subject the TRANSITION is
 *   already counting down. Saying "starts in 9 minutes" above a row reading
 *   "in 9 min" is the same fact twice on one screen.
 */
function agendaRows(agenda, limit = 4, opts = {}) {
  if (!isObj(agenda) || agenda.known !== true || !Array.isArray(agenda.events)) return [];
  const spokenFor = normTitle(opts.countdownHandledFor);
  return agenda.events
    .filter((e) => e && e.running !== true)
    .slice(0, limit)
    .map((e, i) => row(
      timeOf(e) || '—',
      e.subject || e.title || 'Untitled',
      {
        // ⚠ THE NEXT ONE ONLY. The list is sorted, so index 0 is the next
        // thing; a countdown further down the day is noise competing with it.
        countdown: i === 0 && normTitle(e.subject) !== spokenFor ? countdownFor(e) : null,
        // ⚠ "solo" is only said when the brain KNOWS. `attendeesOther` is
        // three-valued and null means "we could not tell" — half Nick's diary is
        // solo blocks, so guessing either way is wrong in a way he would notice.
        meta: e.attendeesOther === true ? 'with others'
          : e.attendeesOther === false ? 'on your own'
            : null,
      }
    ));
}

/**
 * What he is in RIGHT NOW, or that the diary is clear. PURE.
 *
 * Nick, 8 Sep 2026: "there should be a 'current' section as well, showing what
 * I should be currently doing - or indicating I'm free if there's nothing in
 * the diary." The agenda already answered "what's next" and nothing answered
 * "what's on", so a running meeting was indistinguishable from a free hour.
 *
 * ⚠ AN UNREADABLE DIARY YIELDS NULL, NEVER "FREE". "I couldn't look" and
 * "there's nothing on" are opposite facts and only one of them licenses him to
 * start something — this is the same refusal the dashboard note already makes,
 * and answering it twice differently is how a surface starts lying.
 *
 * ⚠ IT SPEAKS ABOUT THE DIARY, NOT ABOUT HIM. "Nothing in the diary" is a fact
 * that can be checked; "you're free" is a claim about his workload that a
 * calendar cannot support, with 150 open tasks sitting one panel below.
 */
function nowSlot(agenda) {
  if (!isObj(agenda) || agenda.known !== true) return null;
  const events = Array.isArray(agenda.events) ? agenda.events : [];

  // ⚠ All-day events are excluded on BOTH branches. One is not something he is
  // "in", and it has no end time to count down to — rendering its 00:00 as a
  // clock reading is the bug the agenda already learned once.
  const running = events.find((e) => e && e.running === true && e.allDay !== true);
  if (running) {
    const until = endTimeOf(running);
    return {
      what: running.subject || 'Untitled',
      meta: until ? `until ${until}` : null,
      free: false,
    };
  }

  // ⚠ Only the TODAY scope can say anything about the rest of today. A rolled
  // forward agenda is here precisely BECAUSE today has nothing left in it, so
  // "clear for the rest of the day" is the true statement in that case — and
  // "free until 09:00" about tomorrow morning would not be.
  const next = agenda.scope === 'today'
    ? events.find((e) => e && e.running !== true && e.allDay !== true)
    : null;
  const at = next ? timeOf(next) : null;
  return {
    what: 'Nothing in the diary',
    meta: at ? `free until ${at}` : 'clear for the rest of the day',
    free: true,
  };
}

/**
 * The subject the transition is already counting down, if it is doing that.
 * Only `leave-now` counts: a post-meeting prompt names something that has
 * finished and is not competing with a countdown.
 */
function transitionSubject(payload) {
  const t = payload && payload.transition;
  if (!isObj(t) || t.kind !== 'leave-now') return null;
  return (isObj(t.meta) && t.meta.subject) || null;
}

/**
 * What could not be read, in SARA's own words where she has them.
 *
 * ⚠ Carried onto EVERY dashboard, not only the blind one. A partly-read day is
 * the normal case, and a dashboard that shows four of five sources without
 * saying so is the "partly live rendered as total confidence" failure the kiosk
 * banner already exists to prevent, one level in.
 */
function gapsOf(payload) {
  const out = [];
  if (Array.isArray(payload.gaps)) {
    for (const g of payload.gaps) {
      if (g && g.input) out.push({ input: String(g.input), why: g.why ? String(g.why) : null });
    }
  }
  return out;
}

// ── The dashboards ──────────────────────────────────────────────────────────
//
// Each returns { kind, label, rows, figure, note }. Every one of them renders
// what the payload ALREADY carries — none of them fetches, and that is the
// discipline that keeps this pure and free to call on every poll.

function dashSteady(payload) {
  const agenda = payload.agenda;
  const known = isObj(agenda) && agenda.known === true;
  const rows = agendaRows(agenda, 4, { countdownHandledFor: transitionSubject(payload) });

  // ⚠ THE PRIMARY IS NOT REPEATED HERE. It used to be appended as an `open`
  // row — the same title and the same `say` that the headline two lines above
  // had just given, word for word (Nick, 8 Sep 2026, seeing it three times on
  // one screen). The dashboard answers "what shape is the day"; the headline
  // answers "what should I do". Restating one inside the other buys nothing
  // and costs the panel its meaning.

  return {
    kind: SURFACES.STEADY,
    // The scope is the brain's word for which day these belong to, rendered
    // verbatim — a client deciding "today" vs "tomorrow" for itself is a second
    // opinion about the one thing an agenda is for.
    label: !known ? 'your day' : agenda.scope === 'today' ? 'the rest of your day' : `${agenda.scope}`,
    now: nowSlot(agenda),
    rows,
    figure: null,
    // ⚠ Three distinct facts, and only the last two are good news: "I couldn't
    // see your diary", "nothing left today", "here is what's left". Collapsing
    // the first into either of the others is the failure the whole provenance
    // model exists to prevent.
    note: !known ? 'I couldn’t read your diary, so this isn’t the whole day.'
      : rows.length === 0 ? 'Nothing else in the diary.'
        : null,
  };
}

function dashPreMeeting(payload) {
  const known = isObj(payload.agenda) && payload.agenda.known === true;
  const rows = agendaRows(payload.agenda, 3, { countdownHandledFor: transitionSubject(payload) });
  return {
    kind: SURFACES.PRE_MEETING,
    label: 'what’s coming',
    now: nowSlot(payload.agenda),
    rows,
    figure: null,
    note: known ? null : 'I couldn’t read your diary.',
  };
}

// What the pool calls something that is on fire. Kept in step with
// `attention.QUEUE_TYPES` by intent — a type here that the engine never emits
// simply matches nothing, which is a quiet failure, so the fallback below is
// what actually protects the screen.
const HOT_TYPES = new Set(['escalation', 'nova-flag', 'novaFlag', 'breach', 'sla']);

function dashFirefighting(payload) {
  // ⚠ REAL ESCALATIONS FIRST, when they could be read. Before this the dashboard
  // could only show the generic pool under the word "live now", so the one
  // surface that exists for things actually on fire was the vaguest of the
  // eight. These are a local `agent_state` read, not a Jira call.
  const esc = payload.escalations;
  if (isObj(esc) && esc.known === true && Array.isArray(esc.items) && esc.items.length) {
    return {
      kind: SURFACES.FIREFIGHTING,
      label: 'unanswered escalations',
      rows: esc.items.slice(0, 4).map((e) => row(
        e.key || 'open',
        e.summary || 'No summary',
        {
          // Each of these is already NULLED upstream when it is the queue's
          // default rather than a fact about the ticket — "Unset" priority,
          // "Open" status, Nick's own name. What survives is the finding.
          meta: [e.priority, e.assignee].filter(Boolean).join(' · ') || null,
          note: e.status || null,
          level: e.priority === 'Critical' ? 'crit' : 'warn',
        }
      )),
      figure: null,
      note: esc.items.length > 4 ? `${esc.items.length} unanswered in total.` : null,
    };
  }
  // ⚠ "I could not read the escalations" is NOT "there are none", and under the
  // word firefighting that difference is the whole point.
  if (isObj(esc) && esc.known === false) {
    return {
      kind: SURFACES.FIREFIGHTING,
      label: 'live now',
      rows: [],
      figure: null,
      note: 'Something is live, but I couldn’t read the escalations — don’t take this as an all-clear.',
    };
  }

  const pool = [payload.primary, ...(Array.isArray(payload.secondary) ? payload.secondary : [])]
    .filter((c) => c && c.kind === 'item');

  let hot = pool.filter((c) => HOT_TYPES.has(c.type));
  // ⚠ FALLBACK, and it is load-bearing. The brain called this firefighting, so
  // something IS live; if no card matches the type list, the honest thing is to
  // show the pool rather than an empty escalations panel under the word
  // "firefighting" — an empty box would read as an all-clear at the exact
  // moment it is least true.
  if (!hot.length) hot = pool;

  return {
    kind: SURFACES.FIREFIGHTING,
    label: 'live now',
    rows: hot.slice(0, 4).map((c) => row(
      c.urgency || 'open',
      c.title,
      { note: c.say || null, level: c.urgency === 'critical' ? 'crit' : 'warn' }
    )),
    figure: null,
    // ⚠ AN EMPTY PANEL MUST STILL SAY SOMETHING. Reached by ASKING "anything
    // escalating?" on a calm day: the escalations read fine, there were none,
    // the pool was empty too, and the dashboard rendered nothing at all — which
    // is indistinguishable from a panel that failed to load, on the surface
    // where that mistake is most expensive. Caught on the live Pi, not by a
    // test. "There are none" and "I could not look" are already kept apart
    // above; this is the third case, and it is the good news.
    note: hot.length ? null
      : (isObj(esc) && esc.known === true
        ? 'Nothing escalating.'
        : 'Nothing live that I can see.'),
  };
}

function dashSession(payload, session) {
  if (!isObj(session)) {
    return {
      kind: SURFACES.SESSION,
      label: 'this session',
      rows: [],
      figure: null,
      // The brain said he is in a session and the session itself could not be
      // read. Saying so beats drawing a zeroed progress bar.
      note: 'A session is running, but I couldn’t read it.',
    };
  }

  const elapsed = Number.isFinite(session.elapsedMinutes) ? session.elapsedMinutes : null;
  const planned = Number.isFinite(session.plannedMinutes) ? session.plannedMinutes : null;

  const rows = [];
  if (session.taskTitle) {
    rows.push(row('on', session.taskTitle, {
      // ⚠ A shrink is EVIDENCE ABOUT THE WORK, never a score against Nick. It is
      // stated as a count and nothing here phrases it as a failure.
      meta: session.shrinkCount > 0
        ? `made smaller ${session.shrinkCount === 1 ? 'once' : `${session.shrinkCount} times`}`
        : null,
    }));
  }

  return {
    kind: SURFACES.SESSION,
    label: 'this session',
    rows,
    figure: elapsed === null ? null : {
      value: elapsed,
      unit: 'min of focus',
      // ⚠ `plannedAssumed` rides all the way to the screen. "Thirty minutes" and
      // "half an hour because nobody said" are different claims, and laundering
      // the second into the first is exactly what #87 rules out.
      of: planned,
      ofLabel: planned === null ? null
        : session.plannedAssumed ? `${planned} assumed` : `${planned} planned`,
      // Clamped, because an overrun is normal and a bar past its end reads as
      // broken. `overrun` carries the fact instead.
      pct: planned ? Math.min(100, Math.round((elapsed / planned) * 100)) : null,
      overrun: session.overrun === true,
    },
    note: session.overrun === true ? 'Over the time you planned — worth a look.' : null,
  };
}

function dashRitual(payload) {
  const cards = [payload.primary, ...(Array.isArray(payload.secondary) ? payload.secondary : [])]
    .filter((c) => c && c.kind === 'item');
  return {
    kind: SURFACES.RITUAL,
    label: 'carried over',
    rows: cards.slice(0, 4).map((c) => row(c.urgency || 'open', c.title, { note: c.say || null })),
    figure: null,
    note: null,
  };
}

function dashOffDuty(payload) {
  const wt = payload.weeklyTarget;
  const rows = [];
  let figure = null;

  // ⚠ FOUR states, and keeping them apart is the whole point of weekly-target:
  // `unset` is NOT a target of zero, and `unknown` is not a bad week.
  if (isObj(wt)) {
    if (wt.state === 'unset') {
      rows.push(row(null, 'No target set for this week', { note: 'Ask me to set one.' }));
    } else if (wt.state === 'unknown') {
      rows.push(row(null, 'I couldn’t count this week', { note: wt.reason || null, level: 'warn' }));
    } else if (Number.isFinite(wt.done)) {
      figure = {
        value: wt.done,
        unit: Number.isFinite(wt.target) ? `of ${wt.target} this week` : 'done this week',
        of: Number.isFinite(wt.target) ? wt.target : null,
        ofLabel: null,
        pct: Number.isFinite(wt.target) && wt.target > 0
          ? Math.min(100, Math.round((wt.done / wt.target) * 100)) : null,
        overrun: false,
      };
    }
  }

  // ⚠ OFF DUTY SHOWS WHAT HE DID, NEVER WHAT HE OWES. That is the entire
  // distinction `resolveDuty` exists to draw, and putting the pool here would
  // undo it. A CRITICAL item is the documented exception — hiding a breaching
  // escalation because it is Saturday is the wrong failure — and the brain has
  // already decided that by leaving it as `primary`.
  const p = payload.primary;
  if (p && p.kind === 'item' && p.urgency === 'critical') {
    rows.push(row('now', p.title, { note: p.say || null, level: 'crit' }));
  }

  return { kind: SURFACES.OFF_DUTY, label: 'this week', rows, figure, note: null };
}

function dashInbox(payload) {
  const box = payload.inbox;
  if (!isObj(box) || box.known !== true) {
    return {
      kind: SURFACES.INBOX,
      label: 'your inbox',
      rows: [],
      figure: null,
      // Triage having never run and the inbox being clear are different facts,
      // and only one of them is good news.
      note: 'I couldn’t read your inbox, so this isn’t "nothing needs you".',
    };
  }
  const urgent = Array.isArray(box.urgent) ? box.urgent : [];
  return {
    kind: SURFACES.INBOX,
    label: urgent.length ? 'needs an answer' : 'your inbox',
    rows: urgent.slice(0, 5).map((m) => row(
      null,
      m.subject || '(no subject)',
      // ⚠ `from`/`fromEmail` are the triage record's fields. The retired
      // `inbox_items` table used `from_name`/`from_email`, and reading those
      // yields `undefined` — the exact bug the urgent-email nudge shipped with.
      { meta: (m.from || m.fromEmail || '').split('<')[0].trim() || null, level: 'warn' }
    )),
    figure: null,
    note: urgent.length ? null : 'Nothing needing an answer.',
  };
}

/**
 * In a meeting.
 *
 * ⚠ IT SHOWED NOTHING AT ALL, and that was wrong (Nick, 8 Sep 2026: "rest of
 * day is missing"). The restraint this state exists for is about the POOL —
 * SARA does not put work in front of him while he is in a room with people, and
 * `attention.gate()` has already held it back. It was never about the DIARY. So
 * a panel labelled "nothing, on purpose" over an unread agenda withheld the two
 * facts he actually wants mid-meeting: when this one is due to end, and what is
 * after it. Neither is something to decide about; both are the shape of the day.
 *
 * ⚠ NO `now` BAND HERE, deliberately, and it is the one surface without one.
 * The headline directly above is the context card — "In a meeting / You're in
 * X" — so a band repeating X is the same thing twice on one screen, which is
 * the whole complaint. The end time is the fact the headline does NOT have, so
 * it goes in the note instead.
 *
 * ⚠ "DUE TO END", never "ends". It is the scheduled end, not a claim about when
 * he will actually get out, and his meetings overrun.
 */
function dashInMeeting(payload) {
  const safe = isObj(payload) ? payload : {};
  const agenda = safe.agenda;
  const known = isObj(agenda) && agenda.known === true;
  // The running one is excluded by `agendaRows` already, so these are genuinely
  // what comes AFTER — which is what the label promises.
  const rows = agendaRows(agenda, 3, { countdownHandledFor: transitionSubject(safe) });
  const running = known
    ? (agenda.events || []).find((e) => e && e.running === true && e.allDay !== true)
    : null;
  const until = running ? endTimeOf(running) : null;

  // ⚠ THE RESTRAINT IS STILL STATED, in every branch. Without it the panel reads
  // as a complete picture of what is waiting, when the point of this state is
  // that things are deliberately being held back — the foot's "N held" line says
  // so too, and both saying it is cheaper than either being the only one that
  // does.
  const held = 'Nothing from your list until you’re out — it’ll still be there.';
  const parts = [];
  if (until) parts.push(`Due to end at ${until}.`);
  if (!known) parts.push('I couldn’t read your diary, so I can’t say what’s after this.');
  else if (rows.length === 0) parts.push('Nothing else in the diary.');
  parts.push(held);

  return {
    kind: SURFACES.IN_MEETING,
    label: 'what’s after this',
    now: null,
    rows,
    figure: null,
    note: parts.join(' '),
  };
}

function dashBlind(payload) {
  const rows = gapsOf(payload).map((g) => row(
    'gap',
    `Couldn’t read ${g.input}`,
    { note: g.why, level: 'warn' }
  ));
  return {
    kind: SURFACES.BLIND,
    label: 'what I couldn’t read',
    rows,
    figure: null,
    // ⚠ These exact words. A blind surface that does not refuse an all-clear is
    // the failure the whole provenance model exists to prevent.
    note: 'Don’t read this as an all-clear — I’m not telling you it’s quiet, I’m telling you I couldn’t look.',
  };
}

// ── Utterances ──────────────────────────────────────────────────────────────
//
// The sentence IS the button, and the intent travels with it so no client ever
// parses language. `intent.kind` is one of:
//   act      — an attention-lifecycle verb on `intent.recordId`
//   navigate — open a screen (`intent.tab`); moves no state
//   ask      — put this to chat as a question
//
// ⚠ There is deliberately no `send`, `reply`, `book` or `chase`. Nothing an
// ambient surface offers may leave the building.

function say(text, intent) {
  return { say: text, intent };
}

/**
 * What he could say next. PURE.
 *
 * ⚠ BOUNDED BY WHAT THE RECORD ALLOWS. `attention-lifecycle` decides which
 * verbs a card accepts — an escalation is deliberately not dismissable — and
 * offering a sentence NEURO will refuse is worse than offering none, because he
 * will have said it out loud before finding out.
 *
 * ⚠ A card with no `recordId` gets NO act utterances at all. The engine's
 * suppression is a timer and cannot express "seen it" or "this is finished", so
 * substituting it is the exact bug the lifecycle replaced.
 */
function utterancesFor(payload, surface, session) {
  const out = [];
  const p = payload.primary;
  const actionable = p && p.kind === 'item' && p.recordId;
  const allowed = new Set(Array.isArray(p && p.actions) ? p.actions : []);
  const can = (verb) => actionable && (allowed.size === 0 || allowed.has(verb));

  if (surface === SURFACES.BLIND) {
    out.push(say('Try again', { kind: 'refresh' }));
    out.push(say('What can you see?', { kind: 'ask', text: 'What can you currently see?' }));
    return finish(out, payload);
  }

  if (surface === SURFACES.IN_MEETING) {
    // ⚠ "That's finished" LEADS, and it is the only thing on this surface that
    // changes anything (Nick, 8 Sep 2026). The diary is a plan, and a meeting
    // that broke up twenty minutes early otherwise costs twenty minutes in
    // which SARA refuses to help — off the calendar's word alone, with no way
    // to tell her otherwise. ⚠ It is a `meeting` intent, NOT `act`: the primary
    // here is a CONTEXT card with no `recordId`, the attention lifecycle would
    // refuse the verb, and a sentence NEURO cannot honour is worse than none —
    // the same reason `shrink` / `step-away` / `finish` are `session` intents.
    if (isObj(payload.meeting) && payload.meeting.key) {
      out.push(say('That’s finished', { kind: 'meeting', action: 'finished', key: payload.meeting.key }));
    }
    // Capture is the one thing that is never an interruption — it is him
    // putting something down, not her picking something up.
    out.push(say('Capture a thought', { kind: 'navigate', tab: 'capture' }));
    out.push(say('What am I missing?', { kind: 'ask', text: 'What am I missing right now?' }));
    return finish(out, payload);
  }

  if (surface === SURFACES.SESSION) {
    // ⚠ `session`, NOT `act`. These are focus-session verbs on `/api/session/*`
    // and the attention lifecycle does not accept them — an `act` intent
    // carrying `shrink` would 400, which is precisely the "a sentence NEURO
    // will refuse" failure the bounding rule above exists to prevent. Caught
    // before it shipped by checking the routes rather than assuming the verb
    // sets matched.
    //
    // ⚠ "Make it smaller" LEADS, everywhere it appears. Nick's difficulty is
    // INITIATION, and shrinking is the only control that lowers the barrier
    // rather than merely rescheduling it. A menu without it pushes him to
    // abandon, which loses the thread and reads as failure.
    out.push(say('Make it smaller', { kind: 'session', action: 'shrink' }));
    // He was pulled off it — deliberately NOT `pause`, which is a decision to
    // stop, and NOT `interrupt`, which records that something ARRIVED and
    // leaves the clock running because the brain cannot know whether he
    // switched.
    out.push(say('Something came up', { kind: 'session', action: 'step-away' }));
    if (session && session.taskTitle) {
      out.push(say('That’s done', { kind: 'session', action: 'finish' }));
    }
    return finish(out, payload);
  }

  if (surface === SURFACES.OFF_DUTY) {
    out.push(say('What did I actually finish?', { kind: 'ask', text: 'What did I finish this week?' }));
    out.push(say('Anything for tomorrow?', { kind: 'ask', text: 'What is on for tomorrow?' }));
    return finish(out, payload);
  }

  // The working surfaces — steady, pre-meeting, firefighting, ritual — all hang
  // off the primary card, so they share one vocabulary.
  if (actionable) {
    const openIt = p.actionHint
      ? say(p.actionHint, { kind: 'navigate', tab: p.tab || 'surface', recordId: p.recordId, action: 'open' })
      : say('Open it', { kind: 'navigate', tab: p.tab || 'surface', recordId: p.recordId, action: 'open' });

    // ⚠ "Not now" carries HOW LONG and WHY. A snooze whose length SARA picked is
    // one he has no reason to trust, and the reason is what makes a thing put
    // off three times for `too-big` a different problem from one put off for
    // `not-now`. Both are recoverable only at the moment the gesture is made.
    const notNow = can('defer')
      ? say('Not now — an hour', { kind: 'act', action: 'defer', recordId: p.recordId, minutes: 60, reason: 'not-now' })
      : null;
    const tooBig = can('defer')
      ? say('It’s too big', { kind: 'act', action: 'defer', recordId: p.recordId, minutes: 60 * 20, reason: 'too-big' })
      : null;
    // Seen is NOT a snooze: it stops her asking again and leaves the card where
    // it is — the one state the old suppression timer could not express.
    const seen = can('acknowledge') ? say('Seen it', { kind: 'act', action: 'acknowledge', recordId: p.recordId }) : null;
    const done = can('complete') ? say('That’s done', { kind: 'act', action: 'complete', recordId: p.recordId }) : null;
    const notMine = can('dismiss') ? say('Not mine', { kind: 'act', action: 'dismiss', recordId: p.recordId }) : null;

    // ⚠ A card that can be STARTED gets a different order (Nick, 11 Sep 2026).
    // Only four sentences fit before "Show me everything", and on an escalation
    // the old order cut "That's done" off entirely. Starting is the hard half,
    // so "I'm on it" LEADS — the "Make it smaller" rule — and "That's done" is
    // kept; "It's too big" and "Seen it" fill in only if room is left, because
    // once a session is running "Make it smaller" answers too-big better.
    //
    // ⚠ `start` must be EXPLICITLY allowed, never inferred from an empty action
    // set (`can`'s legacy leniency): a sentence that starts a session on a
    // meeting or a nudge is one NEURO would have refused to offer.
    //
    // ⚠ Not offered while ANY session is running. Firefighting outranks a focus
    // session, so this surface can be up with one going, and starting would
    // mean silently parking it or a confirm dialog on a kiosk. The server
    // already strips `start` when the session is on THIS card.
    // It is a `session` intent, not `act`: it lives on `/api/session/start`,
    // and the client tells the record afterwards, as the desktop card does.
    const startable = allowed.has('start') && !!p.title;
    if (startable) {
      const onIt = session
        ? null
        : say('I’m on it', { kind: 'session', action: 'start', recordId: p.recordId, text: p.title });
      out.push(onIt, openIt, notNow, done, seen, tooBig, notMine);
    } else {
      out.push(openIt, notNow, tooBig, seen, done, notMine);
    }
  } else {
    out.push(say('What have I got on?', { kind: 'ask', text: 'What have I got on today?' }));
    out.push(say('What am I forgetting?', { kind: 'ask', text: 'What am I forgetting?' }));
  }

  return finish(out, payload);
}

/**
 * The escape hatch, appended last and always.
 *
 * ⚠ NON-NEGOTIABLE. Nick's failure mode is avoidance, and a thing he cannot
 * find is worse than a menu he does not need — an ambient surface that is
 * sometimes wrong must ALWAYS have a way round it, or being wrong once costs
 * the whole feature. Bounded to `MAX_UTTERANCES` so the fallback never becomes
 * the menu it replaced.
 */
const MAX_UTTERANCES = 5;

function finish(list, payload) {
  const out = list.filter(Boolean).slice(0, MAX_UTTERANCES - 1);
  out.push(say('Show me everything', { kind: 'reveal' }));
  return out;
}

/**
 * What the dashboard (and the transition) ALREADY shows, so nothing is rendered
 * twice on one screen. PURE.
 *
 * ⚠ WHY. Nick, 8 Sep 2026: "find a better way to present this so I dont see the
 * same thing three times." One meeting was the transition prompt, the primary
 * headline AND an agenda row; one task was the headline AND a dashboard row AND
 * a card in the list below. Every one of those was a correct decision taken
 * three times by three layers that could not see each other.
 *
 * ⚠ IT IS ADVISORY AND IT FILTERS NOTHING. The pool leaves this module exactly
 * as it arrived — `decision-engine` stays the one generator and
 * `attention.gate()` the one filter, and a framing layer quietly removing items
 * from the feed is the second brain this file exists not to be. A renderer that
 * ignores `covered` shows the old, repetitive screen; it never shows a wrong
 * one.
 *
 * ⚠ MATCHING IS EXACT-ON-TITLE, never fuzzy. A false match HIDES a real item
 * from the list Nick uses to find what he owes; a miss only shows him something
 * twice, which is the state we are already in. The asymmetry decides it.
 */
function coveredBy(payload, dashboard) {
  const shown = new Set();
  for (const r of (dashboard && Array.isArray(dashboard.rows) ? dashboard.rows : [])) {
    const t = normTitle(r && r.what);
    if (t) shown.add(t);
  }
  // ⚠ The `now` slot counts as shown ONLY when it names a real thing. Its
  // free-time wording is a sentence, not a title, and must never suppress a
  // card that happens to be phrased like it.
  if (dashboard && isObj(dashboard.now) && dashboard.now.free === false) {
    const t = normTitle(dashboard.now.what);
    if (t) shown.add(t);
  }

  const cardIds = [];
  for (const c of (Array.isArray(payload.secondary) ? payload.secondary : [])) {
    if (!c || c.kind !== 'item' || !c.id) continue;
    const t = normTitle(c.title);
    if (t && shown.has(t)) cardIds.push(c.id);
  }

  // ⚠ Reported as a FACT ("these name the same thing"), never as an
  // instruction to hide the primary. The transition can be dismissed on the
  // client, and a rule that hid the headline unconditionally would leave the
  // screen with no lead at all the moment he pressed "not now".
  const t = payload.transition;
  const p = payload.primary;
  const transitionIsPrimary = Boolean(
    isObj(t) && isObj(t.meta) && p && p.kind === 'item'
    && normTitle(t.meta.subject) && normTitle(t.meta.subject) === normTitle(p.title)
  );

  return { cardIds, transitionIsPrimary };
}

/**
 * Compose the surface. PURE.
 *
 * @param {object} payload  a built `attention` payload
 * @param {object} [opts]
 * @param {object} [opts.session]  the active focus session projection, if any
 * @returns {{surface: string, dashboard: object, utterances: Array}}
 */
function compose(payload, opts = {}) {
  const safe = isObj(payload) ? payload : {};
  const session = isObj(opts.session) ? opts.session : null;

  // ⚠ A QUESTION can move the dashboard, but it can never move it off `blind`.
  // If the pool could not be read, what is on screen has to say so — answering
  // "what's in my inbox" with a confident panel while she cannot see his work
  // is the one thing the blind state exists to prevent.
  const contextSurface = surfaceFor(safe);
  const asked = contextSurface === SURFACES.BLIND ? null : surfaceForQuestion(opts.ask);
  const surface = asked || contextSurface;

  let dashboard;
  switch (surface) {
    case SURFACES.BLIND: dashboard = dashBlind(safe); break;
    case SURFACES.IN_MEETING: dashboard = dashInMeeting(safe); break;
    case SURFACES.FIREFIGHTING: dashboard = dashFirefighting(safe); break;
    case SURFACES.PRE_MEETING: dashboard = dashPreMeeting(safe); break;
    case SURFACES.SESSION: dashboard = dashSession(safe, session); break;
    case SURFACES.RITUAL: dashboard = dashRitual(safe); break;
    case SURFACES.OFF_DUTY: dashboard = dashOffDuty(safe); break;
    case SURFACES.INBOX: dashboard = dashInbox(safe); break;
    default: dashboard = dashSteady(safe); break;
  }

  // Gaps ride on every dashboard, not only the blind one — a partly-read day is
  // the normal case and must never render as a complete one.
  dashboard.gaps = surface === SURFACES.BLIND ? [] : gapsOf(safe);

  return {
    surface,
    dashboard,
    // ⚠ Reported, so a client can tell "she moved because I asked" from "she
    // moved because the day did". Without it a screen that changed under him
    // has no explanation, and the honest half of an adaptive surface is being
    // able to say why it adapted.
    askedSurface: asked || null,
    // ⚠ Utterances follow the surface actually SHOWN. Offering "what did I
    // finish" under an inbox panel is the mute path disagreeing with the screen
    // it is attached to.
    utterances: utterancesFor(safe, surface, session),
    // Advisory only — see `coveredBy`. Nothing has been removed from the pool.
    covered: coveredBy(safe, dashboard),
  };
}

module.exports = {
  compose,
  surfaceFor,
  surfaceForQuestion,
  SURFACES,
  MAX_UTTERANCES,
  // Exported for the tests, which drive each dashboard directly rather than
  // through eight payload fixtures.
  _internals: {
    dashSteady, dashSession, dashOffDuty, dashBlind, dashFirefighting, dashPreMeeting, dashInMeeting,
    utterancesFor, timeOf, endTimeOf, nowSlot, agendaRows, coveredBy, countdownFor,
    COUNTDOWN_MINUTES,
  },
};
