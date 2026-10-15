'use strict';
// The work-inbox summary prompt must NAME its reader. With only a job title,
// "@Nick Ward can you help" was summarised as "contact Nick Ward's team" —
// telling Nick to go and find himself (15 Oct 2026).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, 'email-triage.js'), 'utf8');

test('summary route exists (positive control)', () => {
  assert.ok(src.includes("'/triage/:emailId/summary'"));
});

test('summary prompt names Nick as the reader and claims his team', () => {
  const start = src.indexOf("'/triage/:emailId/summary'");
  const block = src.slice(start, src.indexOf("runTask('email_summary'", start));
  assert.match(block, /for Nick Ward/);
  assert.match(block, /never tell him to contact them/);
});
