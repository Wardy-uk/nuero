'use strict';

/**
 * keep-my-word-v1 — what SAiM's home shows about Nick keeping his word
 * (21 Oct 2026). Composed ONCE, here, onto `presentation.keepMyWord`, and drawn
 * by the shared renderer on the phone, the desktop, the kiosk and Alt — so the
 * four cannot phrase it, or decide it, differently.
 *
 * The locked scene (timefield.html): a compact left-hand READOUT (the week's
 * promises kept on time, the next protected time, what needs his judgement,
 * the Monday report) beside ONE main surface — a verified RECEIPT, or the
 * promise SAiM is holding as a THREAD.
 *
 * Four states, decided here and nowhere else:
 *   receipt  a live prepared move completed AND read back today, nothing leads
 *   held     the thread needs something SAiM has no authority for — the missing
 *            authority is NAMED; there is no confirmation path on it
 *   folded   an urgent lead is on screen: the lead stays first and the thread
 *            (or receipt) folds beneath it, recognisable by its title
 *   calm     otherwise: the thread leads, or only the readout shows
 *
 * PURE apart from `latestVerifiedReceipt` (a read). It acts on nothing and
 * offers no action of its own: opening the task is the existing `onOpen`.
 */

const score = require('./promise-score');

const CONTRACT = 'keep-my-word-v1';
/** Situation.jsx's own definition of a lead (kept equal by a test). */
const LEAD_MODES = new Set(['degraded', 'in-meeting', 'needs-attention', 'focus', 'upcoming']);

const PREP_LABEL = {
  ready: 'Ready',
  'needs-a-block': 'Needs a block',
  'needs-a-draft': 'Needs a draft',
  'waiting-for-Nick': 'Waiting for you',
  'not-safe-to-prepare': 'Not safe to prepare',
};

const NUM = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten'];
const num = (n) => (n >= 0 && n < NUM.length ? NUM[n] : String(n));

/** PURE. Is something more urgent on the screen? Mirrors Situation.jsx's lead rule. */
function leadFrom(presentation) {
  if (!presentation) return { lead: false, why: null };
  if ((presentation.needsYou || []).length) return { lead: true, why: 'needs-you' };
  const pr = presentation.primary;
  if (pr && (pr.priority === 'P0' || pr.urgency === 'critical' || pr.urgency === 'high')) return { lead: true, why: 'urgent-primary' };
  if (LEAD_MODES.has(presentation.mode)) return { lead: true, why: `mode:${presentation.mode}` };
  return { lead: false, why: null };
}

/** PURE. "Tuesday · 15:30". */
function shortWhen(date, start) {
  return `${score.dayLabel(date).split(' ')[0]} · ${start}`;
}

/** PURE. "Tuesday, 21 October 2026". */
function longDay(dateKey) {
  const parts = score.dayLabel(dateKey).split(' ');
  return `${parts[0]}, ${parts.slice(1).join(' ')} ${dateKey.slice(0, 4)}`;
}

// ── The verified receipt ─────────────────────────────────────────────────────

const CAL_TARGET = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})–(\d{2}:\d{2}) “(.*)”$/;
const GOOD = new Set(['done', 'already-done']);

/**
 * PURE. A receipt event as the home shows it — or null unless it is LIVE,
 * COMPLETE and every step read back (`done` / `already-done` are only ever
 * written after the read-back matched; prepared-move-exec).
 */
