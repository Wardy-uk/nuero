'use strict';

/**
 * Fixes that belong in the reports (23 Oct 2026).
 *
 * When a bug in NOVA, VANTAGE, NEURO or an n8n flow is fixed and it had changed
 * a reported figure or touched the team or customers, the fix is a fact the
 * SOAP report and the Weekly Risk report should carry: once as "fixed this
 * week", and — when figures were wrong — as a correction note beside them.
 *
 * Nick's design (23 Oct 2026, asked one at a time):
 *   • The SESSION THAT SHIPS THE FIX posts it, at deploy, over MCP
 *     (POST /api/report-fixes). It arrives PROPOSED — an AI session's account
 *     of its own fix never reaches his manager unread.
 *   • Nick can also type one himself (POST /api/report-fixes/manual). Because
 *     he is the one entering it, it is INCLUDED at once.
 *   • Past figures are FLAGGED, never restated: the numbers Chris already
 *     received stay as they were; the report says which were affected.
 *   • Threshold: post only a fix with visible impact — it changed a reported
 *     figure, or it affected the team or customers. The record states which.
 *
 * Include / edit / dismiss / restore are Nick's (machine-refused in the
 * authority matrix, interactive in the MCP gateway).
 *
 * Rules:
 *   • Refused, never repaired: a bad date, an unknown system, an impact of
 *     "figures" with no affected figure, more than MAX_AFFECTS entries.
 *   • A re-post of the same fix (system + fixedIn + title) FOLDS: a still
 *     proposed record takes the new wording; one Nick has decided on is never
 *     changed by a machine (`already: true`).
 *   • Dates are wall-clock YYYY-MM-DD strings, compared as strings, never
 *     parsed into a Date.
 *
 * Lazily creates its table on the first write; reads never create it.
 */

const SYSTEMS = Object.freeze(['nova', 'vantage', 'neuro', 'n8n', 'other']);
const SYSTEM_LABEL = Object.freeze({ nova: 'NOVA', vantage: 'VANTAGE', neuro: 'NEURO', n8n: 'n8n', other: 'other' });
const IMPACTS = Object.freeze(['figures', 'team', 'customers']);
const STATUSES = Object.freeze(['proposed', 'included', 'dismissed']);
const MAX_AFFECTS = 10;
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function _db() { return require('../db/database'); }

function _ensure() {
  _db().run(`CREATE TABLE IF NOT EXISTS report_fixes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dedupe_key TEXT NOT NULL UNIQUE,
    system TEXT NOT NULL,
    title TEXT NOT NULL,
    problem TEXT NOT NULL,
    impact_json TEXT NOT NULL,
    affects_json TEXT NOT NULL DEFAULT '[]',
    fixed_in TEXT,
    deployed_on TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('proposed','included','dismissed')),
    source TEXT NOT NULL CHECK (source IN ('session','manual')),
    posted_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    decided_at TEXT
  )`);
  _db().run('CREATE INDEX IF NOT EXISTS idx_report_fixes_deployed ON report_fixes(deployed_on)');
}

function _exists() {
  try { return !!_db().get("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'report_fixes'"); } catch { return false; }
}

const bad = (msg) => Object.assign(new Error(msg), { status: 400 });

/** A real calendar date as YYYY-MM-DD, or null. PURE. */
function validDay(s) {
  const m = DAY_RE.exec(String(s || ''));
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d ? String(s) : null;
}

