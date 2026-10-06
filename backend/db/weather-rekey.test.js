'use strict';

/**
 * The weather_observations re-key runs against the LIVE database, where the
 * table already exists with the first key. Tests otherwise build a fresh DB and
 * never take the migration path (database.js has the calendar incident), so this
 * builds the OLD shape first, with rows, and boots the real init() over it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-wx-rekey-')), 'a.db');
process.env.NEURO_DB_PATH = DB_PATH;

test('⚠ the old (node_id, boot, sequence) table is rebuilt on the new key with every row kept', async () => {
  const raw = new Database(DB_PATH);
  raw.exec(`CREATE TABLE weather_observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT, node_id TEXT NOT NULL, boot INTEGER NOT NULL DEFAULT 1,
    sequence INTEGER NOT NULL, observed_at INTEGER NOT NULL, temperature_c REAL NOT NULL,
    humidity_pct REAL NOT NULL, pressure_hpa REAL NOT NULL, battery_mv INTEGER, rssi INTEGER,
    schema_version TEXT NOT NULL, source TEXT, ingested_at INTEGER NOT NULL,
    UNIQUE(node_id, boot, sequence));
    CREATE INDEX idx_weather_obs_node_t ON weather_observations(node_id, observed_at);`);
  const ins = raw.prepare(`INSERT INTO weather_observations (node_id, boot, sequence, observed_at, temperature_c, humidity_pct, pressure_hpa, schema_version, ingested_at)
    VALUES ('outdoor-1', 1, ?, ?, 23.4, 54, 999.9, 'saim.weather.v1', 0)`);
  ins.run(15, 1791315222488); ins.run(16, 1791315282794); ins.run(1, 1791312642467);
  raw.close();

  const db = require('./database');
  await db.init();
  const sql = db.get("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'weather_observations'", []).sql;
  assert.match(sql, /UNIQUE\(node_id, sequence, observed_at\)/);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM weather_observations', []).n, 3);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'weather_observations_old'", []).n, 0);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'idx_weather_obs_node_t' AND tbl_name = 'weather_observations'", []).n, 1);
  // The new key now admits a second `sequence 1` at a different instant.
  db.run(`INSERT INTO weather_observations (node_id, boot, sequence, observed_at, temperature_c, humidity_pct, pressure_hpa, schema_version, ingested_at)
    VALUES ('outdoor-1', 1, 1, 1791312673000, 23.4, 54, 999.9, 'saim.weather.v1', 0)`, []);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM weather_observations WHERE sequence = 1', []).n, 2);
});
