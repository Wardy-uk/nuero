'use strict';

/**
 * The SARA → SAiM rename (15 Sep 2026) — the compatibility half.
 *
 * ⚠ THE RENAME ITSELF NEEDS NO TEST. A renamed symbol either resolves or does
 * not, and the 3,800 tests already here cover the behaviour behind the new
 * names. What needs pinning is the part that CANNOT fail loudly: the old names
 * are still written into Nick's vault, still sitting in the live SQLite
 * database, and still being sent by an iOS build that has not been rebuilt yet.
 * A reader that knows only the new name does not error on any of them — it
 * finds nothing, and "nothing" is a plausible, silent, wrong answer every time.
 *
 * Each test names the specific thing that breaks without it.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const legacy = require('./legacy-names');
const apns = require('./apns');
const exclusions = require('./vault-exclusions');
const provenance = require('../../shared/task-provenance.cjs');

// ── legacy-names: the one place that knows what things used to be called ────

test('a frontmatter key falls back to its pre-rename spelling', () => {
  // Without this, every note enriched before the rename reads as un-enriched
  // and is re-enriched — a PAID model call per note, across the knowledge base.
  assert.equal(legacy.fmValue({ sara_ai_source_hash: 'abc' }, 'saim_ai_source_hash'), 'abc');
});

test('the CURRENT key wins where a note carries both', () => {
  assert.equal(
    legacy.fmValue({ saim_ai_source_hash: 'new', sara_ai_source_hash: 'old' }, 'saim_ai_source_hash'),
    'new',
    'a note rewritten since the rename must never consult the legacy key');
});

test('an unrelated key is not rewritten on the way through', () => {
  assert.equal(legacy.fmValue({ knowledge_promoted_to: 'x' }, 'knowledge_promoted_to'), 'x');
  assert.equal(legacy.legacyKey('knowledge_promoted_to'), null);
});

test('a heading is matched under either spelling, new first', () => {
  assert.deepEqual(legacy.headingAliases('SAiM Insight'), ['SAiM Insight', 'SARA Insight']);
  assert.deepEqual(legacy.headingAliases('## SAiM Actions'), ['## SAiM Actions', '## SARA Actions']);
});

test('a heading with no SAiM in it yields one spelling, not a phantom alias', () => {
  assert.deepEqual(legacy.headingAliases('Open Loops'), ['Open Loops']);
});

test('a frontmatter VALUE matches under either spelling, case-insensitively', () => {
  // Without this a consolidated note looks unmanaged, and is consolidated again.
  assert.ok(legacy.matchesValue('sara-knowledge-memory', 'saim-knowledge-memory'));
  assert.ok(legacy.matchesValue('SARA-Import-Consolidation', 'saim-import-consolidation'));
  assert.ok(!legacy.matchesValue('something-else', 'saim-knowledge-memory'));
});

// ── the installed iOS build still calls itself 'sara' ───────────────────────

test('an APNs registration from the not-yet-rebuilt app is ACCEPTED and normalised', () => {
  // The iOS build happens on the Mac. Until then the installed app sends
  // app:'sara' on every launch. Reject it and no token is stored, so the phone
  // stops receiving pushes — silently, because a phone nobody sends to looks
  // exactly like a quiet day.
  const r = apns.validate({ token: 'a'.repeat(64), app: 'sara', deviceId: 'ios-1' });
  assert.ok(r.ok, r.reason);
  assert.equal(r.registration.app, 'saim', 'stored under the CURRENT name, not the one sent');
});

test('the rename did not turn the app field into a free-for-all', () => {
  const r = apns.validate({ token: 'a'.repeat(64), app: 'whatever' });
  assert.ok(!r.ok, 'an unknown app must still be refused');
});

// ── generated output that predates the rename is still not content ──────────

test('the PRE-RENAME report folder is still excluded from indexing', () => {
  // Those reports are still in the vault under the old name. Drop the old entry
  // and every one starts being indexed into embeddings and entity extraction —
  // the system reading its own output back as content.
  assert.ok(exclusions.isExcludedPath('Documents/System/SARA Import Reports/2026-08-14.md'),
    'the old report folder must stay excluded');
  assert.ok(exclusions.isExcludedPath('Documents/System/SAiM Import Reports/2026-09-20.md'),
    'and so must the new one');
});

// ── task rows written before the rename keep their provenance ───────────────

test('a task captured before the rename still says where it came from', () => {
  // An unlabelled source is the unreadable-provenance failure that file exists
  // to prevent: Nick cannot check the claim, so the only safe thing left to do
  // with the card is dismiss it.
  assert.ok(Object.prototype.hasOwnProperty.call(provenance.SOURCE_HOW, 'sara-capture'),
    'the pre-rename capture source must still map to a label');
  assert.equal(provenance.SOURCE_HOW['sara-capture'], provenance.SOURCE_HOW['saim-capture'],
    'and must say the same thing as the current spelling');
});

// ── the live database ──────────────────────────────────────────────────────

test('sara_actions is carried over to saim_actions WITH ITS ROWS, on a real database', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'saim-rename-'));
  const dbPath = path.join(dir, 'agent.db');
  const Database = require('better-sqlite3');

  // Build a database in the PRE-rename shape, the way the live Pi holds it.
  const seed = new Database(dbPath);
  seed.exec([
    'CREATE TABLE sara_actions (',
    '  id INTEGER PRIMARY KEY AUTOINCREMENT,',
    '  type TEXT NOT NULL, status TEXT DEFAULT \'pending\',',
    '  payload TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);',
    'CREATE INDEX idx_sara_actions_status ON sara_actions(status);',
    'CREATE TABLE agent_state (key TEXT PRIMARY KEY, value TEXT, updated_at DATETIME);',
    'CREATE TABLE apns_tokens (',
    '  id INTEGER PRIMARY KEY AUTOINCREMENT, token TEXT NOT NULL UNIQUE,',
    '  device_id TEXT, app TEXT NOT NULL DEFAULT \'neuro\',',
    '  environment TEXT NOT NULL DEFAULT \'development\', bundle_id TEXT,',
    '  registered_at DATETIME, last_seen_at DATETIME,',
    '  last_failed_at DATETIME, failure_reason TEXT);',
  ].join('\n'));
  seed.prepare("INSERT INTO sara_actions (type, status, payload) VALUES ('draft_reply','pending','{}')").run();
  seed.prepare('INSERT INTO agent_state (key, value) VALUES (?, ?)').run('sara_greetings', '["hello"]');
  seed.prepare('INSERT INTO apns_tokens (token, app) VALUES (?, ?)').run('b'.repeat(64), 'sara');
  seed.close();

  const prev = process.env.NEURO_DB_PATH;
  process.env.NEURO_DB_PATH = dbPath;
  delete require.cache[require.resolve('../db/database')];
  const db = require('../db/database');
  try {
    await db.init();

    const check = new Database(dbPath, { readonly: true });
    const tables = check.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('sara_actions','saim_actions')"
    ).all().map((r) => r.name);
    assert.ok(tables.includes('saim_actions'), 'the table must have been renamed');
    assert.ok(!tables.includes('sara_actions'), 'and the old name must be gone, not left beside it');

    // ⚠ The ROW is the point. A renamed-but-empty table is exactly what the
    // migration's ordering exists to prevent, and it reads as a quiet day.
    assert.equal(check.prepare('SELECT count(*) AS n FROM saim_actions').get().n, 1,
      'the queued action must have survived the rename');

    assert.equal(
      check.prepare('SELECT value FROM agent_state WHERE key = ?').get('saim_greetings').value,
      '["hello"]', 'the greeting ledger must be carried to the new key');
    assert.ok(check.prepare('SELECT value FROM agent_state WHERE key = ?').get('sara_greetings'),
      'and COPIED, not moved — a rollback must still find the old key');

    assert.equal(
      check.prepare('SELECT app FROM apns_tokens WHERE token = ?').get('b'.repeat(64)).app,
      'saim', 'the device token must follow, or the phone silently stops being pushed to');
    check.close();
  } finally {
    try { if (db.close) db.close(); } catch { /* best effort */ }
    if (prev === undefined) delete process.env.NEURO_DB_PATH;
    else process.env.NEURO_DB_PATH = prev;
    delete require.cache[require.resolve('../db/database')];
  }
});

