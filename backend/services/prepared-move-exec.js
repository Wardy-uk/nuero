'use strict';

/**
 * Executing ONE confirmed prepared move (19 Oct 2026). Not a second executor:
 *   - the move is a STORED, immutable, versioned record (prepared-move-store);
 *   - confirmation is a one-use, 60-second intent grant in human_action_intents,
 *     minted ONLY by intent-grants.mintForPreparedMove for the record's newest
 *     version and the exact write hash it stored for that option, and spent
 *     by the unchanged consume();
 *   - each write is its own row in external_write_ledger (external-writes.begin /
 *     settle): a repeat is a duplicate, a partial outcome is RECORDED rather than
 *     undone, and a retry repeats only the missing or unverified step;
 *   - every write is read back before it is called done.
 *
 * SCOPE IS FIXED: exactly one solo calendar block (no attendees) and one NEW
 * vault note inside an existing project folder. Nothing else is reachable from
 * here — no message, invite response, board update, task, goal or notification.
 *
 * TARGETS: `adapters.kind` is 'sandbox' (prepared-move-sandbox.js, tests only)
 * or 'live' (liveAdapters() below). LIVE IS REFUSED, before any adapter is built
 * or a confirmation spent, unless the switch `saim_prepared_move_execution` is
 * on — checked HERE, not in a screen. It is off by default.
 *
 * The ONLY way in from HTTP is routes/prepared-moves.js → requestForMove() and
 * confirmMove(). Neither takes a date, a path, a title, a recipient or a write
 * type: the request names an OPTION the stored packet offered, and everything
 * written comes from that stored packet. Nothing here runs on a timer.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('../db/database');

const FLAG = 'saim_prepared_move_execution';
const WRITER = Object.freeze({ calendar: 'saim.move.calendar-block', note: 'saim.move.vault-note' });
/** calendar_cache must have synced this recently for "the slot is free" to mean anything. */
const DIARY_MAX_AGE_MS = 15 * 60000;
/**
 * The project folders a prepared move may save into — one, today: T1 lives in
 * the Support Improvement Plan. A note anywhere else is refused before a hash
 * exists, so no confirmation can ever be minted for it. Widening this list is a
 * deliberate change with its own review, never a packet's choice.
 */
