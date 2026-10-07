'use strict';

/**
 * PLAUD's `## Action Items` heading was never an action heading, so every note
 * using it (95 of them on 7 Oct 2026) contributed nothing to the review queue.
 * The fixture is the live 7 Oct consolidation meeting's section, verbatim.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-cand-headings-'));
const vault = path.join(root, 'vault');
fs.mkdirSync(path.join(vault, 'People'), { recursive: true });
for (const p of ['Nick Ward', 'Chris Middleton', 'Lucy Read', 'Siraj Basha']) {
  fs.writeFileSync(path.join(vault, 'People', `${p}.md`), '# x\n');
}
process.env.NEURO_DB_PATH = path.join(root, 'cand.db');
process.env.OBSIDIAN_VAULT_PATH = vault;

const db = require('../db/database');
const { extractMeetingActions } = require('./action-candidates');

const REL = 'Meetings/2026/10/2026-10-07 – Support Teams Consolidation Meeting.md';

const LIVE = [
  '## Action Items',
  '- Complete HR procedures for the new reporting structure.',
  '- Provision Jira licenses for Sarad’s team; create a service account with full project access for Nick.',
  '- Set up and test routing with new email addresses for Starberry, Yomdel(e)/Yarmdale, and TPJ within NT; then switch live addresses.',
  '- Implement updated round-robin logic to keep client tickets with the same initial agent.',
  '- Investigate migration path from old portals to the unified portal (e.g., linking from old forms).',
  '- Nick and Suraj (or substitute) 20-minute review on Oct 7; Nick to coordinate finer details with Lucy.',
  '- Chris to schedule follow-ups for early week of Oct 12; Chris and Lucy to meet Oct 7 or 9.',
  '## Open Decisions and Risks',
  '- Decide on the unified billing model (tiered plans vs. global credits).',
].join('\n');

test.before(async () => { await db.init(); });

test('PLAUD "## Action Items" is read', () => {
  const out = extractMeetingActions(LIVE, REL).map((c) => c.text);
  assert.ok(out.some((t) => /^Nick and Suraj/.test(t)), `Nick's own item missing: ${JSON.stringify(out)}`);
  assert.ok(out.some((t) => /^Implement updated round-robin/.test(t)));
  assert.ok(out.length >= 4, `expected several candidates, got ${out.length}`);
});

test('someone else\'s item and the next section are still not Nick\'s tasks', () => {
  const out = extractMeetingActions(LIVE, REL).map((c) => c.text);
  assert.ok(!out.some((t) => /^Chris to schedule/.test(t)));
  assert.ok(!out.some((t) => /^Decide on the unified billing/.test(t)), 'Open Decisions is not an action section');
});

test('qualified variants PLAUD writes are read too', () => {
  for (const h of ['## Action Items from this 1:1', '### Follow-up Actions', '## **Action Items**', '## Action Points']) {
    const out = extractMeetingActions(`${h}\n- Nick to send the revised rota to the team`, REL);
    assert.equal(out.length, 1, h);
  }
});

test('a heading that merely mentions actions is not one', () => {
  const out = extractMeetingActions('## Actionable insights\n- Nick to send the revised rota to the team', REL);
  assert.equal(out.length, 0);
});
