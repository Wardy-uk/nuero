'use strict';

// saim-handoff-v1 (C4, 15 Oct 2026): the pure SAiM hand-off resolver.
// Real scenarios from the policy decision table, with NEURO's structured
// intent and links added the way neuro-candidates-v2 now allows, and a declared
// device. Covers the cases Nick named: randomised titles, an unavailable app,
// stale state, and no redundant launch — plus the cap, refusals and every rule.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const C = require('../../shared/attention-contracts.cjs');
const POL = require('../../saim/policy/attention-policy.cjs');
const H = require('../../saim/policy/handoff.cjs');
const SC = require('./saim-policy-scenarios');

const clone = (x) => JSON.parse(JSON.stringify(x));
const NOW = SC.at(14, 20);
const ago = (min, now = NOW) => new Date(now - min * 60000).toISOString();

const APP = (id, label, capabilities, state = {}) => ({ id, label, capabilities, available: true, running: null, foreground: null, ...state });
const DEVICE = (apps, extra = {}, now = NOW) => ({ contract: 'saim-device-v1', known: true, observedAt: ago(2, now), apps, ...extra });
const DESK = () => [
  APP('claude', 'Claude', ['ai']), APP('chatgpt', 'ChatGPT', ['ai']), APP('music', 'Music', ['music']),
  APP('word', 'Word', ['docs']), APP('excel', 'Excel', ['sheets']), APP('outlook', 'Outlook', ['mail']),
  APP('teams', 'Teams', ['meeting:teams']), APP('code', 'VS Code', ['code']), APP('browser', 'Browser', ['browser']),
  APP('obsidian', 'Obsidian', ['notes']),
];

/** A scenario's real candidates, with intent/targets added to one candidate, re-decided. */
function setup(id, { ref = null, intent, targets, constraintTargets, surface = 'work-desktop', now } = {}) {
  const s = SC.SCENARIOS.find((x) => x.id === id);
  const built = s.build();
  const candidates = clone(built.candidates);
  const leadRef = ref || built.decision.lead.ref;
  const c = candidates.candidates.find((x) => x.id === leadRef);
  if (c && intent !== undefined) c.handoffIntent = intent;
  if (c && targets !== undefined) c.targets = targets;
  if (constraintTargets) candidates.constraints.targets = constraintTargets;
  const at = now || Date.parse(built.decision.decidedAt);
  return { candidates, decision: POL.decide(candidates, { surface, now: at }), now: at };
}
const run = (x, device = DEVICE(DESK(), {}, x.now)) => {
  const out = H.resolveHandoff({ decision: x.decision, candidates: x.candidates, device, now: x.now });
  const ok = C.checkHandoff(out);
  assert.equal(ok.ok, true, `output fails its own contract: ${ok.reason}`);
  return out;
};
const labels = (o) => (o.handoff ? [o.handoff.primary.label, ...o.handoff.alternatives.map((a) => a.label)] : []);
const DRAFT = { kind: 'work-step', activity: 'draft' };
const WRITE = { kind: 'work-step', activity: 'write' };
const CANON = (href = 'https://neuro.example/?view=actions&action=pa_3') => ({ role: 'canonical', href });

// ── The approved S5 shape ───────────────────────────────────────────────────

test('S5 draft step: Open Claude, then Music and Word — AI not repeated, matching the approved fixture', () => {
  const o = run(setup('1', { intent: DRAFT }));
  assert.equal(o.rule, 'S5 protected block');
  assert.deepEqual(labels(o), ['Open Claude', 'Open Music', 'Open Word']);
  assert.deepEqual(o.handoff.primary.target, { type: 'desk', app: 'claude', mode: 'open' });
});

