'use strict';

/**
 * The fixes log — fixes that belong in the reports (23 Oct 2026).
 *
 * When a bug in NOVA, VANTAGE, NEURO or an n8n flow is fixed and it had changed
 * a reported figure or touched the team or customers, the fix is a fact the
 * SOAP report and the Weekly Risk report should carry: once as "fixed this
 * week", and — when figures were wrong — as a correction note beside them.
 *
 * ⚠ THE VAULT IS THE MASTER (Nick, 23 Oct 2026). One note per fix under
 * `Projects/Fixes Log/`. NEURO keeps no copy: the page, the API and both
 * reports read the notes every time. Nick can add, edit or include a fix in
 * Obsidian directly — changing `status: proposed` to `status: included` is the
 * same as pressing Include.
 *
 * Nick's design (asked one at a time):
 *   • The SESSION THAT SHIPS THE FIX posts it, at deploy, over MCP
 *     (POST /api/report-fixes). It arrives PROPOSED — an AI session's account
 *     of its own fix never reaches his manager unread.
 *   • Nick can type one himself (page, or POST /api/report-fixes/manual);
 *     because he is the one entering it, it is INCLUDED at once.
 *   • Past figures are FLAGGED, never restated.
 *   • Threshold: visible impact only — a reported figure changed, or the team
 *     or customers were affected. The note states which.
 *
 * The note:
 *
 *   ---
 *   type: report-fix
 *   fix_id: fx-1a2b3c4d5e
 *   system: nova
 *   status: proposed            proposed | included | dismissed
 *   impact: figures, customers
 *   fixed_in: v1.1.740
 *   deployed_on: 2026-10-21
 *   source: session             session | manual
 *   posted_by: machine:claude-code
 *   created: 2026-10-23T10:00:00.000Z
 *   decided:
 *   ---
 *   # <title>
 *
 *   ## What was wrong
 *   <problem>
 *
 *   ## Figures affected
 *   | Figure | From | To |
 *   |---|---|---|
 *   | Tier 2 — FRT compliance | 2026-10-05 | 2026-10-16 |
 *
 * Any other `## ` section Nick adds in Obsidian is kept verbatim on every write.
 *
 * Rules:
 *   • Refused, never repaired: a bad date, an unknown system, figures impact
 *     with no figure. A note whose frontmatter the reader cannot use is
 *     reported as unreadable by name, never silently skipped.
 *   • A re-post of the same fix (system + fixedIn + title → fix_id) FOLDS: a
 *     still-proposed note takes the new wording; one Nick has decided on is
 *     never changed by a machine (`already: true`).
 *   • An unreadable vault is a NAMED GAP in the reports, never "no fixes".
 *   • Dates are wall-clock YYYY-MM-DD strings, never parsed into a Date.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SYSTEMS = Object.freeze(['nova', 'vantage', 'neuro', 'n8n', 'other']);
const SYSTEM_LABEL = Object.freeze({ nova: 'NOVA', vantage: 'VANTAGE', neuro: 'NEURO', n8n: 'n8n', other: 'other' });
const IMPACTS = Object.freeze(['figures', 'team', 'customers']);
const STATUSES = Object.freeze(['proposed', 'included', 'dismissed']);
const MAX_AFFECTS = 10;
const FIXES_DIR = path.join('Projects', 'Fixes Log');
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const SEC_PROBLEM = 'What was wrong';
const SEC_FIGURES = 'Figures affected';

const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
const notFound = () => Object.assign(new Error('no such fix'), { status: 404 });

// ── Validation (PURE) ────────────────────────────────────────────────────────

/** A real calendar date as YYYY-MM-DD, or null. PURE. */
function validDay(s) {
  const m = DAY_RE.exec(String(s || '').trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

const pad = (n) => String(n).padStart(2, '0');
function todayLocal(now = new Date()) { return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`; }

const text = (v, max) => String(v === undefined || v === null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Validate a fix as posted. Returns the clean record; throws 400 on anything it does not understand. */
function validate(input = {}, { now = new Date() } = {}) {
  const system = String(input.system || '').toLowerCase().trim();
  if (!SYSTEMS.includes(system)) throw bad(`system must be one of ${SYSTEMS.join(', ')}`);
  const title = text(input.title, 160);
  if (!title) throw bad('title is required: what was fixed, in one line');
  // A problem keeps its line breaks (it is the body of a note); only trimmed.
  const problem = String(input.problem === undefined || input.problem === null ? '' : input.problem).trim().slice(0, 2000);
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
    const measure = text(a && a.measure, 120).replace(/\|/g, '/');
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
function fixIdFor(f) { return `fx-${crypto.createHash('sha1').update(dedupeKey(f)).digest('hex').slice(0, 10)}`; }

// ── The note (PURE) ──────────────────────────────────────────────────────────

const fmVal = (v) => (v === null || v === undefined ? '' : String(v).replace(/[\r\n]+/g, ' '));

/** Render a fix as its note. `extra` = sections Nick added, kept verbatim. PURE. */
function renderNote(f, extra = '') {
  const fm = [
    '---', 'type: report-fix', `fix_id: ${f.id}`, `system: ${f.system}`, `status: ${f.status}`,
    `impact: ${f.impact.join(', ')}`, `fixed_in: ${fmVal(f.fixedIn)}`, `deployed_on: ${f.deployedOn}`,
    `source: ${f.source}`, `posted_by: ${fmVal(f.postedBy)}`, `created: ${fmVal(f.createdAt)}`, `decided: ${fmVal(f.decidedAt)}`, '---',
  ];
  const body = [`# ${f.title}`, '', `## ${SEC_PROBLEM}`, '', f.problem, ''];
  if (f.affects.length) {
    body.push(`## ${SEC_FIGURES}`, '', '| Figure | From | To |', '|---|---|---|');
    for (const a of f.affects) body.push(`| ${a.measure} | ${a.from} | ${a.to} |`);
    body.push('', '_Flagged in the SOAP and Weekly Risk reports; the figures stand as originally reported._', '');
  }
  const tail = String(extra || '').trim();
  return `${fm.join('\n')}\n${body.join('\n')}${tail ? `\n${tail}\n` : ''}`;
}

/**
 * Read a note back. Returns { fix, extra } or { error } naming what is wrong.
 * Frontmatter is flat `key: value`; the problem and figures come from their
 * sections; every other `## ` section is `extra`. PURE.
 */
function parseNote(content, rel) {
  const src = String(content || '').replace(/\r\n/g, '\n');
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(src);
  // A note that never claimed to be a fix (an _about, a README) is not one; one
  // that says `type: report-fix` but has lost its frontmatter is broken, and named.
  if (!m) return { error: /^type:\s*report-fix\s*$/m.test(src) ? 'frontmatter is not closed with ---' : 'not a report-fix note' };
  const fm = {};
  for (const line of m[1].split('\n')) {
    const kv = /^([A-Za-z_]+):\s*(.*)$/.exec(line);
    if (kv) fm[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  if (fm.type !== 'report-fix') return { error: 'not a report-fix note' };
  const body = m[2];
  const title = (/^#\s+(.+)$/m.exec(body) || [])[1];
  const sections = [];
  let cur = null;
  for (const line of body.split('\n')) {
    const h = /^##\s+(.+?)\s*$/.exec(line);
    if (h) { cur = { name: h[1], lines: [line] }; sections.push(cur); continue; }
    if (cur) cur.lines.push(line);
  }
  const sec = (name) => sections.find((s) => s.name.toLowerCase() === name.toLowerCase());
  const problem = sec(SEC_PROBLEM) ? sec(SEC_PROBLEM).lines.slice(1).join('\n').trim() : '';
  const affects = [];
  const figs = sec(SEC_FIGURES);
  if (figs) {
    for (const line of figs.lines.slice(1)) {
      const cells = /^\|(.+)\|\s*$/.exec(line.trim());
      if (!cells) continue;
      const [measure, from, to] = cells[1].split('|').map((c) => c.trim());
      if (!measure || /^-+$/.test(measure) || measure.toLowerCase() === 'figure') continue;
      affects.push({ measure, from, to });
    }
  }
  const extra = sections.filter((s) => s !== sec(SEC_PROBLEM) && s !== figs).map((s) => s.lines.join('\n').trim()).join('\n\n');
  const impact = String(fm.impact || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  const status = String(fm.status || '').toLowerCase();
  if (!STATUSES.includes(status)) return { error: `status "${fm.status || ''}" is not proposed, included or dismissed` };
  let clean;
  try {
    clean = validate({ system: fm.system, title, problem, impact, affects, fixedIn: fm.fixed_in, deployedOn: fm.deployed_on }, { now: new Date(8640000000000000) });
  } catch (e) { return { error: e.message }; }
  const fix = {
    ...clean, id: fm.fix_id || fixIdFor(clean), status, source: fm.source === 'manual' ? 'manual' : 'session',
    postedBy: fm.posted_by || null, createdAt: fm.created || null, decidedAt: fm.decided || null, path: rel,
    systemLabel: SYSTEM_LABEL[clean.system] || clean.system,
  };
  return { fix, extra };
}

/** A filename for a new note: date, system, title. PURE. */
function fileNameFor(f) {
  const safeTitle = f.title.replace(/[\\/:*?"<>|#^[\]]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80);
  return `${f.deployedOn} ${SYSTEM_LABEL[f.system] || f.system} - ${safeTitle} (${f.id}).md`;
}

// ── The vault (I/O) ──────────────────────────────────────────────────────────

function _vault() {
  const v = process.env.OBSIDIAN_VAULT_PATH || '';
  if (!v) return { ok: false, why: 'OBSIDIAN_VAULT_PATH is not set' };
  if (!path.isAbsolute(v)) return { ok: false, why: 'OBSIDIAN_VAULT_PATH is not an absolute path' };
  try { if (!fs.statSync(v).isDirectory()) return { ok: false, why: 'the vault path is not a folder' }; } catch { return { ok: false, why: 'the vault could not be read' }; }
  return { ok: true, root: v, dir: path.join(v, FIXES_DIR) };
}

/**
 * Every note in the fixes log. `known: false` = the vault could not be read
 * (never the same as "no fixes"); `unreadable` names notes that could not be
 * used, so a note Nick mis-edited is visible rather than silently dropped.
 */
function readAll() {
  const v = _vault();
  if (!v.ok) return { known: false, why: v.why, fixes: [], unreadable: [] };
  let names;
  try { names = fs.readdirSync(v.dir); } catch (e) {
    if (e.code === 'ENOENT') return { known: true, fixes: [], unreadable: [] };
    return { known: false, why: `the fixes log folder could not be read (${e.code || e.message})`, fixes: [], unreadable: [] };
  }
  const fixes = []; const unreadable = [];
  const seen = new Map();
  for (const n of names.filter((x) => x.toLowerCase().endsWith('.md')).sort()) {
    const rel = path.join(FIXES_DIR, n).replace(/\\/g, '/');
    let content;
    try { content = fs.readFileSync(path.join(v.dir, n), 'utf-8'); } catch (e) { unreadable.push({ path: rel, why: `could not be read (${e.code || e.message})` }); continue; }
    const r = parseNote(content, rel);
    if (r.error) { if (r.error !== 'not a report-fix note') unreadable.push({ path: rel, why: r.error }); continue; }
    if (seen.has(r.fix.id)) { unreadable.push({ path: rel, why: `same fix_id as ${seen.get(r.fix.id)}` }); continue; }
    seen.set(r.fix.id, rel);
    fixes.push({ ...r.fix, extra: r.extra });
  }
  fixes.sort((a, b) => b.deployedOn.localeCompare(a.deployedOn) || a.id.localeCompare(b.id));
  return { known: true, fixes, unreadable };
}

const strip = ({ extra, ...f }) => f; // eslint-disable-line no-unused-vars

function _find(id) {
  const all = readAll();
  if (!all.known) throw Object.assign(new Error(`the fixes log could not be read: ${all.why}`), { status: 503 });
  return all.fixes.find((f) => f.id === String(id)) || null;
}

function _write(fix, extra, { previousPath = null } = {}) {
  const v = _vault();
  if (!v.ok) throw Object.assign(new Error(`the fixes log could not be written: ${v.why}`), { status: 503 });
  fs.mkdirSync(v.dir, { recursive: true });
  const rel = previousPath || path.join(FIXES_DIR, fileNameFor(fix)).replace(/\\/g, '/');
  const abs = path.join(v.root, rel);
  fs.writeFileSync(abs, renderNote(fix, extra), 'utf-8');
  try { require('./vault-hooks').onVaultWrite(abs, 'report-fixes'); } catch { /* indexing is not worth failing a write for */ }
  return rel;
}

function get(id) {
  const f = _find(id);
  return f ? strip(f) : null;
}

/** The log as the page and the API show it. Never throws. */
function list({ status = null } = {}) {
  if (status && !STATUSES.includes(status)) throw bad(`status must be one of ${STATUSES.join(', ')}`);
  const all = readAll();
  return {
    known: all.known, why: all.why || null, folder: FIXES_DIR.replace(/\\/g, '/'),
    fixes: all.fixes.filter((f) => !status || f.status === status).map(strip),
    unreadable: all.unreadable,
  };
}

/**
 * Store a fix as a note. `manual` = Nick typed it, so it is included at once;
 * otherwise a proposal. A re-post of the same fix folds (see header).
 */
function post(input, { manual = false, postedBy = 'nick', now = new Date() } = {}) {
  const f = validate(input, { now });
  const id = fixIdFor(f);
  const existing = _find(id);
  const stamp = new Date(now).toISOString();
  if (existing) {
    // Nick's decision stands against a machine re-post; a manual entry of the
    // same fix is Nick saying it again, so it takes his wording and includes it.
    if (existing.status !== 'proposed' && !manual) return { fix: strip(existing), created: false, already: true };
    const next = { ...existing, ...f, id, status: manual ? 'included' : 'proposed', decidedAt: manual ? stamp : existing.decidedAt };
    const rel = _write(next, existing.extra, { previousPath: existing.path });
    return { fix: strip({ ...next, path: rel }), created: false, already: false };
  }
  const fix = {
    ...f, id, status: manual ? 'included' : 'proposed', source: manual ? 'manual' : 'session',
    postedBy: String(postedBy || 'unknown').slice(0, 60), createdAt: stamp, decidedAt: manual ? stamp : null,
    systemLabel: SYSTEM_LABEL[f.system] || f.system,
  };
  const rel = _write(fix, '');
  return { fix: { ...fix, path: rel }, created: true, already: false };
}

/** Nick's decision on a fix: include it in the reports, leave it out, or put it back to proposed. */
function decide(id, decision, { now = new Date() } = {}) {
  const map = { include: 'included', dismiss: 'dismissed', restore: 'proposed' };
  if (!map[decision]) throw bad('decision must be include, dismiss or restore');
  const cur = _find(id);
  if (!cur) throw notFound();
  const next = { ...cur, status: map[decision], decidedAt: decision === 'restore' ? null : new Date(now).toISOString() };
  _write(next, cur.extra, { previousPath: cur.path });
  return strip(next);
}

/** Nick edits the wording or dates. Omitted fields are kept; re-validated whole; status unchanged. */
function edit(id, patch = {}, { now = new Date() } = {}) {
  const cur = _find(id);
  if (!cur) throw notFound();
  const merged = { ...cur };
  for (const k of ['system', 'title', 'problem', 'impact', 'affects', 'fixedIn', 'deployedOn']) if (patch[k] !== undefined) merged[k] = patch[k];
  const f = validate(merged, { now });
  // The id stays the note's identity even if its title changes; a different
  // existing fix with the new identity is a clash, refused.
  const newId = fixIdFor(f);
  if (newId !== cur.id && _find(newId)) throw Object.assign(new Error('another fix already has that system, version and title'), { status: 409 });
  const next = { ...cur, ...f, systemLabel: SYSTEM_LABEL[f.system] || f.system };
  _write(next, cur.extra, { previousPath: cur.path });
  return strip(next);
}

// ── Which fixes a report carries (PURE) ──────────────────────────────────────

/**
 * For a report covering `from`..`to` (and showing figures back to `shownFrom`,
 * normally the week before), from the INCLUDED fixes only:
 *   • fixed — deployed within the report's week.
 *   • corrections — fixes that changed figures, deployed by the report's end,
 *     either in its week or touching any figure the report shows.
 *   • rowNotes — figure name (lowercased) → correction numbers, for marking
 *     table rows. EXACT name match, case-insensitive.
 *   • unreadable — why the log could not be read, or null.
 */
function forReport(log, { from, to, shownFrom = null }) {
  const fixes = Array.isArray(log) ? log : (log && log.fixes) || [];
  const unreadable = Array.isArray(log) || !log || log.known !== false ? null : (log.why || 'the fixes log could not be read');
  const lo = shownFrom || from;
  const inc = fixes.filter((f) => f && f.status === 'included' && f.deployedOn <= to);
  const fixed = inc.filter((f) => f.deployedOn >= from);
  const corrections = [];
  for (const f of inc) {
    if (!f.impact.includes('figures')) continue;
    const thisWeek = f.deployedOn >= from;
    const touches = f.affects.filter((a) => a.from <= to && a.to >= lo);
    if (thisWeek || touches.length) corrections.push({ ...f, touches: thisWeek ? f.affects : touches });
  }
  corrections.sort((a, b) => a.deployedOn.localeCompare(b.deployedOn) || String(a.id).localeCompare(String(b.id)));
  const rowNotes = {};
  corrections.forEach((c, i) => {
    for (const a of c.touches) {
      const k = a.measure.toLowerCase();
      rowNotes[k] = rowNotes[k] || [];
      if (!rowNotes[k].includes(i + 1)) rowNotes[k].push(i + 1);
    }
  });
  return { fixed, corrections, rowNotes, unreadable };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const short = (d) => `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]}`;
const span = (a) => (a.from === a.to ? short(a.from) : `${short(a.from)}–${short(a.to)}`);
const where = (f) => `${f.systemLabel}${f.fixedIn ? ` ${f.fixedIn}` : ''}`;
const oneLine = (s) => String(s).replace(/\s+/g, ' ').trim();

/** The "fixed this week" line. PURE. */
function fixedLine(f) { return `Fixed: ${f.title} — ${oneLine(f.problem)} (${where(f)}, ${short(f.deployedOn)})`; }

/** A correction note: which figures, which dates, and that they stand as reported. PURE. */
function correctionLine(c, n) {
  const figs = c.touches.map((a) => `${a.measure} (${span(a)})`).join('; ');
  return `${n !== undefined ? `[${n}] ` : ''}${figs} — affected by: ${oneLine(c.problem)} Fixed in ${where(c)} on ${short(c.deployedOn)}. Figures for those dates are shown as originally reported.`;
}

/** A table row label with its correction marks, e.g. "Tier 2 FRT [1]". PURE. */
function markLabel(label, rowNotes) {
  const n = rowNotes && rowNotes[String(label || '').toLowerCase()];
  return n && n.length ? `${label} [${n.join(',')}]` : label;
}

/** The log, for a report's I/O layer. Never throws: an unreadable log is reported, never fatal. */
function logForReports() {
  try { return readAll(); } catch (e) { return { known: false, why: e.message, fixes: [], unreadable: [] }; }
}

module.exports = {
  SYSTEMS, IMPACTS, STATUSES, MAX_AFFECTS, FIXES_DIR,
  validDay, validate, dedupeKey, fixIdFor, renderNote, parseNote, fileNameFor,
  readAll, post, decide, edit, get, list,
  forReport, fixedLine, correctionLine, markLabel, logForReports,
};
