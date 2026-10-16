'use strict';

/**
 * The Monday briefing, in readiness for the 09:00 tech leadership meeting
 * (12 Oct 2026).
 *
 * Nick's starting set — "start there and we'll add more once I see it":
 *   - CSAT and SLA compliance for last Monday–Sunday, against the week before
 *     (read through weekly-risk, never computed twice — its ratings-based CSAT
 *     and per-queue targets are the only correct ones)
 *   - top and weakest agent off NOVA's KPI Rebuild leaderboard (Model A), via
 *     the bridge's /agent-leaderboard, which ranks with the SAME shared rule
 *   - raised and closed volumes, and the backlog split Support vs Development
 *   - the Friday Support Leadership Meeting's highlights, lowlights and
 *     blockers/escalations, pulled out of the Plaud note
 *   - blood pressure, the one standing health issue: the week, not the morning
 *
 * Everything it could not read is a named gap. A section that silently
 * disappears reads as "nothing to report", which in a leadership briefing is a
 * claim about the team.
 */

const fs = require('fs');
const path = require('path');
const nova = require('./nova-client');
const { todayLocal } = require('./briefing-gather');

// kpi_org_daily keys (NOVA registry). Daily counts for raised/closed; point-in-time stocks for backlog.
const VOLUME_KEYS = Object.freeze({
  raised: 'nt_legacy_new_tickets',
  closed: 'nt_legacy_solved_today',
  backlogSupport: 'nt_open_support_owned',
  backlogDevelopment: 'nt_development',
  backlogTotal: 'nt_legacy_open_tickets',
});
const FLOW_KEYS = new Set(['raised', 'closed']);

// The Support team's own queues (Nick, 12 Oct 2026): Customer Care, Tier 2 and
// Production. Tier 3 and Development are hand-offs and are left out.
const SUPPORT_QUEUES = Object.freeze([
  ['customer_care', 'Customer Care'],
  ['tier_2', 'Tier 2'],
  ['production', 'Production'],
]);
const SLA_METRICS = Object.freeze([['frt', 'FRT'], ['res', 'Resolution']]);

/** kpi_org_daily keys for the daily met / breached counts per queue. */
function supportSlaKeys() {
  const out = [];
  for (const [m] of SLA_METRICS) {
    for (const [q] of SUPPORT_QUEUES) out.push(`nt_sla_${m}_${q}_met`, `nt_sla_${m}_${q}_breached`);
  }
  return out;
}

// ── Weeks ────────────────────────────────────────────────────────────────────

function _addDays(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  return todayLocal(new Date(y, m - 1, d + n));
}

/** The completed Monday–Sunday before `today`, and the week before that. PURE. */
function reportWeeks(today) {
  const [y, m, d] = today.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  const shift = (dt.getDay() + 6) % 7; // Mon=0
  const thisMonday = todayLocal(new Date(y, m - 1, d - shift));
  const from = _addDays(thisMonday, -7);
  const priorFrom = _addDays(thisMonday, -14);
  return {
    thisMonday,
    report: { from, to: _addDays(from, 6) },
    prior: { from: priorFrom, to: _addDays(priorFrom, 6) },
  };
}

// ── Volumes (PURE over the series payload) ───────────────────────────────────

function _inWeek(day, w) {
  return day >= w.from && day <= w.to;
}

function _weekFigure(series, w, flow) {
  if (!series) return { value: null, days: 0 };
  const pts = (series.points || []).filter((p) => p && _inWeek(p.day, w) && Number.isFinite(p.value));
  if (!pts.length) return { value: null, days: 0 };
  if (flow) return { value: pts.reduce((s, p) => s + p.value, 0), days: pts.length };
  const last = pts.sort((a, b) => a.day.localeCompare(b.day))[pts.length - 1];
  return { value: last.value, days: pts.length, asOf: last.day };
}

/**
 * Raised/closed summed over the week; backlog taken at the last day captured.
 * `days` says how many of the 7 held a value — a week with three captured days
 * is reported as three, never scaled up, never read as a quiet week.
 */
function volumesFor(seriesData, weeks) {
  const byKey = new Map((seriesData?.series || []).map((s) => [s.key, s]));
  const rows = [];
  for (const [name, key] of Object.entries(VOLUME_KEYS)) {
    const s = byKey.get(key);
    const flow = FLOW_KEYS.has(name);
    const now = _weekFigure(s, weeks.report, flow);
    const was = _weekFigure(s, weeks.prior, flow);
    rows.push({
      name, key, label: s?.label || key, flow,
      now: now.value, nowDays: now.days, asOf: now.asOf || null,
      was: was.value, wasDays: was.days,
      delta: now.value != null && was.value != null ? Math.round((now.value - was.value) * 10) / 10 : null,
      known: Boolean(s),
    });
  }
  return rows;
}

