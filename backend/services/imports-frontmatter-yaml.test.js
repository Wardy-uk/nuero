'use strict';

/**
 * A routed Plaud note's frontmatter must be valid YAML.
 *
 * `updateFrontmatter` wrote every value raw, and the deterministic router's reason
 * carries a colon ("Deterministic PLAUD routing: identified a project or
 * implementation meeting."). YAML reads `key: a: b` as a mapping inside a mapping, so
 * Obsidian and Dataview parsed NO frontmatter for those notes — date, type, people,
 * meeting-type all invisible. Found 23 Oct 2026 when a vault dashboard counted 1
 * meeting in a week that held 8; 248 notes were affected.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const imports = require('./imports');
const nova121 = require('./nova-121-transcripts');

const ROUTER_REASON = 'Deterministic PLAUD routing: identified a project or implementation meeting.';

function tmpNote(text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-yaml-'));
  const file = path.join(dir, 'note.md');
  fs.writeFileSync(file, text, 'utf-8');
  return file;
}

// Each top-level `key: value` line — a plain scalar may not contain ": " or " #".
function plainScalarProblems(text) {
  const block = text.match(/^---\n([\s\S]*?)\n---/)[1];
  return block.split('\n')
    .filter((l) => /^[A-Za-z_][\w-]*:/.test(l))
    .map((l) => [l, l.slice(l.indexOf(':') + 1).trim()])
    .filter(([, v]) => v && !/^["'[{]/.test(v) && (/:\s|:$|\s#/.test(v) || /^[@`%&*!?|>,]/.test(v)))
    .map(([l]) => l);
}

test('a router reason containing ": " is written quoted', () => {
  const file = tmpNote('---\ntitle: Something\n---\nBody\n');
  imports.updateFrontmatter(file, {
    status: 'processed',
    plaud_route_reason: ROUTER_REASON,
    'review-reason': 'Medium confidence: review suggested',
  });
  const out = fs.readFileSync(file, 'utf-8');
  assert.deepEqual(plainScalarProblems(out), []);
  assert.match(out, /^plaud_route_reason: "Deterministic PLAUD routing: identified/m);
  assert.match(out, /^status: processed$/m, 'a safe plain value stays plain');
  assert.match(out, /\nBody\n$/);
});

test('pre-quoted values, block lists and flow lists pass through untouched', () => {
  assert.equal(imports.yamlValue('"1-1"'), '"1-1"');
  assert.equal(imports.yamlValue('\n  - "Nick Ward"'), '\n  - "Nick Ward"');
  assert.equal(imports.yamlValue('[a, b]'), '[a, b]');
  assert.equal(imports.yamlValue('2026-10-21'), '2026-10-21');
  assert.equal(imports.yamlValue(''), '');
  assert.equal(imports.yamlValue('|'), '|', 'a block-scalar indicator is not a value to quote');
  assert.equal(imports.yamlValue('>-'), '>-');
  assert.equal(imports.yamlValue('@someone'), '"@someone"');
  assert.equal(imports.yamlValue('see #3'), '"see #3"');
});

test('a broken value already in the file is healed on the next write', () => {
  const file = tmpNote(`---\ndate: 2026-10-21\nplaud_route_reason: ${ROUTER_REASON}\n---\nBody\n`);
  imports.updateFrontmatter(file, { status: 'processed' });
  const out = fs.readFileSync(file, 'utf-8');
  assert.deepEqual(plainScalarProblems(out), []);
  // Rewriting again must not double-quote.
  imports.updateFrontmatter(file, { status: 'processed' });
  assert.equal(fs.readFileSync(file, 'utf-8'), out);
});

test('readers still see the words: unquoteYaml and nova-121 readNote', () => {
  const file = tmpNote('---\ntitle: X\n---\nBody\n');
  imports.updateFrontmatter(file, {
    plaud_route_reason: 'Deterministic PLAUD routing: identified a 1-2-1/performance note for Hope Goodall.',
  });
  const { fm } = nova121._internals ? nova121._internals.readNote(file) : nova121.readNote(file);
  assert.match(fm.plaud_route_reason, /^Deterministic PLAUD routing: .*1-2-1\/performance note for Hope Goodall\.$/);
  assert.equal(imports.unquoteYaml('"Medium confidence: x"'), 'Medium confidence: x');
  assert.equal(imports.unquoteYaml('plain'), 'plain');
});
