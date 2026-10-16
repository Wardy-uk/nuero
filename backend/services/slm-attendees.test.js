'use strict';
// The Friday Support Leadership Meeting found by WHO and WHEN when PLAUD's
// title does not say so (Nick, 16 Oct 2026).
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const bw = require('./briefing-weekly');

function vault(notes) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slm-'));
  const dir = path.join(root, 'Meetings', '2026', '10');
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, startAt, body, type = 'meeting'] of notes) {
    fs.writeFileSync(path.join(dir, name), `---\ntype: ${type}\nstart_at: "${startAt}"\n---\n# x\n\n${body}\n`);
  }
  return root;
}
const WEEK = { from: '2026-10-12', to: '2026-10-18' };

test('a Friday-afternoon meeting naming two of the three is the SLM when no title matches', () => {
  const root = vault([['2026-10-16 – Metrics, CSAT and Migration.md', '2026-10-16T13:00:00', 'Nick Ward and Stephen Mitchell agreed…']]);
  const r = bw.findSlmNote(root, WEEK);
  assert.strictEqual(r.found, true);
  assert.strictEqual(r.matchedBy, 'attendees');
  assert.deepStrictEqual(r.attendees, ['Nick Ward', 'Stephen Mitchell']);
});

test('morning, one name, a first name only, a Thursday or a prep note does not match', () => {
  const cases = [
    ['2026-10-16 – A.md', '2026-10-16T09:00:00', 'Nick Ward, Stephen Mitchell, Nathan Rutland'],      // 10:00 BST
    ['2026-10-16 – B.md', '2026-10-16T13:00:00', 'Stephen Mitchell talked to Nathan'],                  // "Nathan" is two people
    ['2026-10-15 – C.md', '2026-10-15T13:00:00', 'Nick Ward, Stephen Mitchell, Nathan Rutland'],      // Thursday
    ['2026-10-16 – D.md', '2026-10-16T13:00:00', 'Nick Ward, Stephen Mitchell, Nathan Rutland', 'meeting-prep'],
  ];
  for (const c of cases) assert.strictEqual(bw.findSlmNote(vault([c]), WEEK).found, false, c[0]);
});

test('a literal title still wins over an attendee match', () => {
  const root = vault([
    ['2026-10-16 – Other.md', '2026-10-16T13:00:00', 'Nick Ward, Stephen Mitchell, Nathan Rutland'],
    ['2026-10-16 – Support Leadership Meeting.md', '2026-10-16T14:00:00', 'notes'],
  ]);
  assert.strictEqual(bw.findSlmNote(root, WEEK).matchedBy, 'title');
});
