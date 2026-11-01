'use strict';

/**
 * Pre-filled answers for the weekly report's manual sections (1 Nov 2026).
 *
 * Nick: by the Monday 07:30 build NEURO should have filled in every manual
 * section from data, so he only reviews, edits and sends. The four sections are
 * overtime, "to escalate to Chris", actions this week and data quality.
 *
 * ⚠⚠ A SUGGESTION IS NOT AN ANSWER. Each one is stored here, apart from the
 * manual answers, with the exact sources it was built from, and the report
 * renders it as "Suggested — check". `weekly-risk.publish()` is still blocked
 * until Nick accepts or edits each one. Nothing here writes a manual answer and
 * nothing here sends anything.
 *
 * Three rules:
 *   1. A source that could not be read proposes NOTHING for its section and is
 *      named as a gap. An empty answer from a source that WAS read proposes an
 *      explicit "None this week", which is still a claim Nick has to accept.
 *   2. Overtime keeps nil and unknown apart: 0 hours is proposed only when both
 *      overtime sources answered and held nothing for the week.
 *   3. A section Nick has answered keeps the proposal that was standing when he
 *      answered it; a rebuild never touches it. A rebuild before he answers
 *      replaces the proposal with a fresh one.
 *
 * The `propose*` functions are PURE (inputs in, proposal or gap out). The store
 * is one agent_state key per week.
 */

const crypto = require('crypto');
const db = require('../db/database');

const SECTIONS = Object.freeze(['overtime', 'escalateToChris', 'actions', 'dataQuality']);
const LABEL = Object.freeze({
  overtime: 'Overtime',
  escalateToChris: 'To escalate to Chris',
  actions: 'Actions this week',
  dataQuality: 'Data quality',
});
const KEY = week => `weekly_risk_proposals_${week}`;

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const clip = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const inSpan = (d, from, to) => { const s = d ? String(d).slice(0, 10) : null; return Boolean(s && s >= from && s <= to); };
const round2 = n => Math.round(n * 100) / 100;

/** A stable fingerprint of a proposal's value, so Accept accepts what was shown. */
function hashOf(value) {
  return crypto.createHash('sha1').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}

function proposal(section, value, sources) {
  const none = section === 'overtime'
    ? value.hours === 0 && !value.approvalsOutstanding
    : Array.isArray(value) && value.length === 0;
  return { section, value, sources, none, hash: hashOf(value) };
}
const gap = (section, reason) => ({ gap: { section, reason } });

// ── Overtime ─────────────────────────────────────────────────────────────────

/**
 * PURE. `claims` = { ok, approved: [], submitted: [], error } from NOVA's
 * overtime claims; `log` = { ok, rows: [], error } from the older overtime log.
 * Both must answer: a total built from one of two sources is understated, and
 * an understated overtime figure in Chris's report is a claim.
 */
function proposeOvertime({ claims, log, from, to }) {
  if (!claims || !claims.ok) return gap('overtime', `NOVA overtime claims could not be read${claims?.error ? ` (${claims.error})` : ''} — no overtime figure suggested.`);
  if (!log || !log.ok) return gap('overtime', `The older overtime log could not be read${log?.error ? ` (${log.error})` : ''} — no overtime figure suggested.`);

  const approved = (claims.approved || []).filter(c => inSpan(c.date, from, to));
  const waiting = (claims.submitted || []).filter(c => inSpan(c.date, from, to));
  const logRows = (log.rows || []).filter(r => inSpan(r.work_date, from, to));
  const logApproved = logRows.filter(r => r.outcome === 'approved');
  const logPending = logRows.filter(r => r.outcome === 'pending');

  const minutes = approved.reduce((s, c) => s + (Number(c.minutes) || 0), 0);
  const hours = round2(minutes / 60 + logApproved.reduce((s, r) => s + (Number(r.hours) || 0), 0));
  const approvalsOutstanding = waiting.length + logPending.length;

  let note;
  if (!approved.length && !logApproved.length) {
    note = 'No overtime logged this period';
  } else {
    const named = approved.slice(0, 3).map(c => `${c.agentName || 'someone'} ${round2((Number(c.minutes) || 0) / 60)}h${c.reason ? ` (${clip(c.reason, 60)})` : ''}`);
    const more = approved.length > 3 ? `, and ${approved.length - 3} more` : '';
    note = approved.length ? `${named.join('; ')}${more}` : '';
    if (logApproved.length) note = `${note ? `${note}; ` : ''}${plural(logApproved.length, 'approval')} in the older overtime log`;
  }

  return proposal('overtime', { hours, approvalsOutstanding, note }, [
    `${plural(approved.length, 'approved overtime claim')} in NOVA dated ${from} to ${to}${waiting.length ? `, ${waiting.length} still waiting for your decision` : ''}`,
    `${plural(logRows.length, 'row')} in the older overtime log for the same week`,
  ]);
}

