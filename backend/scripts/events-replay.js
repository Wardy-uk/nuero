#!/usr/bin/env node
'use strict';

/**
 * Rebuild a replayable consumer from the start of the event log.
 *
 *   node backend/scripts/events-replay.js source-health          # replay
 *   node backend/scripts/events-replay.js --status               # just look
 *
 * Safe to run while the server is up: the consumer's offset is guarded, so a
 * pump in the server that collides with this replay stops rather than applying
 * an event twice. Only consumers declared `replayable` (no external effect) can
 * be replayed; anything else is refused by the bus. Nothing is re-published.
 *
 * On the Pi, export Node 22 first (Node 20 segfaults better-sqlite3).
 */

const db = require('../db/database');
const bus = require('../services/event-bus');

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error('usage: events-replay.js <consumer> | --status');
    process.exit(2);
  }
  await db.init();
  bus.listConsumers();
  if (arg !== '--status') {
    const before = bus.getStatus().consumers.find(c => c.name === arg);
    console.log('before:', JSON.stringify(before));
    const res = await bus.replayConsumer(arg);
    console.log('replay:', JSON.stringify(res));
  }
  console.log(JSON.stringify(bus.getStatus(), null, 2));
}

main().catch(e => {
  console.error('replay failed:', e.message);
  process.exit(1);
});
