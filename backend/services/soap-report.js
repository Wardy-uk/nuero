'use strict';

/**
 * The SOAP report — the weekly debrief for Ricky and Chris (15 Oct 2026).
 *
 * Nick's brief: a Monday-morning debrief, usually delivered in person, so it
 * must exist in NEURO before 08:00. When he is on annual leave on the Monday it
 * goes by email instead — and he approves THAT on the Friday, from a
 * provisional copy built at 16:00.
 *
 * The ground rules the report follows (from the request it answers): commentary
 * strictly on the week's SUCCESS, the STAR of the week, what is turning AMBER
 * and what is RED; every red states what will be done, and the NEXT report says
 * whether it was delivered green — and if not, why and what it costs the people
 * around him.
 *
 * ── Where every fact comes from (nothing here re-derives a number) ─────────
 *
 *   Success / amber / red  weekly-risk's assess() — its findings and positives,
 *                          the ONE definition of a compliance slide in NEURO —
 *                          plus the Support SLA week figure briefing-weekly
 *                          computes, judged by weekly-risk's own RAG rule
 *   SLA day on day         NOVA kpi-org-series, the met/breached counts per day
 *   Star / weakest agent   NOVA's KPI Rebuild leaderboard (Model A), the same
 *                          call and the same summary the Monday briefing uses
 *   Improvement initiatives VANTAGE's /api/plan (Nick-owned actions)
 *   Worst 5 customers      NOVA's ranking, in NOVA's ORDER (bridge route
 *                          /customers/worst). NEURO ranks nothing. Until that
 *                          route exists it is a named gap.
 *
 * ── Provisional vs final ───────────────────────────────────────────────────
 *
 * Both describe the SAME Monday–Sunday week (`week_from`). The provisional is
 * built on the Friday at 16:00 from Monday-to-now; the final is built the
 * following Monday at 07:00 from the whole week. When Nick has approved the
 * provisional for sending, the executor sends EXACTLY what he approved at
 * 08:00 Monday — and only if the final's VERDICTS (success, star, ambers, reds)
 * match the provisional's. The numbers may move over a weekend; a different
 * verdict means the report he approved is no longer true, so it is held.
 * The worst-customer list is deliberately NOT a verdict: it is a point-in-time
 * read NOVA cannot answer "as at Sunday", it is labelled "as at", and letting it
 * hold the send would hold it most weeks (Nick, 15 Oct 2026).
 *
 * ⚠ A source that could not be read is a NAMED GAP, never an empty section.
 * A gap in a VERDICT source (KPIs, leaderboard) also marks the report
 * `verdictComplete: false`, which the executor treats as "cannot confirm the
 * verdicts" and holds the send.
 */

const crypto = require('crypto');
const db = require('../db/database');

const AMBER_BAND = 20; // weekly-risk's rule: within 20 points of target is amber, further is red
const STAR_LIMIT_SUCCESS = 6;
const WORST_CUSTOMERS = 5;
const RECIPIENTS_KEY = 'soap_recipients';
const DEFAULT_RECIPIENTS = Object.freeze(['Chris Middleton', 'Ricky']);
const MANUAL_PREFIX = 'soap_manual:';
const SEND_AT_HOUR = 8; // Monday 08:00

// Findings about Nick's own PIP bookkeeping (overtime, his task list, his log)
// belong to the weekly risk report to Chris, not to a service debrief.
const EXCLUDED_KINDS = new Set([
  'overtime-checklist-gap', 'overtime-outstanding', 'wtr-limit', 'commitment-backlog',
  'task-unclassified', 'management-overdue', 'log-latency', 'people-hr-gap',
]);

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
function addDays(day, n) {
  const [y, m, d] = day.split('-').map(Number);
  return ymd(new Date(y, m - 1, d + n));
}
function mondayOf(day) {
  const [y, m, d] = day.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return ymd(new Date(y, m - 1, d - ((dt.getDay() + 6) % 7)));
}
const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const shortDate = (day) => `${Number(day.slice(8, 10))} ${MONTHS[Number(day.slice(5, 7)) - 1]}`;

// ── Weeks (PURE) ─────────────────────────────────────────────────────────────

/**
 * The week a report covers. `final` (built on a Monday) covers the completed
 * Monday–Sunday before it; `provisional` (built on a Friday) covers the week in
 * progress, up to today. `fileWeek` is the Monday weekly-risk files that week
 * under (its snapshot reports the week BEFORE the one it is given).
 */