test('a database that is ALREADY renamed is left alone (the migration is idempotent)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'saim-rename-idem-'));
  const dbPath = path.join(dir, 'agent.db');
  const Database = require('better-sqlite3');

  const prev = process.env.NEURO_DB_PATH;
  process.env.NEURO_DB_PATH = dbPath;
  delete require.cache[require.resolve('../db/database')];
  const db = require('../db/database');
  try {
    await db.init();               // fresh DB — schema.sql creates saim_actions
    const raw = new Database(dbPath);
    raw.prepare("INSERT INTO saim_actions (type, status, payload) VALUES ('draft_reply','pending','{}')").run();
    raw.close();

    // Restarting must not touch it. The backend restarts several times a day.
    delete require.cache[require.resolve('../db/database')];
    const db2 = require('../db/database');
    await db2.init();

    const check = new Database(dbPath, { readonly: true });
    assert.equal(check.prepare('SELECT count(*) AS n FROM saim_actions').get().n, 1,
      'a second boot must not drop or duplicate the queue');
    check.close();
    try { if (db2.close) db2.close(); } catch { /* best effort */ }
  } finally {
    if (prev === undefined) delete process.env.NEURO_DB_PATH;
    else process.env.NEURO_DB_PATH = prev;
    delete require.cache[require.resolve('../db/database')];
  }
});

