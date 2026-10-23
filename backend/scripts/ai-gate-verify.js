#!/usr/bin/env node
'use strict';

/**
 * Post-deploy check of the shared NEURO + VANTAGE AI ledger (23 Oct 2026).
 *
 *   node backend/scripts/ai-gate-verify.js
 *     [--neuro-env /mnt/data/nuero/backend/.env] [--vantage-env /mnt/data/vantage/backend/.env]
 *     [--live] [--neuro-url http://127.0.0.1:3001] [--vantage-url http://127.0.0.1:3006]
 *     [--lock-probe]
 *
 * READ-ONLY by default. It reports, each by name:
 *   - PATH: AI_GATE_DB_PATH unset or relative in either .env; the two apps naming
 *     DIFFERENT files (compared after realpath); the folder missing, not a folder,
 *     or not readable+writable by this user (fs.access — writes nothing); the
 *     folder writable by group/others (wider than one user needs); the ledger file
 *     not readable+writable; not created yet.
 *   - LEDGER: no id; not in WAL mode; NEURO or VANTAGE never registered on THIS
 *     file, registered from another path, or registered by a process that has since
 *     stopped.
 *   - IDENTITY (--live): each RUNNING app's /api/ai-gate/profile reports the ledger
 *     id it is actually writing; either id differing from the one inside the file is
 *     an identity mismatch, an app that cannot be asked is a problem, and NEURO's
 *     own peer comparison is shown. GET only; PINs come from the .env files and are
 *     never printed.
 *   - LOCK (--lock-probe): opens a second connection and takes the write lock
 *     (BEGIN IMMEDIATE) with a 3 s busy timeout, then ROLLBACK — no data is written.
 *     A ledger that stays locked, or a filesystem that cannot lock, is reported.
 *
 * Exit 0 = all good, 1 = problem(s) (each printed), 2 = could not run.
 */

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const arg = (name, dflt) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : dflt; };
const has = (name) => args.includes(name);
const NEURO_ENV = arg('--neuro-env', '/mnt/data/nuero/backend/.env');
const VANTAGE_ENV = arg('--vantage-env', '/mnt/data/vantage/backend/.env');

/** PURE. The value of KEY in a dotenv file's text (last assignment wins), or null. */
function envValue(text, key) {
  let val = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m || m[1] !== key) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    val = v;
  }
  return val || null;
}

/** PURE. The problems with two apps' configured ledger paths. */
function comparePaths(neuro, vantage, realOf = (p) => p) {
  const problems = [];
  if (!neuro) problems.push('NEURO: AI_GATE_DB_PATH is not set.');
  if (!vantage) problems.push('VANTAGE: AI_GATE_DB_PATH is not set.');
  if (neuro && !path.posix.isAbsolute(neuro) && !path.isAbsolute(neuro)) problems.push(`NEURO: AI_GATE_DB_PATH is not absolute ("${neuro}").`);
  if (vantage && !path.posix.isAbsolute(vantage) && !path.isAbsolute(vantage)) problems.push(`VANTAGE: AI_GATE_DB_PATH is not absolute ("${vantage}").`);
  if (!problems.length) {
    const a = realOf(neuro); const b = realOf(vantage);
    if (a !== b) problems.push(`The two apps name DIFFERENT ledgers: NEURO ${neuro}${a !== neuro ? ` (→ ${a})` : ''}, VANTAGE ${vantage}${b !== vantage ? ` (→ ${b})` : ''}.`);
  }
  return problems;
}

/** Problems with the folder/file as seen by this user. `fsx` and `platform` are injectable for tests. */
function checkAccess(file, fsx = fs, platform = process.platform) {
  const problems = []; const notes = [];
  const dir = path.dirname(file);
  let st;
  try { st = fsx.statSync(dir); } catch { problems.push(`The ledger's folder ${dir} does not exist (create it: install -d -m 0700 ${dir}).`); return { problems, notes }; }
  if (!st.isDirectory()) { problems.push(`The ledger's folder ${dir} is not a directory.`); return { problems, notes }; }
  try { fsx.accessSync(dir, fs.constants.R_OK | fs.constants.W_OK); } catch { problems.push(`The ledger's folder ${dir} is not readable and writable by this user.`); }
  if (platform !== 'win32') {
    const mode = st.mode & 0o777;
    notes.push(`folder mode ${mode.toString(8).padStart(4, '0')}, owner uid ${st.uid}`);
    if (mode & 0o022) problems.push(`The ledger's folder ${dir} is writable by group or others (mode ${mode.toString(8)}); both apps run as one user, so it should be 0700.`);
  }
  if (fsx.existsSync(file)) {
    try { fsx.accessSync(file, fs.constants.R_OK | fs.constants.W_OK); } catch { problems.push(`The ledger ${file} is not readable and writable by this user.`); }
  }
  return { problems, notes };
}

