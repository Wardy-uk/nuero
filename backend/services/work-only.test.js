'use strict';
/**
 * Work only (13 Oct 2026). Nick's switch hides everything in NEURO that is not
 * work. Pinned: it hides what is KNOWN not to be work and never an unknown
 * (hiding a guess hides real things); it beats off duty; it removes the
 * personal presentation kinds; and the desktop really wires it.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const cr = require('./canonical-read');

const dom = (...ds) => ({ domains: ds.map((d) => ({ domain: d, basis: 'declared' })) });
const ev = (title, domains) => ({ id: title, title, start: '2026-10-14T10:00', domains });
const due = (description, domains) => ({ id: description, description, state: 'open', due: { kind: 'stated', relative: 'today', days: 0, date: '2026-10-13', label: 'today' }, domains, counterpart: null });

test('known-personal items are held and counted; work and unknown stay', () => {
  const out = cr.composeNow({
    decision: { primary: null, secondary: [], poolAvailable: true },
    nextEvents: [ev('Hike with Lizzy', dom('fitness')), ev('Team standup', dom('work'))],
    commitments: [due('Book the vet', dom('family')), due('Send the report', dom('work')), due('Something', dom())],
    workOnly: true, nowLocal: '2026-10-13T09:00',
  });
  assert.equal(out.sections.nextEvent.title, 'Team standup');
  const titles = (out.sections.commitments || []).map((c) => c.description);
  assert.ok(titles.includes('Send the report'));
  assert.ok(titles.includes('Something'), 'unknown domain is never hidden');
  assert.ok(!titles.includes('Book the vet'));
  assert.equal(out.personalHeld.count, 2);
  assert.match(out.personalHeld.say, /2 personal items hidden/);
});

test('off: nothing personal is held', () => {
  const out = cr.composeNow({ decision: {}, nextEvents: [ev('Hike with Lizzy', dom('fitness'))], nowLocal: '2026-10-13T09:00' });
  assert.equal(out.sections.nextEvent.title, 'Hike with Lizzy');
  assert.equal(out.personalHeld, null);
});

test('work only beats off duty — he asked to see work', () => {
  const offDuty = { life: { showWork: false } };
  const out = cr.composeNow({ decision: offDuty, nextEvents: [ev('Team standup', dom('work'))], workOnly: true, nowLocal: '2026-10-13T09:00' });
  assert.equal(out.sections.nextEvent.title, 'Team standup');
  assert.equal(out.workHeld, null);
});

test('presentation: personal kinds and themes go, everything else stays in order', () => {
  const p = cr.workOnlyPresentation({
    next: [{ kind: 'event', id: 1 }, { kind: 'offer', id: 2 }, { kind: 'task', id: 3 }],
    context: [{ kind: 'household' }, { kind: 'place' }, { kind: 'leisure' }, { kind: 'weather' }, { kind: 'sleep' }],
    primary: { kind: 'outdoor' },
    synthesis: { themes: [{ type: 'schedule' }, { type: 'recovery' }, { type: 'presence' }] },
  });
  assert.deepEqual(p.next.map((x) => x.id), [1, 3]);
  assert.deepEqual(p.context.map((x) => x.kind), ['place', 'weather']);
  assert.equal(p.primary, null);
  assert.deepEqual(p.synthesis.themes.map((t) => t.type), ['schedule']);
  assert.equal(p.workOnly, true);
});

test('the desktop wires it: sidebar hides LIFE, Now asks the server, Tasks hides personal', () => {
  const F = path.join(__dirname, '..', '..', 'frontend', 'src');
  const side = fs.readFileSync(path.join(F, 'components', 'Sidebar.jsx'), 'utf8');
  assert.match(side, /WORK_ONLY_HIDDEN_GROUPS\.has\(g\.id\)/);
  assert.match(fs.readFileSync(path.join(F, 'workOnly.js'), 'utf8'), /WORK_ONLY_HIDDEN_GROUPS = new Set\(\['life'\]\)/);
  assert.match(fs.readFileSync(path.join(F, 'components', 'AdhdPanel.jsx'), 'utf8'), /\/api\/canonical\/now\?workOnly=1/);
  assert.match(fs.readFileSync(path.join(F, 'components', 'TodoPanel.jsx'), 'utf8'), /workOnly && t\.domain === 'personal'/);
  assert.ok(!/neverMatches/.test(side), 'positive control: the scan reads the real file');
});
