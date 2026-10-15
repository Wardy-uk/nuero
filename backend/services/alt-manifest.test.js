'use strict';

/**
 * The local SAiM Alt desktop ADAPTER (saim/app/alt-v2-manifest), 15 Oct 2026.
 *
 * Golden view-models for the four approved states, built from the REAL
 * composer + policy + resolver (alt-manifest-fixtures), plus the adapter's
 * refusals, its display-safety, its not-read rail, the meeting join gap, a
 * source scan that it decides nothing, and a real render of the view.
 *
 *   ALT_MANIFEST_GOLDEN_UPDATE=1 npm test   rewrites the goldens AND the
 *   preview fixtures under saim/app/alt-v2-manifest/public/fixtures — the
 *   screenshots are taken from exactly the payloads these tests pin.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const React = require('react');
const { renderToString } = require('react-dom/server');
const esbuild = require('esbuild');
const { STATES } = require('./alt-manifest-fixtures');
const DISPLAY = require('../../shared/display-text.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const ADAPTER_DIR = path.join(ROOT, 'saim', 'app', 'alt-v2-manifest');
const GOLDEN_DIR = path.join(__dirname, '__golden__', 'alt-manifest');
const PREVIEW_DIR = path.join(ADAPTER_DIR, 'public', 'fixtures');
const UPDATE = process.env.ALT_MANIFEST_GOLDEN_UPDATE === '1';
const clone = (x) => JSON.parse(JSON.stringify(x));

let M; let View;
const payloads = {};

function cssStub() {
  return {
    name: 'css-stub',
    setup(build) {
      build.onResolve({ filter: /\.css$/ }, (a) => ({ path: a.path, namespace: 'css' }));
      build.onLoad({ filter: /.*/, namespace: 'css' }, () => ({ contents: '', loader: 'js' }));
    },
  };
}

test.before(async () => {
  M = await import(pathToFileURL(path.join(ADAPTER_DIR, 'manifest.mjs')).href);
  const out = await esbuild.build({
    entryPoints: [path.join(ADAPTER_DIR, 'ManifestView.jsx')], bundle: true, write: false, format: 'cjs', platform: 'node',
    jsx: 'automatic', external: ['react', 'react-dom'], plugins: [cssStub()], logLevel: 'silent',
  });
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(mod, mod.exports, require);
  View = mod.exports.default;
  for (const [name, build] of Object.entries(STATES)) payloads[name] = build();
});

const render = (vm) => renderToString(React.createElement(View, { v: vm }));
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/\s+/g, ' ');

test('positive control: all four approved states exist and the adapter accepts each one', () => {
  assert.deepEqual(Object.keys(STATES).sort(), ['s01-blind', 's02u-possible-risk', 's03-meeting', 's05-protected-block']);
  for (const [name, p] of Object.entries(payloads)) {
    const vm = M.manifest(p);
    assert.equal(vm.refused, null, `${name} accepted`);
  }
});

test('golden view-models for the four approved states', () => {
  if (UPDATE) fs.mkdirSync(GOLDEN_DIR, { recursive: true });
  for (const [name, p] of Object.entries(payloads)) {
    const vm = M.manifest(p);
    const file = path.join(GOLDEN_DIR, `${name}.json`);
    if (UPDATE) {
      fs.writeFileSync(file, `${JSON.stringify(vm, null, 2)}\n`);
      fs.mkdirSync(PREVIEW_DIR, { recursive: true });
      fs.writeFileSync(path.join(PREVIEW_DIR, `${name}.json`), `${JSON.stringify(p, null, 2)}\n`);
    }
    assert.ok(fs.existsSync(file), `golden for ${name} exists (run with ALT_MANIFEST_GOLDEN_UPDATE=1 once)`);
    assert.deepEqual(clone(vm), JSON.parse(fs.readFileSync(file, 'utf8')), `${name} matches its golden`);
  }
});

test('the preview fixtures the screenshots use ARE the pinned payloads (adapter output identical)', () => {
  for (const [name, p] of Object.entries(payloads)) {
    const file = path.join(PREVIEW_DIR, `${name}.json`);
    assert.ok(fs.existsSync(file), `${name} preview fixture`);
    assert.deepEqual(clone(M.manifest(JSON.parse(fs.readFileSync(file, 'utf8')))), clone(M.manifest(p)), `${name} preview = golden`);
  }
});