// ── deployed .env files were never touched by the rename ───────────────────

const legacyEnv = require('../../shared/legacy-env.cjs');

test('a pre-rename env var is carried over to the new spelling', () => {
  // .env is gitignored, so the Pi still says SARA_HA_TOKEN while the code reads
  // SAIM_HA_TOKEN. Nothing errors — the bridge just goes idle and the kiosk
  // reports itself healthy while unable to see the house.
  const env = { SARA_PORT: '3005' };
  legacyEnv.applyLegacyEnv(env, () => {});
  assert.equal(env.SAIM_PORT, '3005');
});

test('it COPIES — the old variable is left in place for a rollback', () => {
  const env = { SARA_PORT: '3005' };
  legacyEnv.applyLegacyEnv(env, () => {});
  assert.equal(env.SARA_PORT, '3005', 'code rolled back to the old name must still find it');
});

test('an already-migrated machine is never overridden by a stale legacy line', () => {
  const env = { SARA_HA_BASE_URL: 'http://old', SAIM_HA_BASE_URL: 'http://new' };
  legacyEnv.applyLegacyEnv(env, () => {});
  assert.equal(env.SAIM_HA_BASE_URL, 'http://new',
    'an explicitly set SAIM_* is the migrated answer and outranks the old line');
});

test('unrelated variables are not touched, and the shim says what it carried', () => {
  const env = { SARA_HA_TOKEN: 'a-real-secret', NEURO_PIN: '1234' };
  let logged = '';
  legacyEnv.applyLegacyEnv(env, (m) => { logged = m; });
  assert.equal(env.NEURO_PIN, '1234');
  assert.ok(logged.includes('SARA_HA_TOKEN -> SAIM_HA_TOKEN'), 'it must name what it carried');
  // ⚠ These variable names include tokens. The shim reports NAMES, never values
  // — a log line that solves the mystery by printing the secret is worse than
  // the mystery.
  assert.ok(!logged.includes('a-real-secret'), 'a value must never reach the log');
});

