'use strict';

/**
 * The automatic prepared-move scan (21 Oct 2026). On a bounded London working-
 * day cadence it asks the planner for AT MOST ONE move — the same pipeline the
 * manual "Make this ready" uses — and stores a proposal only when its evidence
 * has materially changed (an unchanged candidate refreshes its check stamp and
 * buys no model call).
 *
 * It NEVER creates a calendar block, note, task, email, invitation or
 * notification: the only thing it writes is NEURO's own proposal row. The
 * home decides whether the proposal may be shown (never over a live P0/P1 or
 * an active meeting — Situation's lead rule).
 *
 * (24 Oct 2026: the cap is ONE automatic proposal whose review time is not yet
 * booked — see scanOnce — not one proposal of any kind.)
 *
 * CADENCE: every 30 minutes, 08:00–17:30, Monday–Friday, Europe/London — and
 * then only on a working day (bank holidays and leave skip), on duty, outside
 * a meeting, with SAiM's actions not stopped and the switch
 * `saim_prepared_move_scan` on.
 */

const CRON = '*/30 8-17 * * 1-5';
const FLAG = 'saim_prepared_move_scan';

let running = false;

/** Unbooked automatic proposals kept open at once — today's ceiling of moves (authority-budget.CEILING.moves). */
const OPEN_AUTOMATIC_MAX = 3;
/** Kinds whose finish may need Nick's own review/work time. */
const REVIEW_KINDS = Object.freeze(['project-note']);

/** PURE. Was this move started by the scan (whatever re-planned it since)? */
function isAutomatic(rec) {
  const p = (rec && rec.packet) || {};
  return (p.firstOrigin || p.origin) === 'scan';
}

/**
 * PURE. Does it count against the review cap? A draft that proposes a private
 * block, or a review-kind move still asking Nick a question (it is on the way
 * to needing his time). A reply or meeting prep never does.
 */
function reviewPending(rec) {
  const s = rec && rec.packet && rec.packet.selected;
  if (!s) return false;
  if (s.plan === 'ask') return REVIEW_KINDS.includes(s.kind);
  return s.plan === 'draft' && ((s.decision || {}).proposedWrites || []).some((w) => w.kind === 'calendar.solo');
}

/** PURE. Should a scan run at this moment? → { run, why } */
function gate({ flagOn, workingDay, duty, inMeeting, stopped }) {
  if (!flagOn) return { run: false, why: 'switched off' };
  if (!workingDay) return { run: false, why: 'not a working day' };
  if (stopped) return { run: false, why: 'SAiM’s actions are stopped' };
  if (!duty || duty.onDuty !== true) return { run: false, why: `off duty (${(duty && duty.why) || 'unknown'})` };
  if (inMeeting) return { run: false, why: 'in a meeting' };
  return { run: true, why: null };
}

async function scanOnce({ now = Date.now(), deps = {} } = {}) {
  if (running) return { ran: false, why: 'a scan is already running' };
  running = true;
  try {
    const flagOn = deps.flagOn != null ? deps.flagOn : require('./feature-flags').isEnabled(FLAG);
    const wd = require('../../shared/working-days.cjs');
    const ymd = new Date(now).toLocaleString('sv-SE', { timeZone: 'Europe/London' }).slice(0, 10);
    const workingDay = deps.workingDay != null ? deps.workingDay : wd.isWorkingDay(new Date(`${ymd}T12:00:00`), require('./working-days').holidaySet());
    const duty = deps.duty || await require('./prepared-move').readDuty(now);
    let inMeeting = false;
    if (deps.inMeeting != null) inMeeting = deps.inMeeting;
    else { try { const l = await require('./life-state').read(new Date(now)); inMeeting = Boolean(l && l.doing === 'in-meeting'); } catch { inMeeting = false; } }
    let stopped = false;
    try { stopped = require('./authority-budget').stopState().stopped; } catch { stopped = false; }
    const g = gate({ flagOn, workingDay, duty, inMeeting, stopped });
    if (!g.run) return { ran: false, why: g.why };
    // Today's allowance used up → nothing more is prepared until tomorrow.
    let left = null;
    try { const s = (deps.authority || require('./authority-budget').status)({ now }); left = s.grant ? s.allowance.moves.left : null; } catch { left = null; }
    if (left === 0) return { ran: false, why: 'today’s prepared moves are used up' };
    // THE AUTOMATIC CAP (24 Oct 2026). The scan keeps at most ONE automatic
    // proposal whose review/work time is not yet BOOKED (store.scheduledFor:
    // a live confirm wrote the block and read it back). A proposed slot Nick
    // has not confirmed still counts; a reply or meeting prep that needs no
    // block never does. Once the block is booked the next item may be prepared,
    // even if the first is otherwise still open. Every open move is re-checked
    // and kept fresh, and never prepared twice.
    const planner = require('./prepared-move-planner');
    const store = require('./prepared-move-store');
    const live = [];
    for (const rec of (deps.active || store.activeV2)({ now, limit: 50 })) {
      let still = { ok: false };
      try { still = await planner.recheck(rec.packet, { deps: deps.planner || {} }); } catch { still = { ok: false }; }
      if (still.ok) { store.markChecked(rec.id, now); live.push(rec); }
    }
    const automatic = live.filter(isAutomatic);
    const scheduled = (r) => Boolean((deps.scheduledFor || store.scheduledFor)(r.moveKey));
    const review = automatic.filter((r) => reviewPending(r) && !scheduled(r));
    const unbooked = automatic.filter((r) => !scheduled(r));
    if (unbooked.length >= OPEN_AUTOMATIC_MAX) return { ran: true, outcome: 'open-cap', open: unbooked.map((r) => r.moveKey), withheld: 0 };
    const r = await planner.planAndStore({
      now, origin: 'scan', deps: deps.planner || {},
      skipKeys: live.map((x) => x.moveKey),
      noBlockKinds: review.length ? REVIEW_KINDS : [],
    });
    const out = { ran: true, outcome: r.outcome, moveKey: r.record ? r.record.moveKey : null, version: r.record ? r.record.version : null, withheld: (r.withheld || []).length, reviewWaiting: review.length ? review[0].moveKey : null };
    if (r.outcome === 'stored') console.log(`[PreparedMoveScan] stored ${out.moveKey} v${out.version} (${out.withheld} withheld)`);
    return out;
  } catch (e) {
    console.warn('[PreparedMoveScan] failed:', e.message);
    return { ran: false, why: e.message };
  } finally {
    running = false;
  }
}

function register({ schedule = null } = {}) {
  const sched = schedule || require('./cron-once').createCron(require('node-cron')).schedule;
  return sched(CRON, () => { scanOnce().catch(() => {}); }, { timezone: 'Europe/London' });
}

module.exports = { CRON, FLAG, OPEN_AUTOMATIC_MAX, REVIEW_KINDS, isAutomatic, reviewPending, gate, scanOnce, register };
