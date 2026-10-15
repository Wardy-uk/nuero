'use strict';

/**
 * Goal measures and goal insights (13 Oct 2026).
 *
 * A goal already had a TYPE: its life domain (Fitness & hiking, Health,
 * Leisure, Personal projects…), declared by Nick. What it lacked was a way for
 * NEURO to say whether it is moving. A MEASURE is the one thing a goal is
 * measured by, chosen by Nick from a CLOSED catalogue — every kind has a reader
 * NEURO already holds, so nothing here is a new source:
 *
 *   hikes       confirmed hikes per week or month   hiking-loop (GPS track or you)
 *   bp          home blood-pressure average          health_daily (HiLo)
 *   weight      weight in kg                         health_daily (scales)
 *   steps       average daily steps, last 7 days     health_daily (Watch)
 *   exercise    exercise minutes, last 7 days        health_daily (Watch)
 *   sleep       average sleep, last 7 nights         health_daily (Watch)
 *   resting-hr  resting heart rate, 14-day median    health_daily (Watch)
 *   caffeine    mg per day, 7 logged days            nutrition (MyFitnessPal via Apple Health)
 *   alcohol     UK units per week                    drinks (named items from Foodnoms via Apple Health)
 *   project     a personal project reaching done     projects (vault + GitHub)
 *
 * No measure = the goal is judged by explicitly linked items, as before
 * (future-radar.goalProgress). NEURO never picks a measure for a goal.
 *
 * ── The rules ───────────────────────────────────────────────────────────────
 *  • A missing reading is UNKNOWN, never zero and never "behind".
 *  • A baseline is the value around when the goal started, from the same
 *    reader — so "moving" is measured against Nick's own starting point.
 *  • With a `by` date, pace is a straight line from baseline to target. Without
 *    one, NEURO only says which way it is moving — it never invents a deadline.
 *  • LEVERS are other things NEURO can see that bear on the goal (salt and
 *    weight for blood pressure; the forecast for a hike). Each is an existing
 *    insight, quoted, with its own source. A lever says "this bears on it",
 *    never "this caused it" — nothing here diagnoses.
 *  • Nothing here notifies, creates a task or changes a goal.
 *
 * `evaluate` and `leversFor` are PURE. `read` gathers inputs and never throws.
 */

const PERIODS = Object.freeze(['week', 'month']);

const MEASURES = Object.freeze({
  hikes: { kind: 'hikes', label: 'Hikes', unit: 'hikes', direction: 'up', domain: 'fitness', target: 'count', periods: PERIODS,
    source: 'Hiking loop — a GPS-tracked hike or your confirmation', levers: ['recovery'] },
  bp: { kind: 'bp', label: 'Blood pressure', unit: 'mmHg', direction: 'down', domain: 'health', target: 'pair',
    source: 'HiLo via Apple Health — 14-day home average', levers: ['bp', 'weight', 'nutrition', 'activity', 'sleep', 'heart'] },
  weight: { kind: 'weight', label: 'Weight', unit: 'kg', direction: 'auto', domain: 'health', target: 'number', min: 30, max: 300,
    source: 'Scales via Apple Health — 7-day average', levers: ['weight', 'nutrition', 'activity'] },
  steps: { kind: 'steps', label: 'Daily steps', unit: 'steps/day', direction: 'up', domain: 'fitness', target: 'number', min: 500, max: 50000,
    source: 'Apple Watch — average of the last 7 full days', levers: ['activity', 'recovery', 'daylight'] },
  exercise: { kind: 'exercise', label: 'Exercise minutes', unit: 'min/week', direction: 'up', domain: 'fitness', target: 'number', min: 10, max: 2000,
    source: 'Apple Watch — exercise minutes over the last 7 full days', levers: ['activity', 'recovery'] },
  sleep: { kind: 'sleep', label: 'Sleep', unit: 'h/night', direction: 'up', domain: 'health', target: 'number', min: 4, max: 11,
    source: 'Apple Watch — average of the last 7 nights', levers: ['sleep', 'daylight', 'recovery'] },
  'resting-hr': { kind: 'resting-hr', label: 'Resting heart rate', unit: 'bpm', direction: 'down', domain: 'health', target: 'number', min: 35, max: 110,
    source: 'Apple Watch — 14-day median', levers: ['heart', 'fitness', 'sleep', 'activity', 'recovery'] },
  // 13 Oct 2026. MFP writes Apple Health's caffeine nutrient per food, so this
  // is a SUM, not an inference. Only logged days count — an unlogged day is
  // unknown, never zero — and a drink whose MFP entry lacks caffeine adds 0, so
  // the figure is a floor. NHS: up to 400 mg a day for most adults.
  caffeine: { kind: 'caffeine', label: 'Caffeine', unit: 'mg/day', direction: 'down', domain: 'health', target: 'number', min: 0, max: 2000,
    source: 'MyFitnessPal via Apple Health — average over the last 7 logged days (a floor: a drink logged without caffeine adds 0)', levers: ['sleep'] },
  // 13 Oct 2026. Units by the drink's NAME (strength) and its own water (volume),
  // with its calories as a cross-check — services/drinks.js. Only drinks logged
  // in an app that sends names (Foodnoms); MyFitnessPal sends none.
  alcohol: { kind: 'alcohol', label: 'Alcohol', unit: 'units/week', direction: 'down', domain: 'health', target: 'number', min: 0, max: 100,
    source: 'Drinks you log in Foodnoms, via Apple Health — strength from the drink’s name, volume from its own figures, the calories as a check. A day with food logged and no drink counts as none.', levers: ['sleep', 'bp'] },
  project: { kind: 'project', label: 'Finish a personal project', unit: null, direction: 'up', domain: 'projects', target: 'project',
    source: 'Personal projects — the hub note, linked tasks and GitHub progress', levers: [] },
});

