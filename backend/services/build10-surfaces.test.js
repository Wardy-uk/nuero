'use strict';

/**
 * Build 10 — what the SURFACES must keep true. Source scans with positive
 * controls (the frontends have no runner reachable from here) plus one real
 * esbuild render of the Now situation block.
 *
 * Numbering follows the Build 10S list in the build record.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const React = require('react');
const { renderToString } = require('react-dom/server');
const esbuild = require('esbuild');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

/** Code only — a comment that EXPLAINS a retirement is not a caller. */
function code(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
}

function walk(rel, exts = ['.js', '.jsx', '.mjs', '.cjs']) {
  const out = [];
  const dir = path.join(ROOT, rel);
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) continue;
    const p = path.join(rel, e.name);
    if (e.isDirectory()) out.push(...walk(p, exts));
    else if (exts.includes(path.extname(e.name)) && !/\.test\./.test(e.name)) out.push(p);
  }
  return out;
}

// ── 10E: Briefing / Focus / Today converge on Now ──────────────────────────

test('10. Briefing, Focus and Today converge on ONE Now read model', () => {
  for (const f of ['frontend/src/components/BriefingPanel.jsx', 'frontend/src/components/FocusPanel.jsx',
    'saim/app/src/views/Today.jsx', 'saim/app/src/views/Focus.jsx']) {
    assert.equal(exists(f), false, `${f} should be deleted (merged into Now)`);
  }
  // NEURO Now reads the canonical Now model — one payload.
  const now = read('frontend/src/components/AdhdPanel.jsx');
  assert.match(now, /useAttention\(\{ interval: 30000, path: '\/api\/canonical\/now' \}\)/);
  assert.match(now, /<NowSituation situation=\{attention\.situation\}/);
  // Old ids still land on Now.
  const ids = read('frontend/src/viewIds.js');
  assert.match(ids, /briefing: 'today'/);
  assert.match(ids, /focus: 'today'/);
  // SAiM: no Today/Focus tab, and their ids resolve to the canonical screens.
  const tabs = code(read('saim/shared-ui/tabs.jsx'));
  assert.doesNotMatch(tabs, /id: 'today'|id: 'focus'/);
  const surfaces = require('../../shared/action-surfaces.cjs');
  assert.equal(surfaces.resolveSaimLiteTab({ tab: 'today' }), 'now');
  assert.equal(surfaces.resolveSaimLiteTab({ tab: 'focus' }), 'surface');
  assert.equal(surfaces.resolveNueroNavigation({ kind: 'focus' }).view, 'today');
  assert.equal(surfaces.resolveSaimLiteTab({ tab: 'now' }), 'now', 'positive control: live tabs still resolve to themselves');
});

// ── 10B / 10D: the first world-model screens read the canonical contract ────

test('1. the Commitments screen reads the projection, never /api/waiting-on', () => {
  const src = code(read('frontend/src/components/canonical/CommitmentsPanel.jsx'));
  assert.match(src, /\/api\/canonical\/commitments/);
  assert.doesNotMatch(src, /\/api\/waiting-on/);
});

test('5. the Sources screen reads SourceHealth only, never /api/signals', () => {
  const src = code(read('frontend/src/components/canonical/SourcesPanel.jsx'));
  assert.match(src, /\/api\/canonical\/sources/);
  assert.doesNotMatch(src, /\/api\/signals/);
  // The six verdicts each have a rendering class — none collapsed.
  for (const v of ['seeing', 'quiet', 'stale', 'failing', 'unknown', 'retired']) assert.match(src, new RegExp(`${v}:`));
});

test('the Findings screen is deep NEURO — not mounted by any SAiM shell', () => {
  assert.match(code(read('frontend/src/components/canonical/FindingsPanel.jsx')), /\/api\/canonical\/findings/);
  for (const f of [...walk('saim/app/src'), ...walk('saim/shared-ui'), ...walk('saim/frontend/src')]) {
    assert.doesNotMatch(code(read(f)), /\/api\/canonical\/findings/, `${f} reaches the findings audit`);
  }
});

// ── 10P: Nick-first navigation ─────────────────────────────────────────────

