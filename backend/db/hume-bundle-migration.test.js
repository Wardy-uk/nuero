'use strict';

/**
 * hume_capture_bundles shipped (729d7cdb) with CHECK (kind IN ('sync','live')).
 * The calibration experiment needs 'calibration', and SQLite cannot widen a
 * CHECK, so database.js rebuilds the table — keeping every row. This pins that
 * against the exact shape that is live on pi5.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');

const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-hume-mig-')), 'a.db');
process.env.NEURO_DB_PATH = file;

test('an old hume_capture_bundles is rebuilt to accept calibration, every row kept', async () => {
  const Database = require('better-sqlite3');
  const old = new Database(file);
  old.exec(`CREATE TABLE hume_capture_bundles (
  bundle_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('sync', 'live')),
  device_id TEXT NOT NULL,
  client TEXT,
  client_decoder_version TEXT,
  received_at TEXT NOT NULL,
  upload_count INTEGER NOT NULL DEFAULT 1,
  conflict INTEGER NOT NULL DEFAULT 0,
  meta_json TEXT,
  PRIMARY KEY (bundle_id, payload_hash)
);`);
  old.prepare(`INSERT INTO hume_capture_bundles (bundle_id, payload_hash, kind, device_id, received_at, upload_count, meta_json)
               VALUES ('sync-old-0001', 'h1', 'sync', 'addr:09:04:02:18:BF:CB', '2026-10-24T12:00:00Z', 2, '{"new":204}')`).run();
  old.close();

  const db = require('./database');
  await db.init();
  const sql = db.get("SELECT sql FROM sqlite_master WHERE type='table' AND name='hume_capture_bundles'").sql;
  assert.match(sql, /'calibration'/);
  const row = db.get("SELECT * FROM hume_capture_bundles WHERE bundle_id = 'sync-old-0001'");
  assert.equal(row.upload_count, 2);
  assert.equal(row.meta_json, '{"new":204}');
  db.run(`INSERT INTO hume_capture_bundles (bundle_id, payload_hash, kind, device_id, received_at)
          VALUES ('calibration-x', 'h2', 'calibration', 'addr:09:04:02:18:BF:CB', '2026-10-24T13:00:00Z')`);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM hume_capture_bundles").n, 2);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'hume_capture_bundles_v1'").n, 0, 'the copy is dropped');
});