function weekFor(kind, now = new Date()) {
  const today = ymd(now);
  const thisMonday = mondayOf(today);
  if (kind === 'final') {
    const from = addDays(thisMonday, -7);
    return { kind, from, to: addDays(from, 6), upTo: addDays(from, 6), fileWeek: thisMonday, today };
  }
  if (kind === 'provisional') {
    return { kind, from: thisMonday, to: addDays(thisMonday, 6), upTo: today, fileWeek: addDays(thisMonday, 7), today };
  }
  throw new Error(`unknown SOAP kind ${kind}`);
}

/** The Monday a provisional for `weekFrom` would be sent on, at 08:00 local, as ISO. */
function sendAtFor(weekFrom) {
  const [y, m, d] = addDays(weekFrom, 7).split('-').map(Number);
  return new Date(y, m - 1, d, SEND_AT_HOUR, 0, 0).toISOString();
}

// ── SLA day on day (PURE) ────────────────────────────────────────────────────

/**
 * Support FRT and Resolution compliance per day across the Support queues the
 * Monday briefing uses (CC + T2 + Production). A day with no met/breached
 * counts is null — "nothing measured", never 0%.
 */
function slaDaily(series, week, { queues, metrics }) {
  const byKey = new Map((series && series.series || []).map((s) => [s.key, s]));
  const valueOn = (key, day) => {
    const s = byKey.get(key);
    const p = s && (s.points || []).find((x) => x && x.day === day && Number.isFinite(x.value));
    return p ? p.value : null;
  };
  const days = [];
  for (let i = 0; i < 7; i += 1) {
    const day = addDays(week.from, i);
    if (day > week.upTo) break;
    const row = { day, label: `${DAY_NAMES[i]} ${shortDate(day)}` };
    for (const [m] of metrics) {
      let met = 0; let breached = 0; let seen = false;
      for (const [q] of queues) {
        const a = valueOn(`nt_sla_${m}_${q}_met`, day);
        const b = valueOn(`nt_sla_${m}_${q}_breached`, day);
        if (a !== null || b !== null) seen = true;
        met += a || 0; breached += b || 0;
      }
      const n = met + breached;
      row[m] = seen && n > 0 ? { pct: Math.round((met / n) * 1000) / 10, met, breached } : null;
    }
    days.push(row);
  }
  return days;
}

// ── Improvement initiatives (PURE over VANTAGE's /api/plan) ──────────────────

/** "04/09" or "21/08, 24/08" → the LATEST date, as YYYY-MM-DD, or null. */
function parseDue(text, today) {
  const hits = [...String(text || '').matchAll(/\b(\d{1,2})\/(\d{1,2})\b/g)];
  if (!hits.length) return null;
  const year = Number(today.slice(0, 4));
  let best = null;
  for (const h of hits) {
    const d = Number(h[1]); const m = Number(h[2]);
    if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31)) continue;
    let day = `${year}-${pad(m)}-${pad(d)}`;
    // A plan date more than half a year ahead is last year's, not next year's.
    if (day > addDays(today, 183)) day = `${year - 1}-${pad(m)}-${pad(d)}`;
    if (!best || day > best) best = day;
  }
  return best;
}

function initiatives(plan, week) {
  const actions = (plan && Array.isArray(plan.actions) ? plan.actions : [])
    .filter((a) => a.ownership === 'mine' && a.status !== 'Not adding' && !a.sameAs);
  const doneThisWeek = [];
  const overdue = [];
  const open = [];
  for (const a of actions) {
    const completedIn = (a.planner || []).map((p) => p.completed).filter((c) => c && c >= week.from && c <= week.upTo);
    if (completedIn.length) doneThisWeek.push({ id: a.id, action: a.action, completed: completedIn.sort().pop() });
    const allDone = a.status === 'Done' || ((a.planner || []).length && (a.planner || []).every((p) => p.percent === 100));
    if (allDone) continue;
    const due = parseDue(a.due, week.upTo);
    const pct = (a.planner || []).length ? Math.round((a.planner || []).reduce((n, p) => n + (p.percent || 0), 0) / a.planner.length) : null;
    const row = { id: a.id, action: a.action, status: a.status, due, dueText: a.due || null, percent: pct, drift: a.drift || [] };
    open.push(row);
    if (due && due < week.upTo) overdue.push(row);
  }
  const count = (s) => actions.filter((a) => a.status === s).length;
  return {
    known: true,
    totals: { mine: actions.length, done: count('Done'), added: count('Added'), toBeAdded: count('To be added') },
    doneThisWeek,
    overdue: overdue.sort((a, b) => a.due.localeCompare(b.due)),
    open,
    readAt: plan && plan.readAt || null,
  };
}

