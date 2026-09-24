'use strict';

/**
 * Does the Suggested people card obey its own rules when it actually renders?
 *
 * A REAL render via esbuild, not a source scan. A `vite build` proves the file
 * compiles; it says nothing about whether a name reached the screen — and the
 * failure this card exists to prevent is a blank panel reading as a settled
 * roster.
 *
 * ⚠ It renders `SuggestedPeopleView`, not the default export. The container
 * fetches in `useEffect`, which `renderToString` never runs, so a test over the
 * default export can only ever assert the loading state and every rule below
 * would be pinned by nothing.
 *
 * Payloads are the LIVE shape off `GET /api/people-gap`, with the real names
 * from the 23 Sep report.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const React = require('react');
const { renderToString } = require('react-dom/server');
const esbuild = require('esbuild');

const CARD = path.resolve(__dirname, '..', '..', 'frontend', 'src', 'components', 'SuggestedPeople.jsx');

let View;

test.before(async () => {
  const out = await esbuild.build({
    entryPoints: [CARD],
    bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic',
    external: ['react', 'react-dom'],
    logLevel: 'silent',
    plugins: [{
      name: 'stub',
      setup(build) {
        build.onResolve({ filter: /\.css$/ }, a => ({ path: a.path, namespace: 'css' }));
        build.onLoad({ filter: /.*/, namespace: 'css' }, () => ({ contents: '', loader: 'js' }));
        build.onResolve({ filter: /(^|\/)api$/ }, () => ({ path: 'api', namespace: 'stub' }));
        build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
          contents: 'export const apiUrl = p => p;\nexport default { apiUrl };',
          loader: 'js',
        }));
      },
    }],
  });
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(mod, mod.exports, require);
  View = mod.exports.SuggestedPeopleView;
});

const noop = () => {};
// ⚠ React SSR splices `<!-- -->` between adjacent interpolations, so a phrase
// the reader sees as "3 sightings" is "3<!-- --> <!-- -->sightings" in the
// markup. Stripped here rather than written into every assertion, which would
// pin React's text-node boundaries instead of the words on the screen.
const draw = (props) => renderToString(React.createElement(View, {
  busy: null, note: '', roles: {}, confirmAlias: null,
  onRetry: noop, onRefresh: noop, onRoleChange: noop, onCreate: noop, onIgnore: noop,
  onUnignore: noop, onProposeAlias: noop, onCommitAlias: noop, onCancelAlias: noop,
  showOnce: false, onToggleOnce: noop, showIgnored: false, onToggleIgnored: noop,
  ...props,
})).replace(/<!-- -->/g, '');

const SCAN = (over = {}) => ({
  status: 'ok', scannedDays: 90, minSightings: 2, existing: 43,
  rosterKnown: true, ignoreKnown: true,
  candidates: [], belowThreshold: [],
  withheld: { resolved: [], ignored: [], notPeople: [] },
  ignored: [],
  ...over,
});

// ── The positive control ──────────────────────────────────────────────────

test('a candidate reaches the screen, with its sightings and its sources', () => {
  // ⚠ Without this, every "must not appear" assertion below is satisfied by a
  // component that renders nothing at all.
  const html = draw({
    scan: SCAN({ candidates: [{ name: 'Melanie Ellis', count: 3, sources: ['calendar', 'inbox'] }] }),
  });
  assert.match(html, /Melanie Ellis/);
  assert.match(html, /3 sightings/);
  assert.match(html, /calendar, inbox/);
  assert.match(html, /Create/);
  assert.match(html, /Not a person/);
});

// ── The three renderings ──────────────────────────────────────────────────

