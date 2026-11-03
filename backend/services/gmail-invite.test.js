'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseInviteSubject } = require('./gmail-invite');

test('a Google invitation subject names its event, day and calendar', () => {
  assert.deepStrictEqual(parseInviteSubject('Invitation: hiking? @ Sun 15 Nov 2026 (ward.nickj@gmail.com)'),
    { title: 'hiking?', date: '2026-11-15', calendar: 'ward.nickj@gmail.com' });
  assert.deepStrictEqual(parseInviteSubject('Invitation: The Hunger Games: Sunrise On The Reaping @ Sat 21 Nov 2026 12:30 - 15:33 (GMT) (ward.nickj@gmail.com)'),
    { title: 'The Hunger Games: Sunrise On The Reaping', date: '2026-11-21', calendar: 'ward.nickj@gmail.com' });
  assert.strictEqual(parseInviteSubject('Updated invitation: cinema @ Sat 21 Nov 2026 (ward.nickj@gmail.com)').title, 'cinema');
  assert.strictEqual(parseInviteSubject('Re: Invitation: hiking'), null);
  assert.strictEqual(parseInviteSubject('Driver Education Course Reminder'), null);
});

test('times are shown on the UK clock whatever offset Google sends', () => {
  const { _london } = require('./gmail-invite');
  assert.strictEqual(_london('2026-11-21T12:30:00Z'), '2026-11-21T12:30:00');
  assert.strictEqual(_london('2026-07-04T12:30:00Z'), '2026-07-04T13:30:00');
  assert.strictEqual(_london('2026-11-15'), '2026-11-15');
});