const PROJECT_FOLDERS = Object.freeze(['Projects/Support Improvement Plan']);
/** One readable line: a block title, never markup, never a second line. */
const TITLE_RE = /^[A-Za-z0-9][A-Za-z0-9 ,'&()–-]{2,78}[A-Za-z0-9)]$/;
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayLong = (d) => { const x = new Date(`${d}T12:00:00Z`); return `${DAYS[x.getUTCDay()]} ${x.getUTCDate()} ${MONTHS[x.getUTCMonth()]}`; };
const toMin = (hhmm) => { const [h, m] = String(hhmm).split(':').map(Number); return h * 60 + m; };
// Europe/London wall clock → epoch ms (the slot is a wall-clock time).
function londonMs(date, hhmm) {
  const guess = Date.parse(`${date}T${hhmm}:00Z`);
  const shown = new Date(guess).toLocaleString('sv-SE', { timeZone: 'Europe/London' }).replace(' ', 'T').slice(0, 16);
  return guess - (Date.parse(`${shown}:00Z`) - guess);
}
/** One write step as the authority budget counts it. */
const budgetStep = (s) => (s.step === 'calendar'
  ? { kind: 'calendar.solo', minutes: toMin(s.end) - toMin(s.start), contacts: (s.attendees || []).length, spendPence: 0 }
  : { kind: s.step === 'reply' ? 'reply.draft' : 'vault.note', minutes: 0, contacts: 0, spendPence: 0 });
const refuse = (reasons, extra = {}) => ({ ok: false, refused: true, reasons: [].concat(reasons), ...extra });

// ── The write set (PURE, no clock) ───────────────────────────────────────────

/**
 * PURE. The exact writes one option of a packet would make, and their hash —
 * or why there are none. Scope and sensitivity are judged here; anything that
 * depends on the clock or the world is a fresh check, below.
 */
function writesFor(packet, option) {
  if (packet && packet.contract === 'prepared-move-v2') return writesForV2(packet, option);
  if (!packet || packet.contract !== 'prepared-move-v1') return refuse('not a prepared-move packet');
  const s = packet.selected;
  if (!s) return refuse('there is no prepared move in this packet');
  const sc = s.screens || {};
  if (!sc.employment || sc.employment.sensitive) return refuse(`employment matter (${((sc.employment || {}).categories || ['unscreened']).join(', ')}) — routing only, never executed`);
  if (sc.freshnessOk !== true) return refuse('a source this move rests on was stale when it was prepared');
  if (sc.recordUnique !== true || !s.record || !s.record.msId) return refuse('the move is not tied to exactly one record');
  const d = s.decision || {};
  const slot = (d.slots || []).find((x) => x.id === option);
  if (!slot) return refuse(`"${option}" is not one of the times this move offered`);
  if (!/^\d{4}-\d\d-\d\d$/.test(slot.date) || !/^\d\d:\d\d$/.test(slot.start) || !/^\d\d:\d\d$/.test(slot.end) || toMin(slot.end) <= toMin(slot.start)) return refuse('the offered time is not a valid block');

  const writes = d.proposedWrites || [];
  if (writes.length !== 2 || writes[0].kind !== 'calendar.solo' || writes[1].kind !== 'vault.note') return refuse('the move must be exactly one solo block and one note');
  const [cal, note] = writes;
  if (!Array.isArray(cal.attendees) || cal.attendees.length !== 0) return refuse('the block has attendees — a block that invites anyone is not this action');
  if (!TITLE_RE.test(String(cal.title || ''))) return refuse('the block title is not a single plain line');
  const p = String(note.path || '');
  if (!/^Projects\/[^/]+\/[^/]+\.md$/.test(p) || p.includes('..') || p.includes('\0')) return refuse('the note path is not a single new note inside a project folder');
  if (!PROJECT_FOLDERS.includes(path.posix.dirname(p))) return refuse(`the note path is not in a project folder a prepared move may save into (${PROJECT_FOLDERS.join(', ')})`);
  const draft = ((s.preparation || []).find((x) => x.draft) || {}).draft;
  if (!draft) return refuse('there is no prepared draft to save');
  if (require('./promise-ledger').hrSensitivity(`${draft}\n${cal.title}`).sensitive) return refuse('the draft reads as an employment matter — routing only, never executed');

  const moveKey = `saim-move:planner:${s.record.msId}@${(d.forum && d.forum.start.slice(0, 10)) || slot.date}`;
  const content = ['---', 'type: draft', 'created-by: SAiM (a prepared move Nick confirmed)', `saim-move: "${moveKey}"`, '---', '', draft, ''].join('\n');
  const steps = [
    { step: 'calendar', writer: WRITER.calendar, title: cal.title, date: slot.date, start: slot.start, end: slot.end, attendees: [], body: cal.body, marker: moveKey },
    { step: 'note', writer: WRITER.note, path: p, content, contentSha: sha(content) },
  ];
  return {
    ok: true, moveKey, option, slot, steps, writeHash: sha(JSON.stringify(steps)),
    forum: d.forum || null, verification: s.verification || null, title: s.title,
    confirmation: {
      writes: [
        `Add “${cal.title}” to your calendar, ${dayLong(slot.date)} ${slot.start}–${slot.end}. Just you — nobody is invited.`,
        `Save the draft as a new note: ${p}`,
      ],
      contacts: 'Nobody else is contacted: no invite, email or message. The shared board and your reply to the meeting invite are left alone.',
    },
  };
}

/**
 * Where a v2 note may be saved, by kind — EXISTING folders only (the writer
 * refuses to create one): a project note inside an existing Projects/<Folder>
 * (never Archive or PIP), a meeting prep beside the meeting notes it belongs
 * with (Meetings/YYYY/MM, the convention the vault's prep notes already use).
 */
const V2_NOTE_RULES = Object.freeze({
  'project-note': (p) => { const m = /^Projects\/([^/]+)\/[^/]+\.md$/.exec(p); return Boolean(m) && !['Archive', 'PIP'].includes(m[1]); },
  'meeting-prep': (p) => /^Meetings\/\d{4}\/\d\d\/[^/]+ Prep\.md$/.test(p),
});

/**
 * PURE. A v2 packet's exact writes for one option (21 Oct 2026). At most ONE
 * of each: a new note, a governed reply DRAFT (which sends nothing — it waits
 * in Actions for Nick's approval code), a solo block. Anything else refuses.
 */
function writesForV2(packet, option) {
  const s = packet.selected;
  if (!s) return refuse('there is no prepared move in this packet');
  if (s.plan === 'ask') return refuse('SAiM needs your answer before there is anything to confirm');
  if (s.plan !== 'draft') return refuse('this move has nothing to confirm');
  const sc = s.screens || {};
  if (!sc.employment || sc.employment.sensitive) return refuse('employment matter — routing only, never executed');
  if (sc.freshnessOk !== true) return refuse('a source this move rests on was stale when it was prepared');
  if (sc.recordUnique !== true) return refuse('the move is not tied to exactly one record');
  const planner = require('./prepared-move-planner');
  if (!planner.KINDS.includes(s.kind) || s.moveKey !== planner.moveKeyFor(s.kind, s.sourceKey)) return refuse('the move does not name its own source');
  const d = s.decision || {};
  const slot = (d.slots || []).find((x) => x.id === option);
  if (!slot) return refuse(`"${option}" is not one of the choices this move offered`);
  const writes = d.proposedWrites || [];
  const kinds = writes.map((w) => w.kind);
  if (!writes.length || new Set(kinds).size !== kinds.length || kinds.some((k) => !['vault.note', 'governed.reply', 'calendar.solo'].includes(k))) return refuse('the move must be at most one note, one reply draft and one solo block');
  const draft = ((s.preparation || []).find((x) => x.draft) || {}).draft;
  if (!draft) return refuse('there is no prepared draft');
  if (require('./promise-ledger').hrSensitivity(`${draft}\n${s.title}`).sensitive) return refuse('the draft reads as an employment matter — routing only, never executed');

  const moveKey = s.moveKey;
  const steps = []; const lines = [];
  const note = writes.find((w) => w.kind === 'vault.note');
  if (note) {
    const p = String(note.path || '');
    const rule = V2_NOTE_RULES[s.kind];
    if (!rule || p.includes('..') || p.includes('\0') || !rule(p)) return refuse('the note path is not one a prepared move may save into');
    const content = ['---', 'type: draft', 'created-by: SAiM (a prepared move Nick confirmed)', `saim-move: "${moveKey}"`, '---', '', draft, ''].join('\n');
    steps.push({ step: 'note', writer: WRITER.note, path: p, content, contentSha: sha(content) });
    lines.push(`Save the ${s.kind === 'meeting-prep' ? 'meeting prep' : 'draft'} as a new note: ${p}`);
  }
  const reply = writes.find((w) => w.kind === 'governed.reply');
  if (reply) {
    if (s.kind !== 'email-reply' || reply.mode !== 'reply' || !reply.emailId || reply.emailId !== (s.source || {}).emailId) return refuse('the reply does not answer the email this move is about');
    const body = String(reply.body || '').trim();
    if (!body || body !== String(draft).trim()) return refuse('the reply is not the draft that was shown');
    steps.push({ step: 'reply', emailId: reply.emailId, mode: 'reply', body, bodySha: sha(body), to: reply.to || null });
    lines.push(`Put the reply to ${reply.toName || reply.to} in Actions, waiting for your approval code. It is NOT sent.`);
  }
  const cal = writes.find((w) => w.kind === 'calendar.solo');
  if (cal) {
    if (!slot.date || !/^\d{4}-\d\d-\d\d$/.test(slot.date) || !/^\d\d:\d\d$/.test(slot.start || '') || !/^\d\d:\d\d$/.test(slot.end || '') || toMin(slot.end) <= toMin(slot.start)) return refuse('the offered time is not a valid block');
    if (!Array.isArray(cal.attendees) || cal.attendees.length !== 0) return refuse('the block has attendees — a block that invites anyone is not this action');
    if (!TITLE_RE.test(String(cal.title || ''))) return refuse('the block title is not a single plain line');
    steps.push({ step: 'calendar', writer: WRITER.calendar, title: cal.title, date: slot.date, start: slot.start, end: slot.end, attendees: [], body: cal.body, marker: moveKey });
    lines.push(`Add “${cal.title}” to your calendar, ${dayLong(slot.date)} ${slot.start}–${slot.end}. Just you — nobody is invited.`);
  } else if (slot.date) {
    return refuse('this move offers a time but books no block');
  }
  return {
    ok: true, contract: 'prepared-move-v2', moveKey, option, slot: cal ? slot : null, steps, writeHash: sha(JSON.stringify(steps)),
    forum: s.forum || null, verification: s.verification || null, title: s.title,
    confirmation: {
      question: s.kind === 'email-reply' ? 'Put this reply in Actions for your approval?' : cal ? `Save the draft and reserve ${toMin(slot.end) - toMin(slot.start)} minutes on ${dayLong(slot.date)} (${slot.start}–${slot.end})?` : 'Save this as a note?',
      writes: lines,
      contacts: reply ? 'Nothing is sent: the reply waits in Actions until you approve it with your code. Nobody is invited and no task is created.' : 'Nobody is contacted: no email, invite or message, and no task is created.',
    },
  };
}

// ── Fresh checks, immediately before execution ───────────────────────────────

/**
 * Every condition the move rested on, re-read now. `checks` supplies the
 * readers (live: defaultChecks; tests and the sandbox: their own). Any failure
 * refuses and hands the packet back for re-preparation.
 */
async function freshChecks({ record, w, checks, now }) {
  const no = (why) => refuse(why, { rePrepare: true, recordId: record.id, packet: record.packet });
  if (now > Date.parse(record.evidenceExpiresAt)) return no(`the evidence behind this move expired at ${record.evidenceExpiresAt} — it needs preparing again`);
  if (!record.options[w.option]) return no('that time was not one this move offered');
  const calStep = w.steps.find((x) => x.step === 'calendar');
  const noteStep = w.steps.find((x) => x.step === 'note');
  if (calStep && londonMs(w.slot.date, w.slot.start) <= now) return no('that time has already passed');
  if (w.forum && londonMs(w.forum.start.slice(0, 10), w.forum.start.slice(11, 16)) <= now) return no('the meeting it was prepared for has already started');
  if (!checks) return no('no fresh checks were available — refusing rather than writing blind');

  // The diary and leave matter only when a block is to be booked.
  if (calStep) {
    const diary = await checks.diary(w.slot, { title: calStep.title, marker: w.moveKey });
    if (!diary || !diary.known) return no(`I couldn’t confirm ${w.slot.start}–${w.slot.end} is still free${diary && diary.why ? ` (${diary.why})` : ''}`);
    if (diary.clashes && diary.clashes.length) return no(`${dayLong(w.slot.date)} ${w.slot.start}–${w.slot.end} is no longer free`);

    const away = await checks.availability(w.slot.date);
    if (!away || !away.known) return no(`I couldn’t check your leave for ${dayLong(w.slot.date)}${away && away.why ? ` (${away.why})` : ''}`);
    if (away.off) return no(`you’re now booked off on ${dayLong(w.slot.date)}`);
    if (away.working === false) return no(`${dayLong(w.slot.date)} is not a working day`);
  }

  const cand = await checks.candidate(record.packet);
  if (!cand || !cand.ok) return no(cand && cand.why ? cand.why : 'I couldn’t re-check the commitment this move is about');

  if (noteStep) {
    const note = await checks.noteState(noteStep.path, noteStep.contentSha);
    if (!note || note.known === false) return no('I couldn’t check the note location');
    if (note.exists && !note.ours) return no('a note already exists at that path — I won’t overwrite it');
  }
  return { ok: true };
}

/**
 * The LIVE readers — all READ-ONLY, all existing NEURO data:
 *   diary         calendar_cache (Graph's own sync, every 5 min), must be fresh
 *   availability  People HR via team-availability; working-days for holidays
 *   candidate     the Planner mirror line still resolves to exactly one open
 *                 card, and the wording + draft still screen clean
 *   noteState     the target path through the adapter's own guard
 */
function defaultChecks({ adapters, now = Date.now() } = {}) {
  return {
    async diary(slot, { title }) {
      let rows = []; let fetched = null;
      try {
        rows = db.all(`SELECT subject, start_time, end_time, is_all_day, show_as, attendees_other, is_organizer FROM calendar_cache WHERE start_time >= ? AND start_time <= ?`, [`${slot.date}T00:00:00`, `${slot.date}T23:59:59`]);
        const f = db.get(`SELECT MAX(fetched_at) m FROM calendar_cache WHERE source = 'graph'`);
        fetched = f && f.m ? Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(String(f.m)) ? f.m : `${String(f.m).replace(' ', 'T')}Z`) : null;
      } catch (e) { return { known: false, why: e.message }; }
      if (!fetched || now - fetched > DIARY_MAX_AGE_MS) return { known: false, why: 'the calendar has not synced in the last 15 minutes' };
      const { heldDespiteFree } = require('./context-state');
      const s = toMin(slot.start); const e = toMin(slot.end);
      const clashes = rows.filter((r) => {
        if (r.is_all_day || r.show_as === 'cancelled') return false;
        const ev = { showAs: r.show_as, attendeesOther: r.attendees_other === 1 ? true : r.attendees_other === 0 ? false : null, isOrganizer: r.is_organizer === 1 ? true : r.is_organizer === 0 ? false : null };
        if (r.show_as === 'free' && !heldDespiteFree(ev)) return false;
        if (r.subject === title) return false; // our own block, on a retry
        const a = toMin(String(r.start_time).slice(11, 16)); const b = toMin(String(r.end_time).slice(11, 16));
        return a < e && b > s;
      }).map((r) => r.subject);
      return { known: true, clashes };
    },
    async availability(date) {
      const ta = require('./team-availability');
      const off = ta.selfAbsenceOn(date, ta.snapshot(new Date(now)));
      const wd = require('../../shared/working-days.cjs');
      const working = wd.isWorkingDay(new Date(`${date}T12:00:00`), require('./working-days').holidaySet());
      return { known: off.known, off: off.off, working, why: off.known ? null : off.reason };
    },
    async candidate(packet) {
      if (packet && packet.contract === 'prepared-move-v2') return require('./prepared-move-planner').recheck(packet);
      const pm = require('./prepared-move');
      const s = packet.selected;
      const res = pm.resolveTodoCard({ title: s.title });
      if (!res.unique) return { ok: false, why: res.hits.length ? 'the commitment is now ambiguous — more than one record carries its words' : 'the commitment can no longer be found — it may be done or renamed' };
      if (res.unique.msId !== s.record.msId) return { ok: false, why: 'the commitment now points at a different record' };
      const draft = ((s.preparation || []).find((x) => x.draft) || {}).draft || '';
      if (pm.employmentScreen({ wording: `${s.title}\n${draft}` }).sensitive) return { ok: false, why: 'it now reads as an employment matter' };
      return { ok: true };
    },
    async noteState(rel, contentSha) {
      try {
        if (!(await adapters.vault.exists(rel))) return { known: true, exists: false };
        const cur = await adapters.vault.read(rel);
        return { known: true, exists: true, ours: cur != null && sha(cur) === contentSha };
      } catch { return { known: false }; }
    },
  };
}

