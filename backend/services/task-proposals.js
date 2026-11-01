'use strict';

/**
 * Proposed MoSCoW, estimate and due date for a task that is missing them
 * (1 Nov 2026).
 *
 * Nick's ask: every new task (and, once, the open ones) arrives with a
 * SUGGESTION for anything missing, which he confirms with one tap or ignores.
 *
 * ⚠⚠ A PROPOSAL IS NEVER A DECISION, AND THE STORAGE IS WHAT GUARANTEES IT.
 * Proposals live in their OWN column (`tasks.proposals_json`) and never in
 * `moscow` / `estimate_minutes` / `due_date`. Those three columns are read all
 * over the estate — time-fit, the day planner, the lane, the weekly risk
 * report, the briefing, Focus — and every one of them treats a value there as
 * Nick's. Writing a guess into them and relying on a `_proposed` flag would
 * need every reader to remember to check it; one that forgot would plan his
 * afternoon on a number nothing measured. Kept apart, a reader that knows
 * nothing about proposals sees exactly what it saw before.
 *
 * ⚠ Confirming is just SETTING the field (PATCH /api/tasks/:id). updateTask
 * drops the matching proposal whenever the real field is written or answered
 * "none" — so editing and confirming are the same act, and a proposal can
 * never sit beside a value Nick chose.
 *
 * ⚠ Three refusals, each pinned:
 *   - no estimate is INVENTED: only Nick's own finished sessions on this task or
 *     a similar one, or his own estimate for a similar task. No data → no
 *     proposal (never the 30-minute assumption — that is time-fit's job, and it
 *     says `assumed` when it does it);
 *   - a due date only when the WORDING states one behind a deadline cue
 *     (commitment-due's rule, past dates refused), or the ten-day default for a
 *     commitment — the same default a meeting commitment gets on promotion;
 *   - no due proposal on a Microsoft-linked or Jira-owned task, or a repeating
 *     one: another system, or the schedule, owns that date.
 */

const db = require('../db/database');
const todoIntelligence = require('./todo-intelligence');
const commitmentDue = require('./commitment-due');

const FIELDS = ['moscow', 'estimate', 'due'];

// The bar for "a similar task" when borrowing a duration. Deliberately the
// MEASURED internal-duplicate threshold from task-dedupe rather than a looser
// one picked here: Nick's tasks share his stock vocabulary almost completely,
// and a loose match would lend a two-day job's duration to a five-minute one.
function _similarBar() {
  try { return require('./task-dedupe').INTERNAL_MIN_SCORE; } catch { return 0.65; }
}

function parse(json) {
  if (!json) return {};
  let v = json;
  if (typeof v === 'string') {
    try { v = JSON.parse(v); } catch { return {}; }
  }
  if (!v || typeof v !== 'object') return {};
  const out = {};
  if (v.moscow && v.moscow.value) out.moscow = v.moscow;
  if (v.estimate && Number(v.estimate.minutes) > 0) out.estimate = v.estimate;
  if (v.due && /^\d{4}-\d{2}-\d{2}$/.test(String(v.due.date || ''))) out.due = v.due;
  return out;
}

function encode(proposals) {
  const p = parse(proposals);
  return Object.keys(p).length ? JSON.stringify(p) : null;
}

