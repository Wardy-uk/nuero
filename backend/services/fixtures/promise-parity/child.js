'use strict';
// Parity child: runs ONE path of canonical Now against ONE database copy at the
// frozen instant and prints what the promise gate sees. Test fixture only.
//   node -r ./clock.js child.js write|readonly|prep
// env: PARITY_BACKEND, NEURO_DB_PATH, OBSIDIAN_VAULT_PATH, FROZEN_AT, HA_FIXTURE,
//      STUB_POOL_THROW=1 (blind), CONTEXT_UNKNOWN=1 (every context input unread)
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const mode = process.argv[2];
const B = process.env.PARITY_BACKEND;
const T = Date.now(); // frozen
const svc = (m) => path.join(B, 'services', m);

// Home Assistant: one recorded fixture at the network boundary; anything else is refused.
const fx = JSON.parse(fs.readFileSync(process.env.HA_FIXTURE, 'utf8'));
global.fetch = async (url, opts = {}) => {
  const u = new URL(String(url));
  if (u.origin !== 'http://ha.fixture') throw new Error(`network refused in parity child: ${u.origin}`);
  const reply = (status, body) => ({ ok: status < 400, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)), json: async () => body });
  if (fx.fail) return reply(500, {});
  if (u.pathname === '/api/template' && (opts.method || 'GET') === 'POST') return reply(200, JSON.stringify(fx.areas || []));
  if (u.pathname === '/api/states') return reply(200, fx.states || []);
  const one = (fx.states || []).find((s) => u.pathname === `/api/states/${s.entity_id}`);
  return one ? reply(200, one) : reply(404, {});
};

// Every outbound door throws.
const stub = (m, ex) => { const id = require.resolve(svc(m)); require.cache[id] = { id, filename: id, loaded: true, exports: ex }; };
const boom = (w) => async () => { throw new Error(`${w} reached in parity child`); };
stub('webpush.js', { sendToAll: boom('webpush'), isConfigured: () => true });
stub('email-sender.js', { sendMail: boom('email'), sendBriefEmail: boom('email'), OWN_ADDRESS: 'x' });
stub('teams.js', { getSendStatus: async () => ({ available: false }) });
stub('microsoft.js', { getSignedInAddress: async () => null, getAccessToken: async () => null, graphWrite: boom('graph'), sendMail: boom('graph') });

// Identical, explicit inductions (both paths get the same one).
if (process.env.STUB_POOL_THROW === '1') { const de = require(svc('decision-engine.js')); de.evaluate = async () => { throw new Error('pool unreadable (parity induction)'); }; }
if (process.env.CONTEXT_UNKNOWN === '1') { const cs = require(svc('context-state.js')); const orig = cs.resolveContext; cs.resolveContext = (inputs, at) => orig({}, at); }

(async () => {
  const db = require(path.join(B, 'db', 'database'));
  await db.init();
  const raw = db.getDb();
  const fp = () => {
    const out = {};
    for (const { name } of raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()) {
      out[name] = crypto.createHash('sha1').update(JSON.stringify(raw.prepare(`SELECT * FROM "${name}"`).all())).digest('hex');
    }
    return out;
  };
  const sites = new Map();
  const prep = raw.prepare.bind(raw);
  raw.prepare = (sql) => {
    const st = prep(sql);
    if (/^\s*(INSERT|UPDATE|DELETE|REPLACE)/i.test(sql)) {
      const run = st.run.bind(st);
      st.run = (...a) => { const k = sql.trim().split(/\s+/).slice(0, 3).join(' '); sites.set(k, (sites.get(k) || 0) + 1); return run(...a); };
    }
    return st;
  };
  const before = fp();
  const payload = await require(svc('canonical-read.js')).now({ now: T, readOnly: mode === 'readonly' });
  const after = fp();
  const policy = require(path.join(B, '..', 'saim', 'policy', 'promises.cjs'));
  const snap = require(svc('promise-observe.js')).snapshot({ now: T });
  const ev = require(svc('promise-shadow.js')).evaluate({ payload, promises: snap.promises, now: T });
  const out = {
    mode, at: new Date(T).toISOString(),
    rule: payload && payload.saim && payload.saim.lead ? payload.saim.lead.rule : null,
    lead: payload && payload.saim && payload.saim.lead ? { ref: payload.saim.lead.ref || null, why: payload.saim.lead.why || null } : null,
    activity: payload && payload.context ? payload.context.activity : null,
    gateInputs: policy.gateInputs(payload && payload.saim, payload && payload.candidates),
    ctx: ev.ctx, gate: ev.gate, sponsorship: ev.sponsorship,
    changed: Object.keys(before).filter((k) => before[k] !== after[k]),
    writes: Object.fromEntries(sites),
  };
  raw.pragma('wal_checkpoint(TRUNCATE)');
  process.stdout.write(`\nPARITY ${JSON.stringify(out)}\n`);
  raw.close();
  process.exit(0);
})().catch((e) => { process.stdout.write(`\nPARITY ${JSON.stringify({ error: e.message })}\n`); process.exit(1); });
