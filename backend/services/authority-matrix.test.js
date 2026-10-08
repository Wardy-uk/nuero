'use strict';

/**
 * Build 14F — the authority matrix is configuration that fails when it drifts.
 *
 * Four independent descriptions of "who may do what" exist: this matrix, the
 * A4 action registry, the external-writes register and the MCP gateway's
 * interactive list. These tests make them agree, and make every inventoried
 * route resolve to a capability.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

const m = require('./authority-matrix');
const registry = require('./action-registry');
const ext = require('./external-writes');
const inventory = require('../../mcp-server/remote/api-inventory.json');

const policy = () => import(pathToFileURL(path.join(__dirname, '..', '..', 'mcp-server', 'remote', 'api-policy.js')).href);

test('every capability is fully declared, on the A0–A4 scale, and A4 never executes for a machine', () => {
  for (const [id, c] of Object.entries(m.CAPABILITIES)) {
    for (const k of ['authority', 'effect', 'machine', 'approval', 'ledger', 'verification', 'idempotent']) {
      assert.ok(k in c, `${id} declares ${k}`);
    }
    assert.ok(registry.AUTHORITY[c.authority], `${id}: ${c.authority}`);
    assert.ok(['execute', 'execute-bounded', 'prepare', 'refuse', 'retired'].includes(c.machine), id);
    if (c.authority === 'A4') assert.ok(!c.machine.startsWith('execute'), `${id} is A4 and must not execute for a machine`);
    if (c.machine === 'execute-bounded') {
      assert.ok(Array.isArray(c.bounds) && c.bounds.length, `${id} states its bounds`);
      assert.ok(c.preauthorisation, `${id} states its pre-authorisation boundary`);
    }
  }
});

test('the 14F matrix covers every named external write', () => {
  for (const id of ['email.send', 'calendar.attendee.create', 'calendar.attendee.reschedule', 'calendar.attendee.cancel',
    'calendar.solo', 'jira.escalate', 'microsoft.task.complete', 'homeassistant.room', 'file.write', 'vault.write',
    'task.status', 'config.preference', 'config.security']) {
    assert.ok(m.CAPABILITIES[id], id);
  }
});

test('every route in the MCP inventory resolves to a capability (no silent defaults for a new domain)', () => {
  const unmapped = inventory.filter((o) => !m.resolve(o.method, o.route).capability).map((o) => `${o.method} ${o.route}`);
  assert.deepEqual(unmapped, []);
});

test('an unmapped non-GET is REFUSED to a machine (fail closed); a GET is a read', () => {
  assert.equal(m.machineDecision('POST', '/api/no-such-domain/x').allow, false);
  assert.equal(m.machineDecision('GET', '/api/no-such-domain/x').allow, true);
  assert.equal(m.resolve('GET', '/api/todos').capability, 'read');
});

test('the MCP gateway does not offer what the matrix refuses — and refuses nothing the matrix allows, bar named exceptions', async () => {
  const { interactive } = await policy();
  const offered = inventory.filter((o) => !m.machineDecision(o.method, o.route).allow && !interactive[o.id]).map((o) => o.id);
  assert.deepEqual(offered, [], 'routes the backend refuses must be interactive in the gateway');
  // The gateway may be STRICTER than the matrix only where the reason is written here.
  const STRICTER = {
    post_actions_by_id_approve: 'local MCP approves internal suggestions (bounded); the remote gateway does not offer it',
    post_projects_github_snapshot: 'Build 24: the reporter on Nick\'s machine posts GitHub metadata directly with the API token; an agent through the gateway must never supply repo evidence',
  };
  const extra = Object.keys(interactive).filter((id) => {
    const o = inventory.find((x) => x.id === id);
    return o && m.machineDecision(o.method, o.route).allow && !STRICTER[id];
  });
  assert.deepEqual(extra, []);
});

test('every executable A4 type in the action registry is a prepare-only capability here', () => {
  const covered = new Set();
  for (const c of Object.values(m.CAPABILITIES)) {
    if (c.registry && c.registry.startsWith('action-registry:')) {
      for (const t of c.registry.slice('action-registry:'.length).split(',')) {
        covered.add(t);
        assert.equal(registry.ACTION_TYPES[t].authority, c.authority, t);
        assert.equal(c.machine, 'prepare', t);
      }
    }
  }
  assert.deepEqual(registry.executableTypes().filter((t) => !covered.has(t)), []);
});

test('every external-writes writer is in the matrix at the same authority', () => {
  const byWriter = new Map();
  for (const [id, c] of Object.entries(m.CAPABILITIES)) {
    if (c.registry && c.registry.startsWith('external-writes:')) byWriter.set(c.registry.slice('external-writes:'.length), { id, c });
  }
  // The register is the authority: it is imported, not restated.
  const writers = require('./external-writes');
  const names = Object.keys(writers.WRITERS || {});
  assert.ok(names.length > 5, 'positive control: the register is readable');
  for (const w of names) {
    assert.ok(byWriter.has(w), `${w} has a capability`);
    assert.equal(byWriter.get(w).c.authority, writers.WRITERS[w].authority, w);
  }
  assert.ok(ext.begin);
});

test('specific decisions: completion bounded, progress/fields/rooms/escalation refused, passthrough retired', () => {
  assert.equal(m.machineDecision('POST', '/api/todos/complete-ms').mode, 'execute-bounded');
  for (const [M, p] of [['POST', '/api/todos/wip-ms'], ['PATCH', '/api/todos/ms/abc'], ['POST', '/api/rooms/x/accept'],
    ['POST', '/api/escalation'], ['POST', '/api/1to1/book'], ['POST', '/api/prepared-actions/x/approve'],
    ['POST', '/api/feature-flags/governed_execution']]) {
    assert.equal(m.machineDecision(M, p).allow, false, `${M} ${p}`);
  }
  assert.equal(m.machineDecision('PATCH', '/api/todos/ms/abc/local').allow, true, 'private annotation stays');
  assert.equal(m.machineDecision('PATCH', '/api/microsoft/planner/tasks/x').status, 410);
  assert.equal(m.machineDecision('POST', '/api/calendar/events/x/respond').status, 410);
  assert.match(m.machineDecision('POST', '/api/calendar/events/x/respond').reason, /prepared and approved/);
  assert.equal(m.machineDecision('POST', '/api/email/triage/abc/reply').mode, 'prepare');
});

test('no route lets a machine send email directly: every email capability a route reaches is prepare or self-only', () => {
  for (const o of inventory) {
    const r = m.resolve(o.method, o.route);
    if (!r.capability) continue;
    const c = m.CAPABILITIES[r.capability];
    if (/email/.test(r.capability) && m.machineDecision(o.method, o.route).allow) {
      assert.ok(['prepare'].includes(c.machine) || r.capability === 'email.self', `${o.id} → ${r.capability}`);
    }
  }
});

test('_matches is whole-segment', () => {
  assert.equal(m._matches('/api/todos/ms/:msId', '/api/todos/ms/abc'), true);
  assert.equal(m._matches('/api/todos/ms/:msId', '/api/todos/ms/abc/local'), false);
  assert.equal(m._matches('/api/escalation', '/api/escalation/ledger/resolve'), false);
});