const KINDS = Object.freeze(Object.keys(MEASURES));
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

// How much movement counts as movement (below this it is "holding steady").
const NOISE = { bp: 2, weight: 0.5, steps: 300, exercise: 15, sleep: 0.15, 'resting-hr': 1, caffeine: 20, alcohol: 1 };
// A project with no meaningful progress for this long has gone quiet.
const PROJECT_QUIET_DAYS = 21;

// ── validation (pure) ───────────────────────────────────────────────────────

/**
 * Validate a measure Nick chose. Refuses, never clamps or guesses: a typo must
 * not turn into a different target. `null` is "not measured" and is valid.
 * Returns { ok, measure } or { ok:false, error }.
 */
function validateMeasure(m) {
  if (m === null) return { ok: true, measure: null };
  if (!m || typeof m !== 'object' || Array.isArray(m)) return { ok: false, error: 'measure must be an object or null' };
  const def = MEASURES[m.kind];
  if (!def) return { ok: false, error: `measure kind must be one of ${KINDS.join(', ')}` };
  const out = { kind: def.kind };
  if (def.target === 'count') {
    const n = Number(m.target);
    if (!Number.isInteger(n) || n < 1 || n > 31) return { ok: false, error: 'hikes target must be a whole number from 1 to 31' };
    if (!PERIODS.includes(m.period)) return { ok: false, error: `period must be ${PERIODS.join(' or ')}` };
    out.target = n; out.period = m.period;
  } else if (def.target === 'pair') {
    const sys = Number(m.target && m.target.sys); const dia = Number(m.target && m.target.dia);
    if (!Number.isFinite(sys) || !Number.isFinite(dia) || sys < 80 || sys > 200 || dia < 40 || dia > 130 || dia >= sys) {
      return { ok: false, error: 'blood-pressure target must be systolic 80–200 over diastolic 40–130, systolic higher' };
    }
    out.target = { sys: Math.round(sys), dia: Math.round(dia) };
  } else if (def.target === 'number') {
    const n = Number(m.target);
    if (!Number.isFinite(n) || n < def.min || n > def.max) return { ok: false, error: `${def.label} target must be between ${def.min} and ${def.max}` };
    out.target = n;
  } else if (def.target === 'project') {
    if (typeof m.projectId !== 'string' || !m.projectId.trim()) return { ok: false, error: 'a project measure needs projectId' };
    out.projectId = m.projectId.trim().slice(0, 200);
  }
  if (m.by !== undefined && m.by !== null) {
    if (!DATE_ONLY.test(String(m.by))) return { ok: false, error: 'by must be YYYY-MM-DD' };
    out.by = String(m.by);
  }
  return { ok: true, measure: out };
}

// ── small helpers (pure) ────────────────────────────────────────────────────

