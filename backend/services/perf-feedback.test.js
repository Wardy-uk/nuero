'use strict';

/**
 * Feedback about Nick from meetings (30 Oct 2026). Pins:
 *  - Nick's weighting order, and that a meeting is only a 1-2-1 when the BODY's
 *    participants agree (a live note listed only Chris in frontmatter while five
 *    people were in the room);
 *  - the guard: only shape (too short, Nick's own words) — nothing is filtered
 *    for health, other colleagues or direct reports (31 Oct 2026);
 *  - the Plaud recording block never leads the text;
 *  - a full pass: highest weight read first, each note once, items in the feed.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-fb-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'agent.db');
const vault = path.join(tmp, 'vault');
process.env.OBSIDIAN_VAULT_PATH = vault;

const { test } = require('node:test');
const assert = require('node:assert/strict');

const fb = require('./perf-feedback');

test.before(async () => { await require('../db/database').init(); });
const { participantsOf, tierOf, guardItems, noteText } = fb._internals;

const ctx = {
  self: 'Nick Ward', manager: 'Chris Middleton',
  seniors: ['Chris Middleton', 'Ricky Bostock', 'Damon Bullimore'],
  directReports: ['Hope Goodall', 'Sebastian Broome'],
  roster: ['Nick Ward', 'Chris Middleton', 'Chris Smith', 'Ricky Bostock', 'Damon Bullimore', 'Hope Goodall', 'Sebastian Broome', 'Liam Sims'],
};

test('weighting: a 1-2-1 only when the body agrees; then tech leadership, risk, seniors, other', () => {
  const t = (title, people, body = '') => tierOf({ title, ...participantsOf(people, body) }, ctx);
  assert.equal(t('Weekly catch up', ['Chris Middleton', 'Nick Ward']), 1);
  assert.equal(t('Weekly Meeting AI Strategy', ['Chris Middleton', 'Nick Ward'], 'Participants: Liam Sims, Nick Ward, Ricky Bostock, Chris Middleton, Speaker 5'), 2);
  assert.equal(t('Catch up', ['Chris Middleton', 'Nick Ward'], 'Participants: Nick Ward, Chris Middleton, Speaker 2'), 4, 'an unnamed third voice is not a 1-2-1');
  assert.equal(t('Tech Leadership Meeting Support Ops', ['Liam Sims']), 2);
  assert.equal(t('Risk Meeting Register Overhaul', ['Liam Sims']), 3);
  assert.equal(t('Sprint review', ['Damon Bullimore', 'Liam Sims']), 4);
  assert.equal(t('Daily standup', ['Hope Goodall']), 5);
});

test('the guard: only shape — too short and Nick\'s own words are dropped; everyone, direct reports included, is named', () => {
  const out = guardItems({ feedback: [
    { from: 'Chris Middleton', said: 'Chris was pleased with how Nick presented the KPI pack to SMT.', stance: 'for', about: 'KPI reporting' },
    { from: 'Chris Middleton', said: 'Chris wants Nick to escalate Engineering blockers earlier.', stance: 'against' },
    { from: 'Chris Middleton', said: 'Nick handled Hope Goodall\'s situation well.', stance: 'for' },
    { from: 'Chris Middleton', said: 'Nick managed the sickness absence cases well this month.', stance: 'for' },
    { from: 'Hope Goodall', said: 'The call coaching from Nick has made a real difference to my confidence.', stance: 'for' },
    { from: 'Hope Goodall', said: 'Hope said Nick should share the rota sooner.', stance: 'against' },
    { from: 'Liam Sims', said: 'Liam thought the escalation guide Nick wrote saved the team time.', stance: 'for' },
    { from: 'Chris Middleton', said: 'ok', stance: 'for' },
    { from: 'Nick Ward', said: 'Nick suggested adopting the ITIL framework for the service desk.', stance: 'for' },
  ] }, ctx);
  assert.deepEqual(out.map((o) => o.said.slice(0, 20)), [
    'Chris was pleased wi', 'Chris wants Nick to ', 'Nick handled Hope Go', 'Nick managed the sic',
    'The call coaching fr', 'Hope said Nick shoul', 'Liam thought the esc',
  ]);
  const dr = out.find((o) => o.role === 'direct-report');
  assert.ok(dr && dr.from, 'a direct report is named');
  assert.equal(out[0].role, 'manager');
  assert.equal(out[1].stance, 'against');
});

test('the Plaud recording block never leads the text', () => {
  const t = noteText('# Summary\n\n## Recording\n\n- Plaud ID: `x`\n- Created: 2026\n- Started: 2026\n- Duration: 1h\n- Device: 88\n\n## Summary\n\nChris praised the dashboards.');
  assert.ok(!/Created|Duration|Device|Plaud ID/.test(t));
  assert.match(t, /Chris praised the dashboards/);
});

test('a pass reads the highest-weight meeting first, each note once, and feeds the window', async () => {
  const dir = path.join(vault, 'Meetings', '2026', '10');
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(vault, 'People'), { recursive: true });
  for (const n of ctx.roster) fs.writeFileSync(path.join(vault, 'People', `${n}.md`), `---\nrole: x\n---\n`);
  fs.writeFileSync(path.join(vault, 'People', 'Nick Ward.md'), '---\nmanager: "[[People/Chris Middleton|Chris Middleton]]"\n---\n');
  const note = (title, people) => `---\ntype: meeting\ndate: 2026-10-20\npeople:\n${people.map((p) => `  - "[[People/${p}|${p}]]"`).join('\n')}\n---\n# Summary\n\nNotes for ${title}.`;
  fs.writeFileSync(path.join(dir, '2026-10-20 – Daily Standup.md'), note('standup', ['Nick Ward', 'Hope Goodall']));
  fs.writeFileSync(path.join(dir, '2026-10-20 – Catch up with Chris.md'), note('catch up', ['Nick Ward', 'Chris Middleton']));

  const seen = [];
  const deps = {
    ctx: { ...ctx, vaultRoot: vault },
    run: async (prompt) => {
      seen.push(prompt.match(/MEETING: (.*) \(/)[1]);
      return { text: JSON.stringify({ feedback: /catch up/i.test(prompt) ? [{ from: 'Chris Middleton', said: 'Chris liked the new SLA review cadence Nick set up.', stance: 'for' }] : [] }) };
    },
  };
  const r1 = await fb.run({ limit: 1, deps });
  assert.equal(r1.read, 1);
  assert.match(seen[0], /Catch up with Chris/, 'the 1-2-1 with the manager is read first');
  await fb.run({ limit: 5, deps });
  const again = await fb.run({ limit: 5, deps });
  assert.equal(again.read, 0, 'an unchanged note is never read twice');

  const items = fb.itemsFor({ from: '2026-10-01', to: '2026-10-31' });
  assert.equal(items.length, 1);
  assert.match(items[0].title, /Chris Middleton \(your line manager\) — 1-2-1 with your line manager \(weight 1 of 5\)/);
  assert.equal(items[0].hint, 'for');
  assert.equal(items[0].kind, 'feedback-t1');
});