const pad = (n) => String(n).padStart(2, '0');
function todayLocal(now = new Date()) { return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`; }
function addDays(day, n) {
  const [y, m, d] = day.split('-').map(Number);
  const dt = new Date(y, m - 1, d + n);
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
}

const text = (v, max) => String(v === undefined || v === null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Validate a fix as posted. Returns the clean record; throws 400 on anything it
 * does not understand. PURE (apart from `now`).
 */
function validate(input = {}, { now = new Date() } = {}) {
  const system = String(input.system || '').toLowerCase().trim();
  if (!SYSTEMS.includes(system)) throw bad(`system must be one of ${SYSTEMS.join(', ')}`);
  const title = text(input.title, 160);
  if (!title) throw bad('title is required: what was fixed, in one line');
  const problem = text(input.problem, 1000);
  if (!problem) throw bad('problem is required: what was wrong and who or what it affected');
  const deployedOn = validDay(input.deployedOn);
  if (!deployedOn) throw bad('deployedOn must be a real date, YYYY-MM-DD');
  if (deployedOn > todayLocal(now)) throw bad('deployedOn is in the future — post the fix once it is deployed');
  if (!Array.isArray(input.impact) || !input.impact.length) throw bad(`impact is required: one or more of ${IMPACTS.join(', ')}`);
  const impact = [...new Set(input.impact.map((x) => String(x).toLowerCase().trim()))];
  const unknownImpact = impact.filter((x) => !IMPACTS.includes(x));
  if (unknownImpact.length) throw bad(`unknown impact: ${unknownImpact.join(', ')} (allowed: ${IMPACTS.join(', ')})`);
  const rawAffects = input.affects === undefined || input.affects === null ? [] : input.affects;
  if (!Array.isArray(rawAffects)) throw bad('affects must be a list of { measure, from, to }');
  if (rawAffects.length > MAX_AFFECTS) throw bad(`at most ${MAX_AFFECTS} affected figures`);
  const affects = rawAffects.map((a, i) => {
    const measure = text(a && a.measure, 120);
    if (!measure) throw bad(`affects[${i}].measure is required: the figure as the report names it`);
    const from = validDay(a.from);
    const to = validDay(a.to);
    if (!from || !to) throw bad(`affects[${i}] needs from and to as real dates, YYYY-MM-DD`);
    if (from > to) throw bad(`affects[${i}]: from is after to`);
    return { measure, from, to };
  });
  if (impact.includes('figures') && !affects.length) throw bad('impact includes "figures" — say which figures in affects');
  if (!impact.includes('figures') && affects.length) throw bad('affects lists figures — add "figures" to impact');
  const fixedIn = text(input.fixedIn, 80) || null;
  return { system, title, problem, impact, affects, fixedIn, deployedOn };
}

function dedupeKey(f) { return `${f.system}|${norm(f.fixedIn)}|${norm(f.title)}`; }

function _shape(r) {
  if (!r) return null;
  let impact = []; let affects = [];
  try { impact = JSON.parse(r.impact_json); } catch { /* keep [] */ }
  try { affects = JSON.parse(r.affects_json); } catch { /* keep [] */ }
  return {
    id: r.id, system: r.system, systemLabel: SYSTEM_LABEL[r.system] || r.system, title: r.title, problem: r.problem,
    impact, affects, fixedIn: r.fixed_in || null, deployedOn: r.deployed_on, status: r.status, source: r.source,
    postedBy: r.posted_by, createdAt: r.created_at, updatedAt: r.updated_at, decidedAt: r.decided_at || null,
  };
}

function get(id) {
  if (!_exists()) return null;
  return _shape(_db().get('SELECT * FROM report_fixes WHERE id = ?', [Number(id)]));
}

/** All fixes, newest deploy first. Optional status filter. Reads never create the table. */
function list({ status = null, limit = 200 } = {}) {
  if (!_exists()) return [];
  if (status && !STATUSES.includes(status)) throw bad(`status must be one of ${STATUSES.join(', ')}`);
  const rows = status
    ? _db().all('SELECT * FROM report_fixes WHERE status = ? ORDER BY deployed_on DESC, id DESC LIMIT ?', [status, limit])
    : _db().all('SELECT * FROM report_fixes ORDER BY deployed_on DESC, id DESC LIMIT ?', [limit]);
  return rows.map(_shape);
}

/**
 * Store a fix. `manual` = Nick typed it, so it is included at once; otherwise
 * it is a proposal. A re-post of the same fix folds (see header).
 */
function post(input, { manual = false, postedBy = 'nick', now = new Date() } = {}) {
  const f = validate(input, { now });
  _ensure();
  const key = dedupeKey(f);
  const existing = _db().get('SELECT * FROM report_fixes WHERE dedupe_key = ?', [key]);
  const cols = [f.system, f.title, f.problem, JSON.stringify(f.impact), JSON.stringify(f.affects), f.fixedIn, f.deployedOn];
  if (existing) {
    // Nick's decision stands against a machine re-post; a manual entry of the
    // same fix is Nick saying it again, so it takes his wording and includes it.
    if (existing.status !== 'proposed' && !manual) return { fix: _shape(existing), created: false, already: true };
    _db().run(`UPDATE report_fixes SET system = ?, title = ?, problem = ?, impact_json = ?, affects_json = ?, fixed_in = ?, deployed_on = ?,
               status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')${manual ? ", decided_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')" : ''}
               WHERE id = ?`, [...cols, manual ? 'included' : 'proposed', existing.id]);
    return { fix: get(existing.id), created: false, already: false };
  }
  const info = _db().run(`INSERT INTO report_fixes (dedupe_key, system, title, problem, impact_json, affects_json, fixed_in, deployed_on, status, source, posted_by, decided_at)
                          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${manual ? "strftime('%Y-%m-%dT%H:%M:%fZ','now')" : 'NULL'})`,
  [key, ...cols, manual ? 'included' : 'proposed', manual ? 'manual' : 'session', String(postedBy || 'unknown').slice(0, 60)]);
  return { fix: get(info.lastInsertRowid), created: true, already: false };
}

/** Nick's decision on a fix: include it in the reports, leave it out, or put it back to proposed. */
function decide(id, decision) {
  const map = { include: 'included', dismiss: 'dismissed', restore: 'proposed' };
  if (!map[decision]) throw bad('decision must be include, dismiss or restore');
  const cur = get(id);
  if (!cur) throw Object.assign(new Error('no such fix'), { status: 404 });
  _db().run(`UPDATE report_fixes SET status = ?, decided_at = ${decision === 'restore' ? 'NULL' : "strftime('%Y-%m-%dT%H:%M:%fZ','now')"},
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`, [map[decision], cur.id]);
  return get(cur.id);
}

/**
 * Nick edits the wording or dates. Omitted fields are left as they are; the
 * result is re-validated whole. Editing does not change the status.
 */
function edit(id, patch = {}, { now = new Date() } = {}) {
  const cur = get(id);
  if (!cur) throw Object.assign(new Error('no such fix'), { status: 404 });
  const merged = { ...cur };
  for (const k of ['system', 'title', 'problem', 'impact', 'affects', 'fixedIn', 'deployedOn']) if (patch[k] !== undefined) merged[k] = patch[k];
  const f = validate(merged, { now });
  const key = dedupeKey(f);
  const clash = _db().get('SELECT id FROM report_fixes WHERE dedupe_key = ? AND id != ?', [key, cur.id]);
  if (clash) throw Object.assign(new Error(`another fix already has that system, version and title (#${clash.id})`), { status: 409 });
  _db().run(`UPDATE report_fixes SET dedupe_key = ?, system = ?, title = ?, problem = ?, impact_json = ?, affects_json = ?, fixed_in = ?, deployed_on = ?,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
  [key, f.system, f.title, f.problem, JSON.stringify(f.impact), JSON.stringify(f.affects), f.fixedIn, f.deployedOn, cur.id]);
  return get(cur.id);
}

// ── Which fixes a report carries (PURE) ──────────────────────────────────────

/**
 * For a report covering `from`..`to` (and showing figures back to `shownFrom`,
 * normally the week before), from the INCLUDED fixes only:
 *   • fixed — deployed within the report's week.
 *   • corrections — fixes that changed figures, deployed by the report's end,
 *     either deployed in its week (the first report after the fix says so) or
 *     whose affected dates overlap any figure the report shows.
 *   • rowNotes — measure name (lowercased) → the correction note numbers that
 *     touch it, for marking table rows. Matched by EXACT name, case-insensitive:
 *     a near match is not evidence a row was affected.
 */
function forReport(fixes, { from, to, shownFrom = null }) {
  const lo = shownFrom || from;
  const inc = (fixes || []).filter((f) => f && f.status === 'included' && f.deployedOn <= to);
  const fixed = inc.filter((f) => f.deployedOn >= from);
  const corrections = [];
  for (const f of inc) {
    if (!f.impact.includes('figures')) continue;
    const thisWeek = f.deployedOn >= from;
    const touches = f.affects.filter((a) => a.from <= to && a.to >= lo);
    if (thisWeek || touches.length) corrections.push({ ...f, touches: thisWeek ? f.affects : touches });
  }
  corrections.sort((a, b) => a.deployedOn.localeCompare(b.deployedOn) || a.id - b.id);
  const rowNotes = {};
  corrections.forEach((c, i) => {
    for (const a of c.touches) {
      const k = a.measure.toLowerCase();
      rowNotes[k] = rowNotes[k] || [];
      if (!rowNotes[k].includes(i + 1)) rowNotes[k].push(i + 1);
    }
  });
  return { fixed, corrections, rowNotes };
}

/** "1 Sep" from YYYY-MM-DD, sliced, never parsed. PURE. */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const short = (d) => `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]}`;
const span = (a) => (a.from === a.to ? short(a.from) : `${short(a.from)}–${short(a.to)}`);
const where = (f) => `${f.systemLabel}${f.fixedIn ? ` ${f.fixedIn}` : ''}`;

/** The "fixed this week" line. PURE. */
function fixedLine(f) { return `Fixed: ${f.title} — ${f.problem} (${where(f)}, ${short(f.deployedOn)})`; }

/** A correction note: which figures, which dates, and that they stand as reported. PURE. */
function correctionLine(c, n) {
  const figs = c.touches.map((a) => `${a.measure} (${span(a)})`).join('; ');
  return `${n !== undefined ? `[${n}] ` : ''}${figs} — affected by: ${c.problem} Fixed in ${where(c)} on ${short(c.deployedOn)}. Figures for those dates are shown as originally reported.`;
}

/** A table row label with its correction marks, e.g. "Tier 2 FRT [1]". PURE. */
function markLabel(label, rowNotes) {
  const n = rowNotes && rowNotes[String(label || '').toLowerCase()];
  return n && n.length ? `${label} [${n.join(',')}]` : label;
}

/** The included fixes, for a report's I/O layer. Never throws: a store problem must not stop a report. */
function includedForReports() {
  try { return list({ status: 'included', limit: 500 }); } catch (e) {
    console.warn('[report-fixes] could not read fixes:', e.message);
    return [];
  }
}

module.exports = {
  SYSTEMS, IMPACTS, STATUSES, MAX_AFFECTS,
  validDay, validate, dedupeKey, post, decide, edit, get, list,
  forReport, fixedLine, correctionLine, markLabel, includedForReports, addDays,
};
