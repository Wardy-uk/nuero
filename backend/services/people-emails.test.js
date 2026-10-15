'use strict';

// People emails: an address goes into a People note only when NEURO is sure it
// is that person's. Fixtures follow the live dry run of 15 Oct 2026.

const test = require('node:test');
const assert = require('node:assert');
const { decide } = require('./people-emails');

const roster = {
  full: ['Abigail Brown', 'Nick Ward', 'Siraj Basha', 'Steve Ryan', 'Helen Ward', 'Chris Smith', 'Chris Middleton'],
  aliases: new Map([['abi brown', 'Abigail Brown'], ['chris', 'Chris Smith'], ['seb', 'Siraj Basha']]),
};
const base = (sightings, extra = {}) => decide({
  sightings, roster,
  declared: new Map(roster.full.map((n) => [n, null])),
  own: new Set(['nickw@nurtur.tech', 'nick@nickward.co.uk']),
  self: new Set(['Nick Ward']),
  ...extra,
});
const learned = (r) => r.learn.map((l) => `${l.person}|${l.email}`);

test('one address under a full name is learned', () => {
  const r = base([{ name: 'Abigail Brown', email: 'Abigail.Brown@nurtur.tech', source: 'calendar' }]);
  assert.deepStrictEqual(learned(r), ['Abigail Brown|abigail.brown@nurtur.tech']);
});

test('"Surname, First" and a multi-word alias match; a first name does not', () => {
  const r = base([
    { name: 'Brown, Abigail', email: 'abigail.brown@nurtur.tech' },
    { name: 'Chris', email: 'someone@nurtur.tech' },
    { name: 'Seb', email: 'seb@nurtur.tech' },
  ]);
  assert.deepStrictEqual(learned(r), ['Abigail Brown|abigail.brown@nurtur.tech']);
});

test("Nick's own note is never written, even from a shared box sending as him", () => {
  const r = base([{ name: 'Nick Ward', email: 'servicehub@nurtur.tech' }]);
  assert.deepStrictEqual(r.learn, []);
  assert.strictEqual(r.skipped.self, 1);
});

test('an address seen under two people is shared and given to neither', () => {
  const r = base([
    { name: 'Chris Smith', email: 'pa@nurtur.tech' },
    { name: 'Chris Middleton', email: 'pa@nurtur.tech' },
  ]);
  assert.deepStrictEqual(r.learn, []);
  assert.strictEqual(r.shared.length, 1);
});

test('an address also seen under an unrelated name is shared; a longer form of the same name is not', () => {
  const shared = base([
    { name: 'Steve Ryan', email: 'desk@acme.com' },
    { name: 'Acme Service Desk', email: 'desk@acme.com' },
  ]);
  assert.deepStrictEqual(shared.learn, []);
  const same = base([
    { name: 'Siraj Basha', email: 'siraj.basha@nurtur.tech' },
    { name: 'Siraj Basha Moideenbasha', email: 'siraj.basha@nurtur.tech' },
    { name: 'chris@nurtur.tech', email: 'siraj.basha@nurtur.tech' },
  ]);
  assert.deepStrictEqual(learned(same), ['Siraj Basha|siraj.basha@nurtur.tech']);
});

test('automated and own addresses are never anyone\'s', () => {
  const r = base([
    { name: 'Steve Ryan', email: 'no-reply@nurtur.tech' },
    { name: 'Steve Ryan', email: 'nickw@nurtur.tech' },
  ]);
  assert.deepStrictEqual(r.learn, []);
});

test('an existing address is never overwritten, nor one another note declares', () => {
  const declared = new Map(roster.full.map((n) => [n, null]));
  declared.set('Steve Ryan', 'steve@old.com');
  declared.set('Chris Smith', 'taken@nurtur.tech');
  const r = base([
    { name: 'Steve Ryan', email: 'steve.ryan@nurtur.tech' },
    { name: 'Helen Ward', email: 'taken@nurtur.tech' },
  ], { declared });
  assert.deepStrictEqual(r.learn, []);
  assert.strictEqual(r.alreadySet, 1);
});

test('several addresses: sphere picks one, otherwise it is ambiguous and not written', () => {
  const sightings = [
    { name: 'Helen Ward', email: 'helen@gmail.com' },
    { name: 'Helen Ward', email: 'helen.ward@nurtur.tech' },
  ];
  assert.deepStrictEqual(learned(base(sightings, { spheres: new Map([['Helen Ward', 'personal']]) })), ['Helen Ward|helen@gmail.com']);
  assert.deepStrictEqual(learned(base(sightings, { spheres: new Map([['Helen Ward', 'work']]) })), ['Helen Ward|helen.ward@nurtur.tech']);
  const unknown = base(sightings);
  assert.deepStrictEqual(unknown.learn, []);
  assert.strictEqual(unknown.ambiguous.length, 1);
});
