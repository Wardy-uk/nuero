'use strict';

/**
 * Holding the week — the four cards, each leading somewhere useful (22 Oct 2026).
 * Composed ONCE here onto `readout.cards` (keep-my-word-cards-v1) and drawn by the
 * shared renderer on NEURO's Now, the SAiM phone and the kiosk — same contract,
 * same entity ids, so no shell decides what a card does.
 *
 * Every card has ONE primary affordance, at most one quiet secondary link, and the
 * exact record that explains it (`detail`, carried inline so a read-only shell can
 * inspect it without a new route). A card with no safe action still opens that
 * record — never a blank card, never a generic "Open task".
 *
 *   kept       the week's promises: what is measured, what is not and exactly why,
 *              which are at risk, and the next valid action for each
 *   monday     the Monday report: the read-back receipt and the saved report when
 *              it was sent; the governed preparation path when it is still due.
 *              Never a resend because the card is visible.
 *   next       the exact protected block: its time, its draft, its task — and
 *              "Start this block" ONLY when a focus session is possible now
 *   judgement  a bounded review of the named promises, one at a time, with their
 *              evidence and the existing safe choices
 *
 * Targets (`open`) — the shell performs what it can and says where the rest lives:
 *   { kind:'detail', card }            the card's own record (every shell, kiosk included)
 *   { kind:'view', view }              a NEURO screen (desktop)
 *   { kind:'task', taskId }            the task, by id
 *   { kind:'note', path, obsidianUrl } the draft note
 *   { kind:'url', href }               the calendar event in Outlook
 *   { kind:'session-start', taskId, minutes, text }   MUTATES — never on the kiosk
 *   { kind:'prepare-delivery', key }   MUTATES (prepares only, sends nothing) — never on the kiosk
 *
 * PURE. Ids only from the records; never title matching.
 */

const score = require('./promise-score');

const CONTRACT = 'keep-my-word-cards-v1';
const MUTATING = new Set(['session-start', 'prepare-delivery']);
const START_LEAD_MS = 10 * 60 * 1000; // a block may be started up to 10 minutes early

const NUM = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten'];
const num = (n) => (n >= 0 && n < NUM.length ? NUM[n] : String(n));
const whenFull = (date, start, end) => `${score.dayLabel(date)}, ${start}${end ? `–${end}` : ''}`;
const isoSay = (iso) => { const t = Date.parse(iso || ''); return Number.isFinite(t) ? score.londonLabel(t) : null; };

const OUTCOME_SAY = {
  'kept-on-time': 'Kept on time',
  late: 'Late',
  unverified: 'Delivered — can’t tell if it was on time',
  pending: 'Not due yet',
  dropped: 'Dropped by you',
};
const EVIDENCE_SAY = {
  'verified-delivery': (e) => `Delivery read back in Sent Items${e.provenBy ? ` ${isoSay(e.provenBy) || ''}` : ''}.`,
  ticked: () => 'You ticked the task.',
  booked: (e) => e.fact || 'Time is booked for it.',
};

/** PURE. One evidence line, never an internal id. */
function evidenceLine(e) {
  if (!e) return null;
  if (e.fact) return e.fact;
  const f = EVIDENCE_SAY[e.kind];
  return f ? f(e) : null;
}

/** PURE. The next valid action for one promise — a delivery note when one can be drafted, else its task. */
function nextActionFor({ key, taskId }, bench, delivery) {
  const it = bench.get(key);
  const r = delivery && delivery.items ? delivery.items[key] : null;
  if (it && it.preparation && it.preparation.state === 'needs-a-draft' && r && r.addressable && !r.live) {
    return { label: 'Draft the delivery note — nothing is sent', open: { kind: 'prepare-delivery', key } };
  }
  return taskId ? { label: 'Open the task', open: { kind: 'task', taskId } } : null;
}

// ── Keeping my word ──────────────────────────────────────────────────────────