// ── Live adapters (existing NEURO protections only) ──────────────────────────

/**
 * Calendar: action-calendar's create (a Graph transactionId + NEURO's marker
 * extended property, `to: []` so there are no attendees) and calendar-read's
 * findByMarker / readEvent. Vault: routes/vault.js's path guard, never an
 * overwrite ('wx'), only inside an EXISTING project folder; a read-back proves
 * the Pi's copy only, so every note carries `syncUncertain`.
 */
function liveAdapters() {
  const ac = require('./action-calendar');
  const map = (e) => (e ? { id: e.id, title: e.subject, date: e.start.slice(0, 10), start: e.start.slice(11, 16), end: e.end.slice(11, 16), attendees: e.attendees, cancelled: e.isCancelled } : null);
  const guard = (rel) => { const p = require('../routes/vault')._safePath(rel); if (!p) throw new Error('HTTP 400 the path is outside the vault, or the vault is unreadable'); return p; };
  return {
    kind: 'live',
    calendar: {
      async findByMarker(marker) {
        const r = await ac.findByMarker(marker);
        // Could not look → do NOT create (it might exist). Thrown without a 4xx, so it reads as uncertain.
        if (!r.ok) throw new Error(`could not check the calendar for an existing block (${r.category || r.status})`);
        return map((r.events || []).find((e) => !e.isCancelled)) || null;
      },
      async create(ev) {
        const r = await ac.createEvent({ subject: ev.title, start: `${ev.date}T${ev.start}`, end: `${ev.date}T${ev.end}`, to: [], body: ev.body }, { transactionId: sha(ev.marker).slice(0, 36), marker: ev.marker });
        if (r.outcome === 'rejected') throw new Error(`HTTP ${r.status} the calendar refused the block`);
        if (r.outcome !== 'accepted' || !r.event) throw new Error(`the calendar did not confirm the block (${r.category || r.status || 'no answer'})`);
        return map(r.event);
      },
      async get(id) {
        const r = await ac.readEvent(id);
        if (!r.ok) throw new Error(`could not read the block back (${r.category || r.status})`);
        return r.exists ? map(r.event) : null;
      },
    },
    vault: {
      async exists(rel) { return fs.existsSync(guard(rel)); },
      async read(rel) { try { return fs.readFileSync(guard(rel), 'utf8'); } catch { return null; } },
      async writeNew(rel, content) {
        const p = guard(rel);
        if (!fs.existsSync(path.dirname(p))) throw new Error('HTTP 400 the project folder does not exist — not creating folders');
        fs.writeFileSync(p, content, { flag: 'wx' });
        return { path: rel, syncUncertain: true };
      },
      syncUncertain: true,
    },
    // A governed reply DRAFT (21 Oct 2026). prepared-actions.prepareReply with
    // origin 'saim-move' — not a human origin, so sending it needs Nick's
    // approval code in Actions; nothing here can send. Recipients come from the
    // original email, never from the move.
    governed: {
      async live(emailId) { return require('./prepared-actions').liveReplyFor(emailId); },
      async prepareReply({ emailId, body }) {
        const r = await require('./prepared-actions').prepareReply({ emailId, body, mode: 'reply', origin: 'saim-move' });
        if (!r.ok) throw new Error(`HTTP ${r.code && r.code < 500 ? r.code : 503} ${r.error}`);
        return r.action;
      },
      async get(actionId) { return require('./prepared-actions').get(actionId); },
    },
  };
}