test('primary plus at most three alternatives, in the fixed order AI → Music → one more', () => {
  const o = run(setup('1', { intent: WRITE }));
  assert.deepEqual(labels(o), ['Open Word', 'Open Claude', 'Open Music', 'Open Obsidian']);
  // Every activity, every subset of the desk: never more than three.
  for (const activity of C.ACTIVITIES) {
    for (let mask = 0; mask < 1 << DESK().length; mask += 37) {
      const apps = DESK().filter((_, i) => mask & (1 << i));
      const r = run(setup('1', { intent: { kind: 'work-step', activity } }), DEVICE(apps));
      if (r.handoff) assert.ok(r.handoff.alternatives.length <= H.MAX_ALTERNATIVES, `${activity}/${mask}`);
    }
  }
});

// ── No redundant launch ─────────────────────────────────────────────────────

test('already open: the foreground app is "Already open", with no launch target', () => {
  const apps = DESK().map((a) => (a.id === 'claude' ? { ...a, running: true, foreground: true } : a));
  const o = run(setup('1', { intent: DRAFT }), DEVICE(apps));
  assert.equal(o.handoff.primary.label, 'Already open — carry on in Claude');
  assert.deepEqual(o.handoff.primary.target, { type: 'already', app: 'claude' });
  assert.ok(!labels(o).includes('Open Claude'), 'never a redundant launch');
});

test('switch to: a known running background app is "Switch to", not "Open"', () => {
  const apps = DESK().map((a) => (a.id === 'claude' ? { ...a, running: true, foreground: false } : a.id === 'word' ? { ...a, running: true, foreground: false } : a));
  const o = run(setup('1', { intent: DRAFT }), DEVICE(apps));
  assert.equal(o.handoff.primary.label, 'Switch to Claude');
  assert.equal(o.handoff.primary.target.mode, 'switch');
  assert.ok(labels(o).includes('Switch to Word'));
});

test('a foreground alternative is dropped — there is nowhere to go', () => {
  const apps = DESK().map((a) => (a.id === 'music' ? { ...a, running: true, foreground: true } : a));
  const o = run(setup('1', { intent: DRAFT }), DEVICE(apps));
  assert.deepEqual(labels(o), ['Open Claude', 'Open Word']);
});

test('unknown running state (null) on a fresh device says "Open" and claims nothing', () => {
  const o = run(setup('1', { intent: DRAFT }));
  assert.equal(o.handoff.primary.target.mode, 'open');
});

// ── Stale state ─────────────────────────────────────────────────────────────

test('stale, missing or unreachable device state → no desk hand-off, with an honest reason', () => {
  const x = setup('1', { intent: DRAFT });
  const stale = run(x, DEVICE(DESK(), { observedAt: ago(H.DEVICE_FRESH_MINUTES + 1, x.now) }));
  assert.equal(stale.handoff, null);
  assert.match(stale.reason, /out of date/);
  const noTime = run(x, DEVICE(DESK(), { observedAt: null }));
  assert.equal(noTime.handoff, null);
  assert.match(noTime.reason, /hasn’t said when/);
  const gone = run(x, DEVICE(DESK(), { known: false }));
  assert.equal(gone.handoff, null);
  assert.match(gone.reason, /isn’t reachable/);
  const future = run(x, DEVICE(DESK(), { observedAt: new Date(x.now + 10 * 60000).toISOString() }));
  assert.equal(future.handoff, null, 'an observation from the future is not fresh');
  // A stale "already open" must never be shown as already open.
  const staleFg = DESK().map((a) => (a.id === 'claude' ? { ...a, running: true, foreground: true } : a));
  assert.equal(run(x, DEVICE(staleFg, { observedAt: ago(30, x.now) })).handoff, null);
});

test('NEURO links do not depend on device freshness (S4 with a stale device still opens the action)', () => {
  const x = setup('2b', { targets: [CANON()] });
  const o = run(x, DEVICE(DESK(), { known: false }));
  assert.equal(o.handoff.primary.label, 'Open this in NEURO Actions');
});

test('the freshness window mirrors desktop-activity’s FRESH_MINUTES', () => {
  const src = fs.readFileSync(path.join(__dirname, 'desktop-activity.js'), 'utf8');
  const m = /const FRESH_MINUTES = (\d+);/.exec(src);
  assert.ok(m, 'positive control: found FRESH_MINUTES');
  assert.equal(H.DEVICE_FRESH_MINUTES, Number(m[1]));
});

