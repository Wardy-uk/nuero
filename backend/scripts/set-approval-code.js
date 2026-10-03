#!/usr/bin/env node
'use strict';

/**
 * Set (or replace) Nick's approval code — the human half of approving an A4
 * action in NEURO (Build 7E, services/approval-proof.js).
 *
 *   ssh to pi5, then:
 *     export PATH=/home/nickw/.nvm/versions/node/v22.22.2/bin:$PATH
 *     cd /mnt/data/nuero/backend && node scripts/set-approval-code.js
 *
 * ⚠ This script is the ONLY way to set the code, on purpose: there is no route
 * for it, because anything holding the PIN can call a route. It reads the code
 * from the terminal with echo off and never from an argument (arguments land
 * in shell history and the process list). Only an scrypt hash is stored. The
 * running backend reads it at approval time — no restart needed.
 *
 * ⚠ Do not let an assistant run this for you or type the code into a chat: a
 * code an agent has seen is a code an agent can use.
 */

const readline = require('readline');

function ask(question, { hidden = true } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      // Echo nothing while the code is typed.
      rl._writeToOutput = (s) => { if (s.includes(question)) rl.output.write(question); };
    }
    rl.question(question, (answer) => { rl.close(); if (hidden) process.stdout.write('\n'); resolve(answer); });
  });
}

(async () => {
  if (!process.stdin.isTTY) {
    console.error('Run this in an interactive terminal on the Pi — the code is never read from a pipe or an argument.');
    process.exit(2);
  }
  const db = require('../db/database');
  await db.init();
  const proof = require('../services/approval-proof');
  const status = proof.codeStatus();
  let current = null;
  if (status.set) {
    console.log(`An approval code is already set (since ${status.setAt}). Replacing it needs the current one.`);
    current = await ask('Current approval code: ');
  }
  const code = await ask(`New approval code (at least ${proof.MIN_CODE_LENGTH} characters): `);
  const again = await ask('Type it again: ');
  if (code !== again) { console.error('The two did not match — nothing changed.'); process.exit(1); }
  const r = proof.setCode(code, { currentCode: current, by: 'pi-shell' });
  if (!r.ok) { console.error(`Not set: ${r.error}`); process.exit(1); }
  console.log(`${r.replaced ? 'Replaced' : 'Set'} at ${r.setAt}. NEURO will ask for it each time you approve something that acts as you.`);
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
