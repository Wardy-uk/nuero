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
 * path that never existed; `sara/backend`'s `/focus/done`; `setScopes` shipped
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
  const src = fs.readFileSync(serverFile, 'utf8');
  const mounts = new Map(); // first segment (or 'a/b') -> router file name | null

  const useRe = /app\.use\('\/api\/([a-zA-Z0-9-]+)(?:\/([a-zA-Z0-9-]+))?',\s*(?:require\('\.\/routes\/([a-zA-Z0-9-]+)'\)|([a-zA-Z0-9_]+))\)/g;
  for (const m of src.matchAll(useRe)) {
    const seg = m[2] ? `${m[1]}/${m[2]}` : m[1];
    let file = m[3] || null;
    if (!file && m[4]) {
      // `app.use('/api/x', fooRoutes)` — find what fooRoutes was required from.
      const re = new RegExp(`(?:const|let|var)\\s+${m[4]}\\s*=\\s*require\\('\\./routes/([a-zA-Z0-9-]+)'\\)`);
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

/** Every `/api/...` literal in these directories, with the file that holds it. */
function clientPaths(dirs) {
  const found = new Map();
  for (const d of dirs) {
    for (const file of walk(path.join(REPO, d))) {
      const src = fs.readFileSync(file, 'utf8');
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

// ── 1. the NEURO clients ────────────────────────────────────────────────────

const NEURO_CLIENTS = {
  'NEURO desktop': ['frontend/src'],
  'SARA phone PWA': ['sara/app/src'],
  'SARA shared views': ['sara/shared-ui'],
};

test('every NEURO web client path resolves to a route that exists', () => {
  const table = mountTable(
    path.join(REPO, 'backend', 'server.js'),
    path.join(REPO, 'backend', 'routes'),
  );

  const dead = [];
  for (const [client, dirs] of Object.entries(NEURO_CLIENTS)) {
    for (const [raw, where] of clientPaths(dirs)) {
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
 * The shared SARA views run on the phone (direct to NEURO) AND on the Pi kiosk
 * (through `sara/backend`'s allowlist). A segment the views call that is not a
 * door is a screen that 404s on the kiosk only — which is invisible from here,
 * because the phone is fine.
 *
 * ⚠ `health` is a DELIBERATELY CLOSED DOOR, not an oversight: body data behind an
 * unauthenticated always-on desk screen. The Today screen names it as not shown
 * there rather than failing. It is listed rather than silently tolerated, so
 * closing a second door is a visible decision — the `push-types.test.js` shape.
 */
const CLOSED_ON_PURPOSE = new Set(['health']);

test('every segment the shared SARA views call is a kiosk door, or declared closed', () => {
  const proxy = fs.readFileSync(
    path.join(REPO, 'sara', 'backend', 'src', 'routes', 'neuroProxy.js'), 'utf8',
  );
  const block = proxy.match(/const DOORS = new Set\(\[([\s\S]*?)\]\)/);
  assert.ok(block, 'could not read the DOORS allowlist — the scan is broken, not the doors');

  // ⚠ COMMENTS ARE NOT DOORS, and this is not pedantry: commenting a line out is
  // exactly how a door gets CLOSED in that file (`journal`, `vault`,
  // `vault-hygiene` and `plaud` went that way on 11 Sep). A scan that reads the
  // whole block as one string still finds the name inside the comment, so the
  // test passes over a door that no longer exists — caught by mutation, not by
  // reading. Take the code half of each line, and only a name that OPENS it.
  const doors = new Set();
  for (const line of block[1].split('\n')) {
    const code = line.split('//')[0].trim();
    const m = code.match(/^'([a-z0-9-]+)'/);
    if (m) doors.add(m[1]);
  }
  assert.ok(doors.size > 5, 'DOORS parsed suspiciously small — positive control on the parse');

  const saraServer = fs.readFileSync(path.join(REPO, 'sara', 'backend', 'server.js'), 'utf8');
  const named = new Set(
    [...saraServer.matchAll(/app\.use\('\/api\/([a-z0-9-]+)'/g)].map((m) => m[1]),
  );

  const stranded = [];
  for (const [raw, where] of clientPaths(['sara/app/src/views', 'sara/shared-ui'])) {
    const seg = knownPrefix(raw)[0];
    if (!seg) continue;
    if (doors.has(seg) || named.has(seg) || CLOSED_ON_PURPOSE.has(seg)) continue;
    stranded.push(`${raw} — '${seg}' is not a kiosk door (${where})`);
  }

  assert.deepStrictEqual(
    stranded,
    [],
    'A shared view calls something the kiosk cannot reach:\n  ' + stranded.join('\n  '),
  );
});
