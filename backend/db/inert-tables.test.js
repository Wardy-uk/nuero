'use strict';

/**
 * A table marked `@inert` in the schema must be read and written by nothing.
 *
 * ⚠ WHY A MARKER AND NOT A COMMENT. Both inert tables ALREADY carried a clear
 * prose warning. `inbox_items`'s said, in so many words, "Written by nothing
 * since `inbox-scanner.js` was removed" — and `state-of-play.js` went on
 * counting it for three weeks, showing "Inbox 0 · 0 high" while 21 urgent emails
 * sat unread. The English was right there and changed nothing.
 *
 * The reason it survived is the shape of the retirement: the 26 Aug cleanup
 * deleted the scanner and its six `db` helpers, which is what you would check —
 * but `state-of-play` queried the table with RAW SQL and so was untouched by
 * removing the API. The reader pre-dated the retirement and nothing swept it.
 *
 * ⚠ AND A NO-WRITER TABLE IS THE DANGEROUS KIND, not a no-reader one. Dead
 * weight is merely untidy; a table with readers and no writer answers plausibly
 * for ever. That is the Jira queue cache verbatim — frozen on 3 July and stated
 * as current fact in chat, the standup, the briefing and working memory for
 * seven weeks — and it is the second time the identical failure reached a
 * surface. This closes the class rather than the instance.
 *
 * The declaration lives beside the table it describes, so retiring one is a
 * one-line edit in the schema and this follows automatically.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const BACKEND = path.join(__dirname, '..');
const REPO = path.join(BACKEND, '..');

/** Tables whose comment block carries `@inert`, with the line it was found on. */
function inertTables() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8')
    .replace(/\r\n/g, '\n');
  const lines = sql.split('\n');
  const found = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^--\s*@inert\b/.test(lines[i])) continue;
    // The next CREATE TABLE below the marker is the one it applies to. Comment
    // lines and blanks may sit between, which is how the schema already reads.
    for (let j = i + 1; j < lines.length; j += 1) {
      const m = lines[j].match(/^CREATE TABLE (?:IF NOT EXISTS )?([a-z_]+)/i);
      if (m) { found.push(m[1]); break; }
      // A second marker before any table means the first one names nothing.
      if (/^--\s*@inert\b/.test(lines[j])) break;
    }
  }
  return found;
}

/**
 * ⚠ Comments stripped, strings kept. Five files discuss `inbox_items` in prose —
 * including the fix that removed the last real reader — and counting those as
 * usage would make this test permanently red for the documentation that explains
 * it. Third place in this codebase where "a name in a comment is not a use".
 */
function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const q = c;
      out += c;
      i++;
      while (i < n && src[i] !== q) {
        if (src[i] === '\\') { out += src[i]; i++; }
        if (i < n) { out += src[i]; i++; }
      }
      out += q;
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function codeFiles() {
  const out = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', 'dist'].includes(e.name)) continue;
      const f = path.join(dir, e.name);
      if (e.isDirectory()) walk(f);
      // ⚠ Tests excluded: a table only a fixture touches is still dead in
      // production, and counting fixtures as usage certifies a corpse.
      else if (/\.(js|cjs)$/.test(e.name) && !/\.test\.js$/.test(e.name)) out.push(f);
    }
  };
  walk(path.join(BACKEND, 'db'));
  walk(path.join(BACKEND, 'services'));
  walk(path.join(BACKEND, 'routes'));
  walk(path.join(BACKEND, 'scripts'));
  walk(path.join(REPO, 'shared'));
  walk(path.join(REPO, 'worker'));
  return out;
}

test('the schema declares at least one inert table — positive control', () => {
  // Without this the whole file passes by finding nothing to check, which is the
  // failure mode that makes a scan worse than no scan.
  const tables = inertTables();
  assert.ok(tables.length >= 2,
    `expected the @inert markers to resolve to tables, got ${JSON.stringify(tables)}`);
  assert.ok(tables.includes('inbox_items'), 'inbox_items is no longer marked @inert');
  assert.ok(tables.includes('jira_tickets_cache'), 'jira_tickets_cache is no longer marked @inert');
});

test('nothing reads or writes an inert table', () => {
  const tables = inertTables();
  const offenders = [];

  for (const file of codeFiles()) {
    const code = stripComments(fs.readFileSync(file, 'utf8'));
    for (const t of tables) {
      const re = new RegExp(
        `(FROM\\s+${t}\\b|JOIN\\s+${t}\\b|INTO\\s+${t}\\b|UPDATE\\s+${t}\\b|DELETE\\s+FROM\\s+${t}\\b)`,
        'i',
      );
      if (re.test(code)) {
        offenders.push(`${path.relative(REPO, file).split(path.sep).join('/')} -> ${t}`);
      }
    }
  }

  assert.deepEqual(offenders, [], `An @inert table is being queried:\n  ${offenders.join('\n  ')}`);
});

test('discussing an inert table in a comment is still allowed', () => {
  // The fix that removed the last reader EXPLAINS itself by naming the table, and
  // several services carry it as a cautionary tale. A test that punished that
  // would delete the only record of why the table is there.
  const sop = fs.readFileSync(path.join(BACKEND, 'services', 'state-of-play.js'), 'utf8');
  assert.ok(sop.includes('inbox_items'),
    'positive control: state-of-play should still DISCUSS the table it stopped reading');
  assert.ok(!/FROM\s+inbox_items/i.test(stripComments(sop)),
    'and it must not be querying it');
});
