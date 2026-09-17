'use strict';

/**
 * Every path a WEB CLIENT calls must resolve to a route that exists.
 *
 * ⚠ WHY THIS EXISTS. `48e6481` (3 Jul 2026) deleted informal Jira flagging as a
 * deliberate product removal. Its commit message lists five frontend files it
 * cleaned up — and missed `CapturePanel`'s "Flag Escalation" control, which went
 * on POSTing to `/api/jira/flagged/:key` for TEN WEEKS. Express has no route, so
 * the reply was a 404 page, `res.json()` threw on the HTML, and the panel showed
 * `Unexpected token '<'`. Nobody could act on that, so nobody reported it.
 *
 * It is the species this codebase keeps paying for, in both directions: a READER
 * outliving its writer (the Jira queue cache, frozen and stated as current fact
 * for seven weeks; `jira_last_sync` with no writer since the same commit), and a
 * CALLER outliving its route (the MCP `get_queue` tool calling `/api/queue`, a
 * path that never existed; `saim/backend`'s `/focus/done`; `setScopes` shipped
 * with no route at all). Every one was invisible from the outside.
 *
 * ⚠ WHAT IT CAN AND CANNOT PROVE. A path built from an interpolated verb —
 * `/api/session/${action}` — cannot be resolved statically, and pretending
 * otherwise is how a check becomes theatre. So each path is reduced to its
 * STATICALLY KNOWN PREFIX (everything before the first `${...}`) and that prefix
 * must be reachable. `/api/jira/flagged/${k}` reduces to `/api/jira/flagged`,
 * which no route in `routes/jira.js` begins with — caught. `/api/session/${a}`
 * reduces to `/api/session`, which is mounted and has routes — allowed. It
 * proves a path is not DEAD; it does not prove the verb is spelled right.
 *
 * ⚠ AND IT NEEDS A POSITIVE CONTROL. A scan that silently matches nothing passes
 * by absence — `webpush.test.js` asserted a bypass using `meeting_alert`, a
 * string that code path never sends, and hid a real bug for the whole life of the
 * governor. So both tests below assert a known-bad path IS caught, and a
 * known-good one is NOT.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..', '..');

// ── reading the server's own mount table ────────────────────────────────────

function mountTable(serverFile, routesDir) {
  // ⚠ COMMENTS STRIPPED HERE TOO, and this one was found by MUTATION rather than
  // by reading — the third time in this file that "a name in a comment counts".
  // Commenting a mount out is how a route gets retired (`saim/backend`'s
  // `/api/email` and `/api/jira` went that way on 11 Sep, and the commented
  // lines are still there explaining why). Reading them as live means the table
  // still contains a mount that no longer exists, so a caller left behind by
  // that retirement resolves happily and this guard says nothing — which is
  // precisely the bug it was written to catch, hiding inside the catcher.
  const src = stripComments(fs.readFileSync(serverFile, 'utf8'));
  const mounts = new Map(); // first segment (or 'a/b') -> router file name | null

  // ⚠ `./routes/` OR `./src/routes/`, and camelCase file names. NEURO mounts
  // from `./routes/state-of-play`; `saim/backend` mounts from
  // `./src/routes/neuroAuth`. One reader for both, or the kiosk cannot be
  // checked at all — and the kiosk is the surface whose dead routes are
  // invisible from everywhere else, because the phone renders the same views
  // against NEURO directly and is fine.
  const useRe = /app\.use\('\/api\/([a-zA-Z0-9-]+)(?:\/([a-zA-Z0-9-]+))?',\s*(?:require\('\.(?:\/src)?\/routes\/([a-zA-Z0-9_-]+)'\)|([a-zA-Z0-9_]+))\)/g;
  for (const m of src.matchAll(useRe)) {
    const seg = m[2] ? `${m[1]}/${m[2]}` : m[1];
    let file = m[3] || null;
    if (!file && m[4]) {
      // `app.use('/api/x', fooRoutes)` — find what fooRoutes was required from.
      const re = new RegExp(`(?:const|let|var)\\s+${m[4]}\\s*=\\s*require\\('\\.(?:/src)?/routes/([a-zA-Z0-9_-]+)'\\)`);
      const hit = src.match(re);
      file = hit ? hit[1] : null;
    }
    mounts.set(seg, file);
  }

  // Paths declared straight on `app`, which belong to no router.
  const inline = new Set();
  for (const m of src.matchAll(/app\.(?:get|post|put|patch|delete)\('(\/api\/[^']+)'/g)) inline.add(m[1]);

  const routesOf = (file) => {
    const p = path.join(routesDir, `${file}.js`);
    if (!fs.existsSync(p)) return null;
    const rsrc = fs.readFileSync(p, 'utf8');
    const out = [];
    // ⚠ BOTH quote styles. `routes/activity.js` declares "/vault-sync" with
    // double quotes, and a single-quote-only scan reports a live route missing.
    for (const m of rsrc.matchAll(/router\.(?:get|post|put|patch|delete)\(\s*['"]([^'"]*)['"]/g)) out.push(m[1]);
    return out;
  };

  return { mounts, inline, routesOf };
}

// ── reading what the clients ask for ────────────────────────────────────────

function walk(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist') continue;
    const f = path.join(dir, e.name);
    if (e.isDirectory()) walk(f, acc);
    else if (/\.(jsx?|mjs|cjs)$/.test(e.name)) acc.push(f);
  }
  return acc;
}

/**
 * Source with comments removed, strings left intact.
 *
 * ⚠ A PATH IN A COMMENT IS NOT A CALLER, and this is not a nicety: the whole
 * value of this guard is that a failure means something real. Without it,
 * `mcp-server/index.js` fails on the comment that EXPLAINS why `/api/queue` was
 * removed, and `saim/frontend`'s `saimState.jsx` fails on the note recording
 * that `/api/actions/focus/done` used to be called. Both are exactly the
 * documentation you want people writing, and a test that punishes it gets
 * switched off — which costs the real catches too.
 *
 * It is the same mistake the DOORS parser in this file made on its first pass
 * (a name inside a comment counted as an open door), and there it survived a
 * mutation check only after being fixed.
 *
 * Strings are walked rather than stripped, so `'https://x'` does not read as the
 * start of a comment and a quote inside a comment does not swallow the file.
 */