const round = (n, dp = 0) => (Number.isFinite(n) ? Math.round(n * 10 ** dp) / 10 ** dp : null);
const mean = (xs) => { const v = xs.filter(Number.isFinite); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
const median = (xs) => {
  const v = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};
function shiftDay(key, n) {
  const [y, mo, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1, d + n)).toISOString().slice(0, 10);
}
function daysBetween(a, b) {
  if (!DATE_ONLY.test(String(a)) || !DATE_ONLY.test(String(b))) return null;
  const [ya, ma, da] = a.split('-').map(Number); const [yb, mb, db] = b.split('-').map(Number);
  return Math.round((Date.UTC(yb, mb - 1, db) - Date.UTC(ya, ma - 1, da)) / 86400000);
}
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function dayWords(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key));
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]}` : String(key);
}
function weekdayOf(key) {
  const [y, mo, d] = key.split('-').map(Number);
  return ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][new Date(Date.UTC(y, mo - 1, d)).getUTCDay()];
}

/**
 * Values of one health_daily field over complete days in [endKey - span, endKey).
 * Input is newest-first, as health-daily.recentDays returns it.
 */
function windowValues(days, field, endKey, span) {
  const lo = shiftDay(endKey, -span);
  return (days || []).filter((d) => d && d.complete && d.day >= lo && d.day < endKey && Number.isFinite(d[field])).map((d) => d[field]);
}

// What each health kind reads, and how. `minDays` is how many days must carry
// a reading before a number is trusted — fewer is unknown, said with the count.
const HEALTH_READ = {
  bp: { span: 14, minDays: 4 },
  weight: { field: 'weightKg', span: 7, how: 'mean', minDays: 1, dp: 1 },
  steps: { field: 'steps', span: 7, how: 'mean', minDays: 5, dp: 0 },
  exercise: { field: 'exerciseMinutes', span: 7, how: 'sum', minDays: 5, dp: 0 },
  sleep: { field: 'asleepHours', span: 7, how: 'mean', minDays: 4, dp: 1 },
  'resting-hr': { field: 'rhrMedian', span: 14, how: 'median', minDays: 5, dp: 0 },
  // Rows from `nutritionDays` (logged days only), not health_daily.
  caffeine: { field: 'caffeineMg', span: 7, how: 'mean', minDays: 3, dp: 0 },
  // Rows from drinks.dailyUnits. A week is the SUM, scaled up from the logged days.
  alcohol: { field: 'alcoholUnits', span: 7, how: 'sum', minDays: 4, dp: 1 },
};

/**
 * Nutrition days as health-style rows. PURE. Only LOGGED, finished days — an
 * unlogged day is absent (unknown), never a day of 0 mg; today is still being
 * logged, so it waits until tomorrow like every other measure.
 */
function nutritionDays(nutrition) {
  if (!nutrition || !Array.isArray(nutrition.days)) return null;
  return nutrition.days.filter((d) => d && d.logged && !d.today)
    .map((d) => ({ day: d.day, complete: true, caffeineMg: Number.isFinite(d.totals && d.totals.dietary_caffeine) ? d.totals.dietary_caffeine : null }));
}

/** One health reading at `endKey` (exclusive). PURE. { value, n } or { value:null, n, why }. */
function healthValue(kind, days, endKey) {
  const r = HEALTH_READ[kind];
  if (kind === 'bp') {
    const lo = shiftDay(endKey, -r.span);
    const rows = (days || []).filter((d) => d && d.complete && d.day >= lo && d.day < endKey
      && Number.isFinite(d.bpSystolic) && Number.isFinite(d.bpDiastolic));
    if (rows.length < r.minDays) return { value: null, n: rows.length, why: `${rows.length} day${rows.length === 1 ? '' : 's'} with a reading in the ${r.span} days — not enough for an average` };
    return { value: { sys: round(mean(rows.map((d) => d.bpSystolic))), dia: round(mean(rows.map((d) => d.bpDiastolic))) }, n: rows.length };
  }
  const vals = windowValues(days, r.field, endKey, r.span);
  if (vals.length < r.minDays) return { value: null, n: vals.length, why: `${vals.length} day${vals.length === 1 ? '' : 's'} with a reading in the ${r.span} days` };
  const v = r.how === 'sum' ? vals.reduce((a, b) => a + b, 0) * (7 / Math.max(vals.length, 1)) // scale a partly-covered week to 7 days
    : r.how === 'median' ? median(vals) : mean(vals);
  return { value: round(v, r.dp), n: vals.length };
}

// ── evaluation (pure) ───────────────────────────────────────────────────────

const fmt = (kind, v) => {
  if (v === null || v === undefined) return '—';
  if (kind === 'bp') return `${v.sys}/${v.dia}`;
  const def = MEASURES[kind];
  if (kind === 'steps') return `${Math.round(v).toLocaleString('en-GB')}`;
  return `${v}${def.unit === 'kg' ? 'kg' : def.unit === 'bpm' ? ' bpm' : def.unit === 'h/night' ? 'h' : def.unit === 'min/week' ? ' min' : def.unit === 'mg/day' ? ' mg/day' : def.unit === 'units/week' ? ' units/week' : ''}`;
};

/** A scalar for distance-to-target. BP uses systolic and diastolic, whichever is further off. */
function gapTo(kind, v, target, dir) {
  if (kind === 'bp') {
    const s = v.sys - target.sys; const d = v.dia - target.dia;
    return Math.max(s, d); // >0 = still above target (bad, direction down)
  }
  return dir === 'down' ? v - target : target - v; // >0 = not there yet
}

/**
 * Judge a health-type measure. PURE.
 *   current, baseline  healthValue results
 *   today, start       YYYY-MM-DD (start = when the goal started)
 * Returns { state, line, ... }. States: met | on-track | behind | not-moving | moving-away | unknown.
 */
function judgeHealth(kind, measure, { current, baseline, today, start }) {
  const def = MEASURES[kind];
  const target = measure.target;
  const out = { kind, label: def.label, unit: def.unit, source: def.source, target, targetText: fmt(kind, target),
    current: current.value, currentText: fmt(kind, current.value), baseline: baseline ? baseline.value : null,
    baselineText: baseline && baseline.value !== null ? fmt(kind, baseline.value) : null, baselineFrom: start, by: measure.by || null };
  if (current.value === null) return { ...out, state: 'unknown', line: `No current number — ${current.why}.` };
  const dir = def.direction === 'auto'
    ? (baseline && baseline.value !== null ? (target < baseline.value ? 'down' : 'up') : (target < current.value ? 'down' : 'up'))
    : def.direction;
  out.direction = dir;
  const gapNow = gapTo(kind, current.value, target, dir);
  if (gapNow <= 0) return { ...out, state: 'met', line: `At target: ${fmt(kind, current.value)} against ${fmt(kind, target)}.` };
  const noise = NOISE[kind] || 0;
  const remaining = `${kind === 'bp' ? `${round(gapNow)} mmHg` : fmt(kind, round(Math.abs(gapNow), HEALTH_READ[kind].dp))} to go`;
  if (!baseline || baseline.value === null) {
    return { ...out, state: 'unknown', line: `${fmt(kind, current.value)} now, ${remaining}. No reading from when the goal started to compare with, so NEURO can't yet say which way it's moving.` };
  }
  const gapStart = gapTo(kind, baseline.value, target, dir);
  const moved = gapStart - gapNow; // >0 = closer
  out.moved = round(moved, 1);
  // Pace, only when Nick gave a date.
  if (measure.by && start) {
    const total = daysBetween(start, measure.by);
    const gone = daysBetween(start, today);
    if (total > 0 && gone !== null) {
      const frac = Math.min(1, Math.max(0, gone / total));
      const expectedGap = gapStart * (1 - frac);
      const left = daysBetween(today, measure.by);
      out.pace = { expectedText: kind === 'bp' ? null : fmt(kind, round(dir === 'down' ? target + expectedGap : target - expectedGap, HEALTH_READ[kind].dp)), daysLeft: left };
      if (left !== null && left < 0) return { ...out, state: 'behind', line: `The date you set (${dayWords(measure.by)}) has passed: ${fmt(kind, current.value)} against ${fmt(kind, target)}.` };
      if (gapNow <= expectedGap + noise) return { ...out, state: 'on-track', line: `${fmt(kind, current.value)} now, from ${fmt(kind, baseline.value)} — on pace for ${fmt(kind, target)} by ${dayWords(measure.by)}.` };
      return { ...out, state: 'behind', line: `${fmt(kind, current.value)} now, from ${fmt(kind, baseline.value)} — behind the pace for ${fmt(kind, target)} by ${dayWords(measure.by)}; ${remaining}.` };
    }
  }
  if (moved > noise) return { ...out, state: 'on-track', line: `Moving the right way: ${fmt(kind, baseline.value)} → ${fmt(kind, current.value)}, ${remaining}.` };
  if (moved < -noise) return { ...out, state: 'moving-away', line: `Moving the wrong way: ${fmt(kind, baseline.value)} → ${fmt(kind, current.value)}, target ${fmt(kind, target)}.` };
  return { ...out, state: 'not-moving', line: `Holding at ${fmt(kind, current.value)} (was ${fmt(kind, baseline.value)}); ${remaining}.` };
}

/**
 * Judge a hikes measure. PURE.
 *   hiking  hiking-loop read (weeks newest-first, each { start, confirmed:[{day}] }) or null
 */
function judgeHikes(measure, { hiking, today }) {
  const def = MEASURES.hikes;
  const base = { kind: 'hikes', label: def.label, unit: def.unit, source: def.source, target: measure.target, period: measure.period,
    targetText: `${measure.target} a ${measure.period}`, by: measure.by || null };
  if (!hiking || !hiking.active) return { ...base, state: 'unknown', current: null, line: 'The hiking loop could not be read, so NEURO can’t count hikes.' };
  const days = [...new Set((hiking.weeks || []).flatMap((w) => (w.confirmed || []).map((c) => c.day)))].sort();
  let count; let elapsed; let length; let periodWord;
  if (measure.period === 'week') {
    const ws = hiking.weekStart || (hiking.current && hiking.current.start);
    count = days.filter((d) => d >= ws && d <= today).length;
    elapsed = (daysBetween(ws, today) ?? 0) + 1; length = 7; periodWord = 'this week';
  } else {
    const ms = `${today.slice(0, 8)}01`;
    const [y, mo] = today.split('-').map(Number);
    length = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    count = days.filter((d) => d >= ms && d <= today).length;
    elapsed = Number(today.slice(8, 10)); periodWord = `this month (${MONTHS[mo - 1]})`;
  }
  const left = length - elapsed;
  const out = { ...base, current: count, currentText: `${count} ${periodWord}`, daysLeft: left,
    reliability: hiking.reliability || null, lastConfirmed: hiking.lastConfirmed || null };
  const unreliable = hiking.reliability && hiking.reliability.level === 'unreliable'
    ? ' Hikes only count when recorded with a GPS-tracked workout or confirmed by you, so a real hike can be missing.' : '';
  if (count >= measure.target) return { ...out, state: 'met', line: `${count} of ${measure.target} ${periodWord} — done.` };
  const expected = Math.floor(measure.target * (elapsed / length));
  const need = measure.target - count;
  if (need > left) return { ...out, state: 'behind', line: `${count} of ${measure.target} ${periodWord}, ${need} still to do and ${left} day${left === 1 ? '' : 's'} left — it can’t be met now.${unreliable}` };
  if (count >= expected) return { ...out, state: 'on-track', line: `${count} of ${measure.target} ${periodWord}, ${left} day${left === 1 ? '' : 's'} left.${unreliable}` };
  return { ...out, state: 'behind', line: `${count} of ${measure.target} ${periodWord}, ${need} still to do in ${left} day${left === 1 ? '' : 's'}.${unreliable}` };
}

/**
 * Judge a project measure. PURE.
 *   project  one project from projects.read().projects, or null
 */
function judgeProject(measure, { project, today }) {
  const def = MEASURES.project;
  const base = { kind: 'project', label: def.label, unit: null, source: def.source, projectId: measure.projectId, by: measure.by || null };
  if (!project) return { ...base, state: 'unknown', line: 'That project is no longer one NEURO can see — the hub note may have moved.' };
  const name = project.displayTitle || project.name;
  const status = project.status && project.status.status;
  const lastAt = project.lastProgress && project.lastProgress.at ? String(project.lastProgress.at).slice(0, 10) : null;
  const quiet = lastAt ? daysBetween(lastAt, today) : null;
  const open = project.tasks && Array.isArray(project.tasks.open) ? project.tasks.open.length : 0;
  const out = { ...base, projectName: name, projectStatus: status || null, lastProgressAt: lastAt, quietDays: quiet, openTasks: open,
    nextAction: project.nextAction || null, blockers: (project.blockers || []).map((b) => b.what).slice(0, 3),
    currentText: status || 'unknown', targetText: 'completed' };
  if (status === 'completed') return { ...out, state: 'met', line: `${name} is marked completed.` };
  if (status === 'abandoned') return { ...out, state: 'behind', line: `${name} is marked abandoned.` };
  if (status === 'parked' || status === 'paused') return { ...out, state: 'not-moving', line: `${name} is ${status}.` };
  const toBy = measure.by ? daysBetween(today, measure.by) : null;
  const byLine = toBy === null ? '' : toBy < 0 ? ` The date you set (${dayWords(measure.by)}) has passed.` : ` ${toBy} days to ${dayWords(measure.by)}.`;
  if (out.blockers.length) return { ...out, state: 'behind', line: `${name} is blocked: ${out.blockers[0]}.${byLine}` };
  if (quiet === null) return { ...out, state: 'not-moving', line: `No progress on ${name} that NEURO can see yet — ${open} open linked task${open === 1 ? '' : 's'}.${byLine}` };
  if (quiet > PROJECT_QUIET_DAYS) return { ...out, state: 'not-moving', line: `Last progress on ${name} was ${quiet} days ago (${dayWords(lastAt)}).${byLine}` };
  if (toBy !== null && toBy < 0) return { ...out, state: 'behind', line: `${name} is still open.${byLine}` };
  return { ...out, state: 'on-track', line: `Progress on ${name} ${quiet === 0 ? 'today' : `${quiet} day${quiet === 1 ? '' : 's'} ago`}; ${open} open linked task${open === 1 ? '' : 's'}.${byLine}` };
}

/** Evaluate one goal's measure against the gathered inputs. PURE. */
function evaluate(goal, inputs) {
  const m = goal.measure;
  if (!m) return null;
  const today = inputs.today;
  const start = goal.startDate || (goal.createdAt ? String(goal.createdAt).slice(0, 10) : null);
  if (m.kind === 'hikes') return judgeHikes(m, { hiking: inputs.hiking, today });
  if (m.kind === 'project') return judgeProject(m, { project: (inputs.projects || []).find((p) => p.projectId === m.projectId) || null, today });
  const days = m.kind === 'caffeine' ? inputs.nutritionDays : m.kind === 'alcohol' ? inputs.alcoholDays : inputs.days;
  if (!days) return { kind: m.kind, label: MEASURES[m.kind].label, state: 'unknown', line: m.kind === 'caffeine' || m.kind === 'alcohol' ? 'Food logs could not be read.' : 'Health data could not be read.' };
  const current = healthValue(m.kind, days, today); // the last full days — today is still accruing
  // Baseline: the window ending the day after the goal started — so a goal set
  // today has a baseline equal to "now", and movement is measured from there on.
  const baseline = start && start < today ? healthValue(m.kind, days, shiftDay(start, 1)) : null;
  return judgeHealth(m.kind, m, { current, baseline, today, start });
}

// ── levers (pure) ───────────────────────────────────────────────────────────

/**
 * What else NEURO can see that bears on this goal, with a concrete action each.
 * Health levers are health-picture insights QUOTED (one judgement, not two);
 * `good` insights are dropped — a lever is something to do.
 */
function leversFor(goal, progress, { picture = null, outdoor = null, today } = {}) {
  const m = goal.measure;
  if (!m) return [];
  const def = MEASURES[m.kind];
  const out = [];
  if (picture && Array.isArray(picture.insights)) {
    for (const ins of picture.insights) {
      if (!def.levers.includes(ins.domain) || ins.level === 'good' || !ins.action) continue;
      out.push({ id: ins.id, level: ins.level, title: ins.title, finding: ins.finding || null, action: ins.action,
        basis: ins.basis || null, source: 'My Health', view: ins.view || 'my-health' });
    }
  }
  if (m.kind === 'hikes' && progress && progress.state !== 'met') {
    const good = (outdoor && outdoor.days || []).filter((d) => d.state === 'favourable' && d.day >= today);
    const planned = (outdoor && outdoor.plans) || [];
    if (planned.length) {
      out.push({ id: 'hike-planned', level: 'watch', title: `Hike planned for ${weekdayOf(planned[0].day)} ${dayWords(planned[0].day)}`,
        finding: null, action: 'Record it as a Hiking workout on the Watch so it counts.', source: 'Hiking loop', view: 'outdoor' });
    } else if (good.length) {
      out.push({ id: 'hike-weather', level: 'watch', title: `Forecast looks good on ${good.slice(0, 2).map((d) => weekdayOf(d.day)).join(' and ')}`,
        finding: good[0].line || null, action: `Put a hike in the diary for ${weekdayOf(good[0].day)} — a calendar entry titled “hike” counts as a plan.`, source: 'Forecast', view: 'outdoor' });
    } else if (outdoor && (outdoor.days || []).length) {
      out.push({ id: 'hike-no-weather', level: 'watch', title: 'No clearly good hiking day in the next few days', finding: null,
        action: 'Pick the least-bad day and plan a shorter route.', source: 'Forecast', view: 'outdoor' });
    }
  }
  if (m.kind === 'project' && progress && progress.state !== 'met') {
    if (progress.nextAction && progress.nextAction.text) {
      out.push({ id: 'project-next', level: 'act', title: `Next step: ${progress.nextAction.text}`, finding: progress.nextAction.why || null,
        action: progress.nextAction.taskId ? `Block time for task #${progress.nextAction.taskId}.` : 'Block time for it this week.', source: 'Personal projects', view: 'leisure' });
    } else {
      out.push({ id: 'project-no-next', level: 'gap', title: 'No next step written down', finding: 'Nothing is pinned, listed under Next in the hub note, or linked as an open task.',
        action: 'Write the next concrete step under “## Next” in the hub note, or link a task to the project.', source: 'Personal projects', view: 'leisure' });
    }
    for (const b of progress.blockers || []) {
      out.push({ id: `project-blocker-${b}`, level: 'act', title: `Blocked: ${b}`, finding: null, action: 'Clear or re-plan the blocker before anything else.', source: 'Personal projects', view: 'leisure' });
    }
  }
  const order = { act: 0, watch: 1, gap: 2 };
  return out.sort((a, b) => (order[a.level] ?? 3) - (order[b.level] ?? 3)).slice(0, 6);
}