function receiptView(r) {
  if (!r || r.target === 'sandbox' || !r.complete) return null;
  const steps = r.steps || [];
  if (!steps.length || !steps.every((s) => GOOD.has(s.status))) return null;
  const at = Date.parse(r.at);
  if (!Number.isFinite(at)) return null;
  const rows = [];
  let calendar = null;
  let notePath = null;
  let hasReply = false;
  for (const s of steps) {
    if (s.step === 'calendar') {
      const m = CAL_TARGET.exec(String(s.target || ''));
      if (!m) return null; // a calendar step we cannot read is not a receipt we can state
      calendar = { date: m[1], start: m[2], end: m[3], title: m[4] };
      rows.push({ label: 'Calendar', title: s.status === 'done' ? `${m[4]} — block created` : `${m[4]} — block already in place`,
        lines: [`${longDay(m[1])} · ${m[2]}–${m[3]}`, 'Calendar read-back verified.'] });
    } else if (s.step === 'note') {
      notePath = String(s.target || '') || null;
      if (!notePath) return null;
      rows.push({ label: 'Vault note', title: s.status === 'done' ? 'Draft note created' : 'Draft note already in place', lines: ['Vault read-back verified.'] });
    } else if (s.step === 'reply') {
      hasReply = true;
      rows.push({ label: 'Reply', title: s.status === 'done' ? 'Reply drafted in Actions' : 'Reply draft already in Actions', lines: ['Waiting for your approval code — not sent.'] });
    }
  }
  if (notePath) rows.push({ label: 'Find it', path: notePath });
  const n = steps.length;
  return {
    label: 'Receipt · verified',
    headline: 'Preparation is now real.',
    title: r.title || null,
    lead: `SAiM made ${num(n).toLowerCase()} internal change${n === 1 ? '' : 's'}, then read ${n === 2 ? 'both' : n === 1 ? 'it' : 'each'} back. ${hasReply ? 'Nothing was sent — the reply waits in Actions for your approval; no invite or task.' : 'Nothing else was changed — no email, invite or task.'}`,
    checkedAt: new Date(at).toISOString(),
    checkedLabel: `Checked ${score.londonLabel(at)}`,
    rows,
    calendar,
    notePath,
  };
}

/** Today's latest LIVE, complete, verified receipt — read from the append-only authority events. */
function latestVerifiedReceipt({ now = Date.now(), db = null } = {}) {
  const d = db || require('../db/database');
  const today = score.londonWall(now).date;
  let rows = [];
  try { rows = d.all(`SELECT at, detail FROM saim_authority_events WHERE kind = 'receipt' ORDER BY id DESC LIMIT 10`); } catch { return null; }
  for (const r of rows) {
    let detail; try { detail = JSON.parse(r.detail); } catch { continue; }
    const rec = { at: r.at, ...detail };
    if (score.londonWall(Date.parse(rec.at)).date !== today) continue;
    const v = receiptView(rec);
    if (v) return v;
  }
  return null;
}

// ── The readout ──────────────────────────────────────────────────────────────

const MONDAY_LINE = {
  'sent-verified-on-time': 'Sent, and read back in Sent Items by the deadline.',
  'sent-verified-late': 'Sent after the deadline, and read back.',
  'written-no-send-record': 'Written — no send is recorded.',
  late: 'Not written or sent, and the deadline has passed.',
  unknown: 'NEURO couldn’t read the report’s records.',
};

/** PURE. */
function mondayLine(m) {
  if (!m) return null;
  if (m.state === 'due') return `Due ${m.dueLabel}.`;
  if (m.state === 'sent-unverified') return `Recorded as sent — ${m.rule}.`;
  return MONDAY_LINE[m.state] || null;
}

/** PURE. "One more than last week." / "Two fewer than last week." / "The same as last week." */
function trendLine(cur, prev) {
  if (!cur || !prev) return null;
  const d = cur.kept - prev.kept;
  if (d === 0) return 'The same as last week.';
  return d > 0 ? `${num(d)} more than last week.` : `${num(-d)} fewer than last week.`;
}

/** PURE. The left-hand readout. */
function readoutFrom({ score: sc, workbench, receipt, now }) {
  const nowMs = typeof now === 'number' ? now : Date.parse(now);
  const out = { label: 'Holding the week', figure: null, figureNote: null, line: null, trend: null, next: null, judgement: null, monday: null };
  if (!sc) {
    out.figureNote = 'Can’t read yet';
    out.line = 'NEURO couldn’t read your promises, so nothing is counted.';
  } else if (!sc.ratio) {
    out.figureNote = 'Not measured yet';
    out.line = sc.why || 'Nothing records a delivery yet, so nothing is counted as kept.';
  } else if (sc.ratio.of === 0) {
    out.figureNote = 'Nothing due yet';
    out.line = sc.counts.pending ? `${num(sc.counts.pending)} still to come this week.` : 'Nothing was due this week.';
  } else {
    out.figure = `${sc.ratio.kept} / ${sc.ratio.of}`;
    out.line = 'Promises kept on time — each one read back as delivered.';
    out.trend = sc.previous && sc.previous.ratio ? trendLine(sc.ratio, sc.previous.ratio) : null;
  }
  if (sc && sc.counts && sc.counts.reDated) out.reDated = `${num(sc.counts.reDated)} re-dated this week.`;
  if (sc && sc.mondayReport) out.monday = { label: 'Monday report', line: mondayLine(sc.mondayReport), state: sc.mondayReport.state };

  // Next protected time: the earliest booked block still ahead, from the bench or today's receipt.
  const ahead = [];
  for (const it of (workbench && workbench.items) || []) {
    for (const b of it.booked || []) ahead.push({ date: b.date, start: b.start, title: it.title });
  }
  if (receipt && receipt.calendar) ahead.push({ ...receipt.calendar });
  const future = ahead.filter((b) => b.date && b.start && score.londonInstant(b.date, b.start) > nowMs)
    .sort((a, b) => `${a.date} ${a.start}`.localeCompare(`${b.date} ${b.start}`));
  if (future.length) out.next = { label: 'Next', strong: shortWhen(future[0].date, future[0].start), line: `${future[0].title}. Protected time.` };

  // What only Nick can say: ticked with no delivery evidence, or waiting for him.
  const keys = new Set();
  for (const e of (sc && sc.entries) || []) if (e.outcome === 'unverified') keys.add(e.key);
  for (const it of (workbench && workbench.items) || []) if (it.preparation && it.preparation.state === 'waiting-for-Nick') keys.add(it.key);
  if (keys.size) out.judgement = { label: 'Needs your judgement', strong: `${num(keys.size)} promise${keys.size === 1 ? '' : 's'}`, line: 'Only you can say whether they were delivered.' };
  return out;
}

