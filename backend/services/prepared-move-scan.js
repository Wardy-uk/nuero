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
 * CADENCE: every 30 minutes, 08:00–17:30, Monday–Friday, Europe/London — and
 * then only on a working day (bank holidays and leave skip), on duty, outside
 * a meeting, with SAiM's actions not stopped and the switch
 * `saim_prepared_move_scan` on.
 */

const CRON = '*/30 8-17 * * 1-5';
const FLAG = 'saim_prepared_move_scan';

let running = false;

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
    const r = await require('./prepared-move-planner').planAndStore({ now, origin: 'scan', deps: deps.planner || {} });
    const out = { ran: true, outcome: r.outcome, moveKey: r.record ? r.record.moveKey : null, version: r.record ? r.record.version : null, withheld: (r.withheld || []).length };
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

module.exports = { CRON, FLAG, gate, scanOnce, register };