/**
 * The governed reply step: put the confirmed words in Actions as a draft and
 * read it back. Never supersedes a DIFFERENT live reply (that may be Nick's
 * own); an identical one already there is found, not repeated.
 */
async function _replyStep(step, gov, { verifyOnly = false } = {}) {
  const live = await gov.live(step.emailId);
  const same = live && live.draft && sha(String(live.draft.body || '').trim()) === step.bodySha;
  if (live && !same) throw new Error(`HTTP 409 a different reply to this email is already ${live.status} in Actions — not replaced`);
  if (!live && verifyOnly) return { created: false, gone: true, id: null, checks: [['the reply drafted earlier is still in Actions', false]] };
  const action = live || await gov.prepareReply({ emailId: step.emailId, body: step.body, to: step.to });
  const back = action && action.actionId ? await gov.get(action.actionId) : null;
  const checks = [
    ['the reply is in Actions', Boolean(back)],
    ['its words are exactly what was confirmed', Boolean(back && back.draft && sha(String(back.draft.body || '').trim()) === step.bodySha)],
    ['it is waiting for your approval, not sent', Boolean(back && back.status === 'prepared')],
    ['it answers the original sender only', Boolean(back && back.draft && (back.draft.to || []).length === 1 && (!step.to || String(back.draft.to[0].email).toLowerCase() === String(step.to).toLowerCase()) && (back.draft.cc || []).length === 0)],
  ];
  return { created: !live, id: back ? back.actionId : null, checks };
}

// ── Confirmation ─────────────────────────────────────────────────────────────

/** Show exactly what a yes will do for a STORED record, and mint the one-use grant for it. */
function requestConfirmation({ recordId, option = 'approve', sessionId, caller = {}, surface = 'neuro-web', now = Date.now() } = {}) {
  const store = require('./prepared-move-store');
  const record = store.get(recordId);
  if (!record) return refuse('no such prepared move');
  if (!store.isLatest(record)) return refuse('this move has changed since it was shown — prepare it again', { rePrepare: true });
  if (now > Date.parse(record.evidenceExpiresAt)) return refuse('the evidence behind this move has expired — prepare it again', { rePrepare: true, packet: record.packet });
  const w = writesFor(record.packet, option);
  if (!w.ok) return w;
  if (!record.options[option] || record.options[option].writeHash !== w.writeHash) return refuse('the stored move does not match its writes — prepare it again', { rePrepare: true });
  const g = require('./intent-grants').mintForPreparedMove({ recordId: record.id, version: record.version, option, writeHash: w.writeHash, surface, sessionId, caller, now });
  if (!g.ok) return refuse(g.error);
  return { ok: true, grantId: g.grantId, expiresAt: g.expiresAt, recordId: record.id, version: record.version, option, confirmation: w.confirmation, writeHash: w.writeHash };
}