test('every visible string, in every state, is safe display text', () => {
  for (const [name, p] of Object.entries(payloads)) {
    const vs = M.visibleStrings(M.manifest(p));
    assert.ok(vs.length > 5, `${name} has visible text`);
    assert.deepEqual(vs.filter((s) => !DISPLAY.isSafeDisplay(s)), [], `${name} unsafe strings`);
  }
});

test('the approved shapes: S5 opens a declared app, S3 opens prep and says the join gap, S1 opens Sources, S2u says why there is no hand-off', () => {
  const s5 = M.manifest(payloads['s05-protected-block']);
  assert.equal(s5.rule, 'S5 protected block');
  assert.ok(s5.handoff && s5.handoff.primary.label, 'S5 primary hand-off');
  assert.ok(s5.handoff.alternatives.length <= 3);
  assert.ok(s5.guard === null || typeof s5.guard === 'object');

  const s3 = M.manifest(payloads['s03-meeting']);
  assert.equal(s3.rule, 'S3 meeting');
  assert.match(s3.handoff.primary.label, /meeting prep/i);
  assert.match(s3.joinGap, /No join link/);
  assert.equal(M.visibleStrings(s3).some((s) => /\bTeams\b/.test(s)), false, 'no invented Teams on the meeting screen');

  const s1 = M.manifest(payloads['s01-blind']);
  assert.equal(s1.rule, 'S1 blind');
  assert.match(s1.handoff.primary.label, /Sources/);
  assert.ok(s1.unreadLead.length > 0);

  const s2u = M.manifest(payloads['s02u-possible-risk']);
  assert.equal(s2u.handoff, null);
  assert.ok(s2u.handoffNote, 'S2u says why there is no hand-off');
});

test('C3: a section SAiM could not read renders as not read, with its reason — never as empty', () => {
  const s1 = M.manifest(payloads['s01-blind']);
  for (const k of ['next', 'held', 'judgement']) assert.equal(s1.rail[k].unread, true, `blind ${k} not read`);
  const p = clone(payloads['s05-protected-block']);
  p.saim.known.judgement = { known: false, why: 'approvals could not be read' };
  const vm = M.manifest(p);
  assert.deepEqual(vm.rail.judgement, { unread: true, why: 'approvals could not be read' });
  const t = text(render(vm));
  assert.match(t, /Not read/i);
  assert.match(t, /approvals could not be read/);
});

test('refuses v1, unknown contracts and a hand-off for a different lead — never falls back', () => {
  const base = payloads['s05-protected-block'];
  const cases = [
    ['candidates v1', (p) => { p.candidates.contract = 'neuro-candidates-v1'; }],
    ['saim v1', (p) => { p.saim.contract = 'saim-attention-v1'; }],
    ['handoff v2', (p) => { p.handoff.contract = 'saim-handoff-v2'; }],
    ['no handoff', (p) => { delete p.handoff; }],
    ['handoff for another lead', (p) => { p.handoff.decidedFor = 'task:999999'; }],
  ];
  for (const [label, mut] of cases) {
    const p = clone(base); mut(p);
    const vm = M.manifest(p);
    assert.ok(vm.refused, `${label} refused`);
    assert.equal(vm.handoff, null, `${label}: no hand-off shown`);
    assert.deepEqual(vm.actions, [], `${label}: no actions shown`);
    assert.match(vm.title, /isn’t an all-clear/, `${label}: says it is not an all-clear`);
  }
});

test('C5: a raw title or reason on the decision never reaches the screen — only display fields do', () => {
  const p = clone(payloads['s05-protected-block']);
  p.saim.lead.title = 'RAW-LEAD-TITLE-zz9';
  p.saim.lead.why = 'RAW-LEAD-WHY-zz9';
  for (const c of p.candidates.candidates) { c.title = `RAW-CAND-${c.id}-zz9`; }
  const vs = M.visibleStrings(M.manifest(p)).join(' | ');
  assert.equal(/zz9/.test(vs), false, 'no raw field reached the view-model');
  assert.equal(/zz9/.test(text(render(M.manifest(p)))), false, 'no raw field reached the render');
});

