'use strict';

/**
 * The standup is the one interaction in NEURO built around Nick pausing to
 * think, and it is a POST. Node closes an idle keep-alive socket after 5s by
 * default, so the browser wrote his reply into a socket the server had already
 * closed: the request never arrived, never reached a handler, was never logged,
 * and his message was never saved — surfacing as the bare `Failed to fetch`,
 * indistinguishable from the Pi being down. Measured on the live Pi on
 * 2026-09-09: the server sent FIN 6,006ms after answering.
 *
 * A source scan rather than a boot: server.js starts the scheduler, opens the
 * DB and reaches Graph, so requiring it in a test is a worse trade than reading
 * the two lines that matter. The positive control means a pass proves the scan
 * works rather than passing by absence.
 *
 * Deliberately no regex — this file has been rewritten by a pipeline that ate
 * its backslashes once already, and a silently broken pattern is a scan that
 * passes for the wrong reason.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');

function timeoutFor(name) {
  for (const raw of SRC.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith(`server.${name}`)) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const digits = line.slice(eq + 1).replace(/[^0-9]/g, '');
    if (digits) return Number(digits);
  }
  return null;
}

test('the scan can see the listen block at all (positive control)', () => {
  assert.ok(SRC.includes('app.listen('), 'server.js no longer calls app.listen — this scan proves nothing');
  assert.strictEqual(timeoutFor('noSuchTimeoutEver'), null, 'the scan matches things that are not there');
});

test('keepAliveTimeout outlives a human thinking pause', () => {
  const keepAlive = timeoutFor('keepAliveTimeout');
  assert.ok(keepAlive !== null, 'server.js does not set keepAliveTimeout — Node defaults to 5s and the standup POST races a closed socket');
  assert.ok(keepAlive >= 30000, `keepAliveTimeout is ${keepAlive}ms; a pause mid-standup is routinely longer than that`);
});

test('headersTimeout stays above keepAliveTimeout', () => {
  const keepAlive = timeoutFor('keepAliveTimeout');
  const headers = timeoutFor('headersTimeout');
  assert.ok(headers !== null, 'headersTimeout must be set alongside keepAliveTimeout');
  // Node kills the connection on headersTimeout. Below keepAliveTimeout it
  // would cut off the request that just won the race — the same bug, later.
  assert.ok(headers > keepAlive, `headersTimeout (${headers}ms) must exceed keepAliveTimeout (${keepAlive}ms)`);
});
