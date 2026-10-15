#!/usr/bin/env node
'use strict';

// Prints the SAiM Attention Policy decision table (markdown) from the same
// scenario runs the tests assert — so the contract's table cannot drift from
// the code. Usage: node backend/scripts/saim-policy-table.js > table.md
// Read-only: runs pure functions over fixtures; touches no database or network.

const { SCENARIOS, row } = require('../services/saim-policy-scenarios');

const rows = SCENARIOS.map(row);
const cell = (s) => String(s).replace(/\|/g, '\\|');

console.log('| # | Scenario | Surface → scope | Lead (rule) | Protected | Held | Recommended action |');
console.log('|---|---|---|---|---|---|---|');
for (const r of rows) {
  console.log(`| ${r.id} | ${cell(r.name)} | ${r.surface} → ${r.scope} | ${cell(r.lead)} — **${r.rule}** | ${cell(r.protected)} | ${cell(r.held)} | ${cell(r.recommended)}${r.alternatives !== '—' ? ` (also: ${cell(r.alternatives)})` : ''} |`);
}
console.log('');
for (const r of rows) {
  console.log(`**${r.id}. ${r.name}**`);
  console.log(`- Candidates (kind/sphere): ${r.candidates}. Excluded by scope: ${r.excluded}.`);
  console.log(`- Lead: ${r.lead === '—' ? 'none' : `“${r.lead}”`} — “${r.why}”`);
  console.log(`- Judgement: ${r.judgement}. Policy review: ${r.review}.`);
  console.log(`- Trace: ${r.trace} — ${r.traceWhy}`);
  console.log('');
}
