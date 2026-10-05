'use strict';
// A commitment's counterpart is an object; the line names a person or says nothing.
const test = require('node:test');
const assert = require('node:assert');
const { counterpartLine } = require('./presentation-intent');

test('a named counterpart reads as a name, never [object Object]', () => {
  assert.strictEqual(counterpartLine({ direction: 'i-owe', counterpart: { name: 'Heidi Power', status: 'resolved' } }), 'For Heidi Power');
  assert.strictEqual(counterpartLine({ direction: 'owed-to-me', counterpart: { name: 'Naomi', status: 'unresolved' } }), 'From Naomi');
});

test('nobody named is NO line, not a placeholder', () => {
  assert.strictEqual(counterpartLine({ direction: 'i-owe', counterpart: { name: null, status: 'not-named' } }), null);
});
