#!/usr/bin/env node
'use strict';

/**
 * LOCAL, READ-ONLY validation harness for the SAiM Alt desktop adapter
 * (15 Oct 2026). Serves the branch's /api/canonical/now — candidates, saim,
 * handoff — from a COPIED database, so the adapter can be checked against real
 * data without touching the Pi.
 *
 *   node backend/scripts/local-readonly-server.js --db <copy.db> [--port 3011]
 *
 * Guarantees, each enforced here rather than hoped for:
 *   - env is set BEFORE any module loads: the copy's path, a throwaway PIN, an
 *     EMPTY scratch vault, and every outbound credential/URL removed;
 *   - every non-loopback network connection (http/https/fetch/net/tls) is
 *     REFUSED and counted — GET /local/outbound shows the attempts;
 *   - only GET requests are served (anything else is 405); no scheduler, no
 *     push, no AI settings bootstrap, no server.js;
 *   - it listens on 127.0.0.1 only.
 * The copy may be written by NEURO's own read paths (e.g. lifecycle bookkeeping);
 * it is a copy, and the live database is never opened.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

const arg = (name, dflt = null) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : dflt; };
const DB = arg('db');
const PORT = Number(arg('port', '3011'));
if (!DB || !fs.existsSync(DB)) { console.error('usage: local-readonly-server.js --db <copied agent.db> [--port 3011]'); process.exit(2); }
if (/\/mnt\/data\/nuero\/backend\/db\/agent\.db$/.test(DB.replace(/\\/g, '/'))) { console.error('refusing: that is the live database path'); process.exit(2); }

// ── Environment, before anything is required ──────────────────────────────────
const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-local-vault-'));
process.env.NEURO_DB_PATH = path.resolve(DB);
process.env.NEURO_PIN = 'local-readonly';
process.env.OBSIDIAN_VAULT_PATH = vault;
process.env.NEURO_TIMEZONE = process.env.NEURO_TIMEZONE || 'Europe/London';
process.env.NODE_ENV = 'local-readonly';
for (const k of Object.keys(process.env)) {
  if (/^(HA_|JIRA_|NOVA_|OPENROUTER|ANTHROPIC|OPENAI|VOYAGE|OLLAMA|VAPID|TALLY_|OWNTRACKS|NOTION|RESCUETIME|DVLA|WU_|NEURO_API_TOKEN|NEURO_KIOSK_TOKEN|SAIM_|PLAUD|STRAVA|MS_|AZURE_|GRAPH_)/.test(k)) delete process.env[k];
}

// ── Outbound: refused at the socket, counted ─────────────────────────────────
const outbound = [];
const LOOPBACK = /^(127\.\d+\.\d+\.\d+|::1|localhost)$/i;
const refuse = (host, via) => { outbound.push({ at: new Date().toISOString(), host: String(host || '?'), via }); return new Error(`local-readonly: outbound to ${host} refused`); };
const hostOf = (a) => (typeof a === 'string' ? (() => { try { return new URL(a).hostname; } catch { return a; } })() : a && (a.hostname || a.host || (a.href && new URL(a.href).hostname)));
for (const mod of ['http', 'https']) {
  const m = require(mod);
  for (const fn of ['request', 'get']) {
    const orig = m[fn];
    m[fn] = function guarded(a, b, c) {
      const h = hostOf(a) || hostOf(b);
      if (!LOOPBACK.test(String(h || '').replace(/^\[|\]$/g, ''))) {
        const err = refuse(h, `${mod}.${fn}`);
        const cb = typeof b === 'function' ? b : typeof c === 'function' ? c : null;
        const fake = new (require('events').EventEmitter)();
        fake.end = () => {}; fake.write = () => true; fake.setTimeout = () => fake; fake.abort = () => {}; fake.destroy = () => {};
        process.nextTick(() => fake.emit('error', err));
        void cb;
        return fake;
      }
      return orig.apply(this, arguments);
    };
  }
}
for (const mod of ['net', 'tls']) {
  const m = require(mod);
  const orig = m.connect;
  m.connect = m.createConnection = function guarded(...a) {
    const o = a[0]; const h = typeof o === 'object' ? o.host : a[1];
    if (h && !LOOPBACK.test(String(h))) throw refuse(h, `${mod}.connect`);
    return orig.apply(this, a);
  };
}
const origFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const h = hostOf(typeof input === 'string' ? input : input && input.url);
  if (!LOOPBACK.test(String(h || ''))) throw refuse(h, 'fetch');
  return origFetch(input, init);
};

// ── The app: read routes only, behind NEURO's real auth ──────────────────────
(async () => {
  const db = require('../db/database');
  await db.init();
  const express = require('express');
  const app = express();
  app.get('/local/outbound', (req, res) => res.json({ refused: outbound.length, attempts: outbound.slice(-50) }));
  app.use((req, res, next) => (req.method === 'GET' ? next() : res.status(405).json({ ok: false, error: 'local read-only harness: GET only' })));
  app.use('/api', require('../services/api-auth'));
  app.use('/api/canonical', require('../routes/canonical'));
  app.use('/api/links', require('../routes/links'));
  app.use('/api/task-activity', require('../routes/task-activity'));
  app.listen(PORT, '127.0.0.1', () => console.log(`[local-readonly] http://127.0.0.1:${PORT} · db ${process.env.NEURO_DB_PATH} · vault ${vault} (empty) · outbound refused`));
})().catch((e) => { console.error('[local-readonly] failed:', e); process.exit(1); });
