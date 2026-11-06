'use strict';

/**
 * Standup honesty — what Nick said he'd do, what landed, what keeps slipping,
 * what is urgent across ALL of NEURO, and how much free time today really has.
 *
 * Nick, 6 Nov 2026: "it needs to make me honest with myself about what I need
 * to achieve that day, and what I should have achieved yesterday — but in a
 * coaching/warm/adhd-friendly way". His three calls:
 *   - an ESCALATING LADDER per slipping item (light → name the pattern → no
 *     more carries: today / smaller step / hand off / drop, and what's in the way)
 *   - open on YESTERDAY, then today
 *   - SHE proposes 2–3 things sized to the free time; he edits
 *
 * ⚠ The memory is DERIVED, never a new store of slips: due-date moves come from
 * `task_triaged` activity rows (the same source promise-ledger reads), missed
 * booked time from task_blocks, carries from the daily notes. So it survives a
 * restart, a resumed session and a fresh conversation by construction. The one
 * thing that IS stored is what only Nick can say — "blocked by HR" — because
 * nothing else in NEURO knows it (`agent_state.standup_task_status`).
 *
 * The pure half (rungFor, landed, capacity) takes plain objects; `gather` is the
 * only part that reads anything.
 */

const db = require('../db/database');

const WINDOW_DAYS = 30;
const WORK_START_MIN = 9 * 60;
const WORK_END_MIN = 17 * 60 + 30;
const ASSUMED_MINUTES = 30;
const STATUS_KEY = 'standup_task_status';
// A "blocked by someone else" note pauses the ladder this long; after that she
// asks ONCE whether it is still blocked rather than assuming it for ever.
const BLOCK_RECHECK_DAYS = 7;
const MAX_SLIPS = 8;
const MAX_URGENT = 8;

function _daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400000);
}

/**
 * PURE. One task's slip facts → a rung on the ladder.
 *   0 nothing slipped · 1 first slip (note it lightly) · 2 a pattern (name it)
 *   3 no more carries (today / smaller step / hand off / drop — and what's in the way)
 * 'paused' = Nick said someone else is holding it up, said recently.
 */
function rungFor(f, today) {
  const facts = [];
  let slips = 0;
  const overdueDays = f.due && f.due < today ? _daysBetween(f.due, today) : 0;
  if (overdueDays > 0) { slips += 1; facts.push(`${overdueDays} day${overdueDays === 1 ? '' : 's'} overdue (due ${f.due})`); }
  if (f.dueMoves > 0) { slips += f.dueMoves; facts.push(`date moved ${f.dueMoves} time${f.dueMoves === 1 ? '' : 's'} in the last ${WINDOW_DAYS} days`); }
  if (f.lapsedBlocks > 0) { slips += f.lapsedBlocks; facts.push(`time booked for it ${f.lapsedBlocks} time${f.lapsedBlocks === 1 ? '' : 's'} and not used`); }
  const carries = Math.max(0, (f.daysCarried || 0) - 1);
  if (carries > 0) { slips += carries; facts.push(`carried on ${f.daysCarried} standups`); }
  let rung = slips === 0 ? 0 : Math.min(3, slips);
  // A long-overdue thing is a pattern even if it only "slipped" once.
  if (overdueDays >= 14 && rung < 2) rung = 2;

  if (f.status && f.status.kind === 'blocked') {
    const age = _daysBetween(f.status.at.slice(0, 10), today);
    if (age < BLOCK_RECHECK_DAYS) {
      return { rung: 'paused', slips, facts, overdueDays, blockedBy: f.status.note, blockedDays: age };
    }
    facts.push(`he said on ${f.status.at.slice(0, 10)} it was blocked: "${f.status.note}" — ${age} days ago, worth asking once if that is still true`);
  }
  return { rung, slips, facts, overdueDays };
}

/**
 * PURE. Yesterday's plan against what actually landed. A plan item counts as
 * landed if its box was ticked, its linked task is done, or it is in the wins
 * ledger's finished list — ticking a task in NEURO never ticks the note line,
 * so the checkbox alone would call finished work a miss.
 */