test('a resolver label or reason carrying a raw id is DROPPED, not shown (the handoff contract does not check label safety — this is the only guard)', () => {
  const p = clone(payloads['s05-protected-block']);
  const raw = 'AAMkAGI2THVSAAAzz9';
  p.handoff.handoff.alternatives[0].label = `Open ${raw}`;
  p.handoff.handoff.why = `because ${raw}`;
  const vm = M.manifest(p);
  assert.equal(vm.refused, null, 'still accepted — one bad label is not a bad decision');
  assert.equal(M.visibleStrings(vm).some((s) => s.includes(raw)), false, 'raw id never reaches the screen');
  assert.equal(vm.handoff.alternatives.length, clone(payloads['s05-protected-block']).handoff.handoff.alternatives.length - 1, 'that alternative is dropped');
  const q = clone(payloads['s02u-possible-risk']);
  q.handoff.reason = `no link for pa_abcdef12`;
  assert.equal(M.manifest(q).handoffNote, null, 'unsafe reason dropped');
});

// ── Real-data mapping (15 Oct 2026): what the copied database showed, as fixtures ──
// The live S7 lead was NEURO's own calendar entry for a task block: a long "Task block:"
// subject, an explanation ("In 9 min") that only repeated the timing, and a NEURO "open"
// action ("Starts soon") offered beside a hand-off that said there was no next step.
const { payload: buildPayload } = require('./alt-manifest-fixtures');
const LONG = 'Task block: Nick Ward to draft the hybrid working proposal: targets, incentives (office and home), and the review date with Stephen';
function realS7() {
  return buildPayload('4', {
    mutate: (c) => {
      c.candidates = c.candidates.filter((x) => x.kind !== 'approval'); // on the desktop an approval would lead S6
      const lead = c.candidates.find((x) => x.id === 'home:home:bins');
      lead.title = LONG;
      lead.display = { title: LONG.replace(/^Task block:\s+/, ''), timing: 'in 9 min (14:45)', explanation: 'In 9 min' };
      lead.actions = [
        { say: 'Starts soon', intent: { kind: 'navigate', tab: 'prep', recordId: 'att_x', action: 'open' } },
        { say: 'Seen it', intent: { kind: 'act', action: 'acknowledge', recordId: 'att_x' } },
      ];
    },
  });
}

test('1 · the lead is a SHORT headline plus one sentence that does not repeat it', () => {
  const p = realS7();
  assert.equal(p.saim.lead.rule, 'S7 top item', 'positive control: the fixture leads S7');
  const vm = M.manifest(p);
  assert.equal(vm.title, 'Draft the hybrid working proposal', 'NEURO’s “Nick Ward to …” said as the verb, cut at the first natural break');
  assert.ok(vm.title.length <= 73);
  assert.ok(vm.sentence, 'a supporting sentence is shown');
  assert.equal(/hybrid/i.test(vm.sentence), false, 'the sentence never restates the task wording');
  assert.equal(/in 9 min/i.test(vm.sentence), false, 'an explanation that only repeats the timing is not the sentence');
  const t = text(render(vm));
  assert.equal(t.split('hybrid working').length - 1, 1, 'the task wording appears exactly once on screen');
  // And every approved state: the sentence never contains its headline.
  for (const [name, q] of Object.entries(payloads)) {
    const v = M.manifest(q);
    if (v.title && v.sentence) assert.equal(v.sentence.toLowerCase().includes(v.title.toLowerCase()), false, `${name}: sentence repeats the headline`);
  }
});

test('2 · Holding the day shows two items; the rest only behind “Show N more held”', () => {
  const p = clone(payloads['s05-protected-block']);
  const extra = ['Book the MOT', 'Reply to Stephen', 'Define hybrid targets', 'Chase the Parsons data'];
  p.saim.display.held = [...p.saim.display.held, ...extra.map((title) => ({ title, why: 'due today', returns: 'at 15:30' }))];
  const total = p.saim.display.held.length;
  const vm = M.manifest(p);
  assert.equal(vm.rail.held.count, total, 'the count is the whole list');
  assert.equal(vm.rail.held.items.length, M.HELD_VISIBLE, 'only two visible');
  assert.equal(vm.rail.held.more.length, total - M.HELD_VISIBLE);
  const html = render(vm);
  assert.match(html, /<details[^>]*>\s*<summary>Show 4 more held<\/summary>/);
  const visiblePart = html.split('<details')[0];
  assert.equal(visiblePart.includes('Chase the Parsons data'), false, 'the remainder is not in the visible rail');
});