// ── Verdicts (PURE) ──────────────────────────────────────────────────────────

/** A key that survives a number changing: the kind plus the subject, digits folded. */
function findingKey(f) {
  const subject = String(f.kpi || f.subject || f.title || '').toLowerCase().replace(/[\d.,%£]+/g, '#').replace(/\s+/g, ' ').trim();
  return `${f.kind || 'finding'}:${subject}`;
}

function slaLight(pct, target) {
  if (pct === null || pct === undefined || target === null || target === undefined) return null;
  if (pct >= target) return 'green';
  return pct >= target - AMBER_BAND ? 'amber' : 'red';
}

/**
 * Success, star, ambers, reds — from what was read. Never re-ranks or
 * re-judges: a finding's severity is weekly-risk's, the star is NOVA's top.
 */
function verdicts({ assessment, supportSla, leaderboard, plan }) {
  const success = [];
  const ambers = [];
  const reds = [];
  for (const p of (assessment && assessment.positives) || []) {
    if (success.length >= STAR_LIMIT_SUCCESS) break;
    success.push({ key: `kpi:${String(p.kpi).toLowerCase()}`, text: `${p.kpi}: ${p.value}${p.target !== null && p.target !== undefined ? ` (target ${p.target})` : ''}` });
  }
  for (const [m, s] of Object.entries(supportSla || {})) {
    const light = slaLight(s.now && s.now.pct, s.target);
    if (!light) continue;
    const text = `${s.label}: ${s.now.pct}% against ${s.target}%${s.delta !== null && s.delta !== undefined ? ` (${s.delta >= 0 ? '+' : ''}${s.delta} on the week before)` : ''}`;
    const item = { key: `sla:${m}`, text };
    if (light === 'green') success.push(item);
    else if (light === 'amber') ambers.push(item);
    else reds.push(item);
  }
  for (const d of (plan && plan.doneThisWeek) || []) success.push({ key: `plan-done:${d.id}`, text: `Improvement plan ${d.id} delivered: ${d.action}` });
  for (const f of (assessment && assessment.findings) || []) {
    if (EXCLUDED_KINDS.has(f.kind)) continue;
    const item = { key: findingKey(f), text: f.title, detail: f.detail || null };
    if (f.severity === 'escalate') reds.push(item);
    else if (f.severity === 'warn') ambers.push(item);
  }
  for (const o of (plan && plan.overdue) || []) {
    ambers.push({ key: `plan-overdue:${o.id}`, text: `Improvement plan ${o.id} past its due date (${o.dueText}): ${o.action}` });
  }
  const top = leaderboard && leaderboard.top;
  const star = top ? {
    name: top.agentName,
    team: top.team || null,
    compositeScore: top.compositeScore ?? null,
    solved: top.solved ?? null,
    slaCompliancePct: top.slaCompliancePct ?? null,
    csatAvg: top.csatAvg ?? null,
    qaOverall: top.qaOverall ?? null,
  } : null;
  return { success, star, ambers, reds };
}

/** What the Monday send is held on: the verdicts, not the numbers. */
function verdictHash(v) {
  const keys = (list) => (list || []).map((x) => x.key).sort();
  return sha(JSON.stringify({
    success: keys(v.success), star: v.star ? v.star.name : null, ambers: keys(v.ambers), reds: keys(v.reds),
  }));
}

/** Which verdicts differ, in words — so a held send can say why. */
function verdictDiff(a, b) {
  const out = [];
  const keys = (l) => new Set((l || []).map((x) => x.key));
  for (const part of ['success', 'ambers', 'reds']) {
    const ka = keys(a[part]); const kb = keys(b[part]);
    const added = (b[part] || []).filter((x) => !ka.has(x.key)).map((x) => x.text);
    const gone = (a[part] || []).filter((x) => !kb.has(x.key)).map((x) => x.text);
    if (added.length) out.push(`${part}: now also ${added.join('; ')}`);
    if (gone.length) out.push(`${part}: no longer ${gone.join('; ')}`);
  }
  const sa = a.star ? a.star.name : null; const sb = b.star ? b.star.name : null;
  if (sa !== sb) out.push(`star of the week: was ${sa || 'nobody'}, now ${sb || 'nobody'}`);
  return out;
}