function keptCard({ sc, bench, delivery }) {
  if (!sc) {
    return {
      id: 'kept', state: 'unreadable',
      primary: { label: 'See why nothing is counted', open: { kind: 'detail', record: 'kept' } }, secondary: null,
      detail: { title: 'Keeping my word', measured: false, missing: ['NEURO couldn’t read your promises, so nothing is counted — this is not a clean week.'], promises: [], notCounted: null },
    };
  }
  const entries = sc.entries || [];
  const promises = [];
  const seen = new Set();
  for (const e of entries) {
    seen.add(e.key);
    const taskId = (e.taskIds && e.taskIds[0]) || null;
    const it = bench.get(e.key);
    const atRisk = e.outcome === 'late' || e.outcome === 'unverified' || (e.outcome === 'pending' && Boolean(it));
    promises.push({
      key: e.key, taskId, title: e.text || null,
      outcome: e.outcome, outcomeSay: OUTCOME_SAY[e.outcome] || e.outcome, rule: e.rule || null,
      due: e.due && e.due.date ? { date: e.due.date, say: `Due ${score.dayLabel(e.due.date)}` } : null,
      evidence: (e.evidence || []).map(evidenceLine).filter(Boolean),
      preparation: it && it.preparation ? it.preparation.why || null : null,
      atRisk,
      action: e.outcome === 'kept-on-time' || e.outcome === 'dropped' ? null : nextActionFor({ key: e.key, taskId }, bench, delivery),
    });
  }
  // At-risk promises the bench holds but the week's entries do not (due soon, not this week).
  for (const it of bench.values()) {
    if (seen.has(it.key)) continue;
    promises.push({
      key: it.key, taskId: it.leadTaskId || (it.taskIds && it.taskIds[0]) || null, title: it.title || null,
      outcome: 'pending', outcomeSay: OUTCOME_SAY.pending, rule: null,
      due: it.due && it.due.date ? { date: it.due.date, say: `Due ${score.dayLabel(it.due.date)}` } : null,
      evidence: (it.evidence || []).map(evidenceLine).filter(Boolean),
      preparation: it.preparation ? it.preparation.why || null : null,
      atRisk: true,
      action: nextActionFor({ key: it.key, taskId: it.leadTaskId || (it.taskIds && it.taskIds[0]) || null }, bench, delivery),
    });
  }
  promises.sort((a, b) => (Number(b.atRisk) - Number(a.atRisk)) || String((a.due || {}).date || '9999').localeCompare(String((b.due || {}).date || '9999')));

  const measured = Boolean(sc.ratio);
  const missing = [];
  if (!measured) {
    if ((sc.gaps || []).some((g) => g.input === 'tasks')) missing.push('NEURO couldn’t read the task list.');
  }
  const affected = promises.filter((p) => p.outcome !== 'kept-on-time' && p.outcome !== 'dropped').map((p) => p.key);
  const c = sc.counts || {};
  const notCounted = {
    undated: c.undated || 0, beforeProofSource: c.beforeProofSource || 0, reDated: c.reDated || 0,
    say: [
      c.undated ? `${num(c.undated)} promise${c.undated === 1 ? ' has' : 's have'} no date — only the 10-day placeholder — so ${c.undated === 1 ? 'it is' : 'they are'} not scored.` : null,
      c.reDated ? `${num(c.reDated)} re-dated this week.` : null,
    ].filter(Boolean),
  };
  return {
    id: 'kept', state: measured ? 'measured' : 'not-measured',
    primary: { label: measured ? 'See this week’s promises' : 'See what’s missing', open: { kind: 'detail', record: 'kept' } },
    secondary: { label: 'All commitments', open: { kind: 'view', view: 'commitments' } },
    detail: {
      title: 'Keeping my word', week: sc.week ? sc.week.label : null, measured,
      figure: measured ? `${sc.ratio.kept} / ${sc.ratio.of}` : null,
      missing, affected, promises, notCounted,
    },
  };
}

// ── Monday report ────────────────────────────────────────────────────────────

const MONDAY_ACTION = {
  due: 'Write and send it', late: 'Write and send it now', 'written-no-send-record': 'Send it, or record that you did',
};

function mondayCard({ m }) {
  const view = { kind: 'view', view: 'weekly-risk' };
  if (!m) {
    return { id: 'monday', state: 'unknown', primary: { label: 'See why', open: { kind: 'detail', record: 'monday' } }, secondary: { label: 'Open the Monday report', open: view },
      detail: { title: 'Monday report', state: 'unknown', say: 'NEURO couldn’t read this week’s report records — that is not the same as not sent.', receipt: null, report: null } };
  }
  const proof = (m.evidence || []).find((e) => e.kind === 'verified-send');
  const report = m.report ? {
    subject: m.report.subject || null, sentAtSay: isoSay(m.report.sentAt), recipients: m.report.recipients || [], excerpt: m.report.excerpt || null,
    reportedByNick: Boolean(m.report.reportedByNick),
  } : null;
  const detail = {
    title: 'Monday report', state: m.state, due: m.dueLabel || null, rule: m.rule || null,
    receipt: proof ? { say: `Read back in Sent Items ${isoSay(proof.provenBy) || ''}.`.replace(' .', '.'), onTime: m.state === 'sent-verified-on-time' } : null,
    report,
  };
  const settled = m.state === 'sent-verified-on-time' || m.state === 'sent-verified-late';
  if (settled) {
    // Sent and read back: the receipt and the saved report — never a send control.
    return { id: 'monday', state: m.state, primary: { label: 'View the receipt and report', open: { kind: 'detail', record: 'monday' } }, secondary: { label: 'Open the saved report', open: view }, detail };
  }
  if (m.state === 'sent-unverified') {
    return { id: 'monday', state: m.state, primary: { label: 'See what was recorded', open: { kind: 'detail', record: 'monday' } }, secondary: { label: 'Open the Monday report', open: view }, detail };
  }
  if (m.state === 'unknown') {
    return { id: 'monday', state: m.state, primary: { label: 'See why', open: { kind: 'detail', record: 'monday' } }, secondary: { label: 'Open the Monday report', open: view }, detail };
  }
  // Still to do: the governed preparation path (write → publish → approve → send).
  return { id: 'monday', state: m.state, primary: { label: MONDAY_ACTION[m.state] || 'Open the Monday report', open: view }, secondary: { label: 'Why', open: { kind: 'detail', record: 'monday' } }, detail };
}

