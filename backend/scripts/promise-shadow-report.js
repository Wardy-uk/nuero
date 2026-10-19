#!/usr/bin/env node
'use strict';

// The meeting-promises shadow review, as markdown. READ-ONLY.
//   node backend/scripts/promise-shadow-report.js [--days=14]
// Label entries with POST /api/promises/shadow/:id/label {label: tp|fp|unsure}
// and record a promise the shadow missed with POST /api/promises/shadow/missed.

const arg = process.argv.find((a) => a.startsWith('--days='));
const days = arg ? Number(arg.split('=')[1]) : 14;
if (!(Number.isInteger(days) && days >= 1 && days <= 60)) { console.error('--days must be 1–60'); process.exit(2); }

(async () => {
  const db = require('../db/database');
  await db.init();
  const r = require('../services/promise-shadow').report({ days });
  if (!r.ok) { console.log(r.error); process.exit(0); } // never creates the table
  const L = [];
  const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : '—');
  L.push(`# Meeting promises — shadow review (${r.window.from.slice(0, 10)} → ${r.window.to.slice(0, 10)})`, '');
  L.push('Nothing below was shown or sent. Each line is what SAiM WOULD have done.', '');
  L.push(`Uptime: ${r.heartbeats} hourly heartbeats.`);
  if (r.counters) {
    const c = r.counters;
    L.push(`Run counters (process since ${String(c.since || '?').slice(0, 16)}, as at ${c.at.slice(0, 16)}): ${c.ticks} ticks · ${c.skipped} skipped on clock + calendar alone · ${c.snapshots} ledger reads · ${c.nowReads} Now/presence reads (${c.nowReadsBundle} bundle, ${c.nowReadsMeeting} pre-meeting) · ${c.nowAvoided || 0} passes settled from history without one ·${c.meetingReinspections} changed-meeting re-reads · ${c.calendarErrors} calendar read errors.`);
    if (c.net) L.push(`Network (local reads only): allowed ${JSON.stringify(c.net.allowed)} · refused before the network ${JSON.stringify(c.net.refused)}.`);
  }
  L.push('', '## Builds the rows ran under');
  for (const b of r.builds) L.push(`- ${b.runningSha ? b.runningSha.slice(0, 10) : 'unknown'} · code ${b.codeHash || '?'} · ${b.rows} rows · ${b.first.slice(0, 16)} → ${b.last.slice(0, 16)}${b.dirty ? ' · DIRTY' : ''}${b.stale ? ' · STALE (checkout moved, not restarted)' : ''}`);
  L.push('');
  L.push('## Proposals', `Would have raised: ${r.proposals.total} (tp ${r.proposals.tp}, fp ${r.proposals.fp}, unlabelled ${r.proposals.unlabelled})`);
  for (const s of r.proposals.suppressed) L.push(`- #${s.id} ${s.at.slice(0, 16)} suppressed: ${s.why}`);
  L.push('', '## Would-be prompts', `Total ${r.prompts.total} — true positives ${r.prompts.tp}, false positives ${r.prompts.fp}, unsure ${r.prompts.unsure}, unlabelled ${r.prompts.unlabelled}; precision of labelled: ${pct(r.prompts.tp, r.prompts.tp + r.prompts.fp)}`);
  L.push(`By moment: ${JSON.stringify(r.prompts.byMoment)}`, '');
  L.push('## Would have interrupted');
  for (const w of r.wouldHaveInterrupted) L.push(`- #${w.id} ${w.at.slice(0, 16)} [${w.moment}] ${w.label ? `(${w.label}) ` : ''}${w.say || w.key} — ${w.why}`);
  L.push('', '## Routing-only (employment matters — no draft, no prompt)', `Distinct promises: ${r.routingOnly.promises.length}; daily entries labelled tp ${r.routingOnly.tp}, fp ${r.routingOnly.fp}, unlabelled ${r.routingOnly.unlabelled}`);
  for (const p of r.routingOnly.promises) L.push(`- ${p.key} tasks ${(p.taskIds || []).join(',')} · ${p.rule || 'rule?'} · ${p.days} day(s)${p.label ? ` · ${p.label}` : ''}`);
  L.push('', '## Suppressions', `Total ${r.suppressions.total}`);
  for (const [why, n] of Object.entries(r.suppressions.byReason)) L.push(`- ${n} × ${why}`);
  L.push('', '## Missed (found by Nick)');
  if (!r.missed.length) L.push('- none recorded');
  for (const m of r.missed) L.push(`- #${m.id} ${m.at.slice(0, 10)} ${m.taskId ? `task #${m.taskId} ` : ''}${m.text || ''}${m.note ? ` — ${m.note}` : ''}`);
  console.log(L.join('\n'));
})().catch((e) => { console.error(e); process.exit(1); });