function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      out += c;
      i++;
      while (i < n && src[i] !== quote) {
        if (src[i] === '\\') { out += src[i]; i++; }
        if (i < n) { out += src[i]; i++; }
      }
      out += quote;
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Every `/api/...` literal in these directories, with the file that holds it. */
function clientPaths(dirs) {
  const found = new Map();
  for (const d of dirs) {
    for (const file of walk(path.join(REPO, d))) {
      const src = stripComments(fs.readFileSync(file, 'utf8'));
      for (const m of src.matchAll(/['"`](\/api\/[A-Za-z0-9/_${}().:%-]*)['"`]/g)) {
        const raw = m[1];
        if (!found.has(raw)) found.set(raw, path.relative(REPO, file).split(path.sep).join('/'));
      }
    }
  }
  return found;
}

/**
 * The segments of a path that are known at build time. Stops at the first
 * interpolation — everything after it could be anything.
 */
function knownPrefix(raw) {
  const withoutQuery = raw.split('?')[0];
  const segs = withoutQuery.replace(/^\/api\/?/, '').split('/').filter(Boolean);
  const known = [];
  for (const s of segs) {
    if (s.includes('${') || s.includes(':')) break;
    known.push(s);
  }
  return known;
}

/** Does any route under this mount begin with these literal segments? */
function prefixIsReachable(routes, tail) {
  if (tail.length === 0) return true; // the mount itself
  return routes.some((r) => {
    const rs = r.split('/').filter(Boolean);
    if (rs.length < tail.length) return false;
    return tail.every((seg, i) => rs[i].startsWith(':') || rs[i] === seg);
  });
}

/** null when the path resolves; a reason string when it does not. */
function unresolved(raw, { mounts, inline, routesOf }) {
  const clean = raw.split('?')[0].replace(/\/+$/, '');
  if (inline.has(clean)) return null;

  const known = knownPrefix(raw);
  if (known.length === 0) return null; // `/api/` used only as a prefix to build on

  let mount = null;
  for (const seg of mounts.keys()) {
    const parts = seg.split('/');
    if (parts.every((p, i) => known[i] === p)) {
      if (!mount || seg.length > mount.length) mount = seg;
    }
  }
  if (!mount) {
    // Could still be an inline path whose tail is interpolated.
    if ([...inline].some((p) => p.startsWith('/api/' + known.join('/')))) return null;
    return `no mount for /api/${known[0]}`;
  }

  const file = mounts.get(mount);
  if (!file) return null; // mounted from a variable we could not trace; not this test's business

  const routes = routesOf(file);
  if (routes === null) return `routes/${file}.js does not exist`;

  const tail = known.slice(mount.split('/').length);
  if (!prefixIsReachable(routes, tail)) {
    return `no route /${tail.join('/')} in routes/${file}.js`;
  }
  return null;
}

// ── VANTAGE is a DIFFERENT SERVER, and the MCP server is a client of both ───
//
// ⚠ `mcp-server/remote/backend.js` declares TWO targets — `NEURO_API_URL` and
// `VANTAGE_API_URL` — so a `/api/...` literal under `mcp-server/` is not
// necessarily aimed at NEURO. Scanned as though it were, VANTAGE's own routes
// (`/api/findings`, `/api/self`, `/api/observations`) report as dead NEURO
// routes: three permanent false positives, red on every deploy, which is how a
// guard stops being read and costs the real catch it exists for.
//
// ⚠ THE AUTHORITY IS THE INVENTORY EACH SERVER PUBLISHES, never a list of path
// names written here. `vantage-inventory.json` (33 routes) and
// `api-inventory.json` (473) already declare who owns what, so a route added to
// VANTAGE tomorrow is excused without anybody editing this file — and the
// alternative, three names in a constant, is a list somebody has to remember to
// extend, which is the same species of rot as a hand-tuned exemption.
//
// ⚠ VANTAGE DECLARING IT IS NOT ENOUGH — NEURO MUST NOT. Measured: `/api/friction`
// and `/api/signals` are on BOTH inventories, and both are real NEURO routes with
// real NEURO callers. Excusing a path on VANTAGE's word alone would blind this
// scan to any NEURO caller of a path that happens to exist on both, which is the
// failure this whole file exists to catch, introduced by the fix for a cosmetic
// one. So the test is: VANTAGE has it AND NEURO does not.
//
// An unreadable or missing inventory excuses NOTHING — it is not evidence that a
// path belongs to VANTAGE, and failing open here costs a false alarm while
// failing closed would cost a real dead route.
function vantageOwnedPaths() {
  const read = (name) => {
    try {
      const raw = fs.readFileSync(path.join(REPO, 'mcp-server', 'remote', name), 'utf8');
      return new Set(JSON.parse(raw).map((e) => e && e.route).filter(Boolean));
    } catch {
      return new Set();
    }
  };
  const vantage = read('vantage-inventory.json');
  const neuro = read('api-inventory.json');
  // A declared route carries `:params`; the scan works on literal prefixes, so
  // compare on the leading literal segments both sides can agree on.
  // ⚠ Keyed to match `knownPrefix`, which STRIPS the leading `api` segment. A
  // key built without that strip matches nothing and the exclusion silently
  // does nothing — which is exactly how the first cut of this failed.
  const literal = (route) => route.replace(/^\/api\/?/, '').split('/').filter(Boolean)
    .reduce((acc, seg) => (acc.stopped || seg.startsWith(':')
      ? { segs: acc.segs, stopped: true }
      : { segs: acc.segs.concat(seg), stopped: false }), { segs: [], stopped: false })
    .segs.join('/');

  const neuroLiteral = new Set([...neuro].map(literal));
  const owned = new Set();
  for (const route of vantage) {
    const key = literal(route);
    if (key && !neuroLiteral.has(key)) owned.add(key);
  }
  return owned;
}

// ── 1. the NEURO clients ────────────────────────────────────────────────────

const NEURO_CLIENTS = {
  'NEURO desktop': ['frontend/src'],
  'SAiM phone PWA': ['saim/app/src'],
  'SAiM shared views': ['saim/shared-ui'],
  'MCP server': ['mcp-server'],
};

test('every NEURO web client path resolves to a route that exists', () => {
  const table = mountTable(
    path.join(REPO, 'backend', 'server.js'),
    path.join(REPO, 'backend', 'routes'),
  );

  const vantageOwned = vantageOwnedPaths();
  const dead = [];
  for (const [client, dirs] of Object.entries(NEURO_CLIENTS)) {
    for (const [raw, where] of clientPaths(dirs)) {
      if (vantageOwned.has(knownPrefix(raw).join('/'))) continue;  // VANTAGE's, not NEURO's
      const why = unresolved(raw, table);
      if (why) dead.push(`${client}: ${raw} — ${why} (${where})`);
    }
  }

  assert.deepStrictEqual(
    dead,
    [],
    'A web client calls a path with no route behind it:\n  ' + dead.join('\n  '),
  );
});

test('POSITIVE CONTROL: the VANTAGE exclusion excuses VANTAGE and nothing else', () => {
  const owned = vantageOwnedPaths();

  // It must actually DO something, or the exclusion is decoration and the three
  // false positives it exists to remove come straight back.
  assert.ok(owned.size > 0, 'no VANTAGE route was recognised — the inventories did not load');
  for (const seg of ['findings', 'self', 'observations']) {
    assert.ok(owned.has(seg), `/api/${seg} is VANTAGE's and must be excused`);
  }

  // ⚠ THE HALF THAT CAN FAIL SILENTLY. `/api/friction` and `/api/signals` are on
  // BOTH inventories and are real NEURO routes with real NEURO callers. Excusing
  // a path on VANTAGE's word alone would pass this whole suite — nothing breaks,
  // the scan simply stops looking at them — so the over-broad version is pinned
  // here rather than left to be noticed. Mutation-checked: dropping the
  // `!neuroLiteral.has(key)` guard fails these two assertions and nothing else.
  for (const shared of ['friction', 'signals']) {
    assert.ok(
      !owned.has(shared),
      `/api/${shared} exists on BOTH servers — NEURO callers of it must still be checked`,
    );
  }

  // And a plain NEURO route is never excused.
  assert.ok(!owned.has('tasks'), '/api/tasks belongs to NEURO and must still be scanned');
});

test('POSITIVE CONTROL: the scan catches a dead path and clears a live one', () => {
  const table = mountTable(
    path.join(REPO, 'backend', 'server.js'),
    path.join(REPO, 'backend', 'routes'),
  );

  // The real bug, as it stood in `CapturePanel.jsx` from 3 Jul to 12 Sep 2026.
  assert.ok(
    unresolved('/api/jira/flagged/${k}', table),
    'the scan must catch /api/jira/flagged — it is the bug this file exists for',
  );

  // Live routes, including the shapes that make a naive scan cry wolf.
  for (const live of [
    '/api/jira/escalations/unseen',   // a real two-segment route
    '/api/session/${action}',         // an interpolated VERB — unverifiable, never a failure
    '/api/activity/vault-sync',       // declared with DOUBLE quotes in its router
    '/api/tasks/${id}/complete',      // interpolation in the middle
    '/api/status',                    // declared straight on `app`, not in a router
  ]) {
    assert.strictEqual(unresolved(live, table), null, `${live} must not be reported`);
  }
});

// ── 2. the kiosk, whose screens are shared and whose doors are not ──────────

/**
 * The shared SAiM views run on the phone (direct to NEURO) AND on the Pi kiosk
 * (through `saim/backend`'s allowlist). A segment the views call that is not a
 * door is a screen that 404s on the kiosk only — which is invisible from here,
 * because the phone is fine.
 *
 * ⚠ `health` is a DELIBERATELY CLOSED DOOR, not an oversight: body data behind an
 * unauthenticated always-on desk screen. The Today screen names it as not shown
 * there rather than failing. It is listed rather than silently tolerated, so
 * closing a second door is a visible decision — the `push-types.test.js` shape.
 */
/**
 * ⚠ `desktop` is a DELIBERATELY CLOSED DOOR (12 Sep 2026). It ends in a
 * PROGRAM STARTING on Nick's work laptop, and the kiosk is an unauthenticated
 * touchscreen in a family room: anyone who walks past it could open a terminal
 * on his machine. The shared Surface therefore offers the row only where it can
 * reach the route, and hides it permanently on a 401/403 — capability, not
 * device, the same way the mic is gated.
 */
const CLOSED_ON_PURPOSE = new Set(['health', 'desktop']);

/**
 * The kiosk's allowlist, read from `neuroProxy.js`.
 *
 * ⚠ COMMENTS ARE NOT DOORS, and this is not pedantry: commenting a line out is
 * exactly how a door gets CLOSED in that file (`journal`, `vault`,
 * `vault-hygiene` and `plaud` went that way on 11 Sep). A scan that reads the
 * whole block as one string still finds the name inside the comment, so the test
 * passes over a door that no longer exists — caught by MUTATION, not by reading.
 * Take the code half of each line, and only a name that OPENS it.
 */
function kioskDoors() {
  const proxy = fs.readFileSync(
    path.join(REPO, 'saim', 'backend', 'src', 'routes', 'neuroProxy.js'), 'utf8',
  );

  const names = (block, pattern) => {
    const out = new Set();
    for (const line of block.split(String.fromCharCode(10))) {
      const code = line.split('//')[0].trim();
      const m = code.match(pattern);
      if (m) out.add(m[1]);
    }
    return out;
  };

  const block = proxy.match(/const DOORS = new Set\(\[([\s\S]*?)\]\)/);
  assert.ok(block, 'could not read the DOORS allowlist — the scan is broken, not the doors');
  const doors = names(block[1], /^'([a-z0-9-]+)'/);
  assert.ok(doors.size > 5, 'DOORS parsed suspiciously small — positive control on the parse');

  // A SECOND, NARROWER LIST. `activity` is deliberately NOT a segment door —
  // that segment also carries `suggestions/apply` and `rebuild-embeddings`,
  // neither of which has a kiosk screen behind it — so the screen-usage report
  // is opened as ONE PATH. A scan that only read DOORS would call that path
  // stranded, and would go on passing if somebody later widened it to a whole
  // segment. Same comment rule as above: a name inside a comment is not a door.
  const exactBlock = proxy.match(/const EXACT_DOORS = new Set\(\[([\s\S]*?)\]\)/);
  const exact = exactBlock ? names(exactBlock[1], /^'(\/[a-z0-9\-/]+)'/) : new Set();

  return { doors, exact };
}

/** Does this client path reach NEURO — by segment door, or as an exact path? */
function throughDoor(raw, gates) {
  const seg = knownPrefix(raw)[0];
  const bare = raw.replace(/^\/api/, '').split(/[?#]/)[0].replace(/\/+$/, '');
  return gates.exact.has(bare) || (Boolean(seg) && gates.doors.has(seg));
}

test('every segment the shared SAiM views call is a kiosk door, or declared closed', () => {
  const doors = kioskDoors();

  const saimServer = fs.readFileSync(path.join(REPO, 'saim', 'backend', 'server.js'), 'utf8');
  const named = new Set(
    [...saimServer.matchAll(/app\.use\('\/api\/([a-z0-9-]+)'/g)].map((m) => m[1]),
  );

  const stranded = [];
  for (const [raw, where] of clientPaths(['saim/app/src/views', 'saim/shared-ui'])) {
    const seg = knownPrefix(raw)[0];
    if (!seg) continue;
    if (throughDoor(raw, doors) || named.has(seg) || CLOSED_ON_PURPOSE.has(seg)) continue;
    stranded.push(`${raw} — '${seg}' is not a kiosk door (${where})`);
  }

  assert.deepStrictEqual(
    stranded,
    [],
    'A shared view calls something the kiosk cannot reach:\n  ' + stranded.join('\n  '),
  );
});

// -- 3. the kiosk SHELL, whose own calls go nowhere near NEURO ---------------

test('every path the kiosk shell calls resolves — on saim/backend or through a door', () => {
  const neuro = mountTable(
    path.join(REPO, 'backend', 'server.js'),
    path.join(REPO, 'backend', 'routes'),
  );
  const saim = mountTable(
    path.join(REPO, 'saim', 'backend', 'server.js'),
    path.join(REPO, 'saim', 'backend', 'src', 'routes'),
  );
  assert.ok(saim.mounts.size > 8, 'saim/backend mounts parsed suspiciously small');

  const doors = kioskDoors();
  const dead = [];

  for (const [raw, where] of clientPaths(['saim/frontend/src'])) {
    // Its OWN backend first — every named door in `saim/backend/server.js` is
    // mounted AHEAD of the proxy, so those win.
    if (!unresolved(raw, saim)) continue;
    // Otherwise it can only be reaching NEURO through the allowlist, which
    // means it must be a door AND resolve on the far side.
    const seg = knownPrefix(raw)[0];
    if (!seg) continue;
    if (!throughDoor(raw, doors)) {
      dead.push(`${raw} — not a saim/backend route and '${seg}' is not a door (${where})`);
      continue;
    }
    const why = unresolved(raw, neuro);
    if (why) dead.push(`${raw} — through the door, but ${why} (${where})`);
  }

  assert.deepStrictEqual(
    dead,
    [],
    'The kiosk shell calls something nothing answers:\n  ' + dead.join('\n  '),
  );
});

test('POSITIVE CONTROL: a path in a COMMENT is not a caller', () => {
  // ⚠ THE FALSE POSITIVE THAT WOULD HAVE KILLED THIS GUARD. Both
  // `mcp-server/index.js` and `saim/frontend`'s `saimState.jsx` carry comments
  // naming routes that were REMOVED — which is exactly the documentation you
  // want, and a test that fails on it gets switched off, costing the real
  // catches too.
  const src = [
    '// it called `/api/queue`, which never existed',
    '/* used to POST /api/actions/focus/done */',
    "const live = '/api/friction';",
    "const url = 'https://example.test/api/not-a-comment';",
  ].join('\n');

  const stripped = stripComments(src);
  assert.ok(!stripped.includes('/api/queue'), 'a line comment survived stripping');
  assert.ok(!stripped.includes('focus/done'), 'a block comment survived stripping');
  // ⚠ And the control in the other direction: real calls and URLs containing
  // `//` must SURVIVE, or the stripper passes by deleting everything.
  assert.ok(stripped.includes("'/api/friction'"), 'a real call was stripped');
  assert.ok(stripped.includes('example.test'), 'a URL was mistaken for a comment');
});