/**
 * The Support team's compliance, POOLED: every met and every breached ticket
 * across Customer Care, Tier 2 and Production, summed over the week, then
 * met ÷ (met + breached). PURE.
 *
 * ⚠ Never an average of the three queue percentages: a queue that solved 20
 * tickets would count as much as one that solved 400. Weighting by tickets is
 * the same ratio NOVA defines each queue's compliance by (ratioOf met/breached).
 *
 * A week with no counts is null, never 100% or 0%. `days` says how many of the
 * 7 carried counts, and `queues` says which queues contributed.
 */
function supportCompliance(seriesData, weeks) {
  const byKey = new Map((seriesData?.series || []).map((s) => [s.key, s]));
  const sumWeek = (key, w) => {
    const s = byKey.get(key);
    if (!s) return { total: 0, days: new Set(), known: false };
    const pts = (s.points || []).filter((p) => p && _inWeek(p.day, w) && Number.isFinite(p.value));
    return { total: pts.reduce((n, p) => n + p.value, 0), days: new Set(pts.map((p) => p.day)), known: true };
  };
  const out = {};
  for (const [m, label] of SLA_METRICS) {
    const one = (w) => {
      let met = 0;
      let breached = 0;
      const days = new Set();
      const queues = [];
      for (const [q, qLabel] of SUPPORT_QUEUES) {
        const a = sumWeek(`nt_sla_${m}_${q}_met`, w);
        const b = sumWeek(`nt_sla_${m}_${q}_breached`, w);
        if (!a.known && !b.known) continue;
        met += a.total;
        breached += b.total;
        for (const d of [...a.days, ...b.days]) days.add(d);
        if (a.total + b.total > 0) queues.push(qLabel);
      }
      const n = met + breached;
      return { pct: n > 0 ? Math.round((met / n) * 1000) / 10 : null, met, breached, days: days.size, queues };
    };
    const now = one(weeks.report);
    const was = one(weeks.prior);
    out[m] = {
      label: `${label} compliance % (Support: CC + T2 + Prod)`,
      now, was,
      delta: now.pct != null && was.pct != null ? Math.round((now.pct - was.pct) * 10) / 10 : null,
      target: 95,
    };
  }
  return out;
}

// ── Leaderboard (PURE) ───────────────────────────────────────────────────────

function leaderboardSummary(data) {
  const ranked = Array.isArray(data?.ranked) ? data.ranked : [];
  if (!ranked.length) return { known: true, enough: false, top: null, weakest: null, rankedCount: 0, unranked: data?.unranked || [] };
  return {
    known: true,
    enough: ranked.length >= 2,
    top: ranked[0],
    weakest: ranked.length >= 2 ? ranked[ranked.length - 1] : null,
    rankedCount: ranked.length,
    unranked: Array.isArray(data?.unranked) ? data.unranked : [],
    rule: data?.rule || null,
    from: data?.from || null,
    to: data?.to || null,
  };
}

// ── The Friday Support Leadership Meeting ────────────────────────────────────

const SLM_PATTERN = /support leadership/i;

/**
 * The SLM note for the report week: a Meetings/ note whose filename carries a
 * date inside the week and "Support Leadership". A Plaud " 2" twin loses to the
 * original. Returns null when none exists — never a guess at another meeting.
 */
function findSlmNote(vaultRoot, week) {
  if (!vaultRoot) return { found: false, why: 'vault not configured' };
  const months = new Set([week.from.slice(0, 7), week.to.slice(0, 7)]);
  const hits = [];
  for (const ym of months) {
    const dir = path.join(vaultRoot, 'Meetings', ym.slice(0, 4), ym.slice(5, 7));
    let names;
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (!name.endsWith('.md')) continue;
      const m = /^(\d{4}-\d{2}-\d{2})/.exec(name);
      if (!m || !_inWeek(m[1], week) || !SLM_PATTERN.test(name)) continue;
      hits.push({ date: m[1], name, file: path.join(dir, name), twin: / \d+\.md$/.test(name) });
    }
  }
  if (!hits.length) {
    // No literal title (Nick, 16 Oct 2026): the meeting is the Friday-afternoon
    // one with him, Stephen Mitchell and Nathan Rutland — two of the three
    // named is enough, because PLAUD titles it from what was discussed.
    const alt = _slmByAttendees(vaultRoot, week, months);
    if (alt) return alt;
    return { found: false, why: `no Support Leadership Meeting note dated ${week.from} – ${week.to}, and no Friday-afternoon meeting naming two of ${SLM_ATTENDEES.join(', ')}` };
  }
  hits.sort((a, b) => (a.twin - b.twin) || b.date.localeCompare(a.date));
  const pick = hits[0];
  return { found: true, matchedBy: 'title', date: pick.date, name: pick.name.replace(/\.md$/, ''), file: pick.file, relPath: path.relative(vaultRoot, pick.file).split(path.sep).join('/') };
}

