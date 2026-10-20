'use strict';

// PURE. No requires: safe to load from a render test without touching the database.

const REGISTER_ID = /^[A-Z]{1,5}\d+[a-z]?\s*[—–-]\s*/;

/**
 * PURE. The draft as an ARTEFACT the screen can lay out as a document fragment:
 * its title (register id removed), its cited sections, the decisions table
 * with every unagreed cell marked open, and its open questions. Citations are
 * reduced to a count and a mark — the paths stay in the folded proof.
 * Built from the real draft only; null when the draft has no heading.
 */
const CITE = /\s*_from [^_]+_\s*$/;
function artefactFrom(markdown) {
  const md = String(markdown || '');
  const h1 = /^#\s+(.+)$/m.exec(md);
  if (!h1) return null;
  const title = h1[1].replace(/\s*\(DRAFT prepared by SAiM\)\s*$/i, '').replace(REGISTER_ID, '').trim();
  const sections = [];
  let decisions = null;
  const openQuestions = [];
  let cur = null;
  let cited = 0;
  for (const raw of md.split('\n')) {
    const l = raw.trim();
    if (/^##\s+/.test(l)) {
      const heading = l.replace(/^##\s+/, '');
      cur = { heading, kind: /open questions/i.test(heading) ? 'questions' : 'list', items: [] };
      if (cur.kind === 'list') sections.push(cur);
      continue;
    }
    if (!cur) continue;
    const row = /^\|(.+)\|\s*$/.exec(l);
    if (row) {
      const cells = row[1].split('|').map((c) => c.trim());
      if (cells.every((c) => /^:?-+:?$/.test(c))) continue;
      if (!decisions || decisions.heading !== cur.heading) {
        decisions = { heading: cur.heading, columns: cells, rows: [] };
        const i = sections.indexOf(cur); if (i >= 0) sections.splice(i, 1);
        continue;
      }
      const [who, ...rest] = cells;
      decisions.rows.push({ who, cells: rest.map((c) => ({ text: /_to agree_/.test(c) ? null : c.replace(/_/g, ''), open: /_to agree_/.test(c) })) });
      continue;
    }
    // A citation on its own line vouches for the section above it.
    if (/^_from [^_]+_$/.test(l)) { cited += 1; cur.cited = (cur.cited || 0) + 1; continue; }
    const b = /^-\s+(.+)$/.exec(l);
    if (b) {
      const isCited = CITE.test(b[1]);
      if (isCited) cited += 1;
      const text = b[1].replace(CITE, '').trim();
      if (cur.kind === 'questions') { if (!/_\(none found/.test(text)) openQuestions.push(text); continue; }
      if (/^_\(.+\)_$/.test(text)) { cur.items.push({ text: text.replace(/^_\(|\)_$/g, ''), cited: false, gap: true }); continue; }
      cur.items.push({ text, cited: isCited });
    }
  }
  // Two counts, never conflated: the ROWS still to agree (7 teams) and the
  // open CELLS (14 acceptance and rejection criteria). A row is not "a decision".
  const openCount = decisions ? decisions.rows.filter((r) => r.cells.some((c) => c.open)).length : 0;
  const openCells = decisions ? decisions.rows.reduce((n, r) => n + r.cells.filter((c) => c.open).length, 0) : 0;
  // The nouns are the table's own words, so nothing here knows what a draft holds.
  const head = decisions && /^[A-Za-z]+$/.test(decisions.columns[0] || '') ? decisions.columns[0].toLowerCase() : null;
  const rowNoun = (n) => (head ? (n === 1 ? head : `${head}s`) : (n === 1 ? 'row' : 'rows'));
  const kinds = decisions ? decisions.columns.slice(1).map((c) => (/^accept/i.test(c) ? 'acceptance' : /^reject/i.test(c) ? 'rejection' : null)) : [];
  const cellNoun = kinds.length && kinds.every(Boolean) ? `${[...new Set(kinds)].join(' and ')} ${openCells === 1 ? 'criterion' : 'criteria'}` : (openCells === 1 ? 'open cell' : 'open cells');
  const openLabel = openCount ? `${openCount} ${rowNoun(openCount)} still ${openCount === 1 ? 'needs' : 'need'} agreement` : null;
  const openCellsLabel = openCells ? `${openCells} ${cellNoun} ${openCells === 1 ? 'remains' : 'remain'} open` : null;
  return { title, sections: sections.filter((x) => x.items.length), decisions, openQuestions, cited, openCount, openLabel, openCells, openCellsLabel };
}

/**
 * PURE. The Surface's state when a move is ACTIONABLE and nothing outranks it:
 * what SAiM has made ready, named by the day of the meeting it serves ("I’ve
 * made Wednesday ready."). From the packet's own forum date — SLICED, never
 * parsed into a local Date. null without a forum: the move's own headline then
 * stands, and the quiet state is still never used for it.
 */
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
function momentFor(forum) {
  const d = forum && /^\d{4}-\d\d-\d\d/.test(String(forum.start || '')) ? String(forum.start).slice(0, 10) : null;
  if (!d) return null;
  const [y, m, day] = d.split('-').map(Number);
  const name = DAY_NAMES[new Date(Date.UTC(y, m - 1, day, 12)).getUTCDay()];
  return { headline: `I’ve made ${name} ready.` };
}

module.exports = { artefactFrom, momentFor };
