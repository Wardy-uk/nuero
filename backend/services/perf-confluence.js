'use strict';

/**
 * Confluence pages Nick wrote or revised (30 Oct 2026) — for VANTAGE's
 * Performance Evidence.
 *
 * Nick: "I want NEURO/VANTAGE to find my evidence for me — the more it finds
 * the better", and his SOPs live in Confluence. Measured first: he CREATED
 * 1,462 pages in 2026, and most of that is moving pages, not writing them — the
 * 27 May bulk move of the LeadPro knowledge base and the "Migrated from
 * BriefYourMarket Knowledge Base" import. Counting those would bury the real
 * work, so his rules (30 Oct 2026):
 *
 *  - CREATED: a page counts unless it was created in a batch (BATCH_MIN = 20 or
 *    more of his pages created the same day) or says "Migrated from". A page
 *    that names him as Owner ("Owner: Nick Ward") counts regardless.
 *  - REVISED: his versions of a page, grouped per London day. On a page that
 *    names him as Owner, any real change counts; on anyone else's page only a
 *    substantial one (CHANGE_MIN = a quarter of the page). Edits on the day he
 *    created the page are part of writing it, not a revision.
 *
 * Reads only (GET). Uses NEURO's existing Atlassian login (JIRA_*). The page
 * body never leaves NEURO — only its title, link, how much changed and Nick's
 * own version notes. Results are cached in tables; itemsFor() reads the cache
 * and never the network, and says it cannot answer until a run has succeeded.
 */

const BATCH_MIN = 20;
const CHANGE_MIN = 0.25;
const OWNER_CHANGE_MIN = 0.02;
const FLOOR_DAYS = 400;
const PAGES_PER_RUN = 60;
const CREATED_SWEEP_MS = 20 * 3600_000;
const OWNER_RE = /Owner:\s*Nick Ward\b/i;
const MIGRATED_RE = /\bMigrated from\b/i;
const STATE_KEY = 'perf_confluence_run';

let ready = false;
function db() {
  const d = require('../db/database').getDb();
  if (!ready) {
    d.exec(`CREATE TABLE IF NOT EXISTS perf_confluence_items (
      key        TEXT PRIMARY KEY,
      page_id    TEXT NOT NULL,
      kind       TEXT NOT NULL,
      day        TEXT NOT NULL,
      at         TEXT NOT NULL,
      title      TEXT,
      space      TEXT,
      url        TEXT,
      counted    INTEGER NOT NULL,
      change     REAL,
      owner      INTEGER,
      detail     TEXT,
      reason     TEXT,
      checked_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_perf_confluence_day ON perf_confluence_items(day);
    CREATE TABLE IF NOT EXISTS perf_confluence_pages (
      page_id       TEXT PRIMARY KEY,
      last_modified TEXT,
      checked_at    TEXT NOT NULL,
      error         TEXT
    );`);
    ready = true;
  }
  return d;
}

// ── pure helpers ────────────────────────────────────────────────────────────

/** London calendar day of an instant. */
function londonDay(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
  const g = (t) => p.find((x) => x.type === t).value;
  return `${g('year')}-${g('month')}-${g('day')}`;
}