/** Last week's reds against this week's: delivered green, or still red. PURE. */
function carriedForward(previousReds, reds) {
  const now = new Set((reds || []).map((r) => r.key));
  return (previousReds || []).map((r) => ({ key: r.key, text: r.text, green: !now.has(r.key) }));
}

// ── Manual (Nick's words) ────────────────────────────────────────────────────

function emptyManual() { return { reds: {}, carried: {}, weakest: '', notes: '' }; }

function getManual(weekFrom) {
  try { return { ...emptyManual(), ...JSON.parse(db.getState(`${MANUAL_PREFIX}${weekFrom}`) || '{}') }; } catch { return emptyManual(); }
}

const clean = (s) => String(s === undefined || s === null ? '' : s).slice(0, 2000).trim();

/** Merge what Nick typed. Omitted fields are left alone; an empty string clears. */
function setManual(weekFrom, patch = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(weekFrom || ''))) throw Object.assign(new Error('weekFrom must be YYYY-MM-DD'), { status: 400 });
  const cur = getManual(weekFrom);
  if (patch.reds && typeof patch.reds === 'object') {
    for (const [k, v] of Object.entries(patch.reds)) cur.reds[k] = { action: clean(v && v.action) };
  }
  if (patch.carried && typeof patch.carried === 'object') {
    for (const [k, v] of Object.entries(patch.carried)) cur.carried[k] = { why: clean(v && v.why), consequences: clean(v && v.consequences) };
  }
  if (patch.weakest !== undefined) cur.weakest = clean(patch.weakest);
  if (patch.notes !== undefined) cur.notes = clean(patch.notes);
  db.setState(`${MANUAL_PREFIX}${weekFrom}`, JSON.stringify(cur));
  return cur;
}

/** What must be written before this report can be sent. PURE. */
function blockers(report, manual) {
  const out = [];
  const m = manual || emptyManual();
  for (const r of report.verdicts.reds) {
    if (!(m.reds[r.key] && m.reds[r.key].action)) out.push(`Red needs what you will do to make it green by next Monday: ${r.text}`);
  }
  for (const c of report.carried || []) {
    if (c.green) continue;
    const e = m.carried[c.key] || {};
    if (!e.why || !e.consequences) out.push(`Last week's red is still red — say why and what it costs the people around you: ${c.text}`);
  }
  return out;
}

// ── Render (PURE) ────────────────────────────────────────────────────────────

const fmtPct = (x) => (x && x.pct !== null && x.pct !== undefined ? `${x.pct}%` : '—');

