'use strict';

/**
 * SANDBOX targets for a prepared move (19 Oct 2026) — TESTS ONLY; nothing in
 * NEURO's routes can reach it. A calendar that is a JSON file and a vault
 * that is a directory, both inside one disposable folder that carries a
 * `.saim-sandbox` marker. Nothing here talks to Microsoft, the Pi or Nick's
 * real vault — and the constructor REFUSES a folder that is, or sits inside,
 * the real vault.
 *
 * Faults can be armed for one call (`fail-next`, `apply-then-throw`,
 * `mangle-next`) so partial outcomes and read-back failures can be shown and
 * tested; they exist only here.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MARKER = '.saim-sandbox';

const inside = (child, parent) => {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

function createSandbox(root, { seed = [], realVault = process.env.OBSIDIAN_VAULT_PATH || null } = {}) {
  if (!root) throw new Error('sandbox: a folder is required');
  if (realVault && (inside(root, realVault) || inside(realVault, root))) throw new Error('sandbox: refusing a folder that is or contains the real vault');
  fs.mkdirSync(path.join(root, 'vault'), { recursive: true });
  fs.writeFileSync(path.join(root, MARKER), `disposable SAiM sandbox created ${new Date().toISOString()}\n`);
  const calFile = path.join(root, 'calendar.json');
  if (!fs.existsSync(calFile)) fs.writeFileSync(calFile, '[]');
  // Read-only COPIES of real files the tracker needs (e.g. the Planner mirror).
  for (const { from, to } of seed) {
    const dest = path.join(root, 'vault', to);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(from, dest);
  }
  const faults = { calendar: null, vault: null };
  const guard = () => { if (!fs.existsSync(path.join(root, MARKER))) throw new Error('sandbox: marker missing — refusing to write'); };
  const take = (k) => { const f = faults[k]; faults[k] = null; return f; };

  const calendar = {
    _all() { return JSON.parse(fs.readFileSync(calFile, 'utf8')); },
    _save(rows) { guard(); fs.writeFileSync(calFile, JSON.stringify(rows, null, 2)); },
    async findByMarker(marker) { return this._all().find((e) => e.marker === marker) || null; },
    async get(id) { return this._all().find((e) => e.id === id) || null; },
    async create(ev) {
      const f = take('calendar');
      if (f === 'fail-next') throw new Error('HTTP 400 sandbox calendar refused the event');
      const rows = this._all();
      const row = { id: `sbx-evt-${crypto.randomBytes(6).toString('hex')}`, title: f === 'mangle-next' ? `${ev.title} (changed by server)` : ev.title, date: ev.date, start: ev.start, end: ev.end, attendees: [...(ev.attendees || [])], body: ev.body, marker: ev.marker, createdAt: new Date().toISOString() };
      rows.push(row); this._save(rows);
      if (f === 'apply-then-throw') throw new Error('timeout waiting for the sandbox calendar');
      return row;
    },
  };

  const vaultRoot = path.join(root, 'vault');
  const abs = (rel) => {
    const p = path.resolve(vaultRoot, rel);
    if (!inside(p, vaultRoot)) throw new Error('HTTP 400 path escapes the sandbox vault');
    return p;
  };
  const vault = {
    root: vaultRoot,
    async exists(rel) { return fs.existsSync(abs(rel)); },
    async read(rel) { try { return fs.readFileSync(abs(rel), 'utf8'); } catch { return null; } },
    async writeNew(rel, content) {
      guard();
      const f = take('vault');
      if (f === 'fail-next') throw new Error('HTTP 423 sandbox vault is locked');
      const p = abs(rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, f === 'mangle-next' ? `${content}\n(changed)` : content, { flag: 'wx' }); // never an overwrite
      if (f === 'apply-then-throw') throw new Error('timeout waiting for the sandbox vault');
      return { path: rel };
    },
  };

  return { kind: 'sandbox', root, calendar, vault, faults, marker: MARKER };
}

module.exports = { createSandbox, MARKER };
