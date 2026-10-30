'use strict';

/**
 * PLAUD's `## Action Items` templates group the list under an owner line and the
 * bullets carry no name, so read bullet by bullet every other person's actions
 * reached Nick's queue as "Unassigned" (29 Oct 2026 stand-up: 16 lines, none his).
 * Fixtures are the live notes' sections, verbatim.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-cand-owners-'));
const vault = path.join(root, 'vault');
fs.mkdirSync(path.join(vault, 'People'), { recursive: true });
for (const p of ['Nick Ward', 'Chris Middleton', 'Kayleigh Russell']) {
  fs.writeFileSync(path.join(vault, 'People', `${p}.md`), '# x\n');
}
process.env.NEURO_DB_PATH = path.join(root, 'cand.db');
process.env.OBSIDIAN_VAULT_PATH = vault;

const db = require('../db/database');
const { extractMeetingActions } = require('./action-candidates');

const REL = 'Meetings/2026/10/2026-10-29 – Stand-Up Meeting.md';
const texts = (md) => extractMeetingActions(md, REL).map((c) => c.text);

test.before(async () => { await db.init(); });

test('bold @Speaker / @Name blocks are not Nick\'s (29 Oct stand-up)', () => {
  const md = [
    '## Action Items', '',
    '**@Stephen**', '- [ ] Review the new Fire Guild response about further investigation', '',
    '**@Speaker 7**', '- [ ] Review the new ticket marked urgent',
    '- [ ] Send the ticket number for the server ticket assigned to the team', '',
    '**@Speaker 12**', '- [ ] Speak with Nick about the emails going out incorrectly, 2026-10-29',
    '- [ ] Close the reopened Swansea ticket [](plaud://source?type=summary&fileId=f_1&start_time=1)',
  ].join('\n');
  assert.deepEqual(texts(md), []);
});

test('an @Nick block IS Nick\'s, in every owner-line shape', () => {
  const shapes = [
    '**@Nick Ward**',
    '### **@Nick Ward**',
    '**[[People/Nick Ward|@Nick Ward]] (team manager)**',
    '- [[People/Nick Ward|@Nick Ward]] (Manager)',
  ];
  for (const header of shapes) {
    const out = extractMeetingActions(`## Action Items\n${header}\n  - [ ] Forward the incident guidance to the team`, REL);
    assert.equal(out.length, 1, header);
    assert.equal(out[0].owner, 'mine', header);
  }
});

test('blocks switch owner, and only Nick\'s survive', () => {
  const md = [
    '## Action Items',
    '**[[People/Chris Middleton|@Chris Middleton]] (executive / leader)**',
    '- [ ] Send Nick the link to the new SLA ticket dashboard.',
    '- [ ] Meet with Nick to review Liam’s SLA report.',
    '',
    '**[[People/Nick Ward|@Nick Ward]] (team manager)**',
    '- [ ] Forward the incident guidance Chris sends to his team.',
    '',
    '### **@Speaker 1**',
    '- [ ] Raise a support ticket regarding the newsletter duplicate send incident',
  ].join('\n');
  assert.deepEqual(texts(md), ['Forward the incident guidance Chris sends to his team.']);
});

test('a heading after the blocks ends the owner', () => {
  const md = '## Action Items\n**@Speaker 2**\n- [ ] Update the items\n## Next Arrangements\n- Nick to send the rota to the team';
  assert.deepEqual(texts(md), ['Nick to send the rota to the team']);
});

test('the prose-owner template is unchanged', () => {
  const md = '## Next Arrangements\n- Nick to send the revised rota\n- Abi to monitor the queue\n- Review the backlog on Friday';
  const out = texts(md);
  assert.ok(out.includes('Nick to send the revised rota'));
  assert.ok(out.includes('Review the backlog on Friday'));
  assert.ok(!out.some((t) => /^Abi/.test(t)));
});

test('an unowned line naming Nick as the object is not his', () => {
  assert.deepEqual(texts('## Next Arrangements\n- Speak with Nick about the emails going out incorrectly'), []);
  assert.deepEqual(texts('## Next Arrangements\n- Send Nick the dashboard link'), []);
});

test('a checkbox with an @ is an action, not an owner line', () => {
  const out = texts('## Action Items\n**@Speaker 3**\n- [ ] x\n## Action Items\n- [ ] Nick to check @Speaker 3 notes');
  assert.deepEqual(out, ['Nick to check @Speaker 3 notes']);
});
