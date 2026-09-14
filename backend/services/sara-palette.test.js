'use strict';

/**
 * ONE VOCABULARY, ACROSS EVERY SARA SURFACE — the guard the per-screen passes
 * needed and did not have.
 *
 * ⚠⚠ THE BUILD ORDER FIXED TEN SCREENS AND THE PALETTE WAS STILL FRAGMENTED.
 * A sweep after the last one counted, in `sara/app/src` alone, **eight distinct
 * ambers and thirteen distinct reds** — on screens already ticked off as done.
 * Each pass had honestly fixed what it looked at, and nothing was watching the
 * whole: Prep's own commit says "one amber" while four `#ffd08a` away-lines sat
 * two rules below the one it changed, and Capture — step 4 — still had the exact
 * live-mic-wears-the-alarm-red bug that was found and fixed on Chat at step 9.
 *
 * ⚠ That is the real lesson of this file: a per-screen review cannot see drift
 * BETWEEN screens, and "a reader cannot learn what red means when every screen
 * mixes its own" is a claim about the app, so only an app-wide check can hold it.
 *
 * ⚠ SEVERITY IS DELIBERATELY ITS OWN VOCABULARY and is declared here rather than
 * folded in. CLAUDE.md is explicit: an ITEM's urgency keeps its own colours and
 * must NOT move with her — a breaching escalation is red because of what it is,
 * not because of how her day is going. Readiness's four-step ramp is the same
 * thing and is left whole.
 *
 * Adding a colour is not forbidden. It has to be DECLARED here, with what it
 * means — which is the difference between a decision and a drift.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const DIRS = [
  path.join(ROOT, 'sara', 'app', 'src'),
  path.join(ROOT, 'sara', 'shared-ui'),
];

/** Every colour SARA is allowed to use, and what each one MEANS. */
const VOCABULARY = new Map(Object.entries({
  // ── Her ────────────────────────────────────────────────────────────────
  // Her light is never a literal: it comes from `--sara-rgb`, which the shell
  // sets once from the live read, so every screen moves with her.

  // ── The two states ─────────────────────────────────────────────────────
  '#f0d6a6': 'GAP — notice this, nothing is broken (unread, unreachable, flagged)',
  '#ffb4b4': 'FAULT — something broke and he can retry it',

  // ── Severity: an ITEM\'s own urgency, which must NOT move with her ──────
  '#ff9db0': 'severity: critical, text',
  '#4a1420': 'severity: critical, ground',
  '#ff6b8a': 'severity: critical, edge',
  '#ffcf8a': 'severity: high, text',
  '#4a2f14': 'severity: high, ground',
  '#ffb45c': 'severity: high, edge',
  '#ffd79d': 'severity: should, text',
  '#4a3a14': 'severity: should, ground',
  '#5ad18f': 'severity: done / landed',
  '#5eead4': 'severity: done, second surface',

  // ── Readiness\'s own four-step ramp, left whole ─────────────────────────
  '#73c79e': 'readiness: calm',
  '#ffd08a': 'readiness: elevated',
  '#ffa64d': 'readiness: high',
  '#ff6b61': 'readiness: critical',

  // ── Ground, ink and chrome ─────────────────────────────────────────────
  '#04121f': 'ink on her colour, where the fill is bright enough to need it',
  '#0b0f14': 'ground',
  '#06080c': 'her ground, darker, behind the field',
  '#1c2530': 'panel',
  '#26313f': 'line',
  '#e6edf3': 'text',
  '#8b98a8': 'muted text',
  '#fff': 'white',
  '#000': 'black',
  '#141b24': 'panel, second surface',
  '#09111a': 'ground, notification card',

  // ⚠ The centrepiece surfaces (Approach / Shelf / Dashboard) carry their own
  // near-white and grey ramp. It is DECLARED rather than folded into the four
  // above: Nick tuned these by eye against the live field on a Fire tablet, a
  // desk kiosk and a phone, and a consolidation pass may not quietly re-tune
  // numbers somebody set by looking — the Field's own rule. What this guard
  // buys here is that no NEW grey can appear beside them without being named.
  '#eef3fa': 'centrepiece: text',
  '#e7eefc': 'centrepiece: text on the shelf',
  '#e8e9ee': 'surface: text',
  '#b7c2d0': 'surface: text, second rank',
  '#9fb0c6': 'shelf: text, second rank',
  '#9aa0b0': 'surface: muted',
  '#78899a': 'surface: muted, quieter',
  '#63728a': 'centrepiece: muted',
  '#5d6b7a': 'surface: faint (quote marks, rules)',
  '#0d141e': 'centrepiece: ground',
  '#060a10': 'centrepiece: ground, deepest',

  // ── Kinds that are deliberately NOT urgencies ──────────────────────────
  '#14324a': 'severity: medium, ground',
  '#8ad0ff': 'severity: medium, text',
  '#1c3348': 'severity: could, ground',
  '#9dc8ff': 'severity: could, text',
  '#7fcf9c': 'severity: he is on it',
  '#0f766e': 'domain — which part of his life this belongs to. Deliberately not '
           + 'red or amber: a third urgency is not what it means.',
  '#5ec1ca': 'the spoken sentence, and the clock on the now band. Deliberately '
           + 'NOT hers — a time that changed colour with her mood would be a '
           + 'clock arguing about the day.',
}));

