#!/usr/bin/env node
// Seed `employment-status: Permanent` into the frontmatter of every People note
// listed in TEAMS, unless one is already set. Run on the Pi where the vault lives.
//
// Usage: node backend/scripts/seed-employment-status.js [--dry-run]

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');

const VAULT_PATH = process.env.OBSIDIAN_VAULT_PATH || '';
if (!VAULT_PATH) {
  console.error('OBSIDIAN_VAULT_PATH is not set');
  process.exit(1);
}

const TEAMS = {
  '2nd Line Technical Support': [
    'Abdi Mohamed', 'Arman Shazad', 'Luke Scaife', 'Stephen Mitchell',
    'Willem Kruger', 'Nathan Rutland',
  ],
  '1st Line Customer Care': [
    'Adele Norman-Swift', 'Heidi Power', 'Hope Goodall', 'Maria Pappa',
    'Naomi Wentworth', 'Sebastian Broome', 'Zoe Rees',
  ],
  'Digital Design': ['Isabel Busk', 'Kayleigh Russell'],
};

const DRY = process.argv.includes('--dry-run');
const DEFAULT_STATUS = 'Permanent';

let added = 0, already = 0, missing = 0;

for (const team of Object.values(TEAMS)) {
  for (const name of team) {
    const notePath = path.join(VAULT_PATH, 'People', `${name}.md`);
    if (!fs.existsSync(notePath)) {
      console.warn(`MISSING: ${name}.md`);
      missing++;
      continue;
    }
    let content = fs.readFileSync(notePath, 'utf-8');

    if (!content.startsWith('---')) {
      content = `---\n---\n` + content;
    }
    const endIdx = content.indexOf('---', 3);
    if (endIdx === -1) {
      console.warn(`BAD FRONTMATTER: ${name}.md`);
      continue;
    }
    const fm = content.substring(0, endIdx + 3);
    if (/employment-status:/.test(fm)) {
      already++;
      continue;
    }
    const newFm = fm.replace(/---\s*$/, `employment-status: ${DEFAULT_STATUS}\n---`);
    const next = newFm + content.substring(endIdx + 3);
    if (DRY) {
      console.log(`WOULD WRITE: ${name}`);
    } else {
      fs.writeFileSync(notePath, next, 'utf-8');
      console.log(`SET ${DEFAULT_STATUS}: ${name}`);
    }
    added++;
  }
}

console.log(`\nDone. added=${added} already=${already} missing=${missing}${DRY ? ' (dry-run)' : ''}`);
