#!/usr/bin/env node
// End-to-end read of REAL copied data through the local adapter (15 Oct 2026).
//
//   node backend/scripts/alt-manifest-e2e.mjs [--base http://127.0.0.1:3011] [--out dir]
//
// Talks ONLY to the local read-only harness (local-readonly-server.js) — it
// refuses any base that is not loopback. For each surface it reads
// /api/canonical/now, checks the three contracts, runs the adapter, checks every
// visible string is safe, resolves every NEURO link the hand-off offers through
// /api/links/resolve, and finally confirms the harness refused zero outbound
// calls. Exit 1 on any failure.

import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath, pathToFileURL } from 'url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CONTRACTS = require(path.join(ROOT, 'shared', 'attention-contracts.cjs'));
const DISPLAY = require(path.join(ROOT, 'shared', 'display-text.cjs'));
const { manifest, visibleStrings } = await import(pathToFileURL(path.join(ROOT, 'saim', 'app', 'alt-v2-manifest', 'manifest.mjs')).href);

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const BASE = arg('base', 'http://127.0.0.1:3011');
const OUT = arg('out', null);
const PIN = 'local-readonly';
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(BASE)) { console.error('refusing: base must be the local harness'); process.exit(2); }

const failures = [];
const fail = (m) => { failures.push(m); console.log(`  ✖ ${m}`); };
const get = async (p) => { const r = await fetch(`${BASE}${p}`, { headers: { 'X-NEURO-PIN': PIN } }); return { status: r.status, body: await r.json().catch(() => null) }; };

const reports = [];
for (const surface of ['work-desktop']) {
  const { status, body: p } = await get(`/api/canonical/now?surface=${surface}`);
  console.log(`\n/now?surface=${surface} → ${status}`);
  if (status !== 200) { fail(`${surface}: /now answered ${status}`); continue; }
  for (const [label, chk, v] of [['candidates', CONTRACTS.checkCandidates, p.candidates], ['saim', CONTRACTS.checkAttention, p.saim], ['handoff', CONTRACTS.checkHandoff, p.handoff]]) {
    const r = chk(v); console.log(`  ${label}: ${r.ok ? r.contract : `REFUSED ${r.reason}`}`);
    if (!r.ok) fail(`${surface}: ${label} ${r.reason}`);
  }
  const vm = manifest(p);
  if (vm.refused) fail(`${surface}: adapter refused — ${vm.refused.problem}`);
  const vs = visibleStrings(vm);
  const unsafe = vs.filter((s) => !DISPLAY.isSafeDisplay(s));
  if (unsafe.length) fail(`${surface}: unsafe visible strings ${JSON.stringify(unsafe)}`);
  for (const k of ['next', 'held', 'judgement']) {
    const sec = vm.rail[k];
    if (sec.unread && !sec.why) fail(`${surface}: rail ${k} not read with no reason`);
  }
  const links = [];
  if (vm.handoff) for (const d of [vm.handoff.primary, ...vm.handoff.alternatives]) if (d.href && d.href.startsWith('neuro:')) links.push(d.href);
  for (const href of links) {
    const r = await get(`/api/links/resolve?href=${encodeURIComponent(href)}`);
    console.log(`  link ${href} → ${r.status}${r.body && r.body.status ? ` ${r.body.status}` : ''}`);
    if (r.status !== 200) fail(`${surface}: hand-off link ${href} did not resolve (${r.status})`);
  }
  console.log(`  rule ${vm.rule} · "${vm.state}" · ${vm.title}`);
  console.log(`  hand-off: ${vm.handoff ? `${vm.handoff.primary.label} + [${vm.handoff.alternatives.map((a) => a.label).join(', ')}]` : `none — ${vm.handoffNote}`}`);
  if (vm.ask) console.log(`  ask: ${vm.ask.question} ${vm.ask.options.map((o) => o.label).join(' / ')}`);
  console.log(`  rail: next ${vm.rail.next.unread ? 'NOT READ' : vm.rail.next.empty ? 'empty' : vm.rail.next.title} · held ${vm.rail.held.unread ? 'NOT READ' : vm.rail.held.count} · judgement ${vm.rail.judgement.unread ? 'NOT READ' : vm.rail.judgement.items.length}`);
  console.log(`  visible strings ${vs.length}, unsafe ${unsafe.length}`);
  reports.push({ surface, rule: vm.rule, policyVersion: p.saim.policyVersion, resolverVersion: p.handoff.resolverVersion, vm });
  if (OUT) fs.writeFileSync(path.join(OUT, `real-${surface}.json`), JSON.stringify(p, null, 2));
}

const ob = await fetch(`${BASE}/local/outbound`).then((r) => r.json());
console.log(`\noutbound attempts refused by the harness: ${ob.refused}`);
if (ob.refused) console.log(JSON.stringify(ob.attempts.slice(0, 10), null, 1));
if (OUT) fs.writeFileSync(path.join(OUT, 'e2e-report.json'), JSON.stringify({ reports, outbound: ob, failures }, null, 2));
console.log(failures.length ? `\nFAILED (${failures.length})` : '\nOK');
process.exitCode = failures.length ? 1 : 0; // not process.exit(): on Windows it races undici's open handles