function render(report, manual, { forEmail = false } = {}) {
  const m = manual || emptyManual();
  const v = report.verdicts;
  const L = [];
  const title = report.kind === 'provisional'
    ? `SOAP — week of ${shortDate(report.from)}–${shortDate(report.to)} (provisional, data to ${shortDate(report.upTo)})`
    : `SOAP — week of ${shortDate(report.from)}–${shortDate(report.to)}`;
  L.push(`# ${title}`, '');
  if (report.kind === 'provisional' && forEmail) {
    L.push('> Built on the Friday from Monday to Friday 16:00; the weekend is not in these figures. Sent on Monday only because the verdicts below were unchanged by the full week.', '');
  }

  L.push('## ✅ Success', '');
  if (v.success.length) for (const s of v.success) L.push(`- ${s.text}`);
  else L.push('- Nothing met its mark this week.');
  L.push('');

  L.push('## ⭐ Star of the week', '');
  if (v.star) {
    const bits = [v.star.team, v.star.solved !== null ? `${v.star.solved} solved` : null,
      v.star.slaCompliancePct !== null ? `SLA ${v.star.slaCompliancePct}%` : null,
      v.star.qaOverall !== null ? `QA ${v.star.qaOverall}` : null].filter(Boolean);
    L.push(`- **${v.star.name}**${bits.length ? ` — ${bits.join(' · ')}` : ''}`);
  } else L.push(report.gapsBySection.leaderboard ? `- Not available — ${report.gapsBySection.leaderboard}` : '- No agent ranked this week.');
  L.push('');

  L.push('## 🟠 Turning amber', '');
  if (v.ambers.length) for (const a of v.ambers) L.push(`- ${a.text}`);
  else L.push('- Nothing turning amber.');
  L.push('');

  L.push('## 🔴 Red — and what I will do', '');
  if (v.reds.length) {
    for (const r of v.reds) {
      const act = m.reds[r.key] && m.reds[r.key].action;
      L.push(`- **${r.text}** — ${act ? `I will: ${act}` : '_(action not written yet)_'}`);
    }
  } else L.push('- Nothing red.');
  L.push('');

  if ((report.carried || []).length) {
    L.push("## Last week's reds", '');
    for (const c of report.carried) {
      if (c.green) { L.push(`- 🟢 Delivered green: ${c.text}`); continue; }
      const e = m.carried[c.key] || {};
      L.push(`- 🔴 **Still red: ${c.text}** — why: ${e.why || '_(not written yet)_'}; consequences: ${e.consequences || '_(not written yet)_'}`);
    }
    L.push('');
  }

  L.push('## SLA adherence, day on day (Support: CC + T2 + Production)', '');
  if (report.slaDaily && report.slaDaily.length) {
    L.push('| Day | FRT | Resolution |', '|---|---|---|');
    for (const d of report.slaDaily) L.push(`| ${d.label} | ${fmtPct(d.frt)} | ${fmtPct(d.res)} |`);
  } else L.push(`- Not available — ${report.gapsBySection.sla || 'no daily SLA figures were returned'}`);
  L.push('');

  L.push('## Agents', '');
  const lb = report.leaderboard;
  if (lb && lb.top) {
    L.push(`- Top: **${lb.top.agentName}**${lb.top.compositeScore !== null && lb.top.compositeScore !== undefined ? ` (score ${lb.top.compositeScore})` : ''}`);
    if (lb.weakest) {
      const w = lb.weakest;
      const bits = [w.solved !== null && w.solved !== undefined ? `${w.solved} solved` : null,
        w.slaCompliancePct !== null && w.slaCompliancePct !== undefined ? `SLA ${w.slaCompliancePct}%` : null,
        w.qaOverall !== null && w.qaOverall !== undefined ? `QA ${w.qaOverall}` : 'QA —'].filter(Boolean);
      L.push(`- Least performing: **${w.agentName}** — ${bits.join(' · ')}`);
      L.push(`  - ${m.weakest ? m.weakest : '_(commentary not written yet)_'}`);
    }
    if (lb.rule) L.push(`- Ranked by NOVA: ${lb.rule}.`);
  } else L.push(`- Not available — ${report.gapsBySection.leaderboard || 'no ranked agents'}`);
  L.push('');

  L.push(`## Worst ${WORST_CUSTOMERS} customers`, '');
  const wc = report.customers;
  if (wc && wc.rows && wc.rows.length) {
    L.push(`As at ${String(wc.generatedAt || '').slice(0, 16).replace('T', ' ')}, in NOVA's order${wc.stale ? ' — NOVA says this list is stale' : ''}.`, '');
    for (const c of wc.rows) L.push(`${c.rank}. **${c.name}**${c.why ? ` — ${c.why}` : ''}`);
  } else if (wc && (wc.status === 'none_qualify' || wc.status === 'stale')) L.push(`- No customer has a negative current sentiment${wc.stale ? ' (NOVA says this list is stale)' : ''}.`);
  else L.push(`- Not available — ${report.gapsBySection.customers || 'NOVA did not answer'}`);
  L.push('');

  L.push('## Improvement initiatives', '');
  const p = report.plan;
  if (p && p.known) {
    L.push(`- ${p.totals.done} of ${p.totals.mine} of my plan actions done; ${p.open.length} open${p.overdue.length ? `, ${p.overdue.length} past due` : ''}.`);
    for (const d of p.doneThisWeek) L.push(`- Delivered this week: ${d.id} — ${d.action}`);
    for (const o of p.overdue.slice(0, 5)) L.push(`- Past due (${o.dueText}): ${o.id} — ${o.action}${o.percent !== null ? ` (${o.percent}%)` : ''}`);
  } else L.push(`- Not available — ${report.gapsBySection.plan || 'VANTAGE did not answer'}`);
  L.push('');

  if (m.notes) L.push('## Notes', '', m.notes, '');

  if (report.gaps.length) {
    L.push("## What NEURO couldn't read", '');
    for (const g of report.gaps) L.push(`- ${g.source}: ${g.why}`);
    L.push('');
  }
  return L.join('\n');
}