function landed(items, { taskStatus = () => null, finished = [] } = {}) {
  const fin = new Set(finished.map((s) => String(s).toLowerCase().trim()));
  const out = { planned: 0, landed: [], missed: [] };
  for (const i of items || []) {
    out.planned += 1;
    const st = i.taskId ? taskStatus(i.taskId) : null;
    const done = i.done || st === 'done' || fin.has(String(i.text).toLowerCase().trim());
    (done ? out.landed : out.missed).push({ text: i.text, taskId: i.taskId || null, dropped: st === 'dropped' });
  }
  return out;
}

function _minOf(iso) {
  const m = typeof iso === 'string' && /T(\d{2}):(\d{2})/.exec(iso);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/**
 * PURE. Free working time left today (09:00–17:30), from today's timed events.
 * Times are SLICED from the strings, never parsed — they are London wall clock.
 * `calendar: null` = the diary could not be read: unknown, never "all free".
 */
function capacity(calendar, nowMin) {
  if (!Array.isArray(calendar)) return { known: false };
  const busy = calendar
    .map((e) => ({ s: _minOf(e.start), e: _minOf(e.end) }))
    .filter((b) => b.s != null && b.e != null && b.e > b.s)
    .sort((a, b) => a.s - b.s);
  let cursor = Math.max(WORK_START_MIN, Math.ceil(nowMin / 5) * 5);
  const gaps = [];
  for (const b of busy) {
    if (b.e <= cursor) continue;
    if (b.s > cursor) { const end = Math.min(b.s, WORK_END_MIN); if (end - cursor >= 15) gaps.push([cursor, end]); }
    cursor = Math.max(cursor, b.e);
    if (cursor >= WORK_END_MIN) break;
  }
  if (WORK_END_MIN - cursor >= 15) gaps.push([cursor, WORK_END_MIN]);
  const hm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const freeMinutes = gaps.reduce((n, [a, b]) => n + (b - a), 0);
  const meetingMinutes = busy.reduce((n, b) => n + Math.max(0, Math.min(b.e, WORK_END_MIN) - Math.max(b.s, WORK_START_MIN)), 0);
  return { known: true, freeMinutes, meetingMinutes, gaps: gaps.map(([a, b]) => `${hm(a)}-${hm(b)}`) };
}

// ── Nick's own word on a task ("blocked by HR") ──────────────────────────────

function readStatuses() {
  try { return JSON.parse(db.getState(STATUS_KEY) || '{}') || {}; } catch { return {}; }
}

function setStatus(taskId, kind, note, now = new Date()) {
  const id = Number(taskId);
  if (!Number.isInteger(id) || id <= 0) return { ok: false, error: 'task_id is required' };
  if (!['blocked', 'clear'].includes(kind)) return { ok: false, error: 'status must be blocked or clear' };
  const all = readStatuses();
  if (kind === 'clear') delete all[id];
  else {
    const text = String(note || '').trim().slice(0, 200);
    if (!text) return { ok: false, error: 'note is required — what is it waiting on?' };
    all[id] = { kind, note: text, at: now.toISOString() };
  }
  db.setState(STATUS_KEY, JSON.stringify(all));
  return { ok: true, taskId: id, status: kind };
}

// ── Gathering (the only part that reads) ────────────────────────────────────

/**
 * PURE. Was this date move Nick's? ⚠ NEURO's own timers (day planner, leave
 * guard, auto-schedule passes) move dates too, and counting those as his slips
 * is exactly the dishonesty this exists to avoid — measured on #358, 12 moves in
 * 30 days, several at 07:15:00 / 06:15:01 on the dot.
 *   by 'nick'        → his (from his own screens)
 *   by 'machine:…'   → his (a machine client acts on his instruction — Sara, MCP)
 *   by null          → NEURO's own service: not his
 *   no `by` at all   → logged before 6 Nov 2026: his unless it landed on a whole
 *                      minute (:00/:01), which is a timer's signature, not a person's
 */
function isNickMove(d, createdAt) {
  if (!d || typeof d !== 'object') return false;
  if ('by' in d) return d.by === 'nick' || (typeof d.by === 'string' && d.by.startsWith('machine:'));
  const sec = String(createdAt || '').slice(17, 19);
  return sec !== '00' && sec !== '01';
}

function _plannerBlockIds() {
  try {
    const all = JSON.parse(db.getState('day_planner_ledger') || '{}') || {};
    return new Set(Object.values(all).flatMap((e) => (e && Array.isArray(e.blockIds) ? e.blockIds : [])).map(Number));
  } catch { return new Set(); }
}

function _moveCounts(sinceIso) {
  const moves = new Map();
  for (const a of db.all(`SELECT event_data, created_at FROM activity_log WHERE event_type = 'task_triaged' AND event_data LIKE '%due_date%' AND created_at >= ?`, [sinceIso])) {
    let d; try { d = JSON.parse(a.event_data); } catch { continue; }
    if (!d || !Array.isArray(d.fields) || !d.fields.includes('due_date') || d.reason === 'recommit') continue;
    if (!isNickMove(d, a.created_at)) continue;
    const id = Number(d.taskId);
    moves.set(id, (moves.get(id) || 0) + 1);
  }
  return moves;
}

function _lapsedCounts(sinceDate) {
  // Time the day planner booked on its own is not time Nick chose and skipped.
  const planner = _plannerBlockIds();
  const out = new Map();
  for (const b of db.all(`SELECT bi.task_id, b.id AS block_id FROM task_block_items bi JOIN task_blocks b ON b.id = bi.block_id
                          WHERE b.status IN ('released','dropped') AND b.date_key >= ?`, [sinceDate])) {
    if (planner.has(Number(b.block_id))) continue;
    out.set(b.task_id, (out.get(b.task_id) || 0) + 1);
  }
  return out;
}

function gather({ today, now = new Date(), accountability = null, calendar = null, finished = [] } = {}) {
  const gaps = [];
  const since = new Date(now.getTime() - WINDOW_DAYS * 86400000);
  const sinceIso = since.toISOString().replace('T', ' ').slice(0, 19);
  const sinceDate = since.toISOString().slice(0, 10);
  const taskStore = require('./task-store');

  // Slips.
  let slipping = [];
  try {
    const moves = (() => { try { return _moveCounts(sinceIso); } catch (e) { gaps.push(`date moves: ${e.message}`); return new Map(); } })();
    const lapsed = (() => { try { return _lapsedCounts(sinceDate); } catch (e) { gaps.push(`booked time: ${e.message}`); return new Map(); } })();
    const carried = new Map();
    for (const c of accountability?.openCommitments || []) {
      const id = c.task?.id || c.taskId;
      if (id) carried.set(Number(id), Math.max(carried.get(Number(id)) || 0, c.daysCarried || 0));
    }
    const statuses = readStatuses();
    for (const t of taskStore.activeTodos()) {
      if (!t.task_id || t.done || t.myPartDone) continue;
      const due = t.due_date ? String(t.due_date).slice(0, 10) : null;
      const r = rungFor({
        due, dueMoves: moves.get(t.task_id) || 0, lapsedBlocks: lapsed.get(t.task_id) || 0,
        daysCarried: carried.get(t.task_id) || 0, status: statuses[t.task_id] || null,
      }, today);
      if (r.rung === 0) continue;
      slipping.push({ id: t.task_id, text: t.text, ...r });
    }
    const order = (x) => (x.rung === 'paused' ? -1 : x.rung);
    slipping.sort((a, b) => order(b) - order(a) || b.slips - a.slips || b.overdueDays - a.overdueDays);
    slipping = slipping.slice(0, MAX_SLIPS);
  } catch (e) { gaps.push(`slipping tasks: ${e.message}`); }

  // Yesterday.
  let yesterday = null;
  const y = accountability?.yesterday;
  if (y?.items?.length) {
    const status = (id) => { try { return taskStore.getTask(id)?.status || null; } catch { return null; } };
    yesterday = { date: y.date, ...landed(y.items, { taskStatus: status, finished }) };
  }

  // Urgent across NEURO.
  let urgent = [];
  try {
    const ns = require('./next-steps').read({ now: now.getTime() });
    urgent = ns.items.filter((i) => i.group === 'now' || i.group === 'today')
      .map((i) => ({ title: i.title, why: i.why || null, group: i.group, kind: i.kind, minutes: i.minutes || null,
        taskId: /^task:\d+$/.test(i.id) ? Number(i.id.slice(5)) : null }));
    for (const g of ns.gaps || []) gaps.push(`next steps — ${g}`);
  } catch (e) { gaps.push(`next steps: ${e.message}`); }
  try {
    for (const c of require('./watched-tickets').nowCards(now.getTime())) {
      urgent.unshift({ title: c.title, why: c.reason, group: 'now', kind: 'ticket-promise', minutes: null, taskId: null });
    }
  } catch (e) { gaps.push(`ticket promises: ${e.message}`); }
  // At most three of any one kind: eight emails is an inbox, not a standup —
  // the report owed, the promise to a customer and the slipping task get crowded out.
  const perKind = new Map();
  urgent = urgent.filter((u) => { const n = (perKind.get(u.kind) || 0) + 1; perKind.set(u.kind, n); return n <= 3; })
    .slice(0, MAX_URGENT);

  const nowMin = now.getHours() * 60 + now.getMinutes();
  return { slipping, yesterday, urgent, capacity: capacity(calendar, nowMin), gaps };
}

/** Render for the standup context. */
function render(h) {
  if (!h) return '';
  const p = [];
  if (h.yesterday) {
    const y = h.yesterday;
    p.push(`\nYESTERDAY'S PLAN vs WHAT LANDED (${y.date}): planned ${y.planned}, landed ${y.landed.length}.`);
    for (const m of y.missed) p.push(`  missed: ${m.text}${m.taskId ? ` [task #${m.taskId}]` : ''}${m.dropped ? ' (since dropped)' : ''}`);
    for (const l of y.landed.slice(0, 4)) p.push(`  landed: ${l.text}`);
  } else {
    p.push('\nYESTERDAY\'S PLAN: no plan was recorded for the last working day — say so, do not invent one.');
  }
  if (h.urgent.length) {
    p.push('\nURGENT ACROSS NEURO (Next steps, in its order — these outrank an old MUST task):');
    for (const u of h.urgent) p.push(`  - ${u.taskId ? `#${u.taskId} ` : ''}${u.title}${u.why ? ` — ${u.why}` : ''}`);
  }
  if (h.slipping.length) {
    p.push('\nSLIPPING (the ladder — see the rules for what each rung means):');
    for (const s of h.slipping) {
      if (s.rung === 'paused') p.push(`  - #${s.id} ${s.text} — PAUSED: he said it is blocked ("${s.blockedBy}", ${s.blockedDays}d ago). Do not chase it.`);
      else p.push(`  - #${s.id} ${s.text} — RUNG ${s.rung}: ${s.facts.join('; ')}`);
    }
  }
  const c = h.capacity;
  if (c.known) {
    p.push(`\nFREE TIME LEFT TODAY (09:00-17:30): ${Math.floor(c.freeMinutes / 60)}h${String(c.freeMinutes % 60).padStart(2, '0')} in ${c.gaps.join(', ') || 'no gaps'}; ${Math.round(c.meetingMinutes / 6) / 10}h of meetings. A task with no estimate counts as ${ASSUMED_MINUTES} min — say it is an assumption.`);
  } else {
    p.push('\nFREE TIME TODAY: the diary could not be read. Do not size the day — say you cannot see the diary.');
  }
  if (h.gaps.length) p.push(`(Could not read: ${h.gaps.join('; ')} — do not treat those as empty.)`);
  return p.join('\n');
}

module.exports = { isNickMove, rungFor, landed, capacity, gather, render, readStatuses, setStatus, STATUS_KEY, ASSUMED_MINUTES };