test('3 · one route forward: a NEURO “open” action never sits beside “no next step”', () => {
  const p = realS7();
  const d = p.saim;
  assert.equal([d.recommended, ...d.alternatives].filter(Boolean).some((a) => a.say === 'Starts soon'), false, 'the policy holds the route out');
  assert.deepEqual(d.routesHeld, ['Starts soon'], 'and names what it held');
  const vm = M.manifest(p);
  assert.equal(vm.actions.some((a) => a.say === 'Starts soon'), false);
  assert.ok(vm.actions.some((a) => a.say === 'Seen it'), 'responses that record state stay');
  assert.equal(vm.handoff, null);
  assert.ok(vm.handoffNote, 'the absence of a route is said once, plainly');
  // The adapter guard holds even if a route reached it.
  const q = clone(payloads['s05-protected-block']);
  q.saim.alternatives = [...q.saim.alternatives, { say: 'Open State of Play', intent: { kind: 'navigate', tab: 'surface', recordId: 'r1', action: 'open' } }];
  assert.equal(M.manifest(q).actions.some((a) => a.say === 'Open State of Play'), false);
});

test('4 · the card names the destination; only the button carries the verb', () => {
  const s5 = M.manifest(payloads['s05-protected-block']);
  assert.equal(s5.handoff.primary.name, 'Claude');
  assert.equal(s5.handoff.primary.label, 'Open Claude');
  assert.deepEqual(s5.handoff.alternatives.map((a) => a.name), ['Music', 'Word']);
  const html = render(s5);
  assert.match(html, /<p class="wk__app">Claude<\/p>/);
  assert.match(html, /<button[^>]*class="wk__open"[^>]*>Open Claude<\/button>/);
  const s3 = M.manifest(payloads['s03-meeting']);
  assert.equal(s3.handoff.primary.name, 'Meeting prep');
  assert.equal(s3.handoff.primary.label, 'Open meeting prep');
  const s1 = M.manifest(payloads['s01-blind']);
  assert.equal(s1.handoff.primary.name, 'Sources in NEURO');
});

test('the rendered page carries no launch that works: every button is disabled in this read-only build', () => {
  for (const p of Object.values(payloads)) {
    const html = render(M.manifest(p));
    const buttons = html.match(/<button[^>]*>/g) || [];
    for (const b of buttons) assert.match(b, /disabled/, `button inert: ${b}`);
    assert.equal(/<a [^>]*href=/.test(html), false, 'no live link');
  }
});

test('source scan: the adapter decides nothing — no policy, resolver, v1 or raw-text reads', () => {
  const files = ['manifest.mjs', 'ManifestView.jsx', 'ManifestApp.jsx', 'main.jsx'];
  const src = files.map((f) => fs.readFileSync(path.join(ADAPTER_DIR, f), 'utf8')).join('\n');
  assert.ok(src.includes('checkCandidates'), 'positive control: the scan reads the adapter');
  assert.equal(/attention-policy|policy\/handoff|resolveHandoff|\bdecide\(/.test(src), false, 'no policy/resolver import or call');
  assert.equal(/-v1['"]/.test(src.replace(/saim-handoff-v1/g, '')), false, 'no v1 fallback');
  // Allowed: disp.* (the C5 display block), ho.reason (the resolver's sentence), check results' reason.
  assert.ok(/disp\.lead\.title/.test(src), 'positive control: the display title IS read');
  assert.equal(/\b(d|saim|p\.saim)\.lead\.(title|why)\b/.test(src), false, 'no raw decision title/why read');
  // The ONLY raw candidate the adapter touches is the lead's, and only for its structured gap FIELD NAMES.
  const candReads = src.match(/leadCand\.[a-zA-Z]+/g) || [];
  assert.ok(candReads.length > 0, 'positive control: the lead candidate is read');
  assert.deepEqual([...new Set(candReads)], ['leadCand.handoffGaps'], 'lead candidate read for handoffGaps only');
  assert.equal((src.match(/candidates\.candidates/g) || []).length, 1, 'candidates list touched once (to find the lead)');
  assert.equal(/activity\s*=|inferActivity|PROCESS_ACTIVITY/.test(src), false, 'no activity inference');
});

test('feature flag: the entry renders only with VITE_ALT_MANIFEST=1 on localhost', () => {
  const main = fs.readFileSync(path.join(ADAPTER_DIR, 'main.jsx'), 'utf8');
  assert.match(main, /VITE_ALT_MANIFEST\s*===\s*'1'/);
  assert.match(main, /localhost/);
  assert.match(main, /127\.0\.0\.1/);
  const cfg = fs.readFileSync(path.join(ROOT, 'saim', 'app', 'vite.config.alt2-manifest.js'), 'utf8');
  assert.match(cfg, /host:\s*'127\.0\.0\.1'/, 'dev server binds loopback only');
});
