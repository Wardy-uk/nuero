'use strict';

/**
 * Automatic context linking lives in SETTINGS and nowhere else (22 Oct 2026).
 *
 *  - the control (activate / deactivate / the backfill tick) is mounted ONLY by
 *    AdminPanel (Settings); Brain Health mounts a read-only status that GETs only;
 *  - no other frontend, SAiM or VESTA source names the activate/deactivate routes;
 *  - machine clients cannot enable, disable or start a scan: the authority matrix
 *    refuses all three, the MCP gateway marks all three interactive, and no chat
 *    tool reaches them;
 *  - status() reports next run only while on, in London time across both clock changes.
 *
 * Source scans carry positive controls so a scan that reads nothing cannot pass.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) continue;
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) walk(rel, out);
    else if (/\.(jsx?|mjs|cjs)$/.test(e.name)) out.push(rel.split(path.sep).join('/'));
  }
  return out;
}

const UI_DIRS = ['frontend/src', 'saim/app/src', 'saim/shared-ui', 'saim/frontend/src', 'vesta/src'].filter((d) => fs.existsSync(path.join(ROOT, d)));

test('the switch is mounted only by Settings (AdminPanel)', () => {
  const files = UI_DIRS.flatMap((d) => walk(d));
  assert.ok(files.length > 50, 'positive control: the scan read the UI sources');
  const importers = files.filter((f) => /from\s+['"]\.\/TaskContextActivation(\.jsx)?['"]/.test(read(f)));
  assert.deepEqual(importers, ['frontend/src/components/AdminPanel.jsx']);
  const routeCallers = files.filter((f) => /\/api\/task-context\/(activate|deactivate)/.test(read(f)));
  assert.deepEqual(routeCallers, ['frontend/src/components/TaskContextActivation.jsx']);
});

test('Brain Health only reads the status and links to Settings', () => {
  const brain = read('frontend/src/components/BrainHealthPanel.jsx');
  assert.match(brain, /TaskContextStatus/);
  assert.doesNotMatch(brain, /TaskContextActivation/);
  const st = read('frontend/src/components/TaskContextStatus.jsx');
  assert.match(st, /\/api\/task-context\/status/, 'positive control');
  assert.doesNotMatch(st, /method:\s*['"]POST|\/activate|\/deactivate|\/scan/);
  assert.match(st, /onNavigate\('admin'\)/);
  assert.match(read('frontend/src/App.jsx'), /case 'brain-health': return <BrainHealthPanel onNavigate=\{handleNavigate\} \/>/);
});

test('machines cannot enable, disable or scan: matrix refuses, gateway is interactive, chat has no tool', () => {
  const matrix = require('./authority-matrix');
  for (const p of ['/api/task-context/activate', '/api/task-context/deactivate', '/api/task-context/scan']) {
    const rule = matrix.resolve ? matrix.resolve('POST', p) : null;
    const src = read('backend/services/authority-matrix.js');
    assert.match(src, new RegExp(`R\\('POST', '${p.replace(/\//g, '\\/')}', '[^']+', \\{ machine: 'refuse' \\}\\)`));
    if (rule) assert.equal(rule.machine, 'refuse');
  }
  const policy = require('../../mcp-server/remote/api-policy.js');
  for (const id of ['post_task_context_activate', 'post_task_context_deactivate', 'post_task_context_scan']) {
    assert.ok(policy.interactive[id], `${id} is interactive in the gateway`);
  }
  assert.match(policy.interactive.post_task_context_activate, /NEURO → Settings/);
  for (const f of ['backend/services/chat-tools.js', 'backend/services/claude.js', 'backend/services/standup-session.js']) {
    assert.doesNotMatch(read(f), /task-context\/(activate|deactivate|scan)|taskContext\.(activate|deactivate|runScan)/, f);
  }
  // Manual linking stays reachable for a human whether or not automatic linking is on.
  assert.match(read('backend/routes/task-context.js'), /router\.post\('\/tasks\/:taskId\/links'/);
});

test('status: next run only while on, London time across the clock changes; last result from the receipt', () => {
  const tc = require('./task-context');
  assert.equal(tc.nextRunAt(Date.parse('2026-10-22T12:00:00Z')), '2026-10-23T02:40:00.000Z', 'BST');
  assert.equal(tc.nextRunAt(Date.parse('2026-10-24T03:00:00Z')), '2026-10-25T03:40:00.000Z', 'clocks go back on the 25th');
  assert.equal(tc.nextRunAt(Date.parse('2026-03-29T00:30:00Z')), '2026-03-29T02:40:00.000Z', 'clocks go forward on the 29th');
  assert.equal(tc.lastResultSay({ ok: true, receipt: { tasks: 1, pinned: 0, suggested: 3 } }), 'Last scan: 1 open task, 0 pinned, 3 suggested.');
  assert.match(tc.lastResultSay({ ok: false, error: 'vault unreadable' }), /failed: vault unreadable/);
  assert.equal(tc.lastResultSay(null), null);
  assert.match(tc.WAITING_SAY, /NEURO → Settings/);
  assert.match(tc.WAITING_SAY, /by hand/);
});
