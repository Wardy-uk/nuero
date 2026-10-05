'use strict';
// A confident in-house room answers presence when the phone cannot — never over it.
const test = require('node:test');
const assert = require('node:assert');
const { presenceFromRoom } = require('./attention');

const bedroom = { known: true, room: 'bedroom', offsite: false };

test('a stale phone plus a sure bedroom read is HOME', () => {
  const p = presenceFromRoom({ known: false }, bedroom);
  assert.deepStrictEqual({ known: p.known, present: p.present, source: p.source }, { known: true, present: true, source: 'room-sensor' });
});

test('a phone that answered wins, even not_home — the room tracks the watch', () => {
  assert.strictEqual(presenceFromRoom({ known: true, present: false }, bedroom), null);
});

test('an OFFSITE room is never proof of being home', () => {
  assert.strictEqual(presenceFromRoom({ known: false }, { known: true, room: 'office', offsite: true }), null);
});

test('SAiM not saying whether a room is offsite is "cannot tell"', () => {
  assert.strictEqual(presenceFromRoom({ known: false }, { known: true, room: 'bedroom', offsite: null }), null);
});

test('an unsure room is not evidence', () => {
  assert.strictEqual(presenceFromRoom({ known: false }, { known: false, room: null, offsite: false }), null);
});

// ⚠ The pure tests pass with the helper never CALLED. This drives the real
// gather() with the three sources stubbed to the 5 Oct 07:25 state.
test('WIRING: gather() turns a stale phone + sure bedroom into presence, with no presence gap', async () => {
  const path = require('path');
  const stub = (name, exports) => {
    const id = require.resolve(path.join(__dirname, name));
    const prev = require.cache[id];
    require.cache[id] = { id, filename: id, loaded: true, exports };
    return () => { if (prev) require.cache[id] = prev; else delete require.cache[id]; };
  };
  const undo = [
    stub('ha', { isConfigured: () => true, getPhoneStatus: async () => ({ presence: 'home', presenceAgeHours: 11.3 }) }),
    stub('room-presence', { read: async () => ({ known: true, room: 'bedroom', offsite: false, subject: 'watch' }) }),
    stub('location', { isConfigured: () => false }),
  ];
  try {
    const attention = require('./attention');
    const g = await attention.gather(new Date('2026-10-05T06:25:00Z'));
    const inputs = g.inputs || g;
    assert.strictEqual(inputs.presence.known, true);
    assert.strictEqual(inputs.presence.present, true);
    assert.strictEqual(inputs.location.room, 'bedroom', 'the room must survive the location fallback');
    const gaps = g.gaps || inputs.gaps || [];
    assert.ok(!gaps.some((x) => x.input === 'presence'), 'no presence gap: ' + JSON.stringify(gaps));
  } finally { undo.forEach((u) => u()); }
});