// ── The thread ───────────────────────────────────────────────────────────────

/** PURE. The held sentence when the thread needs authority SAiM lacks — or null. */
const DRAFT_SAY = 'SAiM can prepare a delivery note for your approval. Nothing will be sent.';
const DRAFT_CONTROL = 'Draft the delivery note';
const SHOW_CONTROL = 'Show the delivery note';
const SENDING_OFF = '“Send approved emails” is off, so the note can be reviewed but can’t be approved to send until that setting is on.';
const REVIEW_SAY = 'Review it, write in what you promised, and approve it in Actions, in NEURO on the desktop. Nothing is sent until you do.';
const WAITING = {
  prepared: 'A delivery note is already drafted and waiting for your approval.',
  approved: 'Its delivery note is approved and about to be sent.',
  executing: 'Its delivery note is being sent now.',
  executed: 'Its delivery note was sent and is waiting to be read back in Sent Items.',
  execution_uncertain: 'Its delivery note may have been sent — Actions is checking Sent Items.',
};

/**
 * PURE. The bounded delivery action for a `needs-a-draft` promise — or null.
 * Shown ONLY when NEURO can name one recipient address; a draft that has moved
 * past `prepared` is reported, not offered again. Readiness unknown → null
 * (and heldFor names why).
 */
function draftFor(item, delivery) {
  if (!item.preparation || item.preparation.state !== 'needs-a-draft') return null;
  const r = delivery && delivery.items ? delivery.items[item.key] : null;
  if (!r || !r.addressable) return null;
  const live = r.live || null;
  // A draft that exists is never offered as a NEW draft: a prepared one can be
  // shown again (the same idempotent route returns it); one further on is
  // reported only.
  return {
    key: item.key,
    say: live ? (WAITING[live.status] || 'A delivery note already exists for this promise.') : DRAFT_SAY,
    control: !live ? DRAFT_CONTROL : live.status === 'prepared' ? SHOW_CONTROL : null,
    liveActionId: live ? live.actionId : null,
    sendingOff: delivery.sending === true ? null : SENDING_OFF,
    review: REVIEW_SAY,
  };
}

/** PURE. The held sentence when the thread cannot proceed — or null. */
function heldFor(item, authority, delivery = null) {
  const prep = item.preparation && item.preparation.state;
  if (prep === 'needs-a-draft') {
    const r = delivery && delivery.items ? delivery.items[item.key] : null;
    if (!r) return 'NEURO couldn’t check whether this can be drafted, so nothing is offered.';
    if (!r.addressable) return `NEURO has no single email address for ${item.owedTo || 'the person it is owed to'} in their People note, so nothing is drafted. Add it there and this can be drafted.`;
    return null;
  }
  if (prep === 'needs-a-block' && authority && authority.boundary && authority.boundary.say) return authority.boundary.say;
  return null;
}