function median(nums) {
  const s = nums.filter(n => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function _pad(n) { return String(n).padStart(2, '0'); }
function _key(d) { return `${d.getFullYear()}-${_pad(d.getMonth() + 1)}-${_pad(d.getDate())}`; }

/**
 * PURE. What to propose for one task.
 *
 * input:  { text, taskId, moscow, moscowProposed, estimateMinutes, dueDate,
 *           origin, sourcePath, msId, jiraOwned, recurring, triageNone, now }
 * ctx:    { sessions: [{ taskId, text, actualMinutes }]   (finished focus sessions)
 *           estimates: [{ taskId, text, minutes }]         (Nick's own estimates)
 *           similar: (aText, bText) => score 0..1,
 *           similarBar, snap: (minutes) => bucketed minutes }
 */
function proposeFor(input = {}, ctx = {}) {
  const text = String(input.text || '').trim();
  const out = {};
  if (!text) return out;
  const none = Array.isArray(input.triageNone) ? input.triageNone : [];
  const now = input.now ? new Date(input.now) : new Date();
  const today = _key(now);

  // ── MoSCoW: the same classifier the list already ranks with. A proposal only
  // where nothing is stored at all — an existing proposal (the 12 Aug import's
  // moscow_proposed) is already a suggestion, and a second is noise.
  if (!input.moscow) {
    const value = todoIntelligence.triageTodo({
      text, sourcePath: input.sourcePath || null, dueDate: input.dueDate || null,
    }, today).moscow;
    if (value) out.moscow = { value, basis: 'wording', why: 'from the wording' };
  }

  // ── Estimate: only Nick's own numbers.
  if (input.estimateMinutes == null && !none.includes('estimate')) {
    const snap = ctx.snap || ((m) => m);
    const sim = ctx.similar;
    const bar = ctx.similarBar == null ? 0.65 : ctx.similarBar;
    const sessions = (ctx.sessions || []).filter(s => s && Number(s.actualMinutes) >= 1);
    const own = input.taskId != null ? sessions.filter(s => s.taskId != null && Number(s.taskId) === Number(input.taskId)) : [];
    let picked = null;
    if (own.length) {
      picked = { minutes: median(own.map(s => Number(s.actualMinutes))), basis: 'measured-this-task',
        why: `${own.length} finished focus session${own.length === 1 ? '' : 's'} on this task` };
    } else if (sim) {
      const alike = sessions.filter(s => s.text && (input.taskId == null || Number(s.taskId) !== Number(input.taskId))
        && sim(text, s.text) >= bar);
      if (alike.length) {
        picked = { minutes: median(alike.map(s => Number(s.actualMinutes))), basis: 'measured-similar',
          why: `${alike.length} finished focus session${alike.length === 1 ? '' : 's'} on a similar task` };
      } else {
        const est = (ctx.estimates || []).filter(e => e && Number(e.minutes) > 0 && e.text
          && (input.taskId == null || Number(e.taskId) !== Number(input.taskId))
          && sim(text, e.text) >= bar);
        if (est.length) {
          picked = { minutes: median(est.map(e => Number(e.minutes))), basis: 'similar-estimate',
            why: `your estimate for ${est.length === 1 ? 'a similar task' : `${est.length} similar tasks`}` };
        }
      }
    }
    if (picked && picked.minutes > 0) {
      const minutes = snap(picked.minutes);
      if (minutes) out.estimate = { minutes, basis: picked.basis, why: picked.why };
    }
  }

  // ── Due date.
  if (!input.dueDate && !none.includes('due') && !input.msId && !input.jiraOwned && !input.recurring) {
    const stated = commitmentDue.statedDue(text, now);
    if (stated && stated.date >= today) {
      out.due = { date: stated.date, basis: 'stated', why: `the task says “${stated.phrase}”` };
    } else if (input.origin === 'commitment') {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      d.setDate(d.getDate() + commitmentDue.DEFAULT_DUE_DAYS);
      out.due = { date: _key(d), basis: 'default',
        why: `a commitment with no date gets ${commitmentDue.DEFAULT_DUE_DAYS} days, as a meeting commitment does` };
    }
  }
  return out;
}

/** Finished focus sessions (whole-task durations only). */
function _sessions() {
  try {
    const rows = JSON.parse(db.getState('focus_session_history') || '[]');
    return (Array.isArray(rows) ? rows : [])
      .filter(s => s && (s.endedReason === 'completed' || s.status === 'done') && Number(s.actualMinutes) >= 1)
      .map(s => ({ taskId: s.taskId ?? null, text: s.text || '', actualMinutes: Number(s.actualMinutes) }));
  } catch { return []; }
}

function _context(rows) {
  const dedupe = require('./task-dedupe');
  const taskStore = require('./task-store');
  const all = rows || db.listTaskRows({ status: 'all' });
  const estimates = all.filter(r => r.estimate_minutes != null)
    .map(r => ({ taskId: r.id, text: r.text, minutes: r.estimate_minutes }));
  const sessions = _sessions();
  const texts = [...all.map(r => r.text), ...sessions.map(s => s.text)].filter(Boolean);
  const idf = dedupe.buildIdf(texts.map(t => dedupe.tokenize(t)));
  return {
    sessions,
    estimates,
    similarBar: _similarBar(),
    similar: (a, b) => dedupe.scorePair(dedupe.tokenize(a), dedupe.tokenize(b), idf).score,
    snap: (m) => taskStore.normEstimate(m),
  };
}

function _jiraOwned(id) {
  try { return require('./jira-tasks').isJiraOwned(id); } catch { return false; }
}

/** The proposals for a stored task row (does not write). */
function forRow(row, { ctx = null, now = new Date() } = {}) {
  if (!row || !['open', 'in-progress'].includes(row.status)) return {};
  let none = [];
  try { none = require('../../shared/task-triage.cjs').normNone(row.triage_none); } catch {}
  return proposeFor({
    text: row.text,
    taskId: row.id,
    moscow: row.moscow,
    moscowProposed: Boolean(row.moscow_proposed),
    estimateMinutes: row.estimate_minutes,
    dueDate: row.due_date,
    origin: row.origin,
    sourcePath: row.origin_path,
    msId: row.ms_id,
    jiraOwned: _jiraOwned(row.id),
    recurring: Boolean(row.recurrence_json),
    triageNone: none,
    now,
  }, ctx || _context());
}

/**
 * Store proposals for one task. Never throws — a proposal that could not be
 * worked out must never cost the create it rides on.
 */
function proposeAndStore(id, { now = new Date(), ctx = null } = {}) {
  try {
    const row = db.getTaskRow(id);
    if (!row) return null;
    const p = forRow(row, { ctx, now });
    const next = encode(p);
    if ((next || null) !== (row.proposals_json || null)) db.updateTaskRow(id, { proposals_json: next });
    return p;
  } catch (e) {
    console.warn(`[TaskProposals] Could not propose for #${id}: ${e.message}`);
    return null;
  }
}

/**
 * After a write: drop the proposal for any field that now HAS a value or was
 * answered "none". Returns the encoded JSON to store (or undefined = no change).
 */
function pruneFor(row, patch) {
  const current = parse(row.proposals_json);
  if (!Object.keys(current).length) return undefined;
  const val = (col) => (col in patch ? patch[col] : row[col]);
  let none = [];
  try { none = require('../../shared/task-triage.cjs').normNone(val('triage_none')); } catch {}
  const next = { ...current };
  if (val('moscow') && !Number(val('moscow_proposed'))) delete next.moscow;
  if ('moscow' in patch) delete next.moscow;
  if (val('estimate_minutes') != null || none.includes('estimate')) delete next.estimate;
  if (val('due_date') || none.includes('due')) delete next.due;
  const enc = encode(next);
  return enc === (row.proposals_json || null) ? undefined : enc;
}

module.exports = { FIELDS, parse, encode, proposeFor, forRow, proposeAndStore, pruneFor, _context, median };