// ── Execution ────────────────────────────────────────────────────────────────

/**
 * `verifyOnly`: the ledger already records this step as DONE. It is read back,
 * never written again — if Nick has since deleted the block or the note, that
 * is his decision and a second confirmation does not quietly undo it.
 */
async function _calendarStep(step, cal, { verifyOnly = false } = {}) {
  const existing = await cal.findByMarker(step.marker);
  if (!existing && verifyOnly) return { created: false, gone: true, id: null, checks: [['the block made earlier is still there', false]] };
  const ev = existing || await cal.create({ title: step.title, date: step.date, start: step.start, end: step.end, attendees: [], body: step.body, marker: step.marker });
  // One block per move: if it already exists at another time it is NOT moved
  // (moving is not part of this action) — the receipt says where it is.
  const want = existing && (existing.date !== step.date || existing.start !== step.start || existing.end !== step.end)
    ? { date: existing.date, start: existing.start, end: existing.end } : step;
  const back = await cal.get(ev.id);
  const checks = [
    ['the block exists', Boolean(back)],
    ['title matches', back && back.title === step.title],
    [`time is ${want.date} ${want.start}–${want.end}`, back && back.date === want.date && back.start === want.start && back.end === want.end],
    ['nobody is invited', back && Array.isArray(back.attendees) && back.attendees.length === 0],
  ];
  return { created: !existing, id: ev.id, checks, keptAt: want === step ? null : want };
}

async function _noteStep(step, vault, { verifyOnly = false } = {}) {
  let created = false;
  let syncUncertain = Boolean(vault.syncUncertain);
  const there = await vault.exists(step.path);
  if (!there && verifyOnly) return { created: false, gone: true, path: step.path, checks: [['the note saved earlier is still there', false]], syncUncertain };
  if (there) {
    const cur = await vault.read(step.path);
    // Never an overwrite: a different note at that path is a refusal the far end "returned".
    if (sha(cur) !== step.contentSha) throw new Error('HTTP 409 a different note already exists at that path — not overwritten');
  } else {
    const r = await vault.writeNew(step.path, step.content);
    created = true;
    syncUncertain = syncUncertain || Boolean(r && r.syncUncertain);
  }
  const back = await vault.read(step.path);
  const checks = [
    ['the note exists', back != null],
    ['its contents are exactly what was confirmed', back != null && sha(back) === step.contentSha],
  ];
  return { created, path: step.path, checks, syncUncertain };
}

/**
 * Run a confirmed, STORED move. Needs, IN THIS ORDER and all inside this
 * function: the environment master lock (every target), no emergency stop, the
 * record's newest version and exact write set, Nick on duty, the AUTHORITY
 * BUDGET reserved atomically — and only then is the one-use confirmation spent
 * and an adapter built. Every fresh check passes, then each step is ledgered,
 * read back and settled against its budget reservation. Returns a receipt;
 * never throws for a failed step.
 *
 * `adapters` is either the adapter object (tests) or a FUNCTION that builds it
 * (the live path), with `target` naming what it builds — so nothing is
 * constructed until every gate has passed.
 */
async function execute({ recordId, option = 'approve', grantId, adapters, target = null, checks = null, now = Date.now() } = {}) {
  const budget = require('./authority-budget');
  const kind = typeof adapters === 'function' ? target : (adapters && adapters.kind);
  // 1. The gates, before anything else is read — and before any adapter exists.
  if (!adapters || !['sandbox', 'live'].includes(kind)) return refuse('unknown execution target');
  if (!require('./feature-flags').isEnabled(FLAG)) return refuse('Carrying out moves is switched off on NEURO’s server — nothing was written and your confirmation was not used.', { gate: 'device' });
  if (budget.stopState().stopped) return refuse(`${budget.STOPPED_SAY} Nothing was written and your confirmation was not used.`, { gate: 'stop' });
  if (!grantId) return refuse('nothing runs without your confirmation');

  // 2. The stored record, its newest version, and the exact write set.
  const store = require('./prepared-move-store');
  const record = store.get(recordId);
  if (!record) return refuse('no such prepared move');
  if (!store.isLatest(record)) return refuse('this move has changed since you confirmed it — confirm the new version', { rePrepare: true });
  const w = writesFor(record.packet, option);
  if (!w.ok) return w;
  if (!record.options[option] || record.options[option].writeHash !== w.writeHash) return refuse('the stored move does not match its writes — prepare it again', { rePrepare: true });

  // 3. One execution of a move at a time. A second confirm arriving while the
  //    first is mid-write could otherwise look for the block before the first
  //    has made it, and make a second one. Turned away unspent, not queued.
  if (RUNNING.has(w.moveKey)) return refuse('This move is already being carried out — your confirmation was not used.', { busy: true });
  RUNNING.add(w.moveKey);
  try {
    return await _executeHeld({ record, w, option, grantId, adapters, kind, checks, now, budget });
  } finally {
    RUNNING.delete(w.moveKey);
  }
}
const RUNNING = new Set();