// ── Gather (I/O) ─────────────────────────────────────────────────────────────

async function gather({ kind, now = new Date(), overrides = {} } = {}) {
  const week = weekFor(kind, now);
  const gaps = [];
  const gapsBySection = {};
  const use = (name, fn) => (typeof overrides[name] === 'function' ? overrides[name] : fn);
  const pull = async (name, section, label, fn, { verdict = false } = {}) => {
    try { return await use(name, fn)(); } catch (e) {
      const why = e && e.message ? e.message : String(e);
      gaps.push({ source: label, why, verdict });
      gapsBySection[section] = why;
      return null;
    }
  };
  const nova = require('./nova-client');
  const bw = require('./briefing-weekly');

  const assessment = await pull('kpi', 'kpi', 'KPIs and risk findings from NOVA', async () => {
    if (!nova.isConfigured()) throw new Error('NOVA bridge not configured');
    const wr = require('./weekly-risk');
    const snap = await wr.snapshot({ week: week.fileWeek });
    const a = wr.assess(snap);
    const blocked = (a.findings || []).filter((f) => f.severity === 'blocked');
    for (const b of blocked) gaps.push({ source: b.title, why: b.detail, verdict: true });
    return a;
  }, { verdict: true });

  const metrics = [['frt', 'FRT'], ['res', 'Resolution']];
  const series = await pull('series', 'sla', 'daily SLA counts from NOVA', () => nova.call(
    `/api/neuro-bridge/kpi-org-series?days=21&keys=${bw.supportSlaKeys().join(',')}&to=${week.upTo}`,
  ), { verdict: true });
  const daily = series ? slaDaily(series, week, { queues: bw.SUPPORT_QUEUES, metrics }) : null;
  const supportSla = series ? bw.supportCompliance(series, {
    report: { from: week.from, to: week.upTo }, prior: { from: addDays(week.from, -7), to: addDays(week.from, -1) },
  }) : null;

  const lb = await pull('leaderboard', 'leaderboard', 'the agent leaderboard from NOVA',
    () => nova.call(`/api/neuro-bridge/agent-leaderboard?anchor=${week.upTo}`), { verdict: true });
  const leaderboard = lb ? bw.leaderboardSummary(lb) : null;

  const planRaw = await pull('plan', 'plan', 'the improvement plan from VANTAGE', () => require('./vantage-client').get('/api/plan'));
  const plan = planRaw ? (planRaw.available === false ? null : initiatives(planRaw, week)) : null;
  if (planRaw && planRaw.available === false) { gaps.push({ source: 'the improvement plan from VANTAGE', why: 'VANTAGE could not read the plan note', verdict: false }); gapsBySection.plan = 'VANTAGE could not read the plan note'; }

  const custRaw = await pull('customers', 'customers', 'worst customers from NOVA', async () => {
    try { return await nova.call(`/api/neuro-bridge/customers/worst?limit=${WORST_CUSTOMERS}`); } catch (e) {
      if (e.status === 404) throw new Error('NOVA has no worst-customer route yet');
      if (e.status === 503) throw new Error('NOVA is still building its customer index');
      throw e;
    }
  });
  const customers = custRaw ? {
    status: custRaw.status, generatedAt: custRaw.generatedAt || null, stale: custRaw.status === 'stale',
    rows: (custRaw.rows || []).slice(0, WORST_CUSTOMERS),
  } : null;

  const v = verdicts({ assessment, supportSla, leaderboard, plan });
  return {
    kind, from: week.from, to: week.to, upTo: week.upTo, generatedAt: new Date(now).toISOString(),
    verdicts: v, verdictHash: verdictHash(v), verdictComplete: !gaps.some((g) => g.verdict),
    slaDaily: daily, supportSla, leaderboard, plan, customers, gaps, gapsBySection,
  };
}

// ── Store ────────────────────────────────────────────────────────────────────

function _row(r) {
  if (!r) return null;
  const data = JSON.parse(r.data_json);
  return { ...data, kind: r.kind, from: r.week_from, generatedAt: r.generated_at, verdictHash: r.verdict_hash };
}

function get(weekFrom, kind) {
  return _row(db.get('SELECT * FROM soap_reports WHERE week_from = ? AND kind = ?', [weekFrom, kind]));
}
const finalFor = (weekFrom) => get(weekFrom, 'final');