test('the shim is applied at BOOT in both backends, before anything reads env', () => {
  // A shim nobody calls is the "reader with no writer" failure in its purest
  // form: correct code, wired to nothing, discovered by an outage.
  for (const rel of ['../server.js', '../../saim/backend/server.js']) {
    const src = fs.readFileSync(path.join(__dirname, rel), 'utf8');
    assert.ok(/legacy-env\.cjs'\)\.applyLegacyEnv\(\)/.test(src), `${rel} must apply the shim`);
  }
});

// ── names this repo does NOT own ───────────────────────────────────────────
//
// ⚠ THE RENAME SWEEP GOT THESE WRONG ONCE (15 Sep 2026) and they had to be put
// back by hand. A find-and-replace cannot tell a name we own from a name that
// lives in Notion, in the iOS build settings, or as a file on Nick's disk —
// renaming the REFERENCE just makes the reference wrong, silently, and a doc
// naming a page or a file that does not exist is worse than no doc.
//
// This is a forbidden-wording test, the `prompt-parity` pattern: it fails if a
// future sweep "finishes the job" on any of them.

const REPO = path.join(__dirname, '..', '..');
const readRepo = (...p) => fs.readFileSync(path.join(REPO, ...p), 'utf8');

test('the iOS bundle id is documented as it actually is, not as the rename would have it', () => {
  const claude = readRepo('CLAUDE.md');
  assert.ok(claude.includes('uk.co.nickward.sara'), 'the real bundle id must appear');
  assert.ok(!/uk\.co\.nickward\.saim/.test(claude),
    'uk.co.nickward.saim does not exist — renaming it makes CLAUDE.md contradict the code');
});

test('Notion page titles keep the spelling Notion actually uses', () => {
  // Verified against the live mappings in agent_state on the Pi: the pages are
  // "NEURO / SARA / Architecture" and "NEURO / SARA / Current State". Renaming
  // them is a Notion-side action, not a repo one.
  assert.ok(readRepo('CLAUDE.md').includes('SARA Memory'),
    'the Notion tree is titled "SARA Memory" in Notion');
  assert.ok(readRepo('backend', 'services', 'notion-sync', 'notion-api.js').includes('NEURO / SARA /'),
    'the example must name the real page tree');
});

test('code pointing at a vault note names the file that is on disk', () => {
  assert.ok(readRepo('backend', 'services', 'saim-voice.js').includes('SARA — Personality Spec'),
    'the vault file is still named "SARA — Personality Spec.md"');
  assert.ok(readRepo('saim', 'shared-ui', 'Lit.jsx').includes('SARA — Design Build Order'),
    'the vault file is still named "SARA — Design Build Order.md"');
});

test('positive control — the scan is reading real files', () => {
  // Without this, a typo'd path would make every assertion above pass by
  // throwing nowhere and asserting on nothing. (It would actually throw, but
  // the control makes the intent explicit and survives a refactor to a
  // forgiving reader.)
  assert.ok(readRepo('CLAUDE.md').includes('SAiM'), 'CLAUDE.md must be the rebranded file');
  assert.ok(readRepo('backend', 'services', 'saim-voice.js').length > 100, 'saim-voice.js must be real');
});

test('the MCP instructions still tell the model that Sara is the EXTERNAL ChatGPT assistant', () => {
  // ⚠ NOT A STALE REFERENCE TO THE RETIRED NAME. Sara is a real, separate
  // assistant living in ChatGPT — confirmed by Nick, 15 Sep 2026. NEURO
  // push-only publishes vault notes into Notion pages still titled
  // `NEURO / SARA / …` (verified against agent_state.notion_sync_mappings on
  // the Pi), so a model told only that SAiM exists would read those titles as a
  // stale reference to SAiM and conflate two different assistants.
  //
  // ⚠ This sentence was DELETED once, by a session that grepped both repos,
  // found no evidence of the entity, and reasonably concluded it was invented.
  // An exhaustive search of code cannot disprove a fact about a system the code
  // does not own — and the asymmetry is the whole argument: keeping a
  // possibly-wrong instruction costs one confusing sentence, deleting a
  // possibly-right one silently destroys a fact nothing else records.
  //
  // It lives in mcp-server/remote/tools.js, which this file does not own. If
  // that string moves, update this path rather than dropping the assertion.
  const tools = readRepo('mcp-server', 'remote', 'tools.js');
  assert.ok(/Sara is the external ChatGPT assistant/.test(tools),
    'the disambiguation must survive a rename sweep — see the comment above it in tools.js');
  assert.ok(!/SAiM is the external ChatGPT assistant/.test(tools),
    'renaming it is worse than deleting it: SAiM is what NEURO is, not something living in ChatGPT');
});