async function _executeHeld({ record, w, option, grantId, adapters, kind, checks, now, budget }) {
  // 4. Off duty: prepare and read only — never act.
  const duty = await deps.readDuty(now);
  if (!duty || duty.onDuty !== true) return refuse(HELD, { held: true });

  // 4. The confirmation must be a prepared-move grant (anyone else's is left unspent).
  const ig = require('./intent-grants');
  const row = ig.get(grantId);
  if (!row || row.action_capability !== ig.PREPARED_MOVE_CAPABILITY) return refuse('that confirmation is not for a prepared move');

  // 5. The authority budget, reserved ATOMICALLY before the confirmation is spent.
  //    Keyed by the write ledger's own idempotency key, so a retry reuses it.
  const stepKey = (step) => `${w.moveKey}:${step.step}`;
  const res = budget.reserve({
    action: budget.ACTION, moveKey: w.moveKey, title: w.title, now,
    // 22 Oct 2026: every written output counts — a block, a note, or a governed
    // reply DRAFT (which still waits in Actions for the approval code; nothing
    // is sent). The day's allowance is three moves; each is confirmed alone.
    steps: w.steps.map((s) => ({ key: stepKey(s), ...budgetStep(s) })),
  });
  if (!res.ok) return refuse(`${res.say} Nothing was written and your confirmation was not used.`, { budget: res.limit });

  const spent = ig.consume({ grantId, actionId: record.id, version: record.version, payloadHash: w.writeHash, now });
  if (!spent.ok) { budget.releaseUnstarted(res.created, { now }); return refuse(spent.error); }

  // 6. Only now is anything that can write constructed.
  const ad = typeof adapters === 'function' ? adapters() : adapters;
  if (!ad || ad.kind !== kind) { budget.releaseUnstarted(res.created, { now }); return refuse('unknown execution target'); }
  const ck = typeof checks === 'function' ? checks(ad) : checks || (kind === 'live' ? defaultChecks({ adapters: ad, now }) : null);

  // 7. Fresh checks, immediately before writing.
  const fresh = await freshChecks({ record, w, checks: ck, now });
  if (!fresh.ok) { budget.releaseUnstarted(res.created, { now }); return fresh; }

  // 8. The two steps, each ledgered, each read back, each settled against the budget.
  const ext = require('./external-writes');
  const results = [];
  for (const step of w.steps) {
    const key = stepKey(step);
    if (step.step === 'reply') {
      const tgtR = `reply draft in Actions (email ${String(step.emailId).slice(0, 12)}…)`;
      if (budget.stopState().stopped) { budget.releaseUnstarted([key], { now }); results.push({ step: 'reply', target: tgtR, status: 'stopped' }); continue; }
      if (!ad.governed) { budget.releaseUnstarted([key], { now }); results.push({ step: 'reply', target: tgtR, status: 'refused', why: 'this target cannot draft a governed reply' }); continue; }
      try {
        const r = await _replyStep(step, ad.governed);
        const verified = r.checks.every(([, ok]) => ok);
        budget.settle(key, verified || r.gone || r.created ? 'used' : 'unknown', { now });
        results.push({ step: 'reply', target: tgtR, status: r.gone ? 'removed-since' : !verified ? 'unverified' : r.created ? 'done' : 'already-done', id: r.id || null, sent: false, verified: r.checks.map(([what, ok]) => ({ what, ok: Boolean(ok) })) });
      } catch (e) {
        const provably = /^HTTP 4\d\d/.test(e.message);
        budget.settle(key, provably ? 'released' : 'unknown', { now });
        results.push({ step: 'reply', target: tgtR, status: 'failed', provablyNotApplied: provably, error: e.message.replace(/^HTTP \d+ /, ''), sent: false });
      }
      continue;
    }
    const tgt = step.step === 'calendar' ? `${step.date} ${step.start}–${step.end} “${step.title}”` : step.path;
    // The emergency stop is honoured between steps: a stopped step is never attempted.
    if (budget.stopState().stopped) {
      budget.releaseUnstarted([key], { now });
      results.push({ step: step.step, target: tgt, status: 'stopped' });
      continue;
    }
    const b = ext.begin({ writer: step.writer, key, target: tgt, request: { ...step, content: undefined, recordId: record.id, version: record.version }, initiatedBy: `nick:${spent.grant.id}`, now });
    if (!b.ok && !b.duplicate) {
      if (res.created.includes(key)) budget.releaseUnstarted([key], { now });
      results.push({ step: step.step, status: 'refused', target: tgt, why: b.why, ledgerId: b.entry && b.entry.id });
      continue;
    }
    try {
      const opts = { verifyOnly: Boolean(b.duplicate) };
      const r = step.step === 'calendar' ? await _calendarStep(step, ad.calendar, opts) : await _noteStep(step, ad.vault, opts);
      const verified = r.checks.every(([, ok]) => ok);
      if (b.ok) ext.settle(b.entry.id, { status: verified ? 'confirmed' : 'uncertain', result: { id: r.id || null, path: r.path || null, created: r.created }, readback: r.checks.map(([what, ok]) => `${ok ? '✓' : '✗'} ${what}`).join('; '), now });
      budget.settle(key, verified || r.gone || r.created || b.duplicate ? 'used' : 'unknown', { now });
      results.push({
        step: step.step, target: tgt, ledgerId: (b.entry || {}).id,
        status: r.gone ? 'removed-since' : !verified ? 'unverified' : b.duplicate || !r.created ? 'already-done' : 'done',
        id: r.id || null, path: r.path || null,
        ...(r.keptAt ? { note: `Already booked for ${dayLong(r.keptAt.date)} ${r.keptAt.start}–${r.keptAt.end}; I didn’t move it.` } : {}),
        ...(r.syncUncertain ? { unconfirmed: 'Saved and read back on the Pi. Reaching your other devices depends on Obsidian Sync, which I haven’t checked.' } : {}),
        verified: r.checks.map(([what, ok]) => ({ what, ok: Boolean(ok) })),
      });
    } catch (e) {
      const status = ext.classifyError(e);
      if (b.ok) ext.settle(b.entry.id, { status, result: { error: e.message }, readback: null, now });
      // Provably not applied → the allowance comes back; uncertain → it stays spent.
      budget.settle(key, status === 'failed' ? 'released' : 'unknown', { now });
      results.push({ step: step.step, target: tgt, ledgerId: (b.entry || {}).id, status: 'failed', provablyNotApplied: status === 'failed', error: e.message });
    }
  }

  const good = (r) => r.status === 'done' || r.status === 'already-done';
  const complete = results.every(good);
  const label = (r) => (r.step === 'calendar' ? 'The calendar block' : r.step === 'reply' ? 'The reply draft' : 'The note');
  const STAYS = { calendar: 'The calendar block is in place and stays.', note: 'The note is saved and stays.', reply: 'The reply draft is in Actions and stays — it has not been sent.' };
  const DONE = { calendar: 'The block is in your calendar, just you.', note: 'The note is saved and read back.', reply: 'The reply is in Actions waiting for your approval code — it has NOT been sent.' };
  const v2 = w.contract === 'prepared-move-v2';
  const receipt = {
    recordId: record.id, version: record.version, option, moveKey: w.moveKey, target: kind,
    at: new Date(now).toISOString(), confirmedWith: spent.grant.id, writeHash: w.writeHash,
    steps: results, complete,
    ...(v2 ? { contract: 'prepared-move-v2', sent: false } : {}),
    plain: complete
      ? (v2 ? results.map((r) => DONE[r.step]).join(' ') : 'Both are in place and checked.')
      : results.filter((r) => !good(r)).map((r) => (r.status === 'removed-since'
        ? `${label(r)} was made earlier and has since been removed — I haven’t recreated it.`
        : r.status === 'stopped'
          ? `${label(r)} was not attempted — SAiM’s actions were stopped.`
          : `${label(r)} ${r.status === 'failed' ? (r.provablyNotApplied ? 'was not saved' : 'may not have been saved') : 'was saved but did not read back as confirmed'}: ${r.error || 'the check did not match'}.`)).join(' ')
        + ` ${results.filter(good).map((r) => STAYS[r.step]).join(' ')}`.trimEnd(),
    next: complete ? 'Nothing else will be done.'
      : results.every((r) => good(r) || r.status === 'removed-since') ? 'Nothing else will be done.'
        : results.some((r) => r.status === 'stopped') ? 'Nothing more will happen while SAiM’s actions are stopped.'
          : 'Confirm again to retry only what is missing — nothing that worked is repeated or undone.',
    contacted: [],
    forum: w.forum,
  };
  // Kept with what SAiM wrote, so a later read can tell Nick's own words from SAiM's.
  const noteW = w.steps.find((x) => x.step === 'note');
  try { db.setState(`saim_move_receipt:${w.moveKey}`, JSON.stringify({ ...receipt, written: noteW ? { path: noteW.path, content: noteW.content } : null })); } catch { /* the ledger still holds the steps */ }
  budget.recordReceipt(receipt, { title: w.title, now });
  return { ok: true, receipt };
}