/** PURE. The prepared-move state for the thread's promise, as the card shows it (promise-moves.moveFor). */
function moveView(m) {
  if (!m) return null;
  return {
    state: m.state, ref: m.ref, control: m.control || null, say: m.say || null,
    privateDraft: m.privateDraft || null, owedAnswer: m.owedAnswer || null, focusRef: m.focusRef || null, interview: m.interview || null,
    question: m.question ? { id: m.question.id, question: m.question.question, why: m.question.why || null, choices: m.question.choices || [] } : null,
    recordId: m.recordId || null, version: m.version || null, scheduled: m.scheduled || null,
  };
}

/** PURE. The promise SAiM is holding, as the scene draws it. */
function threadFrom(workbench, authority, delivery = null, moves = null) {
  const items = (workbench && workbench.items) || [];
  if (!items.length) return null;
  const it = items[0];
  const move = moveView(moves ? moves[it.key] : null);
  // A needs-a-block promise SAiM can PREPARE is not held: the allowance only
  // matters when a prepared move is confirmed, and that confirm names it.
  // A promise SAiM can only take forward as a PRIVATE draft is not held either:
  // the card says what SAiM can't do and what it can, and offers the draft —
  // never a delivery note, never "who is it owed to?" (25 Oct 2026).
  const privateDraft = Boolean(move && move.privateDraft);
  const held = move && (privateDraft || it.preparation.state === 'needs-a-block') ? null : heldFor(it, authority, delivery);
  const draft = held || privateDraft ? null : draftFor(it, delivery);
  const sensitiveWithheld = (workbench.withheld && workbench.withheld.sensitive) || 0;
  return {
    key: it.key, taskIds: it.taskIds, taskId: it.leadTaskId,
    label: 'Keeping your word',
    title: it.title,
    owedTo: privateDraft || it.owedToSelf ? null : it.owedTo,
    due: { say: it.due.say, label: `Due ${score.dayLabel(it.due.date)}`, date: it.due.date, endsAt: it.due.endsAt },
    preparation: privateDraft
      ? { state: 'private-draft', label: 'Private draft', why: `${move.privateDraft.cannot} ${move.privateDraft.can}` }
      : { state: it.preparation.state, label: PREP_LABEL[it.preparation.state], why: it.preparation.why },
    evidence: it.evidence,
    because: it.because,
    held: held ? { say: held } : null,
    draft,
    move,
    more: items.length > 1 ? { count: items.length - 1, titles: items.slice(1).map((x) => x.title) } : null,
    withheld: sensitiveWithheld ? `${num(sensitiveWithheld)} more involve${sensitiveWithheld === 1 ? 's' : ''} someone’s employment — not shown here.` : null,
  };
}

/**
 * PURE. The whole home contract.
 *   score         promise-score-v1 (with previous + mondayReport) or null
 *   workbench     promise-workbench-v1 or null
 *   receipt       receiptView() or null
 *   authority     authority-budget.brief() or null
 *   delivery      { sending, items: { key → promise-delivery.readiness() } } or null
 *   moves         { key → promise-moves.moveFor() } or null — taking a promise forward
 *   presentation  the presentation it rides on (for the lead rule)
 */
function compose({ score: sc = null, workbench = null, receipt = null, authority = null, delivery = null, moves = null, presentation = null, now = Date.now() } = {}) {
  const lead = leadFrom(presentation);
  const thread = threadFrom(workbench, authority, delivery, moves);
  const readout = readoutFrom({ score: sc, workbench, receipt, now });
  const hasMain = Boolean(receipt || thread);
  let state;
  if (lead.lead && hasMain) state = 'folded';
  else if (receipt) state = 'receipt';
  else if (thread && thread.held) state = 'held';
  else state = 'calm';
  const entry = receipt
    ? `Receipt · verified${receipt.title ? ` — ${receipt.title}` : ''}`
    : thread ? `Keeping your word — ${thread.title} · ${thread.due.say}` : null;
  return {
    contract: CONTRACT,
    state,
    leads: hasMain && !lead.lead,
    leadWhy: lead.why,
    readout,
    receipt: receipt || null,
    thread,
    entry,
    benchState: workbench ? workbench.state : 'unknown',
    benchWhy: workbench ? workbench.why : 'NEURO couldn’t read the workbench.',
  };
}

module.exports = { CONTRACT, LEAD_MODES, PREP_LABEL, DRAFT_SAY, DRAFT_CONTROL, SHOW_CONTROL, SENDING_OFF, REVIEW_SAY, draftFor, leadFrom, receiptView, latestVerifiedReceipt, mondayLine, trendLine, readoutFrom, heldFor, threadFrom, moveView, compose };