// ── Next protected time ──────────────────────────────────────────────────────

function nextCard({ work, bench, receipt, session, now }) {
  const nowMs = typeof now === 'number' ? now : Date.parse(now);
  const blocks = [];
  for (const w of work || []) {
    if (!w.block || !w.block.date) continue;
    const endMs = score.londonInstant(w.block.date, w.block.end || w.block.start);
    if (!(endMs > nowMs)) continue;
    blocks.push({ source: 'draft', date: w.block.date, start: w.block.start, end: w.block.end, title: w.title, moveKey: w.moveKey,
      draft: w.path ? { path: w.path, findIt: String(w.path).replace(/\.md$/i, '').split('/').join(' → '), obsidianUrl: w.obsidianUrl || null } : null,
      task: w.task ? { id: w.task.id, text: w.task.text || null, status: w.task.status || null } : null,
      outlookUrl: w.outlookUrl || null });
  }
  // Booked time the bench knows about that has no saved draft behind it (date, time, its task).
  for (const it of bench.values()) {
    for (const b of it.booked || []) {
      if (!b.date || !b.start) continue;
      const endMs = score.londonInstant(b.date, b.end || b.start);
      if (!(endMs > nowMs) || blocks.some((x) => x.date === b.date && x.start === b.start)) continue;
      const tid = it.leadTaskId || (it.taskIds && it.taskIds[0]) || null;
      blocks.push({ source: 'bench', date: b.date, start: b.start, end: b.end || null, title: it.title, draft: null, task: tid ? { id: tid, text: it.title || null, status: null } : null, outlookUrl: null });
    }
  }
  if (receipt && receipt.calendar && !blocks.some((x) => x.date === receipt.calendar.date && x.start === receipt.calendar.start)) {
    const endMs = score.londonInstant(receipt.calendar.date, receipt.calendar.end);
    if (endMs > nowMs) blocks.push({ source: 'receipt', ...receipt.calendar, draft: receipt.notePath ? { path: receipt.notePath, findIt: String(receipt.notePath).replace(/\.md$/i, '').split('/').join(' → '), obsidianUrl: null } : null, task: null, outlookUrl: null });
  }
  blocks.sort((a, b) => `${a.date} ${a.start}`.localeCompare(`${b.date} ${b.start}`));
  const b = blocks[0];
  if (!b) {
    const unbooked = (work || []).filter((w) => !w.block).length;
    return {
      id: 'next', state: 'none',
      primary: { label: 'See what’s prepared', open: { kind: 'detail', record: 'next' } }, secondary: null,
      detail: { title: 'Next', block: null, say: 'No protected time is booked ahead.', unbooked, drafts: unbooked ? { label: `${num(unbooked)} saved draft${unbooked === 1 ? '' : 's'} with no time booked — open Drafts`, open: { kind: 'view', view: 'drafts' } } : null },
    };
  }
  const startMs = score.londonInstant(b.date, b.start);
  const endMs = b.end ? score.londonInstant(b.date, b.end) : startMs;
  const sameTask = session && b.task && Number(session.taskId) === Number(b.task.id);
  let possible = false; let why;
  // focus-session.current(): a live session (active, paused, stepped away, needs-smaller) unless stale.
  if (session && !session.stale) {
    why = sameTask ? 'A focus session on this task is already running.' : `A focus session on “${session.text || 'another task'}” is running — finish or pause it first.`;
  } else if (!b.task) {
    why = 'This block has no task linked, so there is nothing to start a session on.';
  } else if (nowMs < startMs - START_LEAD_MS) {
    why = `Start this block becomes available at ${b.start} on ${score.dayLabel(b.date)}.`;
  } else {
    possible = true;
    why = null;
  }
  const minutes = Math.max(5, Math.round((endMs - Math.max(nowMs, startMs)) / 60000));
  const detail = {
    title: 'Next', state: possible ? 'startable' : 'booked',
    block: { date: b.date, start: b.start, end: b.end, when: whenFull(b.date, b.start, b.end), title: b.title, outlookUrl: b.outlookUrl || null },
    draft: b.draft, task: b.task,
    session: { possible, why },
  };
  const detailOpen = { kind: 'detail', record: 'next' };
  return {
    id: 'next', state: detail.state,
    primary: possible
      ? { label: 'Start this block', open: { kind: 'session-start', taskId: b.task.id, minutes, text: b.task.text || b.title } }
      : { label: 'Open this block', open: detailOpen },
    secondary: possible
      ? { label: 'View the block, draft and task', open: detailOpen }
      : (b.draft ? { label: 'Open the draft', open: { kind: 'note', path: b.draft.path, obsidianUrl: b.draft.obsidianUrl } } : null),
    detail,
  };
}