// ── The two HTTP entry points (routes/prepared-moves.js) ─────────────────────

/** Swappable in tests only: what prepares the packet, and what builds the live readers/writers. */
const deps = {
  prepare: (opts) => require('./prepared-move').prepare(opts),
  liveAdapters: () => liveAdapters(),
  defaultChecks: (opts) => defaultChecks(opts),
  readDuty: (now) => require('./prepared-move').readDuty(now),
};
function _setDeps(over = {}) { const was = { ...deps }; Object.assign(deps, over); return () => Object.assign(deps, was); }

/** The vault as a READER only — what a request may look at. It cannot write. */
function readOnlyVault() {
  const guard = (rel) => { const p = require('../routes/vault')._safePath(rel); if (!p) throw new Error('the path is outside the vault, or the vault is unreadable'); return p; };
  return Object.freeze({
    async exists(rel) { return fs.existsSync(guard(rel)); },
    async read(rel) { try { return fs.readFileSync(guard(rel), 'utf8'); } catch { return null; } },
  });
}

const executionEnabled = () => require('./feature-flags').isEnabled(FLAG);
const HELD = 'I’ve prepared this for your next working morning.';
const MACHINE = 'Only Nick, in NEURO, can confirm a prepared move — a machine client cannot.';

/**
 * Step 1 — "show me what yes would do". Prepares the move from NEURO's live
 * read-only decision, stores it as an immutable version, re-checks the diary,
 * leave, the commitment and the note path, and only then mints a one-use,
 * 60-second confirmation bound to that version, option and write hash.
 *
 * Allowed while execution is switched OFF (so the move can be reviewed): it
 * writes nothing outside NEURO's own database, and says that confirming will
 * not write anything.
 */
async function requestForMove({ option = 'approve', recordId = null, surface = 'neuro-web', sessionId, caller = {}, now = Date.now() } = {}) {
  if (caller.machine) return refuse(MACHINE, { code: 403 });
  const budget = require('./authority-budget');
  if (budget.stopState().stopped) return refuse(`${budget.STOPPED_SAY} Nothing will be prepared for confirmation until you resume them.`, { code: 409, gate: 'stop' });
  if (recordId) return _requestStored({ recordId, option, surface, sessionId, caller, now, budget });
  const packet = await deps.prepare({ now });
  if (!packet || !packet.selected) {
    const why = (packet && (packet.noneBecause || (packet.withheld || []).map((x) => `${x.title}: ${x.reason}`).join('; '))) || 'nothing could be prepared';
    return refuse(`There is no prepared move to confirm right now — ${why}`, { code: 409 });
  }
  // Off duty or on leave: the move stays held. Nothing stored, nothing minted.
  // A packet that does not say is treated as off duty (fail closed).
  // (An out-of-scope or employment move is refused as THAT first — never as held.)
  const w0 = writesFor(packet, option);
  if (!w0.ok) return { ...w0, code: 409 };
  if (!packet.duty || packet.duty.onDuty !== true) return refuse(HELD, { code: 409, held: true });
  // The boundary (20 Oct 2026): a yes that could not be carried out is not
  // asked for. Device lock, stop, today's allowance and whether this move fits
  // it are judged BEFORE anything is stored or a confirmation is minted, and
  // the one boundary that stands is named in plain words.
  // A move already begun today (a retry to finish it, or to find what landed)
  // was charged when it started, so "used up" is not a boundary for IT —
  // execute() re-judges each step at reservation either way.
  const b = budget.brief({ now }).boundary;
  let begun = false;
  try { begun = budget.usage(budget.londonDay(now)).moveKeys.includes(w0.moveKey); } catch { begun = false; }
  if (b && !(begun && b.gate === 'used')) return refuse(b.say, { code: 409, gate: b.gate, boundary: b });
  if (!begun) {
    const mins0 = toMin(w0.slot.end) - toMin(w0.slot.start);
    const fit0 = budget.wouldFit({ action: budget.ACTION, now, steps: [{ kind: 'calendar.solo', minutes: mins0, contacts: 0, spendPence: 0 }, { kind: 'vault.note', minutes: 0, contacts: 0, spendPence: 0 }] });
    if (!fit0.ok) return refuse(fit0.say, { code: 409, gate: 'allowance', boundary: { gate: 'fit', say: fit0.say } });
  }
  const st =require('./prepared-move-store').store(packet, { now });
  if (!st.ok) return refuse(st.why, { code: 409 });
  const record = st.record;
  const w = writesFor(record.packet, option);
  if (!w.ok) return { ...w, code: 409 };
  const fresh = await freshChecks({ record, w, checks: deps.defaultChecks({ adapters: { vault: readOnlyVault() }, now }), now });
  if (!fresh.ok) return { ...fresh, packet: undefined, code: 409 };
  const c = requestConfirmation({ recordId: record.id, option, sessionId, caller, surface, now });
  if (!c.ok) return { ...c, code: 409 };
  const enabled = executionEnabled();
  const mins = toMin(w.slot.end) - toMin(w.slot.start);
  // What would stop it — said BEFORE the click, from the same check execute() makes.
  const fit = budget.wouldFit({
    action: budget.ACTION, now,
    steps: [{ kind: 'calendar.solo', minutes: mins, contacts: 0, spendPence: 0 }, { kind: 'vault.note', minutes: 0, contacts: 0, spendPence: 0 }],
  });
  return {
    ok: true,
    recordId: record.id, moveKey: record.moveKey, version: record.version, option, writeHash: c.writeHash,
    grantId: c.grantId, expiresAt: c.expiresAt,
    executionEnabled: enabled,
    authority: { ...budget.brief({ now }), fits: fit.ok, ...(fit.ok ? {} : { limit: fit.limit, say: fit.say }) },
    confirmation: {
      question: `Reserve ${mins} minutes on ${dayLong(w.slot.date)} (${w.slot.start}–${w.slot.end}) and save the draft?`,
      writes: c.confirmation.writes,
      contacts: c.confirmation.contacts,
      nothingElse: 'Nothing else changes: no email, invite, task, board card, goal or notification.',
      ...(enabled ? {} : { off: 'Carrying out prepared moves is switched off, so confirming will not write anything.' }),
    },
  };
}