test('navigation does not make Work the root of the app', () => {
  const sidebar = read('frontend/src/components/Sidebar.jsx');
  const primary = sidebar.slice(sidebar.indexOf('const PRIMARY_ITEMS'), sidebar.indexOf('const GROUPS'));
  const ids = [...primary.matchAll(/id: '([a-z-]+)'/g)].map((m) => m[1]);
  assert.deepEqual(ids, ['today', 'capture', 'chat', 'actions', 'commitments']);
  const groups = sidebar.slice(sidebar.indexOf('const GROUPS'), sidebar.indexOf('const GROUP_OF'));
  const groupIds = [...groups.matchAll(/\{ id: '([a-z]+)', label: '([A-Z &]+)'/g)].map((m) => m[2]);
  assert.equal(groupIds[0], 'LIFE', 'Life leads; Work is one section');
  assert.ok(groupIds.includes('WORK') && groupIds.indexOf('WORK') > 0);
  // Every item id is unique and routable.
  // Items only — a group's label is UPPER CASE, an item's is not.
  const all = [...sidebar.matchAll(/\{ id: '([a-z-]+)',\s+label: '(?![A-Z &]+')/g)].map((m) => m[1]);
  assert.ok(all.length > 25, 'positive control: the menu items were found');
  assert.equal(new Set(all).size, all.length, 'a view appears twice in the menu');
  const app = read('frontend/src/App.jsx');
  for (const id of all) {
    if (id === 'chat') continue; // opens the aside, never a view
    assert.ok(app.includes(`case '${id}':`) || id === 'today', `${id} has a menu entry and no view`);
  }
  // Retired ids are not offered.
  for (const gone of ['briefing', 'focus', 'kpi-tracker', 'qa', 'strava']) assert.ok(!all.includes(gone), `${gone} is still in the menu`);
});

test('KPI Tracker, QA and Strava are retired from NEURO, with a VANTAGE hand-off for KPIs', () => {
  for (const f of ['frontend/src/components/KpiTrackerPanel.jsx', 'frontend/src/components/QATab.jsx', 'frontend/src/components/StravaPanel.jsx',
    'backend/routes/kpi-tracker.js', 'backend/routes/qa.js', 'backend/routes/strava.js', 'backend/services/strava.js']) {
    assert.equal(exists(f), false, `${f} still exists`);
  }
  const server = code(read('backend/server.js'));
  assert.doesNotMatch(server, /\/api\/(qa|strava|kpi-tracker)'/);
  assert.match(read('frontend/src/viewIds.js'), /'kpi-tracker': 'moved-vantage'/);
  assert.match(read('frontend/src/App.jsx'), /case 'moved-vantage'/);
  // Workout context survives the Strava retirement, from Apple Health.
  assert.match(read('backend/services/claude.js'), /todaysWorkoutContext/);
  assert.match(read('backend/routes/journal.js'), /todaysWorkoutContext/);
});

// ── 10I: the kiosk second engine is gone ────────────────────────────────────

test('15+16. the kiosk renders the server decision and runs no engine of its own', () => {
  for (const f of ['saim/frontend/src/state/saimState.jsx', 'saim/frontend/src/state/views.js', 'saim/frontend/src/state/presentation.js',
    'saim/backend/src/state/stateEngine.js', 'saim/backend/src/state/inference.js', 'saim/backend/src/state/seed.js',
    'saim/backend/src/routes/state.js', 'saim/backend/src/routes/inference.js', 'saim/backend/src/routes/focus.js', 'saim/backend/src/routes/actions.js']) {
    assert.equal(exists(f), false, `${f} should be retired`);
  }
  const kiosk = walk('saim/frontend/src');
  assert.ok(kiosk.length > 5, 'positive control: the kiosk source was scanned');
  for (const f of kiosk) {
    const src = code(read(f));
    assert.doesNotMatch(src, /\/api\/state\b|\/api\/inference|\/api\/focus/, `${f} still calls the retired engine`);
    assert.doesNotMatch(src, /buildUrgentSnapshot|score\s*[+*]=|\.sort\([^)]*(urgency|score|severity|priority)/, `${f} ranks attention itself`);
  }
  // The kiosk mounts the shared tab registry, so its Surface IS the phone's,
  // rendering /api/attention through saim/backend's passthrough.
  assert.match(read('saim/frontend/src/App.jsx'), /shared-ui\/tabs/);
  const server = code(read('saim/backend/server.js'));
  assert.match(server, /app\.use\('\/api\/attention', attentionRoute\)/);
  assert.doesNotMatch(server, /stateRoute|inferenceRoute|focusRoute|actionsRoute/);
});

// ── 10O: /api/focus has no callers left ─────────────────────────────────────

test('25. no surface calls /api/focus — every caller moved', () => {
  const files = [...walk('frontend/src'), ...walk('saim/app/src'), ...walk('saim/shared-ui'), ...walk('saim/frontend/src'),
    ...walk('saim/backend/src'), 'mcp-server/index.js'];
  assert.ok(files.length > 50, 'positive control: the surfaces were scanned');
  for (const f of files) {
    assert.doesNotMatch(code(read(f)), /['"`]\/api\/focus/, `${f} still calls /api/focus`);
  }
  // The phone lock screen checks the PIN against the auth endpoint.
  assert.match(code(read('saim/app/src/components/LockScreen.jsx')), /\/api\/auth\/check/);
  // Suggestions are produced by the agent loop now, not by whoever polled /api/focus.
  assert.match(read('backend/services/agent-loop.js'), /generateSuggestions\(result\.items\)/);
});

test('27. dead legacy pieces are not left reachable', () => {
  for (const f of ['saim.js', 'saim/app/src/components/DueControl.jsx', 'sara', '_incoming-daypilot-sara']) {
    assert.equal(exists(f), false, `${f} is still in the tree`);
  }
  // The archived WS0/WS1 documents ARE kept.
  assert.ok(exists('saim/attractor/spec/ws1_state_engine_behavioural_spec.md'));
});

// ── 10K: SAiM never approves ───────────────────────────────────────────────

test('21. SAiM cannot approve — no approve call on any SAiM shell', () => {
  const files = [...walk('saim/app/src'), ...walk('saim/shared-ui'), ...walk('saim/frontend/src'), ...walk('saim/backend/src')];
  for (const f of files) {
    const src = code(read(f));
    assert.doesNotMatch(src, /\/approve['"`]|\/approval-challenge/, `${f} can approve`);
  }
  // Positive control: the statement IS rendered.
  assert.match(read('saim/shared-ui/AttentionSurface.jsx'), /approvals/);
});

// ── 10Q: iOS — cross-repo source guards (the Swift tests need the Mac) ─────

const { findIOSCheckout } = require('./ios-checkout');
const IOS = findIOSCheckout();
const swift = (rel) => fs.readFileSync(path.join(IOS, rel), 'utf8');
const swiftCode = (rel) => swift(rel).split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

test('22+23. iOS reads the canonical screens, and its governed queue stays read-only', { skip: !IOS && 'no iOS checkout beside this repo' }, () => {
  const menu = swiftCode('NeuroKit/Sources/NeuroKit/Menu.swift');
  for (const p of ['/api/canonical/commitments', '/api/canonical/sources', '/api/canonical/findings', '/api/canonical/life']) {
    assert.ok(menu.includes(`"${p}"`), `iOS menu lacks ${p}`);
  }
  assert.doesNotMatch(menu, /"\/api\/focus/, 'iOS menu still reads /api/focus');
  // The governed queue on iOS is read-only (Build 9 rule, unchanged here).
  const actions = swiftCode('Neuro/Features/ActionScreens.swift');
  assert.match(actions, /prepared-actions/);
  assert.doesNotMatch(actions, /prepared-actions\/[^"]*\/approve/, 'iOS can approve a governed draft');
});

test('25 (iOS). no Swift code calls /api/focus; SAiM iOS has no Today/Focus and no task editor', { skip: !IOS && 'no iOS checkout beside this repo' }, () => {
  for (const f of ['NeuroKit/Sources/NeuroKit/Actions.swift', 'Saim/SaimShell.swift', 'Saim/SaimTasksView.swift', 'NeuroKit/Sources/NeuroKit/SaimTabs.swift']) {
    assert.doesNotMatch(swiftCode(f), /"\/api\/focus/, `${f} still calls /api/focus`);
  }
  for (const f of ['Saim/SaimFocusView.swift', 'Saim/SaimTodayView.swift', 'NeuroKit/Sources/NeuroKit/FocusFeed.swift', 'Saim/DueControl.swift']) {
    assert.equal(fs.existsSync(path.join(IOS, f)), false, `${f} should be deleted`);
  }
  const tabs = swiftCode('NeuroKit/Sources/NeuroKit/SaimTabs.swift');
  assert.doesNotMatch(tabs, /id: "today"|id: "focus"/);
  const tasks = swiftCode('Saim/SaimTasksView.swift');
  assert.doesNotMatch(tasks, /TaskEditView\(|DueControl\(/, 'SAiM iOS edits tasks again');
  assert.match(tasks, /open Tasks in NEURO/, 'positive control: the hand-off is said');
});

// ── 10F: the Now situation block, rendered for real ─────────────────────────

let NowSituation;
test.before(async () => {
  const out = await esbuild.build({
    entryPoints: [path.join(ROOT, 'frontend', 'src', 'components', 'canonical', 'NowSituation.jsx')],
    bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic',
    external: ['react', 'react-dom'], logLevel: 'silent',
    plugins: [{
      name: 'stub',
      setup(b) {
        b.onResolve({ filter: /\.css$/ }, (a) => ({ path: a.path, namespace: 'css' }));
        b.onLoad({ filter: /.*/, namespace: 'css' }, () => ({ contents: '', loader: 'js' }));
        b.onResolve({ filter: /(^|\/)api$/ }, () => ({ path: 'api', namespace: 'stub' }));
        b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const apiFetch = async () => ({ ok: true, json: async () => ({}) });', loader: 'js' }));
      },
    }],
  });
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(mod, mod.exports, require);
  NowSituation = mod.exports.default;
});

const render = (situation) => renderToString(React.createElement(NowSituation, { situation }));

test('13. calm renders as calm — and only then', () => {
  const html = render({ sections: {}, calm: true, calmSay: 'Nothing needs you right now.', uncertainty: { unreadable: false, gaps: [] } });
  assert.match(html, /cn-now-calm[^>]*>Nothing needs you right now\./);
  const busy = render({ sections: { needsYou: { say: 'One drafted email waits for you in Actions.' } }, calm: false, calmSay: null, uncertainty: {} });
  assert.doesNotMatch(busy, /cn-now-calm/);
  assert.match(busy, /One drafted email waits/);
});

test('14. a blind read is never rendered as calm', () => {
  const html = render({ sections: {}, calm: false, calmSay: 'Nothing is asking for you — but some of what NEURO looks at could not be read, so this is not an all-clear.', uncertainty: { unreadable: true } });
  assert.doesNotMatch(html, /cn-now-calm/);
  assert.match(html, /not an all-clear/);
});

test('cross-domain: a personal item renders with its domain, an unknown one says unknown', () => {
  const html = render({
    sections: {
      commitments: [
        { id: 'a', description: 'Book Ember into the vet', direction: 'i-owe', counterpart: { name: null }, due: { label: 'tomorrow · stated deadline' }, domains: { domains: [{ domain: 'ember', basis: 'declared' }] } },
        { id: 'b', description: 'Confirm the marketing fix', direction: 'owed-to-me', counterpart: { name: 'Abdi Mohamed' }, due: { label: 'today · stated deadline' }, domains: { domains: [] } },
      ],
      nextEvent: { start: '2026-10-05T09:00', title: 'Tech Leadership', withPeople: ['Chris Middleton'], unresolvedPeople: 4, domains: { domains: [{ domain: 'work', basis: 'inference' }] } },
    },
    calm: false, calmSay: null, uncertainty: {}, workHeld: null,
  });
  assert.match(html, /Ember/);
  assert.match(html, /domain unknown/);
  assert.match(html, /Abdi Mohamed owes you/);
  // React separates adjacent text nodes with <!-- --> markers; allow them.
  assert.match(html, /\+(<!-- -->)?4(<!-- -->)? not matched to a person/, 'unresolved attendees are said, not hidden');
  assert.match(html, /Work(<!-- -->)?\?/, 'an inferred domain is marked as inferred');
});

test('off duty says what it held back', () => {
  const html = render({ sections: {}, calm: true, calmSay: 'Nothing needs you right now.', uncertainty: {}, workHeld: { count: 2, say: "2 work items held back while you're off duty." } });
  assert.match(html, /2 work items held back while you&#x27;re off duty\./);
});