// ── Unavailable / undeclared apps ───────────────────────────────────────────

test('an unavailable app is never offered — and if it was the only fit, no hand-off with the reason', () => {
  const apps = DESK().map((a) => (a.id === 'word' ? { ...a, available: false } : a));
  const o = run(setup('1', { intent: WRITE }), DEVICE(apps));
  assert.equal(o.handoff, null);
  assert.match(o.reason, /Nothing declared on this device can do this \(docs\)/);
  assert.ok(!JSON.stringify(o).includes('"word"'), 'the unavailable app is not named anywhere');
  const d = run(setup('1', { intent: DRAFT }), DEVICE(apps));
  assert.ok(!labels(d).some((l) => /Word/.test(l)), 'not offered as an alternative either');
});

test('an undeclared app is never offered', () => {
  for (const drop of ['music', 'word', 'claude', 'chatgpt', 'obsidian']) {
    const apps = DESK().filter((a) => a.id !== drop);
    const o = run(setup('1', { intent: WRITE }), DEVICE(apps));
    assert.ok(!JSON.stringify(o.handoff || {}).includes(`"app":"${drop}"`), drop);
  }
  const ai = run(setup('1', { intent: DRAFT }), DEVICE(DESK().filter((a) => a.id !== 'claude')));
  assert.equal(ai.handoff.primary.label, 'Open ChatGPT', 'the next declared AI app, not an invented one');
});

// ── Missing intent / link / capability ──────────────────────────────────────

test('missing intent, unknown activity or intent "none" → no hand-off, said honestly', () => {
  assert.match(run(setup('1', { intent: null })).reason, /stated no next step/);
  assert.match(run(setup('1', { intent: { kind: 'work-step', activity: null } })).reason, /doesn’t know what kind of work/);
  assert.match(run(setup('1', { intent: { kind: 'none' } })).reason, /nowhere to go/);
});

test('S4 / S6: exactly that action in NEURO; no exact link → no hand-off; an approve link degrades to no hand-off', () => {
  const o = run(setup('2b', { targets: [CANON()] }));
  assert.equal(o.rule, 'S4 deadline inside the block');
  assert.deepEqual(o.handoff.primary.target, { type: 'link', href: 'https://neuro.example/?view=actions&action=pa_3', role: 'canonical' });
  assert.deepEqual(o.handoff.alternatives, []);
  assert.match(run(setup('2b')).reason, /no link to this exact action/);
  const s = SC.SCENARIOS.find((x) => x.id === '2b').build();
  const bad = clone(s.candidates);
  bad.candidates.find((c) => c.id === s.decision.lead.ref).targets = [CANON('https://neuro.example/api/prepared-actions/pa_3/approve')];
  const r = H.resolveHandoff({ decision: s.decision, candidates: bad, device: DEVICE(DESK()), now: NOW });
  assert.equal(r.handoff, null);
  assert.equal(r.refused, undefined, 'a bad optional link is not a contract refusal');
  assert.match(r.reason, /malformed/);
  assert.ok(r.basis.some((b) => /approve link/.test(b)));
});

test('S2 confirmed risk: the real control surface, no alternatives; else the item in NEURO; else nothing', () => {
  const ctl = run(setup('5b', { targets: [{ role: 'control', href: 'https://ha.example/lovelace/kitchen', label: 'Home Assistant' }, CANON('https://neuro.example/?view=home')] }));
  assert.equal(ctl.rule, 'S2 critical risk');
  assert.deepEqual(labels(ctl), ['Open Home Assistant'], 'no desk apps beside a risk');
  assert.deepEqual(labels(run(setup('5b', { targets: [CANON('https://neuro.example/?view=home')] }))), ['Open it in NEURO']);
  assert.match(run(setup('5b')).reason, /no link to act on/);
});