/**
 * Step 1 for a STORED v2 proposal (21 Oct 2026): the record Nick is looking
 * at — never re-prepared here, so what he confirms is exactly what was shown.
 * Same gates as the v1 path, in the same order: duty, the allowance boundary
 * and fit, the fresh checks (read-only vault), then the one-use confirmation.
 */
async function _requestStored({ recordId, option, surface, sessionId, caller, now, budget }) {
  const store = require('./prepared-move-store');
  const record = store.get(recordId);
  if (!record || !record.packet || record.packet.contract !== 'prepared-move-v2') return refuse('no such prepared move', { code: 404 });
  if (!store.isLatest(record)) return refuse('this move has changed since it was shown — look again', { code: 409, rePrepare: true });
  const sup = store.suppression(record.moveKey, now);
  if (sup) return refuse(sup.say, { code: 409 });
  const w = writesFor(record.packet, option);
  if (!w.ok) return { ...w, code: 409 };
  const duty = await deps.readDuty(now);
  if (!duty || duty.onDuty !== true) return refuse(HELD, { code: 409, held: true });
  const budgetSteps = w.steps.map(budgetStep);
  const b = budget.brief({ now }).boundary;
  let begun = false;
  try { begun = budget.usage(budget.londonDay(now)).moveKeys.includes(w.moveKey); } catch { begun = false; }
  if (b && !(begun && b.gate === 'used')) return refuse(b.say, { code: 409, gate: b.gate, boundary: b });
  const fit = budgetSteps.length && !begun ? budget.wouldFit({ action: budget.ACTION, now, steps: budgetSteps }) : { ok: true };
  if (!fit.ok) return refuse(fit.say, { code: 409, gate: 'allowance', boundary: { gate: 'fit', say: fit.say } });
  const fresh = await freshChecks({ record, w, checks: deps.defaultChecks({ adapters: { vault: readOnlyVault() }, now }), now });
  if (!fresh.ok) return { ...fresh, packet: undefined, code: 409 };
  store.markChecked(record.id, now);
  const c = requestConfirmation({ recordId: record.id, option, sessionId, caller, surface, now });
  if (!c.ok) return { ...c, code: 409 };
  const enabled = executionEnabled();
  return {
    ok: true, recordId: record.id, moveKey: record.moveKey, version: record.version, option, writeHash: c.writeHash,
    grantId: c.grantId, expiresAt: c.expiresAt, executionEnabled: enabled,
    authority: { ...budget.brief({ now }), fits: fit.ok },
    confirmation: {
      question: w.confirmation.question, writes: w.confirmation.writes, contacts: w.confirmation.contacts,
      nothingElse: 'Nothing else changes: nothing is sent, nobody is invited, and no task, board card, goal or notification is created.',
      ...(enabled ? {} : { off: 'Carrying out prepared moves is switched off, so confirming will not write anything.' }),
    },
  };
}

/**
 * Step 2 — "yes". With the switch off this refuses FIRST: no record read, no
 * adapter built, no confirmation spent. With it on, execute() spends the grant,
 * re-runs every fresh check and makes exactly the stored writes.
 */
async function confirmMove({ recordId, version, option, grantId, caller = {}, now = Date.now() } = {}) {
  if (caller.machine) return refuse(MACHINE, { code: 403 });
  if (!executionEnabled()) return refuse(`Carrying out prepared moves is switched off (${FLAG}) — nothing was written and your confirmation was not used.`, { code: 409, disabled: true, gate: 'device' });
  const budget = require('./authority-budget');
  if (budget.stopState().stopped) return refuse(`${budget.STOPPED_SAY} Nothing was written and your confirmation was not used.`, { code: 409, gate: 'stop' });
  // Re-read now: a confirmation minted in working hours is not used off duty.
  const duty = await deps.readDuty(now);
  if (!duty || duty.onDuty !== true) return refuse(HELD, { code: 409, held: true });
  const store = require('./prepared-move-store');
  const record = store.get(recordId);
  if (!record) return refuse('no such prepared move', { code: 404 });
  if (Number(version) !== record.version || !store.isLatest(record)) return refuse('this move has changed since it was shown — it needs confirming again', { code: 409, rePrepare: true });
  const sup = store.suppression(record.moveKey, now);
  if (sup) return refuse(`${sup.say} Nothing was written and your confirmation was not used.`, { code: 409 });
  // The live adapters are a FACTORY: execute() builds them only after every
  // gate — lock, stop, duty, budget, confirmation — has passed.
  const r = await execute({ recordId, option, grantId, adapters: () => deps.liveAdapters(), target: 'live', checks: (ad) => deps.defaultChecks({ adapters: ad, now }), now });
  return r.ok ? r : { ...r, packet: undefined, code: 409 };
}

module.exports = {
  FLAG, WRITER, DIARY_MAX_AGE_MS, PROJECT_FOLDERS, V2_NOTE_RULES, writesFor, writesForV2, freshChecks, defaultChecks, liveAdapters, readOnlyVault,
  requestConfirmation, execute, requestForMove, confirmMove, londonMs, _setDeps,
};
