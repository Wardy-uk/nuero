#!/usr/bin/env node
'use strict';

/**
 * One-off repair: quote frontmatter values that are invalid YAML because they contain
 * ": " (or another plain-scalar breaker). `imports.updateFrontmatter` wrote values raw
 * until 23 Oct 2026, so Plaud notes carrying the router's reason —
 *   plaud_route_reason: Deterministic PLAUD routing: identified a ...
 * — had NO frontmatter as far as Obsidian/Dataview were concerned.
 *
 * Touches only the offending top-level lines, nothing else in the file. Dry run by
 * default; --apply backs every touched file up under
 * Scripts/.lint-backups/frontmatter-colons-<stamp>/ before writing.
 *
 *   node backend/scripts/repair-frontmatter-colons.js --vault=/mnt/data/nuero-vault [--apply]
 *   [--keys=plaud_route_reason,review-reason]   limit to these keys (default: every key)
 *
 * Run it on the CANONICAL vault (the Pi); Obsidian Sync carries the change to Windows.
 */

const fs = require('fs');
const path = require('path');
const { yamlValue } = require('../services/imports');

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] === undefined ? true : m[2]] : [a, true];
}));
const vault = args.vault || process.env.OBSIDIAN_VAULT_PATH;
if (!vault || !path.isAbsolute(vault) || !fs.existsSync(vault)) {
  console.error('Give --vault=<absolute path to the vault>');
  process.exit(2);
}
const apply = !!args.apply;
const onlyKeys = args.keys ? new Set(String(args.keys).split(',')) : null;
const SKIP_DIRS = new Set(['.obsidian', '.trash', '.stversions', '.git', 'node_modules']);
const SKIP_PREFIX = ['Scripts/.lint-backups'];

function* walk(dir, rel = '') {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || SKIP_PREFIX.some((p) => r.startsWith(p))) continue;
      yield* walk(path.join(dir, e.name), r);
    } else if (e.name.endsWith('.md')) {
      yield [path.join(dir, e.name), r];
    }
  }
}

// Returns the repaired text and what changed, or null.
function repair(text) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(eol);
  if (lines[0] !== '---') return null;
  const end = lines.indexOf('---', 1);
  if (end === -1) return null;
  const changes = [];
  for (let i = 1; i < end; i++) {
    const m = lines[i].match(/^([A-Za-z_][\w-]*):(\s+)(.+)$/);
    if (!m) continue;
    const [, key, , value] = m;
    if (onlyKeys && !onlyKeys.has(key)) continue;
    const fixed = yamlValue(value);
    if (fixed !== value) {
      changes.push(key);
      lines[i] = `${key}: ${fixed}`;
    }
  }
  return changes.length ? { text: lines.join(eol), changes } : null;
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupRoot = path.join(vault, 'Scripts', '.lint-backups', `frontmatter-colons-${stamp}`);
const byKey = {};
const byFolder = {};
let files = 0;
const touched = [];
for (const [full, rel] of walk(vault)) {
  let text;
  try { text = fs.readFileSync(full, 'utf-8'); } catch { continue; }
  const r = repair(text);
  if (!r) continue;
  files++;
  touched.push(rel);
  for (const k of r.changes) byKey[k] = (byKey[k] || 0) + 1;
  const top = rel.split('/')[0];
  byFolder[top] = (byFolder[top] || 0) + 1;
  if (apply) {
    const bak = path.join(backupRoot, rel);
    fs.mkdirSync(path.dirname(bak), { recursive: true });
    fs.copyFileSync(full, bak);
    fs.writeFileSync(full, r.text, 'utf-8');
  }
}

console.log(`${apply ? 'APPLIED' : 'DRY RUN'} — ${files} file(s) with unquoted unsafe frontmatter values`);
console.log('by key:', JSON.stringify(byKey, null, 1));
console.log('by top folder:', JSON.stringify(byFolder, null, 1));
if (args.list) touched.forEach((t) => console.log('  ' + t));
if (apply && files) console.log(`backups: ${backupRoot}`);
