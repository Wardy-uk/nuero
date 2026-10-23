#!/usr/bin/env node
'use strict';

/**
 * READ-ONLY post-deploy check of the shared NEURO + VANTAGE AI ledger (23 Oct 2026).
 *
 *   node backend/scripts/ai-gate-verify.js
 *     [--neuro-env /mnt/data/nuero/backend/.env] [--vantage-env /mnt/data/vantage/backend/.env]
 *
 * Proves, from the two deployed .env files and the ledger itself:
 *   1. both set AI_GATE_DB_PATH, both absolute, the SAME path (after realpath);
 *   2. the ledger file exists and opens read-only;
 *   3. both apps have REGISTERED on that one file since they last started
 *      (gate_apps: configured path, resolved path, host, pid, start time) — the
 *      registration is written by the running process, so a row here means that
 *      process opened THIS file, whatever user it runs as;
 *   4. today's (London) counts, so a live ledger is visibly being written.
 *
 * Writes nothing: the env files are only read, the ledger is opened with
 * { readonly: true, fileMustExist: true }. Exit 0 = all good, 1 = a problem
 * (each printed), 2 = could not run.
 */

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const arg = (name, dflt) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : dflt; };
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

function realOf(p) { try { return fs.realpathSync(p); } catch { try { return path.join(fs.realpathSync(path.dirname(p)), path.basename(p)); } catch { return p; } } }

function alive(pid) {
  if (!pid) return null;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM' ? true : false; }
}

function main() {
  const problems = [];
  const read = (f, who) => { try { return fs.readFileSync(f, 'utf8'); } catch (e) { problems.push(`${who}: cannot read ${f} (${e.code || e.message}).`); return ''; } };
  const nPath = envValue(read(NEURO_ENV, 'NEURO'), 'AI_GATE_DB_PATH');
  const vPath = envValue(read(VANTAGE_ENV, 'VANTAGE'), 'AI_GATE_DB_PATH');
  console.log(`NEURO   ${NEURO_ENV}\n  AI_GATE_DB_PATH=${nPath || '(unset)'}`);
  console.log(`VANTAGE ${VANTAGE_ENV}\n  AI_GATE_DB_PATH=${vPath || '(unset)'}`);
  problems.push(...comparePaths(nPath, vPath, realOf));
  if (problems.length) return finish(problems);

  const file = realOf(nPath);
  if (!fs.existsSync(file)) return finish([`The ledger ${file} does not exist yet — has either app started since AI_GATE_DB_PATH was set?`]);
  let db;
  try {
    db = new (require('better-sqlite3'))(file, { readonly: true, fileMustExist: true });
  } catch (e) { return finish([`The ledger ${file} could not be opened read-only (${e.message}).`]); }

  try {
    const id = (db.prepare("SELECT value FROM gate_meta WHERE key='ledger_id'").get() || {}).value;
    console.log(`\nLedger  ${file}\n  id ${id || '(none)'}`);
    if (!id) problems.push('The ledger has no id — it was not created by the current gate.');
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
    const rows = db.prepare(`SELECT app, decision, status, COUNT(*) n, ROUND(SUM(COALESCE(cost_usd, est_usd, 0)), 4) usd FROM gate_tickets WHERE day=? GROUP BY app, decision, status ORDER BY app`).all(day);
    console.log(`\nToday (${day}, London):`);
    if (!rows.length) console.log('  no tickets yet today');
    for (const r of rows) console.log(`  ${r.app.padEnd(8)} ${r.decision.padEnd(7)} ${r.status.padEnd(9)} ${String(r.n).padStart(5)}  $${r.usd}`);
    const ev = db.prepare('SELECT kind, COUNT(*) n FROM gate_events WHERE day=? GROUP BY kind').all(day);
    if (ev.length) console.log(`  events: ${ev.map((e) => `${e.kind} ${e.n}`).join(', ')}`);
  } catch (e) {
    problems.push(`The ledger could not be read (${e.message}).`);
  } finally { db.close(); }
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
  try { main(); } catch (e) { console.error(`could not run: ${e.message}`); process.exitCode = 2; }
}

module.exports = { envValue, comparePaths };