// ── reader ──────────────────────────────────────────────────────────────────

function _localDay(nowMs) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: process.env.NEURO_TIMEZONE || 'Europe/London' }).format(new Date(nowMs));
}

/**
 * Progress and levers for every active and paused goal. Inputs are read only
 * for the kinds present, each failure a named gap. Never throws.
 */
function read({ now = Date.now(), picture: given = undefined, kinds: only = null } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : now;
  const today = _localDay(nowMs);
  const gaps = [];
  const attempt = (input, fn, fallback = null) => { try { return fn(); } catch (e) { gaps.push({ input, why: e.message }); return fallback; } };
  const goals = attempt('goals', () => require('./canonical-read').listGoals({ status: 'all' }), [])
    .filter((g) => g.status === 'active' || g.status === 'paused')
    // `kinds` narrows to goals measured by those kinds — a page reading only its own.
    .filter((g) => !only || (g.measure && only.includes(g.measure.kind)));
  const kinds = new Set(goals.filter((g) => g.measure).map((g) => g.measure.kind));
  const needsHealth = [...kinds].some((k) => HEALTH_READ[k] && k !== 'caffeine' && k !== 'alcohol');
  const inputs = { today };
  if (needsHealth) inputs.days = attempt('health', () => require('./health-daily').recentDays(400), null);
  if (kinds.has('caffeine')) inputs.nutritionDays = attempt('nutrition', () => nutritionDays(require('./nutrition').read({ now: new Date(nowMs), days: 400 })), null);
  if (kinds.has('alcohol')) inputs.alcoholDays = attempt('drinks', () => require('./drinks').read({ now: new Date(nowMs), days: 60 }).days, null);
  if (kinds.has('hikes')) inputs.hiking = attempt('hiking', () => require('./hiking-loop').read({ now: nowMs, weeks: 6 }), null);
  if (kinds.has('project')) inputs.projects = attempt('projects', () => require('./projects').read({ now: nowMs }).projects, []);
  // Any measure with health levers needs My Health's insights (caffeine and
  // alcohol included — they read their own source but their levers are there).
  const wantsPicture = [...kinds].some((k) => (MEASURES[k].levers || []).length);
  const picture = given !== undefined ? given
    : wantsPicture ? attempt('my-health', () => require('./health-picture').read({ now: new Date(nowMs) }), null) : null;
  let outdoor = null;
  if (kinds.has('hikes')) {
    outdoor = attempt('outdoor', () => {
      const od = require('./outdoor');
      const days = [0, 1, 2, 3, 4, 5, 6].map((i) => shiftDay(today, i)).map((d) => od.weatherNear(d, nowMs));
      const plans = require('./hiking-loop').plansAhead({ now: nowMs, days: 7 });
      return { days, plans };
    }, null);
  }
  const out = goals.map((g) => {
    if (g.status === 'paused') return { goalId: g.id, title: g.title, measure: g.measure || null, progress: null, levers: [], paused: true };
    let progress = null; let levers = [];
    try { progress = evaluate(g, inputs); } catch (e) { progress = { state: 'unknown', line: `Could not judge it: ${e.message}` }; }
    try { levers = leversFor(g, progress, { picture, outdoor, today }); } catch { levers = []; }
    return { goalId: g.id, title: g.title, measure: g.measure || null, progress, levers };
  });
  return {
    ok: true, contract: 'goal-progress-v1', today, goals: out, gaps,
    rule: 'Measured only by what you chose. A missing reading is unknown, never behind. Levers are things NEURO can see that bear on a goal, not causes. Nothing here notifies or creates anything.',
  };
}