function latest() {
  return _row(db.get(`SELECT * FROM soap_reports ORDER BY week_from DESC, CASE kind WHEN 'final' THEN 0 ELSE 1 END LIMIT 1`));
}

function list(limit = 12) {
  return db.all('SELECT week_from, kind, generated_at, verdict_hash FROM soap_reports ORDER BY week_from DESC, kind LIMIT ?', [limit])
    .map((r) => ({ weekFrom: r.week_from, kind: r.kind, generatedAt: r.generated_at }));
}

/** Build and store a report. The previous week's reds are carried in from its final (else its provisional). */
async function build({ kind, now = new Date(), overrides = {} } = {}) {
  const report = await gather({ kind, now, overrides });
  const prevFrom = addDays(report.from, -7);
  const prev = get(prevFrom, 'final') || get(prevFrom, 'provisional');
  report.carried = prev ? carriedForward(prev.verdicts.reds, report.verdicts.reds) : [];
  report.previousWeek = prev ? prevFrom : null;
  db.run(`INSERT INTO soap_reports (week_from, kind, week_to, generated_at, data_json, verdict_hash)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(week_from, kind) DO UPDATE SET week_to = excluded.week_to, generated_at = excluded.generated_at,
            data_json = excluded.data_json, verdict_hash = excluded.verdict_hash`,
  [report.from, kind, report.to, report.generatedAt, JSON.stringify(report), report.verdictHash]);
  console.log(`[SOAP] ${kind} for w/c ${report.from} built — ${report.verdicts.reds.length} red, ${report.verdicts.ambers.length} amber, ${report.gaps.length} gap(s)`);
  return report;
}

/** The report as Nick sees it: stored data + his words + what still blocks a send. */
function view(weekFrom, kind) {
  const r = get(weekFrom, kind);
  if (!r) return null;
  const manual = getManual(weekFrom);
  return { report: r, manual, markdown: render(r, manual), blockers: blockers(r, manual) };
}

// ── Recipients ───────────────────────────────────────────────────────────────

function recipientNames() {
  try {
    const v = JSON.parse(db.getState(RECIPIENTS_KEY) || 'null');
    if (Array.isArray(v) && v.length) return v.map(String);
  } catch { /* fall through */ }
  return [...DEFAULT_RECIPIENTS];
}

/**
 * Each recipient by EXACT People-note name with one address. A name the vault
 * cannot answer is a blocker with the reason — never a guess.
 */
function resolveRecipients() {
  const contacts = require('./contact-directory').fromPeopleNotes();
  const out = []; const problems = [];
  for (const name of recipientNames()) {
    const hits = contacts.filter((c) => c.name.toLowerCase() === name.toLowerCase());
    if (hits.length === 1) out.push({ name: hits[0].name, email: hits[0].email });
    else if (!hits.length) problems.push(`${name}: no People note with that exact name carries an email: line`);
    else problems.push(`${name}: more than one People note matches`);
  }
  return { recipients: out, problems };
}

// ── Leave ────────────────────────────────────────────────────────────────────

/** Is Nick off on the coming Monday? Manual leave flag first, then People HR via NOVA. */
function offOnMonday(now = new Date()) {
  const monday = addDays(mondayOf(ymd(now)), 7);
  const [y, m, d] = monday.split('-').map(Number);
  const at = new Date(y, m - 1, d, 9, 0, 0);
  try {
    const leave = require('./nudges').getLeave(at);
    if (leave.onLeave) return { monday, off: true, known: true, source: 'manual', detail: `annual leave until ${leave.until}` };
  } catch { /* fall through to People HR */ }
  const av = require('./team-availability');
  const mine = av.selfAbsenceOn(monday, av.snapshot(now));
  return { monday, off: !!mine.off, known: !!mine.known, source: 'peoplehr', detail: mine.detail || mine.reason || null };
}

// ── Sending (prepares only — the executor sends) ─────────────────────────────

/**
 * Freeze the provisional into a governed `send_soap_report` action. Refuses
 * while anything blocks it or a recipient cannot be resolved.
 */