// ── Escalations to Chris ─────────────────────────────────────────────────────

/**
 * PURE. My escalations (raised in Jira + by email), the open "discuss with
 * Chris" items, and the report's own escalation findings.
 */
function proposeEscalations({ myEscalations, findings, failedSources = [] }) {
  if (!myEscalations || myEscalations.error || myEscalations.total == null) {
    const why = myEscalations?.error
      || [myEscalations?.jira?.error, myEscalations?.email?.error].filter(Boolean).join('; ')
      || 'not read';
    return gap('escalateToChris', `Your escalations for the week could not be read (${why}) — no escalation list suggested.`);
  }
  const esc = (findings || []).filter(f => f && f.severity === 'escalate');

  const items = esc.map(f => `${f.title} — ${f.detail}`);
  if (myEscalations.total > 0) {
    const keys = [...new Set([...(myEscalations.jira?.tickets || []), ...(myEscalations.email?.tickets || [])])];
    const shown = keys.slice(0, 8).join(', ');
    items.push(`I escalated ${plural(myEscalations.total, 'ticket')} myself this week (${myEscalations.jira.count} raised in Jira, ${myEscalations.email.count} by email)${shown ? `: ${shown}${keys.length > 8 ? ` and ${keys.length - 8} more` : ''}` : ''}`);
  }

  // An empty list built while part of the report did not answer would claim
  // "nothing to escalate" on the strength of missing data.
  if (!items.length && failedSources.length) {
    return gap('escalateToChris', `${plural(failedSources.length, 'report source')} did not answer (${failedSources.join(', ')}) — "nothing to escalate" is not suggested on partial data.`);
  }

  return proposal('escalateToChris', items, [
    `${plural(esc.length, 'escalation finding')} in this report`,
    `your escalations: ${myEscalations.total} (${myEscalations.jira.count} raised in Jira, ${myEscalations.email.count} by email)`,
    ...(failedSources.length ? [`⚠ ${plural(failedSources.length, 'report source')} did not answer, so the findings may be incomplete`] : []),
  ]);
}

// ── Actions ──────────────────────────────────────────────────────────────────

/**
 * PURE. Management-log items opened, closed or overdue in the week, after any
 * open action carried from last week.
 */
function proposeActions({ management, carried = [], from, to }) {
  if (!management || !Array.isArray(management.rows)) {
    return gap('actions', 'The management log could not be read — no actions suggested.');
  }
  const textOf = r => `${clip(r.summary, 160)}${r.action && r.action !== r.summary ? `: ${clip(r.action, 120)}` : ''}${r.person ? ` (${r.person})` : ''}`;
  const out = [];
  const seen = new Set();
  const push = (text, done, extra = {}) => {
    const k = text.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ text, done, ...extra });
  };
  for (const a of carried) if (a && a.text) push(a.text, Boolean(a.done), a.carriedFrom ? { carriedFrom: a.carriedFrom } : {});

  let opened = 0; let closed = 0; let overdue = 0;
  const ids = new Set();
  for (const r of management.rows) {
    const isDone = r.status === 'done';
    if (isDone && inSpan(r.resolved_date, from, to)) {
      push(textOf(r), true); closed += 1; ids.add(r.id);
    } else if (!isDone && (inSpan(r.entry_date, from, to) || inSpan(r.logged_at, from, to))) {
      push(`${textOf(r)}${r.due_date ? ` — due ${r.due_date}` : ''}`, false); opened += 1; ids.add(r.id);
    }
  }
  for (const o of management.overdue || []) {
    if (ids.has(o.id)) continue;
    push(`${clip(o.summary, 160)} — overdue ${plural(o.workingDaysOverdue || 0, 'working day')}`, false); overdue += 1;
  }
  return proposal('actions', out, [
    `management log: ${opened} opened and ${closed} closed in the week, ${overdue} overdue`,
    `${plural(carried.length, 'open action')} carried from last week`,
  ]);
}