test('S2u possible risk: the item in NEURO only; never a guessed fixer', () => {
  const o = run(setup('8', { targets: [CANON('https://neuro.example/?view=today'), { role: 'control', href: 'https://elsewhere.example', label: 'Somewhere' }] }));
  assert.equal(o.rule, 'S2u unclassified potential risk');
  assert.deepEqual(labels(o), ['Open it in NEURO']);
  assert.match(run(setup('8')).reason, /no link to this item/);
});

test('S1 blind: only where NEURO says the failure shows; never a desk app, even on a fresh device', () => {
  const o = run(setup('6a', { constraintTargets: [{ role: 'source', href: 'https://neuro.example/?view=sources', label: 'Sources in NEURO' }] }));
  assert.equal(o.rule, 'S1 blind');
  assert.deepEqual(labels(o), ['Open Sources in NEURO']);
  const n = run(setup('6a', { constraintTargets: [] }));
  assert.equal(n.handoff, null);
  assert.match(n.reason, /won’t guess/);
});

test('S3 running meeting: join link + prep; already in Teams leads when Teams is in front; nothing to join → honest none', () => {
  const ref = 'meeting:14:30:Nick Catch Up';
  const T = [{ role: 'join', href: 'https://teams.microsoft.com/l/meetup-join/x', provider: 'teams' }, { role: 'prep', href: 'saim:prep?meeting=catchup' }];
  const o = run(setup('9a', { ref, intent: { kind: 'meeting' }, targets: T }));
  assert.equal(o.rule, 'S3 meeting');
  assert.deepEqual(labels(o), ['Join in Teams', 'Open meeting prep']);
  const fg = DESK().map((a) => (a.id === 'teams' ? { ...a, running: true, foreground: true } : a));
  assert.deepEqual(labels(run(setup('9a', { ref, intent: { kind: 'meeting' }, targets: T }), DEVICE(fg, {}, SC.at(14, 40)))), ['Already open — carry on in Teams', 'Join in Teams', 'Open meeting prep']);
  const appOnly = run(setup('9a', { ref, intent: { kind: 'meeting', provider: 'teams' }, targets: [] }));
  assert.deepEqual(labels(appOnly), ['Open Teams']);
  assert.match(run(setup('9a', { ref, intent: { kind: 'meeting' }, targets: [] })).reason, /no join link, prep or meeting app/);
});

test('S3a transition: the calendar’s join link first, prep second (Nick, 16 Oct 2026)', () => {
  const ref = 'meeting:14:30:Nick Catch Up';
  const o = run(setup('3', { ref, intent: { kind: 'meeting' }, targets: [{ role: 'join', href: 'https://teams.microsoft.com/l/meetup-join/y', provider: 'teams' }, { role: 'prep', href: 'saim:prep?meeting=catchup' }] }));
  assert.equal(o.rule, 'S3a imminent meeting transition');
  assert.deepEqual(labels(o), ['Join in Teams', 'Open meeting prep']);
  // Without a join link, prep leads as before.
  const p = run(setup('3', { ref, intent: { kind: 'meeting' }, targets: [{ role: 'prep', href: 'saim:prep?meeting=catchup' }] }));
  assert.deepEqual(labels(p), ['Open meeting prep']);
});

test('S8 / S10 / S11: no launcher, with the reason — even when an intent is present', () => {
  const s11 = (() => { const b = SC.build({ now: NOW, surface: 'work-desktop' }); return b; })();
  assert.equal(s11.decision.lead.rule, 'S11 nothing');
  const n11 = H.resolveHandoff({ ...s11, device: DEVICE(DESK()), now: NOW });
  assert.equal(n11.handoff, null);
  assert.match(n11.reason, /Nothing needs you/);
  const s10 = SC.build({ now: SC.at(9, 20), surface: 'work-desktop', primary: { kind: 'context', id: 'context-ritual', title: 'Standup outstanding', reason: 'x' } });
  assert.equal(s10.decision.lead.rule, 'S10 ritual');
  assert.match(H.resolveHandoff({ ...s10, device: DEVICE(DESK()), now: SC.at(9, 20) }).reason, /ritual happens in SAiM/);
  const solo = { eventId: 'f', source: 'graph', subject: 'Focus', start: '2026-10-15T14:00:00.0000000', end: '2026-10-15T15:00:00.0000000', startAt: SC.iso(14, 0), endAt: SC.iso(15, 0), allDay: false, showAs: 'busy', attendeesOther: false, sphere: { value: 'work', basis: 'classified', why: 'x' } };
  const s8 = SC.build({ now: NOW, surface: 'work-desktop', calendar: [solo] });
  assert.equal(s8.decision.lead.rule, 'S8 protected diary time');
  const c8 = clone(s8.candidates); c8.candidates.find((c) => c.id === s8.decision.lead.ref).handoffIntent = DRAFT;
  const n8 = H.resolveHandoff({ decision: POL.decide(c8, { surface: 'work-desktop', now: NOW }), candidates: c8, device: DEVICE(DESK()), now: NOW });
  assert.equal(n8.handoff, null);
  assert.match(n8.reason, /no app to send you to/);
});

