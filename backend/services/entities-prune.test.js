'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * `pruneExcludedEntities` had ONE arm — the exclude list — and a moved note is not an
 * excluded one. When 111 duplicate PLAUD notes were archived on 16 Sep 2026, their
 * 4,354 entity rows stayed behind under the path the notes used to occupy, inflating
 * mention counts on every person page with meetings that no longer exist. Nothing
 * anywhere would ever have dropped them.
 */

function withEntities(run) {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'entities-prune-'));
  const dbPath = path.join(vault, 'scratch.db');
  const prevVault = process.env.OBSIDIAN_VAULT_PATH;
  const prevDb = process.env.NEURO_DB_PATH;
  process.env.OBSIDIAN_VAULT_PATH = vault;
  process.env.NEURO_DB_PATH = dbPath;

  for (const key of Object.keys(require.cache)) {
    if (key.includes('entities') || key.includes('database')) delete require.cache[key];
  }

  return (async () => {
    const db = require('../db/database');
    await db.init();
    const entities = require('./entities');
    try {
      return await run({ vault, db, entities });
    } finally {
      if (prevVault === undefined) delete process.env.OBSIDIAN_VAULT_PATH;
      else process.env.OBSIDIAN_VAULT_PATH = prevVault;
      if (prevDb === undefined) delete process.env.NEURO_DB_PATH;
      else process.env.NEURO_DB_PATH = prevDb;
      for (const key of Object.keys(require.cache)) {
        if (key.includes('entities') || key.includes('database')) delete require.cache[key];
      }
    }
  })();
}

function seed(db, relativePath, name) {
  db.run(
    'INSERT INTO extracted_entities (entity_type, entity_value, source_path, context, extracted_at) VALUES (?, ?, ?, ?, ?)',
    ['person', name, relativePath, 'context', new Date().toISOString()]
  );
}

test('a note that has GONE loses its mentions', async () => {
  await withEntities(async ({ vault, db, entities }) => {
    fs.mkdirSync(path.join(vault, 'Meetings'), { recursive: true });
    fs.writeFileSync(path.join(vault, 'Meetings', 'live.md'), '# live');

    seed(db, 'Meetings/live.md', 'Hope Goodall');
    seed(db, 'Meetings/archived-copy 2.md', 'Hope Goodall');

    const result = entities.pruneExcludedEntities();
    assert.equal(result.prunedMissing, 1, 'the note that is gone must be pruned');

    const left = db.all('SELECT DISTINCT source_path FROM extracted_entities').map((r) => r.source_path);
    assert.deepEqual(left, ['Meetings/live.md'], 'the note still on disk keeps its mentions');
  });
});

test('an UNREADABLE vault prunes nothing by the missing-file arm', async () => {
  await withEntities(async ({ vault, db, entities }) => {
    seed(db, 'Meetings/live.md', 'Hope Goodall');
    seed(db, 'Meetings/also-live.md', 'Nathan Rutland');

    // The disk is not there — every note looks missing, and deleting every mention
    // NEURO holds is not a recoverable mistake.
    process.env.OBSIDIAN_VAULT_PATH = path.join(vault, 'gone');
    for (const key of Object.keys(require.cache)) {
      if (key.includes('entities')) delete require.cache[key];
    }
    const reloaded = require('./entities');

    const result = reloaded.pruneExcludedEntities();
    assert.equal(result.vaultReadable, false, 'it must SAY it could not look');
    assert.equal(result.prunedMissing, 0);
    assert.equal(db.all('SELECT DISTINCT source_path FROM extracted_entities').length, 2,
      'an unreadable vault is never evidence that a note has gone');
  });
});

test('the exclude arm still works, and is reported separately', async () => {
  await withEntities(async ({ vault, db, entities }) => {
    fs.mkdirSync(path.join(vault, 'Archive'), { recursive: true });
    fs.writeFileSync(path.join(vault, 'Archive', 'old.md'), '# old');
    fs.mkdirSync(path.join(vault, 'Meetings'), { recursive: true });
    fs.writeFileSync(path.join(vault, 'Meetings', 'live.md'), '# live');

    // Present on disk, but excluded — a different fact from being gone, and the two
    // are counted separately so a report can tell them apart.
    seed(db, 'Archive/old.md', 'Hope Goodall');
    seed(db, 'Meetings/live.md', 'Hope Goodall');

    const result = entities.pruneExcludedEntities();
    assert.equal(result.pruned, 1, 'the excluded note is pruned by the exclude arm');
    assert.equal(result.prunedMissing, 0, 'it is on disk, so it is not missing');
  });
});
