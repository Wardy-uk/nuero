'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseAnswer, targetFor, _validate } = require('./email-calendar');

test('the Driver Education email becomes a timed draft with its Zoom link', () => {
  const r = parseAnswer('{"found":true,"title":"Speed Awareness Course","date":"2026-11-08","start":"07:45","end":"10:45","allDay":false,"location":null,"link":"https://us06web.zoom.us/j/82698029697"}');
  assert.deepStrictEqual(r.draft, {
    title: 'Speed Awareness Course', date: '2026-11-08', allDay: false,
    start: '07:45', end: '10:45', location: null, link: 'https://us06web.zoom.us/j/82698029697',
  });
});

test('no date is no draft; unreadable is not "no event"; a bad end gets an hour, never a guess at the email', () => {
  assert.strictEqual(parseAnswer('{"found":true,"date":null}').why, 'no-date');
  assert.strictEqual(parseAnswer('{"found":false}').why, 'no-event');
  assert.strictEqual(parseAnswer('sorry').why, 'unreadable');
  const r = parseAnswer('{"found":true,"date":"2026-11-08","start":"10:00","end":"09:00"}');
  assert.strictEqual(r.draft.end, '11:00');
  const all = parseAnswer('{"found":true,"date":"2026-11-08","start":null}');
  assert.strictEqual(all.draft.allDay, true);
  assert.strictEqual(parseAnswer('{"found":true,"date":"2026-11-08","link":"javascript:alert(1)"}').draft.link, null);
});

test('work mail goes to Outlook; everything else to the family calendar', () => {
  assert.strictEqual(targetFor('work'), 'outlook');
  assert.strictEqual(targetFor('personal'), 'family');
});

test('what Nick confirms is refused when wrong, never repaired', () => {
  assert.strictEqual(_validate({ title: '', date: '2026-11-08', start: '09:00', end: '10:00' }).ok, false);
  assert.strictEqual(_validate({ title: 'x', date: '8/11', start: '09:00', end: '10:00' }).ok, false);
  assert.strictEqual(_validate({ title: 'x', date: '2026-11-08', start: '10:00', end: '09:00' }).ok, false);
  assert.strictEqual(_validate({ title: 'x', date: '2026-11-08', allDay: true }).ok, true);
});