test('a surface that cannot launch desk apps names the desktop instead of launching', () => {
  const o = run(setup('1', { intent: DRAFT, surface: 'work-tablet' }));
  assert.equal(o.handoff.primary.target.type, 'elsewhere');
  assert.equal(o.handoff.primary.label, 'Claude, on the desktop');
});

// ── Never inspects raw titles ───────────────────────────────────────────────

const TEXT_KEYS = new Set(['title', 'text', 'description', 'why', 'reason', 'line', 'what', 'summary', 'subject', 'say']);
function scramble(x, seed) {
  let n = seed;
  const rnd = () => { n = (n * 1103515245 + 12345) % 2147483648; return `zz${n.toString(36)} ${'Open Word draft spreadsheet email teams'.split(' ')[n % 6]}`; };
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') { const o = {}; for (const [k, val] of Object.entries(v)) o[k] = TEXT_KEYS.has(k) && typeof val === 'string' ? rnd() : walk(val); return o; }
    return v;
  };
  return walk(x);
}

test('randomised titles: replacing every title/text/description/why/reason changes nothing', () => {
  const ref = 'meeting:14:30:Nick Catch Up';
  const cases = [
    setup('1', { intent: DRAFT }),
    setup('1', { intent: WRITE }),
    setup('2b', { targets: [CANON()] }),
    setup('5b', { targets: [{ role: 'control', href: 'https://ha.example/x', label: 'Home Assistant' }] }),
    setup('8', { targets: [CANON('https://neuro.example/?view=today')] }),
    setup('9a', { ref, intent: { kind: 'meeting' }, targets: [{ role: 'join', href: 'https://teams.microsoft.com/l/z', provider: 'teams' }] }),
    setup('1'),
  ];
  for (const [i, x] of cases.entries()) {
    const base = run(x);
    for (const seed of [1, 7, 42]) {
      const y = { candidates: scramble(x.candidates, seed + i), decision: scramble(x.decision, seed * 3 + i), now: x.now };
      assert.deepEqual(run(y), base, `case ${i} seed ${seed}`);
    }
  }
});