/** Visible words of a Confluence storage body. */
function textOf(storage) {
  return String(storage || '')
    .replace(/<ac:parameter[^>]*>[\s\S]*?<\/ac:parameter>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function words(text) {
  return String(text || '').toLowerCase().match(/[a-z0-9][a-z0-9'’-]*/g) || [];
}

/** Share of the page that changed: 1 − shared words ÷ the longer version. 0..1. */
function changeRatio(before, after) {
  const a = words(before); const b = words(after);
  const longer = Math.max(a.length, b.length);
  if (!longer) return 0;
  if (!a.length || !b.length) return 1;
  const counts = new Map();
  for (const w of a) counts.set(w, (counts.get(w) || 0) + 1);
  let shared = 0;
  for (const w of b) { const n = counts.get(w); if (n) { shared += 1; counts.set(w, n - 1); } }
  return 1 - shared / longer;
}

/** The created-page rule, given the page and how many pages he created that day. */
function judgeCreated({ excerpt, sameDayCount }) {
  const owner = OWNER_RE.test(excerpt || '');
  if (owner) return { counted: true, owner, reason: 'names you as Owner' };
  if (MIGRATED_RE.test(excerpt || '')) return { counted: false, owner, reason: 'migrated page' };
  if (sameDayCount >= BATCH_MIN) return { counted: false, owner, reason: `created in a batch of ${sameDayCount} that day` };
  return { counted: true, owner, reason: 'you created it' };
}

/** The revision rule. */
function judgeRevision({ change, owner }) {
  if (owner) return change >= OWNER_CHANGE_MIN
    ? { counted: true, reason: 'your page (names you as Owner)' }
    : { counted: false, reason: 'no real change' };
  return change >= CHANGE_MIN
    ? { counted: true, reason: 'substantial revision' }
    : { counted: false, reason: `small edit (${Math.round(change * 100)}% changed)` };
}

/** His versions grouped per London day, excluding version 1 (the creation). */
function groupVersions(versions, me, floorIso) {
  const groups = new Map();
  for (const v of versions) {
    if (v.authorId !== me || v.number <= 1 || v.createdAt < floorIso) continue;
    const day = londonDay(v.createdAt);
    if (!day) continue;
    const g = groups.get(day) || { day, first: v.number, last: v.number, at: v.createdAt, notes: [] };
    g.first = Math.min(g.first, v.number);
    if (v.number >= g.last) { g.last = v.number; g.at = v.createdAt; }
    if (v.message && !g.notes.includes(v.message)) g.notes.push(v.message);
    groups.set(day, g);
  }
  return [...groups.values()];
}

// ── network ─────────────────────────────────────────────────────────────────

function configured() {
  return !!(process.env.JIRA_BASE_URL && process.env.JIRA_EMAIL && process.env.JIRA_API_TOKEN);
}

function makeClient(fetchImpl = global.fetch) {
  const base = String(process.env.JIRA_BASE_URL || '').replace(/\/+$/, '');
  const auth = 'Basic ' + Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString('base64');
  return {
    base,
    async get(p) {
      const url = p.startsWith('http') ? p : `${base}${p}`;
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 30_000);
      try {
        const r = await fetchImpl(url, { headers: { Authorization: auth, Accept: 'application/json' }, signal: ctl.signal });
        if (!r.ok) throw new Error(`Confluence answered ${r.status} for ${p.split('?')[0]}`);
        return await r.json();
      } finally { clearTimeout(t); }
    },
  };
}

/** Every search result for a CQL, following `next` links. */
async function searchAll(client, cql, expand) {
  const out = [];
  let next = `/wiki/rest/api/search?limit=100&expand=${expand}&cql=${encodeURIComponent(cql)}`;
  for (let i = 0; next && i < 60; i += 1) {
    const j = await client.get(next);
    out.push(...(j.results || []));
    next = j._links?.next ? `/wiki${j._links.next}` : null;
  }
  if (next) throw new Error('Confluence search did not finish (more than 6,000 results)');
  return out;
}

async function versionsSince(client, pageId, floorIso) {
  const out = [];
  let next = `/wiki/api/v2/pages/${pageId}/versions?limit=50&sort=-modified-date`;
  for (let i = 0; next && i < 20; i += 1) {
    const j = await client.get(next);
    const got = j.results || [];
    out.push(...got);
    if (got.some((v) => v.createdAt < floorIso)) break;
    next = j._links?.next ? `/wiki${j._links.next.replace(/^\/wiki/, '')}` : null;
  }
  return out;
}

async function bodyAt(client, pageId, version) {
  if (version < 1) return '';
  const j = await client.get(`/wiki/api/v2/pages/${pageId}?version=${version}&body-format=storage`);
  return textOf(j.body?.storage?.value);
}

// ── run ─────────────────────────────────────────────────────────────────────

function todayKey(now = new Date()) { return londonDay(now.toISOString()); }

function readState() {
  try { return JSON.parse(require('../db/database').getState(STATE_KEY) || 'null') || {}; } catch { return {}; }
}
function writeState(s) { require('../db/database').setState(STATE_KEY, JSON.stringify(s)); }

/**
 * One pass. Daily: every page he created (batch counts need the whole set).
 * Every pass: pages he contributed to that changed since last checked, up to
 * PAGES_PER_RUN, newest first.
 */
async function run({ deps = {} } = {}) {
  if (!configured() && !deps.fetch) return { ok: false, error: 'Atlassian login not configured (JIRA_BASE_URL / JIRA_EMAIL / JIRA_API_TOKEN)' };
  const client = makeClient(deps.fetch);
  const now = deps.now || new Date();
  const today = todayKey(now);
  const floorIso = new Date(now.getTime() - FLOOR_DAYS * 864e5).toISOString();
  const floorDay = floorIso.slice(0, 10);
  const d = db();
  const state = readState();
  const stamp = now.toISOString();
  const report = { ok: true, createdSweep: null, pagesChecked: 0, revisions: 0, counted: 0, failed: 0, remaining: 0 };
  try {
    const me = (await client.get('/wiki/rest/api/user/current')).accountId;
    if (!me) throw new Error('Confluence did not say who the login is');

    const upItem = d.prepare(`INSERT INTO perf_confluence_items (key, page_id, kind, day, at, title, space, url, counted, change, owner, detail, reason, checked_at)
      VALUES (@key, @page_id, @kind, @day, @at, @title, @space, @url, @counted, @change, @owner, @detail, @reason, @checked_at)
      ON CONFLICT(key) DO UPDATE SET title = excluded.title, space = excluded.space, url = excluded.url, counted = excluded.counted,
        change = excluded.change, owner = excluded.owner, detail = excluded.detail, reason = excluded.reason, checked_at = excluded.checked_at`);

    // 1. Pages he created (daily — the batch rule needs every page of a day).
    if (!state.createdAt || now - Date.parse(state.createdAt) > CREATED_SWEEP_MS || deps.forceCreated) {
      const rows = await searchAll(client, `creator = currentUser() AND type = page AND created >= "${floorDay}" ORDER BY created DESC`, 'content.history,content.space');
      const pages = rows.map((r) => ({
        id: String(r.content?.id), title: r.content?.title || r.title, space: r.content?.space?.name || r.resultGlobalContainer?.title || null,
        url: `${client.base}/wiki${r.content?._links?.webui || r.url || ''}`,
        at: r.content?.history?.createdDate, excerpt: r.excerpt || '',
      })).filter((p) => p.id && p.at);
      const perDay = new Map();
      for (const p of pages) { p.day = londonDay(p.at); perDay.set(p.day, (perDay.get(p.day) || 0) + 1); }
      let counted = 0;
      d.transaction(() => {
        for (const p of pages) {
          const j = judgeCreated({ excerpt: p.excerpt, sameDayCount: perDay.get(p.day) });
          if (j.counted) counted += 1;
          upItem.run({ key: `created:${p.id}`, page_id: p.id, kind: 'created', day: p.day, at: p.at, title: p.title, space: p.space, url: p.url,
            counted: j.counted ? 1 : 0, change: null, owner: j.owner ? 1 : 0, detail: null, reason: j.reason, checked_at: stamp });
        }
      })();
      state.createdAt = stamp;
      report.createdSweep = { pages: pages.length, counted };
    }

    // 2. Pages he contributed to that changed since they were last checked.
    const rows = await searchAll(client, `contributor = currentUser() AND type = page AND lastmodified >= "${floorDay}" ORDER BY lastmodified DESC`, 'content.space,content.version');
    const known = new Map(d.prepare('SELECT page_id, last_modified FROM perf_confluence_pages').all().map((r) => [r.page_id, r.last_modified]));
    const todo = rows.map((r) => ({
      id: String(r.content?.id), title: r.content?.title || r.title, space: r.content?.space?.name || r.resultGlobalContainer?.title || null,
      url: `${client.base}/wiki${r.content?._links?.webui || r.url || ''}`,
      lastModified: r.content?.version?.when || r.lastModified || null,
    })).filter((p) => p.id && (!known.has(p.id) || known.get(p.id) !== p.lastModified));
    report.remaining = Math.max(0, todo.length - PAGES_PER_RUN);
    const createdDay = new Map(d.prepare("SELECT page_id, day FROM perf_confluence_items WHERE kind = 'created'").all().map((r) => [r.page_id, r.day]));
    const have = new Set(d.prepare("SELECT key FROM perf_confluence_items WHERE kind = 'revised'").all().map((r) => r.key));
    const upPage = d.prepare(`INSERT INTO perf_confluence_pages (page_id, last_modified, checked_at, error) VALUES (?, ?, ?, ?)
      ON CONFLICT(page_id) DO UPDATE SET last_modified = excluded.last_modified, checked_at = excluded.checked_at, error = excluded.error`);

    for (const p of todo.slice(0, PAGES_PER_RUN)) {
      try {
        const groups = groupVersions(await versionsSince(client, p.id, floorIso), me, floorIso);
        let unfinished = false;
        for (const g of groups) {
          // Today is not over: its edits are judged tomorrow, as one day's work.
          if (g.day >= today) { unfinished = true; continue; }
          const key = `revised:${p.id}:${g.day}`;
          if (have.has(key)) continue;
          if (createdDay.get(p.id) === g.day) {
            upItem.run({ key, page_id: p.id, kind: 'revised', day: g.day, at: g.at, title: p.title, space: p.space, url: p.url,
              counted: 0, change: null, owner: null, detail: null, reason: 'same day you created it', checked_at: stamp });
            continue;
          }
          const before = await bodyAt(client, p.id, g.first - 1);
          const after = await bodyAt(client, p.id, g.last);
          const change = changeRatio(before, after);
          const owner = OWNER_RE.test(after);
          const j = judgeRevision({ change, owner });
          const pct = Math.round(change * 100);
          const detail = [`${pct}% of the page changed (versions ${g.first - 1} → ${g.last}).`, g.notes.length ? `Your version notes: ${g.notes.slice(0, 5).join('; ')}` : null].filter(Boolean).join(' ');
          upItem.run({ key, page_id: p.id, kind: 'revised', day: g.day, at: g.at, title: p.title, space: p.space, url: p.url,
            counted: j.counted ? 1 : 0, change, owner: owner ? 1 : 0, detail, reason: j.reason, checked_at: stamp });
          report.revisions += 1;
          if (j.counted) report.counted += 1;
        }
        // A page with edits still running today is checked again next pass.
        upPage.run(p.id, unfinished ? null : p.lastModified, stamp, null);
        report.pagesChecked += 1;
      } catch (e) {
        upPage.run(p.id, null, stamp, String(e.message).slice(0, 300));
        report.failed += 1;
      }
    }
    state.lastOk = stamp;
    state.lastError = null;
  } catch (e) {
    report.ok = false;
    report.error = e.message;
    state.lastError = { at: stamp, message: String(e.message).slice(0, 300) };
  }
  state.lastRun = stamp;
  state.last = report;
  writeState(state);
  return report;
}

function status() {
  const d = db();
  const r = d.prepare('SELECT kind, count(*) n, sum(counted) counted FROM perf_confluence_items GROUP BY kind').all();
  return { configured: configured(), ...readState(), items: Object.fromEntries(r.map((x) => [x.kind, { seen: x.n, counted: x.counted || 0 }])) };
}

/** Feed items for a window — the cache only. Unread is a named gap, never []. */
function itemsFor(w) {
  if (!configured()) throw new Error('Confluence not configured (Atlassian login)');
  const s = readState();
  if (!s.lastOk) throw new Error(s.lastError ? `Confluence not read yet: ${s.lastError.message}` : 'Confluence not read yet');
  const rows = db().prepare('SELECT * FROM perf_confluence_items WHERE counted = 1 AND day >= ? AND day <= ? ORDER BY at').all(w.from, w.to);
  return rows.map((r) => ({
    id: `confluence:${r.key}`,
    source: 'confluence',
    kind: r.kind === 'created' ? 'doc-created' : 'doc-revised',
    hint: null,
    at: r.at,
    title: r.kind === 'created'
      ? `Wrote the Confluence page "${r.title}"${r.space ? ` (${r.space})` : ''}`
      : `Revised the Confluence page "${r.title}"${r.space ? ` (${r.space})` : ''}`,
    detail: r.kind === 'created' ? `Created by you${r.owner ? '; names you as Owner' : ''}.` : r.detail,
    ref: r.url,
  }));
}

module.exports = {
  run, status, itemsFor, BATCH_MIN, CHANGE_MIN,
  _internals: { londonDay, textOf, changeRatio, judgeCreated, judgeRevision, groupVersions },
};
