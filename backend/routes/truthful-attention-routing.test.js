'use strict';

/**
 * Brief 002, D-009 — through the REAL /api/canonical/now route over a scratch
 * database: a read that fails AFTER the situation is composed (here the Future
 * Radar, sabotaged) must change the presentation's honesty output. A pure test
 * cannot see this join: the defect was in the ORDER inside now().
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-b002-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'scratch.db');
delete process.env.HA_TOKEN;

const db = require('../db/database');

let server;
let base;

test.before(async () => {
  await db.init();
  const app = express();
  app.use(express.json());
  app.use('/api/canonical', require('./canonical'));
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => { if (server) server.close(); });

test('a failed late-stage read (radar) is visible in presentation honesty and details', async () => {
  const radar = require('../services/future-radar');
  const real = radar.read;
  radar.read = () => { throw new Error('radar sabotaged for the test'); };
  try {
    const res = await fetch(`${base}/api/canonical/now`);
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.equal(j.radar, null, 'positive control: the sabotage took effect');
    assert.ok((j.gaps || []).some((g) => g.input === 'radar'), 'the late gap reaches payload.gaps');
    assert.ok(j.presentation, 'presentation composed');
    assert.equal(j.presentation.situation.honesty.complete, false);
    assert.match(j.presentation.situation.honesty.say || '', /radar/);
    assert.ok(j.presentation.details.some((d) => d.id === 'gaps' && /radar/.test(d.label)), 'a visible caveat');
    assert.ok(j.situation.uncertainty.gaps.some((g) => g.input === 'radar'));
    assert.notEqual(j.situation.calm, true, 'calm cannot stand over a failed read');
  } finally {
    radar.read = real;
  }
});