test('source scan: the resolver reads no title, text, description, facts or lead explanation', () => {
  const src = fs.readFileSync(require.resolve('../../saim/policy/handoff.cjs'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.ok(src.includes('handoffIntent'), 'positive control: scanned the real resolver');
  for (const bad of [/\.title\b/, /\.text\b/, /\.description\b/, /\.facts\b/, /lead\.why\b/, /\.subject\b/, /\.match\(|\.test\(|new RegExp/]) {
    assert.ok(!bad.test(src), `resolver must not use ${bad}`);
  }
});

// ── Contracts ────────────────────────────────────────────────────────────────

test('incompatible inputs are refused, never guessed around', () => {
  const x = setup('1', { intent: DRAFT });
  const v1 = clone(x.candidates); v1.contract = 'neuro-candidates-v1';
  const cases = {
    'candidates v1': { ...x, candidates: v1 },
    'decision v2': { ...x, decision: { ...x.decision, contract: 'saim-attention-v3' } },
    'device v2': { ...x, device: { ...DEVICE(DESK()), contract: 'saim-device-v2' } },
    'device app with an unknown capability': { ...x, device: DEVICE([APP('fax', 'Fax', ['fax'])]) },
    'device app declared twice': { ...x, device: DEVICE([APP('word', 'Word', ['docs']), APP('word', 'Word', ['docs'])]) },
    'device running not boolean': { ...x, device: DEVICE([APP('word', 'Word', ['docs'], { running: 'yes' })]) },
    'decision about something NEURO did not send': { ...x, decision: { ...x.decision, lead: { ...x.decision.lead, ref: 'block:999' } } },
  };
  for (const [name, input] of Object.entries(cases)) {
    const r = H.resolveHandoff({ decision: input.decision, candidates: input.candidates, device: input.device || DEVICE(DESK()), now: x.now });
    assert.equal(r.handoff, null, name);
    assert.ok(r.refused, `${name}: carries refused`);
    assert.equal(C.checkHandoff(r).ok, true, name);
  }
  const refusedDecision = POL.decide(v1, { surface: 'work-desktop', now: x.now });
  const r = H.resolveHandoff({ decision: refusedDecision, candidates: x.candidates, device: DEVICE(DESK()), now: x.now });
  assert.equal(r.handoff, null);
  assert.match(r.reason, /couldn’t read NEURO’s candidates/);
});

// ── Malformed OPTIONAL hand-off fields degrade; they never refuse ───────────

const MALFORMED = {
  'invented activity': { intent: { kind: 'work-step', activity: 'vibes' } },
  'unknown intent kind': { intent: { kind: 'teleport' } },
  'intent not an object': { intent: 'draft' },
  'javascript: href': { targets: [{ role: 'canonical', href: 'javascript:alert(1)' }] },
  'approve link': { targets: [{ role: 'canonical', href: 'https://neuro.example/api/prepared-actions/pa_1/approve' }] },
  'unknown role': { targets: [{ role: 'backdoor', href: 'https://x.example' }] },
  'targets not a list': { targets: { role: 'canonical', href: 'https://x.example' } },
  'one bad entry beside a good one': { targets: [CANON('https://neuro.example/?view=actions&action=pa_1'), { role: 'canonical', href: 'ftp://x' }] },
};

test('malformed intent/links on the lead: no hand-off with an honest reason; the attention payload and SAiM’s decision stand', () => {
  for (const [name, m] of Object.entries(MALFORMED)) {
    const clean = setup('1');
    const x = setup('1', { intent: m.intent === undefined ? DRAFT : m.intent, targets: m.targets });
    assert.equal(C.checkCandidates(x.candidates).ok, true, `${name}: the candidates payload is still valid`);
    assert.equal(x.decision.refused, undefined, `${name}: SAiM’s decision is not refused`);
    assert.equal(x.decision.lead.rule, 'S5 protected block', `${name}: never turned into blindness`);
    assert.deepEqual({ ...x.decision }, { ...clean.decision }, `${name}: the decision is identical to the clean one`);
    const o = run(x);
    assert.equal(o.handoff, null, name);
    assert.equal(o.refused, undefined, `${name}: degraded, not refused`);
    assert.match(o.reason, /malformed, so SAiM won’t use them/, name);
    assert.equal(o.rule, 'S5 protected block');
  }
});

test('a malformed field on ANOTHER candidate changes nothing about the lead’s hand-off', () => {
  const good = run(setup('1', { intent: DRAFT }));
  const x = setup('1', { intent: DRAFT });
  const other = x.candidates.candidates.find((c) => c.id !== x.decision.lead.ref);
  other.handoffIntent = { kind: 'teleport' };
  other.targets = [{ role: 'canonical', href: 'javascript:alert(1)' }];
  assert.equal(C.checkCandidates(x.candidates).ok, true);
  assert.deepEqual(run(x), good);
});

test('S1 blind with a malformed constraints.targets: still S1, no hand-off, never a refusal', () => {
  const x = setup('6a', { constraintTargets: [{ role: 'source', href: 'not a link' }] });
  assert.equal(C.checkCandidates(x.candidates).ok, true);
  assert.equal(x.decision.lead.rule, 'S1 blind');
  assert.equal(x.decision.refused, undefined, 'S1 here is the genuine blind state, not a contract refusal');
  const o = run(x);
  assert.equal(o.handoff, null);
  assert.equal(o.refused, undefined);
  assert.match(o.reason, /link for where to look is malformed/);
});

// ── The three-alternative contract, executed ─────────────────────────────────

const desk = (id, label) => ({ label: `Open ${label}`, target: { type: 'desk', app: id, mode: 'open' } });

test('overflow: four (and five) valid alternatives are cut to three, in order — and the output contract refuses four', () => {
  const primary = desk('word', 'Word');
  const four = [desk('claude', 'Claude'), desk('music', 'Music'), desk('obsidian', 'Obsidian'), desk('excel', 'Excel')];
  for (const d of four) assert.equal(C.checkHandoff({ contract: 'saim-handoff-v1', owner: 'saim', resolverVersion: 'x', handoff: { primary, alternatives: [d] } }).ok, true, 'each alternative is valid on its own');
  const cut = H.limitAlternatives(primary, four);
  assert.equal(cut.length, H.MAX_ALTERNATIVES);
  assert.equal(H.MAX_ALTERNATIVES, 3);
  assert.deepEqual(cut.map((d) => d.label), ['Open Claude', 'Open Music', 'Open Obsidian'], 'the first three, in order');
  assert.deepEqual(H.limitAlternatives(primary, [...four, desk('code', 'VS Code')]).map((d) => d.label), ['Open Claude', 'Open Music', 'Open Obsidian']);
  // Skipped entries don't use up a slot: duplicates of the primary or each other, "already open", empties.
  const noisy = [null, desk('word', 'Word'), { label: 'Already', target: { type: 'already', app: 'teams' } }, ...four, desk('claude', 'Claude')];
  assert.deepEqual(H.limitAlternatives(primary, noisy).map((d) => d.label), ['Open Claude', 'Open Music', 'Open Obsidian']);
  // The contract itself refuses an uncapped four.
  const uncapped = { contract: 'saim-handoff-v1', owner: 'saim', resolverVersion: 'x', handoff: { primary, alternatives: four, why: 'x' } };
  assert.equal(C.checkHandoff(uncapped).ok, false);
  assert.match(C.checkHandoff(uncapped).reason, /more than three alternatives/);
  assert.equal(C.checkHandoff({ ...uncapped, handoff: { ...uncapped.handoff, alternatives: cut } }).ok, true);
});

test('the resolver enforces the cap through limitAlternatives (single enforcement point)', () => {
  const src = fs.readFileSync(require.resolve('../../saim/policy/handoff.cjs'), 'utf8');
  assert.match(src, /alternatives: limitAlternatives\(primary, alternatives\)/, 'done() routes through the exported limiter');
  assert.equal((src.match(/MAX_ALTERNATIVES\) break/g) || []).length, 1, 'the cap is written once');
});

test('the activity table and registry agree; checkHandoff refuses a malformed output', () => {
  assert.deepEqual(Object.keys(H.ACTIVITY).sort(), [...C.ACTIVITIES].sort());
  for (const a of Object.values(H.ACTIVITY)) for (const cap of [...a.needs, a.also].filter(Boolean)) assert.ok(C.CAPABILITIES.includes(cap), cap);
  const ok = run(setup('1', { intent: WRITE }));
  const four = clone(ok); four.handoff.alternatives.push(four.handoff.alternatives[0]);
  assert.equal(C.checkHandoff(four).ok, false, 'more than three alternatives');
  const already = clone(ok); already.handoff.alternatives[0].target = { type: 'already', app: 'x' };
  assert.equal(C.checkHandoff(already).ok, false, 'already-open as an alternative');
  assert.equal(C.checkHandoff({ ...ok, handoff: null, reason: null }).ok, false, 'no hand-off without a reason');
});