test('an unreadable scan is amber and REFUSES to imply everyone has a note', () => {
  const html = draw({ scan: null, error: 'OBSIDIAN_VAULT_PATH not configured' });
  assert.match(html, /couldn(&#x27;|')t read the scan/);
  assert.match(html, /OBSIDIAN_VAULT_PATH not configured/, 'it must say WHY');
  assert.match(html, /not a statement that everyone has a note/);
  assert.match(html, /sp-error/);
  assert.match(html, /Try again/);
});

test('a scan that is not ok renders as an ERROR, never as an empty day', () => {
  // The route answers `status:'error'` WITH `candidates: []`. Trusted, that
  // takes the empty-day branch and renders nothing at all over a vault NEURO
  // could not read — silence standing in for an all-clear.
  const html = draw({ scan: { status: 'error', error: 'vault unreadable', candidates: [], belowThreshold: [] } });
  assert.match(html, /sp-error/);
  assert.match(html, /vault unreadable/);
  assert.notEqual(html, '');
});

test('a clean empty day renders NOTHING — not an empty card', () => {
  // The roster settles for weeks. A permanent panel saying there is nothing in
  // it is furniture on the page Nick opens to look at his team.
  assert.equal(draw({ scan: SCAN() }), '');
});

test('but an ignore list alone still renders, because Undo must stay reachable', () => {
  // "Ignored names never come back" is only safe while there is a way back.
  const html = draw({ scan: SCAN({ ignored: [{ name: 'The Scrum Room', at: null }] }), showIgnored: true });
  assert.match(html, /Ignored \(1\)/);
  assert.match(html, /The Scrum Room/);
  assert.match(html, /Undo/);
});

test('a degraded read always renders, and says which half it could not read', () => {
  // Silence here would be the third meaning of a blank card.
  const roster = draw({ scan: SCAN({ rosterKnown: false }) });
  assert.match(roster, /alias map couldn(&#x27;|')t be read/);
  assert.match(roster, /sp-gap/);

  const ignore = draw({ scan: SCAN({ ignoreKnown: false }) });
  assert.match(ignore, /ignore list couldn(&#x27;|')t be read/);
});

test('"nothing to add" is only ever said over a clean read', () => {
  // It renders alongside something to decide — never alone (covered above), and
  // never over a scan that could not see the roster.
  const html = draw({ scan: SCAN({ rosterKnown: false }) });
  assert.match(html, /alias map couldn(&#x27;|')t be read/,
    'the caveat must sit above the reassurance, not instead of it');
});

// ── The near miss ─────────────────────────────────────────────────────────

test('a near miss is offered as a QUESTION about an existing person', () => {
  const html = draw({
    scan: SCAN({ belowThreshold: [{ name: 'Naomi Winkworth', count: 1, sources: ['meetings'], maybeAliasOf: 'Naomi Wentworth' }] }),
    showOnce: true,
  });
  assert.match(html, /maybe Naomi Wentworth/);
  assert.match(html, /Alias of Naomi/);
  // ⚠ And it must NOT read as a decision already taken.
  assert.doesNotMatch(html, /is Naomi Wentworth|merged|same person/i);
});

test('a row with no near miss offers no alias button', () => {
  const html = draw({ scan: SCAN({ candidates: [{ name: 'Richard Power', count: 3, sources: ['inbox'] }] }) });
  assert.doesNotMatch(html, /Alias of/, 'a button that guesses which person it means is worse than none');
});

// ── The confirm ───────────────────────────────────────────────────────────

test('the confirm quotes the exact line and names the file it edits', () => {
  const html = draw({
    scan: SCAN(),
    confirmAlias: { person: 'Naomi Wentworth', alias: 'Naomi Winkworth', line: '  - Naomi Winkworth', path: 'People/Naomi Wentworth.md' },
  });
  assert.match(html, /- Naomi Winkworth/, 'the literal line, from the server');
  assert.match(html, /People\/Naomi Wentworth\.md/, 'and which note it goes into');
  assert.match(html, /Write it/);
  assert.match(html, /Cancel/, 'there must be a way out of a write with no undo');
});

// ── Withheld names ────────────────────────────────────────────────────────

test('a filtered name is SAID, with its reason — a silent filter is uncheckable', () => {
  const html = draw({
    scan: SCAN({
      candidates: [{ name: 'Melanie Ellis', count: 3, sources: ['inbox'] }],
      withheld: { resolved: [], ignored: [], notPeople: [{ name: 'The Scrum Room', reason: 'ends in "Room"' }] },
    }),
  });
  assert.match(html, /Not shown, not a person/);
  assert.match(html, /The Scrum Room/);
  assert.match(html, /ends in/);
});

test('the seen-once fold states its count before it is opened', () => {
  const html = draw({
    scan: SCAN({
      candidates: [{ name: 'Melanie Ellis', count: 3, sources: ['inbox'] }],
      belowThreshold: [
        { name: 'Abigail Brown', count: 1, sources: ['inbox'] },
        { name: 'Joshua Mills', count: 1, sources: ['inbox'] },
      ],
    }),
    showOnce: false,
  });
  assert.match(html, /Seen once \(2\)/);
  assert.doesNotMatch(html, /Abigail Brown/, 'collapsed means collapsed');
});

// ── Wording ───────────────────────────────────────────────────────────────

test('nothing on the card claims a person is at fault or a name is wrong', () => {
  const html = draw({
    scan: SCAN({
      candidates: [{ name: 'Naomi Winkworth', count: 2, sources: ['meetings'], maybeAliasOf: 'Naomi Wentworth' }],
      withheld: { resolved: [], ignored: [], notPeople: [{ name: 'The Scrum Room', reason: 'ends in "Room"' }] },
    }),
  });
  for (const forbidden of [/\bwrong\b/i, /\bmistake\b/i, /\berror\b/i, /\bfailed\b/i, /\bmissing person\b/i]) {
    assert.doesNotMatch(html, forbidden, `the card must not say ${forbidden}`);
  }
});
