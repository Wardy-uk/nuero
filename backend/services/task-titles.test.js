'use strict';
/**
 * Short display titles for the family wall (17 Oct 2026). The real household
 * task wordings are the fixtures. The record is never changed; a model's
 * rewrite is only used if it adds no word the task (or the car's name) lacks.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const t = require('./task-titles');

const ctx = { car: 'Captur' };
const MOT = 'Book my car in for its MOT tomorrow (8 October 2026). Must do tomorrow.';
const BASICS = 'Fill in the Captur basics in NEURO: registration, current mileage, MOT, tax and insurance';

test('rules: the first clause, no dates or time words, "my car" named from the vehicle record', () => {
  assert.equal(t.ruleTitle(MOT, ctx), 'Book Captur MOT');
  assert.equal(t.ruleTitle(BASICS, ctx), 'Fill in the Captur basics');
  assert.equal(t.ruleTitle(MOT, {}), 'Book my car MOT', 'no vehicle on record: the car is not named');
  assert.equal(t.ruleTitle('Renew car tax by Friday', ctx), 'Renew car tax');
  assert.equal(t.ruleTitle('Pay the window cleaner on 12/11/2026', ctx), 'Pay the window cleaner');
  assert.equal(t.ruleTitle('Take bins out', ctx), 'Take bins out', 'a short task is left alone');
  for (const s of [MOT, BASICS, 'Apply for Part-Time Tuition Fee Loan for TM252 module, before the deadline']) {
    const out = t.ruleTitle(s, ctx);
    assert.ok(out.split(' ').length <= t.MAX_WORDS && out.length <= 34, out);
    assert.ok(!/\b(tomorrow|october|2026|must do)\b/i.test(out), 'no date survives into the label: ' + out);
  }
});

test('a model title is only shown if it adds nothing the task does not say', () => {
  assert.equal(t.acceptable('Book Captur MOT', MOT, ctx), 'Book Captur MOT');
  assert.equal(t.acceptable('Complete Captur details', BASICS, ctx), 'Complete Captur details');
  assert.equal(t.acceptable('Book Captur MOT for Monday', MOT, ctx), null, 'a day the task does not hold');
  assert.equal(t.acceptable('Call Helen about the car', MOT, ctx), null, 'a person the task does not name');
  assert.equal(t.acceptable('Book MOT on 8 Oct', MOT, ctx), null, 'no digits — a date is never restated');
  assert.equal(t.acceptable('Book Captur MOT', MOT, {}), null, 'the car name needs a vehicle on record');
  assert.equal(t.acceptable('', MOT, ctx), null);
  assert.equal(t.acceptable('One two three four five six', 'one two three four five six', ctx), null, 'at most five words');
});

test('titlesFor answers at once with the rules title, never waiting for a model', () => {
  const out = t.titlesFor([{ id: 1, text: MOT }, { id: 2, text: 'Take bins out' }]);
  assert.equal(typeof out[1], 'string');
  assert.ok(out[1].length > 0 && out[1].length <= 34);
  assert.equal(out[2], 'Take bins out');
});