function queueSend(weekFrom, { now = Date.now() } = {}) {
  const v = view(weekFrom, 'provisional');
  if (!v) return { ok: false, code: 404, error: 'no provisional report for that week — build it first' };
  if (v.blockers.length) return { ok: false, code: 409, error: 'the report is not finished', blockers: v.blockers };
  const { recipients, problems } = resolveRecipients();
  if (problems.length) return { ok: false, code: 409, error: 'a recipient cannot be resolved', blockers: problems };
  const markdown = render(v.report, v.manual, { forEmail: true });
  const html = require('./weekly-risk').toEmailHtml(markdown);
  return require('./prepared-actions').prepareSoapReport({
    weekFrom, recipients, markdown, html, verdictHash: v.report.verdictHash,
    notBefore: sendAtFor(weekFrom), subject: `SOAP — week of ${shortDate(v.report.from)}`, now,
  });
}

// ── Scheduled passes ─────────────────────────────────────────────────────────

function _push(title, body) {
  try { return require('./webpush').sendToAll(title, body, { type: 'soap_report', view: 'soap' }); } catch (e) {
    console.warn('[SOAP] push failed:', e.message);
    return null;
  }
}

/** Thursday 16:00: say early that Friday's provisional is coming. */
async function thursdayCheck({ now = new Date() } = {}) {
  const off = offOnMonday(now);
  if (off.off) _push('SAiM — SOAP report', `You're off Monday (${off.detail || off.source}). The provisional SOAP will be ready at 16:00 tomorrow for you to check and approve for sending to Ricky and Chris.`);
  else if (!off.known) console.warn(`[SOAP] Thursday check could not tell whether Monday is a day off: ${off.detail}`);
  return off;
}

/** Friday 16:00: when Nick is off Monday, build the provisional and ask. */
async function fridayCheck({ now = new Date() } = {}) {
  const off = offOnMonday(now);
  if (!off.off) {
    if (!off.known) console.warn(`[SOAP] Friday check could not tell whether Monday is a day off: ${off.detail}`);
    return { off, built: false };
  }
  const report = await build({ kind: 'provisional', now });
  const v = view(report.from, 'provisional');
  const todo = v.blockers.length;
  _push('SAiM — SOAP report', todo
    ? `You're off Monday. The provisional SOAP is ready — ${todo} thing(s) to write before it can be queued for Monday 08:00.`
    : `You're off Monday. The provisional SOAP is ready — check it, then Queue send and approve it in Actions.`);
  return { off, built: true, blockers: todo };
}

/** Monday 07:00: the full-week report, every week. */
async function mondayFinal({ now = new Date() } = {}) {
  return build({ kind: 'final', now });
}

/** Monday 08:30: say what happened to a send Nick approved on Friday. Once. */
function mondayOutcome({ now = new Date() } = {}) {
  const weekFrom = weekFor('final', now).from;
  const a = db.get(`SELECT action_id, status, outcome_detail, last_block FROM prepared_actions WHERE action_type = 'send_soap_report'
                    AND commitment_id = ? ORDER BY created_at DESC LIMIT 1`, [`soap:${weekFrom}`]);
  if (!a) return null;
  const key = `soap_outcome_told:${weekFrom}`;
  if (db.getState(key)) return a;
  let msg = null;
  if (['executed', 'verified'].includes(a.status)) msg = 'The SOAP report went to Ricky and Chris at 08:00.';
  else if (['cancelled', 'expired', 'failed'].includes(a.status)) {
    const prov = get(weekFrom, 'provisional');
    const fin = get(weekFrom, 'final');
    const diff = prov && fin ? verdictDiff(prov.verdicts, fin.verdicts) : [];
    msg = `The SOAP report was NOT sent: ${a.outcome_detail || a.status}.${diff.length ? ` What changed — ${diff.join(' | ')}` : ''}`;
  }
  else if (a.status === 'approved') msg = `The SOAP report is approved but has not gone yet: ${a.last_block || 'waiting'}.`;
  else if (a.status === 'prepared') msg = 'The SOAP report was queued but never approved, so it was not sent.';
  if (msg) { _push('SAiM — SOAP report', msg); db.setState(key, new Date(now).toISOString()); }
  return a;
}

module.exports = {
  weekFor, sendAtFor, slaDaily, parseDue, initiatives, findingKey, slaLight, verdicts, verdictHash, verdictDiff,
  carriedForward, blockers, render, emptyManual, getManual, setManual, gather, build, get, finalFor, latest, list, view,
  recipientNames, resolveRecipients, offOnMonday, queueSend, thursdayCheck, fridayCheck, mondayFinal, mondayOutcome,
  EXCLUDED_KINDS, AMBER_BAND, WORST_CUSTOMERS, DEFAULT_RECIPIENTS,
};