// ── Needs your judgement ─────────────────────────────────────────────────────

function judgementCard({ sc, bench, delivery }) {
  const items = [];
  const keys = new Set();
  for (const e of (sc && sc.entries) || []) {
    if (e.outcome !== 'unverified' || keys.has(e.key)) continue;
    keys.add(e.key);
    const taskId = (e.taskIds && e.taskIds[0]) || null;
    items.push({
      key: e.key, taskId, title: e.text || null,
      why: 'Delivered, but NEURO can’t tell if it was on time.',
      evidence: [e.rule ? `Rule: ${e.rule}.` : null, e.due && e.due.date ? `Due ${score.dayLabel(e.due.date)}.` : null, ...(e.evidence || []).map(evidenceLine)].filter(Boolean),
      choices: [nextActionFor({ key: e.key, taskId }, bench, delivery)].filter(Boolean),
    });
  }
  for (const it of bench.values()) {
    if (!(it.preparation && it.preparation.state === 'waiting-for-Nick') || keys.has(it.key)) continue;
    keys.add(it.key);
    const taskId = it.leadTaskId || (it.taskIds && it.taskIds[0]) || null;
    items.push({
      key: it.key, taskId, title: it.title || null,
      why: 'Waiting for your answer.',
      evidence: [it.preparation.why || null, it.due && it.due.date ? `Due ${score.dayLabel(it.due.date)}.` : null, ...(it.evidence || []).map(evidenceLine)].filter(Boolean),
      choices: [taskId ? { label: 'Open the task', open: { kind: 'task', taskId } } : null].filter(Boolean),
    });
  }
  const n = items.length;
  return {
    id: 'judgement', state: n ? 'waiting' : 'none',
    primary: n ? { label: n === 1 ? 'Review it' : `Review them one at a time (${n})`, open: { kind: 'detail', record: 'judgement' } } : { label: 'What counts here', open: { kind: 'detail', record: 'judgement' } },
    secondary: null,
    detail: {
      title: 'Needs your judgement', count: n, items,
      say: n ? 'Only you can say whether these were delivered. One at a time — nothing is changed until you choose.'
        : 'Nothing is waiting on your judgement. A promise lands here when its task is ticked with no proof of delivery, or when SAiM is waiting for your answer.',
    },
  };
}

/**
 * PURE. The four cards.
 *   score, workbench, delivery   as keep-my-word.compose has them
 *   work      prepared-drafts.savedWork().work (saved drafts with booked blocks)
 *   receipt   keep-my-word.receiptView() or null
 *   session   focus-session.current() or null
 */
function cardsFrom({ score: sc = null, workbench = null, delivery = null, work = null, receipt = null, session = null, now = Date.now() } = {}) {
  const bench = new Map(((workbench && workbench.items) || []).map((it) => [it.key, it]));
  return {
    contract: CONTRACT,
    kept: keptCard({ sc, bench, delivery }),
    monday: mondayCard({ m: sc ? sc.mondayReport : null }),
    next: nextCard({ work, bench, receipt, session, now }),
    judgement: judgementCard({ sc, bench, delivery }),
  };
}

/** PURE. Whether a target changes anything (a read-only shell — the kiosk — never performs these). */
function isMutating(target) { return Boolean(target && MUTATING.has(target.kind)); }

module.exports = { CONTRACT, MUTATING, START_LEAD_MS, cardsFrom, isMutating, nextActionFor, evidenceLine };