// ── Data quality ─────────────────────────────────────────────────────────────

/**
 * PURE. The report's own source gaps and the fixes Nick included for the week
 * (`fixes` = report-fixes.forReport output; `rf` its line formatters).
 */
function proposeDataQuality({ sources = [], fixes, rf }) {
  if (!fixes || fixes.unreadable) {
    return gap('dataQuality', `The fixes log could not be read${fixes?.unreadable ? ` (${fixes.unreadable})` : ''} — no data-quality list suggested.`);
  }
  const failed = sources.filter(s => s && !s.ok);
  const items = failed.map(s => `NOVA ${s.name} did not answer (${clip(s.error, 120) || 'no reason given'}) — sections built on it are absent this week, not zero.`);
  for (const c of fixes.corrections || []) items.push(`Data correction: ${rf.correctionLine(c)}`);
  for (const f of (fixes.fixed || []).filter(x => !(x.impact || []).includes('figures'))) items.push(rf.fixedLine(f));
  return proposal('dataQuality', items, [
    `${plural(sources.length, 'report source')} checked, ${failed.length} did not answer`,
    `${plural((fixes.corrections || []).length, 'data correction')} and ${plural((fixes.fixed || []).length, 'fix', 'fixes')} included in the fixes log for the week`,
  ]);
}

/** PURE. All four, from what the report already gathered. */
function proposeAll(input) {
  const results = {
    overtime: proposeOvertime({ claims: input.overtimeClaims, log: input.overtimeLog, from: input.from, to: input.to }),
    escalateToChris: proposeEscalations({
      myEscalations: input.myEscalations, chrisAgenda: input.chrisAgenda, findings: input.findings,
      failedSources: (input.sources || []).filter(s => s && !s.ok).map(s => s.name),
    }),
    actions: proposeActions({ management: input.management, carried: input.carried || [], from: input.from, to: input.to }),
    dataQuality: proposeDataQuality({ sources: input.sources, fixes: input.fixes, rf: input.rf }),
  };
  const sections = {};
  const gaps = [];
  for (const s of SECTIONS) {
    if (results[s].gap) gaps.push(results[s].gap);
    else sections[s] = results[s];
  }
  return { sections, gaps };
}

// ── Store ────────────────────────────────────────────────────────────────────

function read(week) {
  const raw = db.getState(KEY(week));
  if (!raw) return null;
  try {
    const p = JSON.parse(raw);
    return p && typeof p === 'object' ? { sections: p.sections || {}, gaps: p.gaps || [], builtAt: p.builtAt || null } : null;
  } catch { return null; }
}

/**
 * Store a fresh set, sparing every section Nick has answered: its stored
 * proposal (if any) is kept as the record of what was suggested. An unanswered
 * section takes the new proposal, or loses its old one when its source could
 * not be read this time.
 */
function refresh(week, computed, isAnswered, now = new Date()) {
  const prev = read(week) || { sections: {}, gaps: [] };
  const at = now.toISOString();
  const sections = {};
  const gaps = [];
  for (const s of SECTIONS) {
    if (isAnswered(s)) {
      if (prev.sections[s]) sections[s] = prev.sections[s];
      continue;
    }
    const next = computed.sections[s];
    if (next) {
      const old = prev.sections[s];
      sections[s] = { ...next, builtAt: old && old.hash === next.hash ? old.builtAt : at };
    } else {
      const g = computed.gaps.find(x => x.section === s);
      if (g) gaps.push(g);
    }
  }
  const stored = { sections, gaps, builtAt: at };
  db.setState(KEY(week), JSON.stringify(stored));
  return stored;
}

/** What the screen and the report read: each proposal with whether it is answered. */
function view(stored, isAnswered) {
  const sections = {};
  let pending = 0;
  for (const s of SECTIONS) {
    const p = stored && stored.sections[s];
    if (!p) continue;
    const answered = isAnswered(s);
    if (!answered) pending += 1;
    sections[s] = { ...p, label: LABEL[s], answered };
  }
  return { sections, gaps: (stored && stored.gaps) || [], pending, builtAt: (stored && stored.builtAt) || null };
}

module.exports = {
  SECTIONS, LABEL, KEY,
  hashOf, proposeOvertime, proposeEscalations, proposeActions, proposeDataQuality, proposeAll,
  read, refresh, view,
};
