'use strict';

/**
 * "Due today" means today.
 *
 * Nick pressed the Due today chip with 8 tasks due that day and saw SEVEN rows,
 * every one of them overdue — 33d, 26d, 2d — and not one of the eight. The
 * backend was innocent throughout: `/api/todos/focus?filter=today` returned all
 * eight correctly.
 *
 * The predicate was:
 *
 *   const d = new Date(t.due_date);                      // UTC midnight
 *   const today = new Date(new Date().toDateString());   // LOCAL midnight
 *   return d.getTime() === today.getTime() || d < today;
 *
 * In BST those two are an hour apart, so a task due TODAY sits an hour AFTER
 * "today" and matches NEITHER branch. What survived was `d < today` — the
 * overdue pile — so the chip quietly became a second, worse Overdue filter. It
 * would have started working by itself in October when the clocks change, which
 * is the worst possible way for a bug to go away.
 *
 * ⚠ THE OBVIOUS TEST IS WORTHLESS ON THIS MACHINE. Windows ignores `TZ` in
 * process, and Europe/London is east of UTC, so a behavioural test here passes
 * under the broken form for half the year. The CONSTRUCTION is therefore pinned
 * by a source scan as well as the behaviour — the same belt-and-braces the
 * ritual-record date rule needed.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const DIR = path.resolve(__dirname, '..', '..', 'frontend', 'src', 'components');
const TODO = path.join(DIR, 'TodoPanel.jsx');
const DONEXT = path.join(DIR, 'DoNextPanel.jsx');

let mod;

test.before(async () => {
  const out = await esbuild.build({
    entryPoints: [TODO],
    bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic',
    external: ['react', 'react-dom'], logLevel: 'silent',
    plugins: [{
      name: 'stub',
      setup(build) {
        build.onResolve({ filter: /\.css$/ }, a => ({ path: a.path, namespace: 'css' }));
        build.onLoad({ filter: /.*/, namespace: 'css' }, () => ({ contents: '', loader: 'js' }));
        build.onResolve({ filter: /(^|\/)api$/ }, () => ({ path: 'api', namespace: 'stub' }));
        build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
          contents: 'export const apiUrl = p => p;\nexport default { apiUrl };', loader: 'js',
        }));
      },
    }],
  });
  const m = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(m, m.exports, require);
  mod = m.exports;
  assert.ok(mod.FILTER_PREDICATES, 'positive control: predicates must be exported');
  assert.ok(mod.todayKey, 'positive control: todayKey must be exported');
});

// Clock-derived, so this cannot rot into a date bomb.
const shift = (days) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

test('a task due TODAY matches — the case that was broken all summer', () => {
  assert.equal(mod.FILTER_PREDICATES.today({ due_date: mod.todayKey() }), true);
  assert.equal(mod.FILTER_PREDICATES.today({ due_date: shift(0) }), true);
});

test('overdue and future tasks do NOT match', () => {
  // Overdue has its own chip. A "Due today" that also answers "or earlier" is a
  // second, worse Overdue filter, which is exactly what it had become.
  assert.equal(mod.FILTER_PREDICATES.today({ due_date: shift(-1) }), false, 'yesterday is not today');
  assert.equal(mod.FILTER_PREDICATES.today({ due_date: shift(-33) }), false, '33d overdue is not today');
  assert.equal(mod.FILTER_PREDICATES.today({ due_date: shift(1) }), false, 'tomorrow is not today');
});

test('an undated task never matches either filter', () => {
  assert.equal(mod.FILTER_PREDICATES.today({ due_date: null }), false);
  assert.equal(mod.FILTER_PREDICATES.nodue({ due_date: null }), true);
});

test('a full timestamp is SLICED, not re-parsed', () => {
  // The stored value may carry a time. Re-parsing it is what re-introduces the
  // offset this whole file exists to remove.
  assert.equal(mod.dueKey('2026-09-23T14:30:00.000Z'), '2026-09-23');
  assert.equal(mod.FILTER_PREDICATES.today({ due_date: `${mod.todayKey()}T23:59:00Z` }), true);
});

/**
 * Strip comments, walking strings rather than blindly removing.
 *
 * ⚠ Without this the scan fails on the comment ABOVE the fix that EXPLAINS the
 * broken construction — punishing the documentation of a bug is how a guard
 * gets deleted, and it takes the real catches with it. Fourth instance of "a
 * name inside a comment counts" in this repo.
 */
function stripComments(src) {
  // Backslash and newline built by code point: this file has been rewritten
  // through shells that eat escapes, and a mangled one here fails at parse.
  const BS = String.fromCharCode(92);
  const NL = String.fromCharCode(10);
  let out = '', i = 0, quote = null;
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (quote) {
      if (c === BS) { out += '  '; i += 2; continue; }
      if (c === quote) quote = null;
      out += c; i++; continue;
    }
    if (c === '"' || c === String.fromCharCode(39) || c === String.fromCharCode(96)) { quote = c; out += c; i++; continue; }
    if (c === '/' && n === '/') { while (i < src.length && src[i] !== NL) { out += ' '; i++; } continue; }
    if (c === '/' && n === '*') {
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) { out += src[i] === NL ? NL : ' '; i++; }
      out += '  '; i += 2; continue;
    }
    out += c; i++;
  }
  return out;
}

test('⚠ CONSTRUCTION: no due-date comparison parses dates', () => {
  // Behaviour alone cannot catch this on a machine east of UTC for half the
  // year, so the shape is pinned too.
  for (const file of [TODO, DONEXT]) {
    const src = stripComments(fs.readFileSync(file, 'utf-8'));
    const lines = src.split('\n');
    lines.forEach((line, i) => {
      if (!/new Date\(new Date\(\)\.toDateString\(\)\)/.test(line)) return;
      // formatDue divides by a whole day and floors, which absorbs the skew;
      // it is the COMPARISONS that must not do this.
      const context = lines.slice(Math.max(0, i - 6), i + 1).join('\n');
      assert.match(context, /formatDue/,
        `${path.basename(file)}:${i + 1} compares dates by parsing them — use a local YYYY-MM-DD string`);
    });
  }
});

test('⚠ the local date key never uses toISOString', () => {
  // `toISOString()` is UTC: between midnight and 01:00 BST it names yesterday,
  // which would put "due today" on the wrong day for an hour every night.
  const src = fs.readFileSync(TODO, 'utf-8');
  const body = src.slice(src.indexOf('export function todayKey'), src.indexOf('export function dueKey'));
  assert.ok(!/toISOString/.test(body), 'todayKey must build from local getters');
  assert.match(body, /getFullYear\(\)/);
});