function realOf(p) { try { return fs.realpathSync(p); } catch { try { return path.join(fs.realpathSync(path.dirname(p)), path.basename(p)); } catch { return p; } } }

function alive(pid) {
  if (!pid) return null;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

async function getProfile(url, headers) {
  try {
    const res = await fetch(`${url.replace(/\/$/, '')}/api/ai-gate/profile`, { headers, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    return { body: await res.json() };
  } catch (e) { return { error: e.cause && e.cause.code ? e.cause.code : e.message }; }
}

/** PURE. Identity problems from the file's id and each running app's reported ledger. */
function compareIdentity(fileId, neuro, vantage) {
  const problems = [];
  for (const [who, r] of [['NEURO', neuro], ['VANTAGE', vantage]]) {
    if (!r || r.error) { problems.push(`${who} could not be asked for its ledger (${(r && r.error) || 'no answer'}) — is it running?`); continue; }
    const id = r.body && r.body.ledger && r.body.ledger.id;
    if (!id) problems.push(`${who} reports no ledger id (${(r.body && (r.body.degraded || r.body.error)) || 'ledger unavailable'}).`);
    else if (id !== fileId) problems.push(`Identity mismatch: ${who} is writing ledger ${id}, but ${fileId ? `the file holds ${fileId}` : 'the file has no id'} — it is not writing this file.`);
  }
  return problems;
}

function lockProbe(file, timeoutMs = 3000) {
  let db;
  try {
    db = new (require('better-sqlite3'))(file, { fileMustExist: true, timeout: timeoutMs });
    const t0 = Date.now();
    db.exec('BEGIN IMMEDIATE');
    db.exec('ROLLBACK');
    return { ok: true, ms: Date.now() - t0 };
  } catch (e) {
    const code = e.code || '';
    return { ok: false, say: /BUSY|LOCKED/.test(code) || /locked/i.test(e.message)
      ? `Lock/concurrency failure: the ledger stayed write-locked for ${timeoutMs / 1000} s (${code || e.message}). Another process is holding it, or this filesystem does not support SQLite locking.`
      : `Lock probe failed (${code || e.message}).` };
  } finally { try { db && db.close(); } catch { /* closed */ } }
}

async function main() {
  const problems = [];
  const read = (f, who) => { try { return fs.readFileSync(f, 'utf8'); } catch (e) { problems.push(`${who}: cannot read ${f} (${e.code || e.message}).`); return ''; } };
  const nText = read(NEURO_ENV, 'NEURO'); const vText = read(VANTAGE_ENV, 'VANTAGE');
  const nPath = envValue(nText, 'AI_GATE_DB_PATH');
  const vPath = envValue(vText, 'AI_GATE_DB_PATH');
  console.log(`NEURO   ${NEURO_ENV}\n  AI_GATE_DB_PATH=${nPath || '(unset)'}`);
  console.log(`VANTAGE ${VANTAGE_ENV}\n  AI_GATE_DB_PATH=${vPath || '(unset)'}`);
  problems.push(...comparePaths(nPath, vPath, realOf));
  if (problems.length) return finish(problems);

  const file = realOf(nPath);
  const access = checkAccess(file);
  if (access.notes.length) console.log(`  ${access.notes.join('; ')}`);
  problems.push(...access.problems);
  if (problems.length) return finish(problems);
  if (!fs.existsSync(file)) return finish([`The ledger ${file} does not exist yet — has either app started since AI_GATE_DB_PATH was set?`]);

  let db; let fileId = null;
  try {
    db = new (require('better-sqlite3'))(file, { readonly: true, fileMustExist: true });
  } catch (e) { return finish([`The ledger ${file} could not be opened read-only (${e.message}).`]); }
  try {
    fileId = (db.prepare("SELECT value FROM gate_meta WHERE key='ledger_id'").get() || {}).value || null;
    const mode = db.pragma('journal_mode', { simple: true });
    console.log(`\nLedger  ${file}\n  id ${fileId || '(none)'}  journal ${mode}`);
    if (!fileId) problems.push('The ledger has no id — it was not created by the current gate.');
    if (String(mode).toLowerCase() !== 'wal') problems.push(`The ledger is not in WAL mode (${mode}); two apps writing it need WAL.`);
    const apps = db.prepare('SELECT app, configured_path, real_path, host, pid, gate_version, started_at FROM gate_apps ORDER BY app').all();
    for (const want of ['neuro', 'vantage']) {
      const r = apps.find((a) => a.app === want);
      if (!r) { problems.push(`${want.toUpperCase()} has not registered on this ledger — it has not started with this AI_GATE_DB_PATH (restart it, then re-run).`); continue; }
      const live = alive(r.pid);
      console.log(`  ${want.padEnd(8)} started ${r.started_at} pid ${r.pid} (${live ? 'running' : 'not running'}) on ${r.host}\n           configured ${r.configured_path} → ${r.real_path}`);
      if (realOf(r.configured_path) !== file && r.real_path !== file) problems.push(`${want.toUpperCase()} registered from a different path (${r.real_path || r.configured_path}).`);
      if (live === false) problems.push(`${want.toUpperCase()}'s registered process ${r.pid} is not running — the row is from an earlier start; restart it, then re-run.`);
    }
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date());
    const rows = db.prepare('SELECT app, decision, status, COUNT(*) n, ROUND(SUM(COALESCE(cost_usd, est_usd, 0)), 4) usd FROM gate_tickets WHERE day=? GROUP BY app, decision, status ORDER BY app').all(day);
    console.log(`\nToday (${day}, London):`);
    if (!rows.length) console.log('  no tickets yet today');
    for (const r of rows) console.log(`  ${r.app.padEnd(8)} ${r.decision.padEnd(7)} ${r.status.padEnd(9)} ${String(r.n).padStart(5)}  $${r.usd}`);
    const ev = db.prepare('SELECT kind, COUNT(*) n FROM gate_events WHERE day=? GROUP BY kind').all(day);
    if (ev.length) console.log(`  events: ${ev.map((e) => `${e.kind} ${e.n}`).join(', ')}`);
  } catch (e) {
    problems.push(`The ledger could not be read (${e.message}).`);
  } finally { db.close(); }

  if (has('--live')) {
    const nPort = envValue(nText, 'PORT') || '3001'; const vPort = envValue(vText, 'PORT') || '3006';
    const nUrl = arg('--neuro-url', `http://127.0.0.1:${nPort}`); const vUrl = arg('--vantage-url', `http://127.0.0.1:${vPort}`);
    const nHeaders = {}; const vHeaders = {};
    const nPin = envValue(nText, 'NEURO_PIN'); const nTok = envValue(nText, 'NEURO_API_TOKEN'); const vPin = envValue(vText, 'VANTAGE_PIN');
    if (nTok) nHeaders['X-NEURO-API-TOKEN'] = nTok; else if (nPin) nHeaders['X-NEURO-PIN'] = nPin;
    if (vPin) vHeaders['x-vantage-pin'] = vPin;
    const [n, v] = await Promise.all([getProfile(nUrl, nHeaders), getProfile(vUrl, vHeaders)]);
    console.log(`\nLive (${nUrl}, ${vUrl}):`);
    for (const [who, r] of [['NEURO', n], ['VANTAGE', v]]) console.log(`  ${who.padEnd(8)} ${r.error ? `could not ask (${r.error})` : `ledger ${(r.body.ledger && r.body.ledger.id) || '(none)'}`}`);
    if (n.body && n.body.peer) console.log(`  NEURO's own peer check: ${n.body.peer.state}${n.body.peer.say ? ` — ${n.body.peer.say}` : ''}`);
    problems.push(...compareIdentity(fileId, n, v));
  }

  if (has('--lock-probe')) {
    const r = lockProbe(file);
    console.log(`\nLock probe: ${r.ok ? `write lock taken and released in ${r.ms} ms (rolled back; nothing written)` : 'FAILED'}`);
    if (!r.ok) problems.push(r.say);
  }
  return finish(problems);
}

function finish(problems) {
  if (problems.length) {
    console.log(`\n✖ ${problems.length} problem(s):`);
    for (const p of problems) console.log(`  - ${p}`);
    process.exitCode = 1;
  } else {
    console.log('\n✔ NEURO and VANTAGE write the one shared ledger.');
    process.exitCode = 0;
  }
}

if (require.main === module) {
  main().catch((e) => { console.error(`could not run: ${e.message}`); process.exitCode = 2; });
}

module.exports = { envValue, comparePaths, checkAccess, compareIdentity, lockProbe };