/** The three people at the SLM. FULL names only: "Nathan" alone is two people. */
const SLM_ATTENDEES = ['Nick Ward', 'Stephen Mitchell', 'Nathan Rutland'];
const SLM_MIN_ATTENDEES = 2;

/** Hour (0-23) in Europe/London of a PLAUD start_at, which is UTC with no zone marker. PURE. */
function _londonHour(startAt) {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/.exec(String(startAt || '').replace(/^"|"$/g, ''));
  if (!m) return null;
  const d = new Date(`${m[1]}T${m[2]}:${m[3]}:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', hourCycle: 'h23' }).format(d));
}

/** Which of the SLM attendees a note names, by whole full name. PURE. */
function slmAttendeesIn(text) {
  const t = String(text || '').toLowerCase();
  return SLM_ATTENDEES.filter((n) => new RegExp(`(^|[^a-z])${n.toLowerCase()}([^a-z]|$)`).test(t));
}

function _slmByAttendees(vaultRoot, week, months) {
  const hits = [];
  for (const ym of months) {
    const dir = path.join(vaultRoot, 'Meetings', ym.slice(0, 4), ym.slice(5, 7));
    let names;
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (!name.endsWith('.md')) continue;
      const m = /^(\d{4}-\d{2}-\d{2})/.exec(name);
      if (!m || !_inWeek(m[1], week)) continue;
      if (new Date(`${m[1]}T12:00:00Z`).getUTCDay() !== 5) continue;   // Friday
      const file = path.join(dir, name);
      let text;
      try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
      const fm = (/^---[\s\S]*?\n---/.exec(text) || [''])[0];
      if (/^type:\s*["']?meeting-prep/m.test(fm)) continue;            // prep is not the meeting
      const hour = _londonHour((/^start_at:\s*(.+)$/m.exec(fm) || [])[1]);
      if (hour === null || hour < 12) continue;                        // afternoon, and provably so
      const who = slmAttendeesIn(text);
      if (who.length < SLM_MIN_ATTENDEES) continue;
      hits.push({ date: m[1], name, file, who, twin: / \d+\.md$/.test(name) });
    }
  }
  if (!hits.length) return null;
  hits.sort((a, b) => (b.who.length - a.who.length) || (a.twin - b.twin) || b.date.localeCompare(a.date));
  const pick = hits[0];
  return { found: true, matchedBy: 'attendees', attendees: pick.who, date: pick.date, name: pick.name.replace(/\.md$/, ''), file: pick.file, relPath: path.relative(vaultRoot, pick.file).split(path.sep).join('/') };
}

function _stripFrontmatter(text) {
  return String(text || '').replace(/^---[\s\S]*?\n---\s*\n/, '');
}

const SLM_PROMPT = `You are pulling the key points out of the notes of a weekly Support Leadership Meeting (three people: the Head of Technical Support and two senior agents), for a briefing read before the Monday tech leadership meeting.

Return ONLY a JSON object, no prose, in exactly this shape:
{"highlights":[], "lowlights":[], "blockers":[]}

- highlights: things that went well or improved.
- lowlights: things that went badly, slipped or got worse.
- blockers: blockers and escalations — things stuck, waiting on another team, or needing a decision or help from leadership.
Each entry is one plain sentence of at most 25 words, stating a fact from the notes. At most 5 per list. Use an empty list when the notes say nothing for it. Do not invent, infer or add advice. Do not attribute points to people.

Meeting notes:
`;

/** Parse the model's answer. Anything unreadable is null — never an empty list. PURE. */
function parseSlmPoints(text) {
  const s = String(text || '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  let obj;
  try { obj = JSON.parse(s.slice(start, end + 1)); } catch { return null; }
  const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()).slice(0, 5) : null);
  const out = { highlights: list(obj.highlights), lowlights: list(obj.lowlights), blockers: list(obj.blockers) };
  if (!out.highlights || !out.lowlights || !out.blockers) return null;
  return out;
}

async function slmPoints(vaultRoot, week, { extract = null } = {}) {
  const note = findSlmNote(vaultRoot, week);
  if (!note.found) return { known: false, why: note.why };
  let body;
  try { body = _stripFrontmatter(fs.readFileSync(note.file, 'utf8')).slice(0, 16000); } catch (e) {
    return { known: false, why: `could not read ${note.name}: ${e.message}`, note };
  }
  let text = null;
  try {
    text = extract
      ? await extract(SLM_PROMPT + body)
      : (await require('./ai-routing').runTask('briefing_synthesis', { prompt: SLM_PROMPT + body, maxTokens: 900 }))?.text;
  } catch (e) {
    return { known: false, why: `could not summarise the note: ${e.message}`, note };
  }
  const points = parseSlmPoints(text);
  if (!points) return { known: false, why: 'the summary came back unreadable', note };
  return { known: true, note, ...points };
}

// ── Blood pressure for the week (PURE over health_daily rows) ────────────────

function _median(xs) {
  const v = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

function bpWeek(rows, weeks) {
  const pick = (w) => {
    const days = (rows || []).filter((r) => r && _inWeek(r.day, w) && Number.isFinite(r.bpSystolic) && Number.isFinite(r.bpDiastolic));
    return {
      days: days.length,
      systolic: days.length ? Math.round(_median(days.map((r) => r.bpSystolic))) : null,
      diastolic: days.length ? Math.round(_median(days.map((r) => r.bpDiastolic))) : null,
    };
  };
  return { now: pick(weeks.report), was: pick(weeks.prior) };
}

// ── The personal half (12 Oct 2026: "both are heavy on the work side") ──────

/**
 * Last week's body against the week before: median sleep, median resting heart
 * rate. Medians, as health-daily uses. A week with no readings is null. PURE.
 */
function healthWeek(rows, weeks) {
  const pick = (w, field) => {
    const vals = (rows || []).filter((r) => r && _inWeek(r.day, w) && Number.isFinite(r[field])).map((r) => r[field]);
    return { days: vals.length, median: vals.length ? Math.round(_median(vals) * 10) / 10 : null };
  };
  const both = (field) => {
    const now = pick(weeks.report, field);
    const was = pick(weeks.prior, field);
    return { now, was, delta: now.median != null && was.median != null ? Math.round((now.median - was.median) * 10) / 10 : null };
  };
  return { sleepHours: both('asleepHours'), restingHr: both('rhrMedian') };
}

/**
 * The week AHEAD, personal side: the Future Radar's next 7 days, taken as given
 * (its own needs-you and lead-time rules). Work items are excluded. PURE over
 * the radar payload.
 */
function weekAheadFrom(radar) {
  if (!radar || radar.ok === false) return { known: false, items: [] };
  const items = (radar.items || [])
    .filter((it) => it && it.title && it.sphere !== 'work')
    .map((it) => ({
      title: it.title,
      date: it.date || null,
      time: it.time || null,
      kind: it.kind || null,
      needsYou: it.actionState === 'needs_you',
      why: Array.isArray(it.whyVisible) && it.whyVisible[0] ? it.whyVisible[0] : null,
    }));
  return { known: true, items, heading: radar.heading || null };
}

/**
 * Goals for the week (15 Oct 2026): every active goal with a measure, as
 * goal-measures judged it, needing-help first, with its ONE top suggestion.
 * A goal with no measure is counted, never judged. PURE over read()'s payload.
 */
const GOAL_ORDER = ['behind', 'moving-away', 'not-moving', 'unknown', 'on-track', 'met'];
function goalsWeek(read) {
  if (!read || read.ok === false) return { known: false, items: [], unmeasured: 0 };
  const rows = (read.goals || []).filter((g) => !g.paused);
  const items = rows.filter((g) => g.measure && g.progress).map((g) => {
    const top = (g.levers || [])[0] || null;
    return { title: g.title || '', state: g.progress.state, line: g.progress.line,
      help: top ? { title: top.title, action: top.action, source: top.source } : null };
  }).sort((a, b) => GOAL_ORDER.indexOf(a.state) - GOAL_ORDER.indexOf(b.state));
  return { known: true, items, unmeasured: rows.filter((g) => !g.measure).length,
    gaps: (read.gaps || []).map((x) => x.input) };
}

// ── Assembly ─────────────────────────────────────────────────────────────────

async function _pull(name, fn, gaps, label) {
  try { return await fn(); } catch (e) {
    gaps.push({ source: label, why: e.message });
    return null;
  }
}

/**
 * Gather the weekly. `overrides` swaps any source (tests). Never throws.
 */
async function gatherWeekly({ now = new Date(), overrides = {} } = {}) {
  const today = todayLocal(now);
  const weeks = reportWeeks(today);
  const gaps = [];
  const use = (name, fn) => (typeof overrides[name] === 'function' ? overrides[name] : fn);

  // KPIs through weekly-risk: one CSAT and one compliance definition in NEURO.
  const assessment = await _pull('kpi', use('kpi', async () => {
    if (!nova.isConfigured()) throw new Error('NOVA bridge not configured');
    const wr = require('./weekly-risk');
    const snap = await wr.snapshot({ week: weeks.thisMonday });
    for (const s of snap.sources || []) {
      if (!s.ok && /kpi-org-trend|csat-reported/.test(s.name)) gaps.push({ source: `NOVA ${s.name}`, why: s.error });
    }
    return wr.assess(snap);
  }), gaps, 'KPIs from NOVA');

  let sla = null;
  let csatRows = null;
  if (assessment) {
    const wr = require('./weekly-risk');
    sla = (assessment.trend || [])
      .filter((t) => wr.isComplianceKpi(t.kpi))
      .sort((a, b) => wr.byComplianceOrder(a.kpi, b.kpi))
      .map((t) => ({
        kpi: t.kpi,
        measured: t.measured,
        now: t.reported?.value ?? null,
        was: t.compare?.value ?? null,
        delta: t.delta,
        target: t.target ?? null,
        targetMoved: Boolean(t.targetMoved),
        lastSeen: t.measured ? null : (t.lastSeen?.period || null),
      }));
    csatRows = assessment.csatRows || null;
    // ⚠ Found live (12 Oct): NOVA answered kpi-org-trend "ok" with no rows
    // during a busy moment, and the per-queue table rendered short with no
    // gap. An empty answer from a source that always has these KPIs is a
    // failure to read, never "no queues".
    if (!sla.length) gaps.push({ source: 'per-queue SLA compliance from NOVA', why: 'NOVA answered but returned no compliance rows — rebuild to try again' });
  }

  const series = await _pull('volumes', use('volumes', () => {
    const keys = [...Object.values(VOLUME_KEYS), ...supportSlaKeys()].join(',');
    return nova.call(`/api/neuro-bridge/kpi-org-series?days=21&keys=${keys}&to=${weeks.report.to}`);
  }), gaps, 'ticket volumes from NOVA');
  const volumes = series ? volumesFor(series, weeks) : null;
  const supportSla = series ? supportCompliance(series, weeks) : null;

  const lb = await _pull('leaderboard', use('leaderboard', () => nova.call(`/api/neuro-bridge/agent-leaderboard?anchor=${weeks.report.to}`)), gaps, 'the agent leaderboard');
  const leaderboard = lb ? leaderboardSummary(lb) : null;

  const vaultRoot = process.env.OBSIDIAN_VAULT_PATH || null;
  const slm = await use('slm', () => slmPoints(vaultRoot, weeks.report))();
  if (slm && !slm.known) gaps.push({ source: 'the Friday Support Leadership Meeting', why: slm.why });

  const bpRows = await _pull('bp', use('bp', () => require('./health-daily').recentDays(21)), gaps, 'blood pressure');
  const bp = bpRows ? bpWeek(bpRows, weeks) : null;
  const health = bpRows ? healthWeek(bpRows, weeks) : null;

  const radar = await _pull('weekAhead', use('weekAhead', () => require('./future-radar').read({ now: now.getTime(), horizonDays: 7 })), gaps, 'the week ahead (Future Radar)');
  const weekAhead = weekAheadFrom(radar);

  const goalRead = await _pull('goals', use('goals', () => require('./goal-measures').read({ now: now.getTime() })), gaps, 'your goals');
  const goals = goalsWeek(goalRead);
  if (goalRead && goals.gaps && goals.gaps.length) gaps.push({ source: `goal inputs (${goals.gaps.join(', ')})`, why: 'some goals say “can’t tell”' });

  return { today, weeks, sla, supportSla, csatRows, volumes, leaderboard, slm, bp, health, weekAhead, goals, gaps };
}

module.exports = {
  gatherWeekly, reportWeeks, volumesFor, supportCompliance, healthWeek, weekAheadFrom, goalsWeek, supportSlaKeys, SUPPORT_QUEUES, leaderboardSummary, findSlmNote, slmAttendeesIn, parseSlmPoints, slmPoints, bpWeek,
  VOLUME_KEYS, SLM_PROMPT,
};