/** ⚠ Comments are stripped first — a literal being EXPLAINED is not one in use. */
const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '');

function cssFiles() {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.css')) out.push(p);
    }
  };
  DIRS.forEach(walk);
  return out;
}

test('⚠⚠ every colour SARA uses is one she has a word for', () => {
  const files = cssFiles();
  assert.ok(files.length > 15, `only found ${files.length} stylesheets`);  // positive control

  const undeclared = new Map();
  for (const file of files) {
    const body = strip(fs.readFileSync(file, 'utf8'));
    for (const m of body.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
      const hex = m[0].toLowerCase();
      if (VOCABULARY.has(hex)) continue;
      const rel = path.relative(ROOT, file).replace(/\\/g, '/');
      if (!undeclared.has(hex)) undeclared.set(hex, new Set());
      undeclared.get(hex).add(rel);
    }
  }

  const lines = [...undeclared.entries()]
    .map(([hex, where]) => `  ${hex}  ${[...where].join(', ')}`);
  assert.equal(
    lines.length, 0,
    'Undeclared colours — each is either a drift or a decision nobody wrote down.\n' +
    'Fold it into the vocabulary above, or declare it there with what it MEANS:\n' +
    lines.join('\n'),
  );
});

test('⚠ the two states have exactly one value each', () => {
  // The whole point. Amber-means-notice and red-means-broken only work if there
  // is one amber and one red; the sweep that prompted this found eight and
  // thirteen.
  const meanings = [...VOCABULARY.values()];
  assert.equal(meanings.filter((m) => m.startsWith('GAP')).length, 1);
  assert.equal(meanings.filter((m) => m.startsWith('FAULT')).length, 1);
});

test('⚠ severity is declared as separate, not folded in', () => {
  // A breaching escalation is red because of WHAT IT IS, not because of how her
  // day is going — so it keeps its own colours and does not move with her.
  // Losing that distinction would be a worse outcome than the drift this file
  // exists to stop.
  const severity = [...VOCABULARY.values()].filter((m) => m.startsWith('severity:'));
  assert.ok(severity.length >= 6, 'the severity vocabulary has been folded away');
  const readiness = [...VOCABULARY.values()].filter((m) => m.startsWith('readiness:'));
  assert.equal(readiness.length, 4, 'the readiness ramp is no longer whole');
});

test('⚠ her light is never a literal', () => {
  // Every screen takes her colour from `--sara-rgb`, set once on the shell from
  // the live read. A hex here would be a screen that stays blue on a red day —
  // which is what `var(--accent)` was, and why it is gone.
  const files = cssFiles();
  const offenders = [];
  for (const file of files) {
    const body = strip(fs.readFileSync(file, 'utf8'));
    if (/var\(--accent(-dim)?[,)]/.test(body)) {
      offenders.push(path.relative(ROOT, file).replace(/\\/g, '/'));
    }
  }
  assert.deepEqual(offenders, [],
    `the fixed system accent is back in: ${offenders.join(', ')}`);
});
