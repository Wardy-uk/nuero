'use strict';

/**
 * Build 5C — add a verified work address to People notes that declare none.
 *
 *   node backend/scripts/enrich-people-emails.js <vaultRoot> [--apply]
 *
 * DRY RUN by default. The list below is NOT inferred here: each address was
 * verified on 3 Oct 2026 against live evidence (verify-emails, read-only on
 * pi5) as the ONLY address ever seen under that exact display name in calendar
 * attendees and inbox senders, seen under no other name, and claimed by no
 * other note. Nothing is derived from a naming convention.
 *
 * Deliberately NOT here: Lucy Read (also sends from the shared
 * tpj.maintenance@ box), Steve Ryan (seen as "Steven Ryan" too), Chris Smith and
 * Nathan Button (Build 4 marked them confirm-by-hand), Nick Ward (identity comes
 * from the signed-in account). Those are Nick's call.
 *
 * The edit is a hand-written line insert, NEVER obsidian.updateFrontmatter,
 * which reserialises and drops YAML list values (aliases:). It refuses a note
 * that already declares an address, preserves the file's line endings, and
 * backs the original up to Scripts/.lint-backups/<ts>/People/.
 */

const fs = require('fs');
const path = require('path');

const VERIFIED = [
  ['Alex Carr', 'alexc@nurtur.tech'],
  ['Andrea Glykofrydis', 'andrea.glykofrydis@nurtur.tech'],
  ['Andrea Melisa', 'andrea.melisa@nurtur.tech'],
  ['Catherine Thorpe', 'catherine.thorpe@nurtur.tech'],
  ['Emma Maciver', 'emma.maciver@nurtur.tech'],
  ['Georgie Guthrie', 'georginag@nurtur.tech'],
  ['Marie Mahoney', 'marie.mahoney@nurtur.tech'],
  ['Paul Adams', 'paul.adams@nurtur.tech'],
  ['Riannah Clegg', 'riannah.clegg@nurtur.tech'],
  ['Richard Combellack', 'richardc@nurtur.tech'],
  ['Simon Greenhalgh', 'simon@nurtur.tech'],
];
const SOURCE = 'Build 5C 2026-10-03: the only address seen under this exact name in calendar attendees and inbox senders; no other note claims it';

/** Insert two frontmatter lines. PURE. Returns { text } or { refused }. */
function insertEmail(text, email) {
  if (!text.startsWith('---')) return { refused: 'no frontmatter' };
  // The FRONTMATTER's own line ending: vault notes are mixed CRLF/LF, and one
  // CRLF line in the body says nothing about the header (Alex Carr's note).
  const nl = text.slice(3, 5) === '\r\n' ? '\r\n' : '\n';
  const end = text.indexOf(`${nl}---`, 3);
  if (end < 0) return { refused: 'frontmatter not closed' };
  const fm = text.slice(0, end);
  if (/^email:\s*\S/m.test(fm) || /^emails:/m.test(fm)) return { refused: 'already declares an address' };
  const add = `${nl}email: ${email}${nl}email-source: "${SOURCE}"`;
  return { text: text.slice(0, end) + add + text.slice(end) };
}

function main() {
  const vault = process.argv[2];
  const apply = process.argv.includes('--apply');
  if (!vault || !fs.existsSync(path.join(vault, 'People'))) { console.error('usage: enrich-people-emails.js <vaultRoot> [--apply]'); process.exit(2); }
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = path.join(vault, 'Scripts', '.lint-backups', ts, 'People');
  let changed = 0;
  for (const [name, email] of VERIFIED) {
    const file = path.join(vault, 'People', `${name}.md`);
    if (!fs.existsSync(file)) { console.log(`skip   ${name}: no note`); continue; }
    const text = fs.readFileSync(file, 'utf8');
    const r = insertEmail(text, email);
    if (r.refused) { console.log(`skip   ${name}: ${r.refused}`); continue; }
    console.log(`${apply ? 'write ' : 'would '} ${name}: email: ${email}`);
    if (apply) {
      fs.mkdirSync(backup, { recursive: true });
      fs.copyFileSync(file, path.join(backup, `${name}.md`));
      fs.writeFileSync(file, r.text);
    }
    changed += 1;
  }
  console.log(`${apply ? 'wrote' : 'would write'} ${changed} note(s)${apply && changed ? `; originals in ${backup}` : ''}`);
}

if (require.main === module) main();
module.exports = { insertEmail, VERIFIED, SOURCE };