// ── where goals show up elsewhere (pure) ────────────────────────────────────

// Which My Health tile a measure belongs on. Hikes and projects are not health.
const HEALTH_SYSTEM = { bp: 'bp', weight: 'weight', steps: 'activity', exercise: 'activity', sleep: 'sleep',
  'resting-hr': 'heart', caffeine: 'nutrition', alcohol: 'nutrition' };

/**
 * The health goals, shaped for My Health. PURE. `progressRead` is read()'s
 * answer; `goals` is listGoals(). Returns the goal rows, the goals per tile and
 * the goals each insight bears on — so the page can say "bears on your goal"
 * without deciding anything. Paused goals are listed and lend nothing.
 */
function healthView(progressRead, goals = []) {
  const byId = new Map(((progressRead && progressRead.goals) || []).map((x) => [x.goalId, x]));
  const rows = [];
  const bySystem = {};
  const byInsight = {};
  for (const g of goals) {
    if (!g.measure || !HEALTH_SYSTEM[g.measure.kind] || (g.status !== 'active' && g.status !== 'paused')) continue;
    const p = byId.get(g.id) || {};
    const prog = p.progress || null;
    const row = {
      goalId: g.id, title: g.title, kind: g.measure.kind, label: MEASURES[g.measure.kind].label, status: g.status,
      state: g.status === 'paused' ? 'paused' : prog ? prog.state : 'unknown',
      line: g.status === 'paused' ? 'Paused — you paused it.' : prog ? prog.line : 'Not judged yet.',
      targetText: prog && prog.targetText ? prog.targetText : null, by: g.measure.by || null,
      system: HEALTH_SYSTEM[g.measure.kind], levers: g.status === 'paused' ? [] : p.levers || [],
    };
    rows.push(row);
    (bySystem[row.system] = bySystem[row.system] || []).push({ goalId: g.id, title: g.title, state: row.state, targetText: row.targetText });
    if (g.status === 'active') {
      for (const l of row.levers) {
        if (l.source !== 'My Health') continue;
        (byInsight[l.id] = byInsight[l.id] || []).push({ goalId: g.id, title: g.title, state: row.state });
      }
    }
  }
  return { contract: 'health-goals-v1', known: !!progressRead, goals: rows, bySystem, byInsight,
    gaps: (progressRead && progressRead.gaps) || [] };
}

function catalogue() {
  return KINDS.map((k) => {
    const d = MEASURES[k];
    return { kind: k, label: d.label, unit: d.unit, direction: d.direction, domain: d.domain, target: d.target,
      periods: d.periods || null, min: d.min ?? null, max: d.max ?? null, source: d.source };
  });
}

module.exports = {
  MEASURES, KINDS, PERIODS, validateMeasure, healthValue, nutritionDays, evaluate, judgeHealth, judgeHikes, judgeProject,
  leversFor, read, catalogue, healthView, HEALTH_SYSTEM,
};
