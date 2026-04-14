#!/usr/bin/env node
'use strict';

/**
 * Smoke test for Tier 1 services against the real vault.
 * Run with: OBSIDIAN_VAULT_PATH="..." node scripts/test-tier1.js
 */

process.env.OBSIDIAN_VAULT_PATH = process.env.OBSIDIAN_VAULT_PATH ||
  'C:\\Users\\NickW\\Documents\\Nicks knowledge base';

const path = require('path');
const devPlan = require('../services/development-plan');
const actionItems = require('../services/action-items');
const meetingNote = require('../services/meeting-note');
const prep = require('../services/one-to-one-prep');

const PERSON = 'Heidi Power';

function section(title) {
  console.log('\n' + '='.repeat(60));
  console.log(title);
  console.log('='.repeat(60));
}

async function run() {
  console.log('Vault:', process.env.OBSIDIAN_VAULT_PATH);

  section('1. readPlan(Heidi Power)');
  const plan = devPlan.readPlan(PERSON);
  console.log(JSON.stringify(plan, null, 2).substring(0, 1500));

  section('2. findActionItems(Heidi Power, open)');
  const actions = actionItems.findActionItems({ person: PERSON, status: 'open', daysBack: 90 });
  console.log(`Found ${actions.length} open actions`);
  for (const a of actions.slice(0, 5)) {
    console.log(`- ${a.text.substring(0, 80)} | assignee=${a.assignee || '-'} due=${a.dueDate || '-'} file=${a.file}`);
  }

  section('3. generatePrep(Heidi Power) — should REFUSE overwrite');
  const refuse = await prep.generatePrep({ person: PERSON });
  console.log(JSON.stringify(refuse, null, 2));

  section('4. generatePrep(Heidi Power, force=true) — dry run via different filename');
  // Use tomorrow's date so we don't actually clobber today's real n8n file
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowISO = tomorrow.toISOString().slice(0, 10);
  const genResult = await prep.generatePrep({ person: PERSON, date: tomorrowISO });
  console.log(JSON.stringify(genResult, null, 2));
  console.log('\n--- Prep file preview ---');
  const fs = require('fs');
  if (genResult.status === 'created') {
    const full = path.join(process.env.OBSIDIAN_VAULT_PATH, genResult.path);
    const content = fs.readFileSync(full, 'utf-8');
    console.log(content.substring(0, 2000));
    // Clean up the test file
    fs.unlinkSync(full);
    console.log(`\n[cleanup] Deleted ${genResult.path}`);
  }

  section('5. manageMeetingNote(create) — dry run');
  const testTitle = `NEURO Smoke Test ${Date.now()}`;
  const createResult = meetingNote.manageMeetingNote({
    action: 'create',
    title: testTitle,
    type: '1-1',
    people: [PERSON],
  });
  console.log(JSON.stringify(createResult, null, 2));
  if (createResult.status === 'created') {
    const full = path.join(process.env.OBSIDIAN_VAULT_PATH, createResult.path);
    fs.unlinkSync(full);
    console.log(`[cleanup] Deleted ${createResult.path}`);
  }

  section('6. readPlan → updateProgress (dry run on a real goal)');
  if (plan.status === 'ok' && plan.goals.length) {
    const g = plan.goals[0];
    console.log(`Would update Goal ${g.number}: "${g.title}" — progress entries before: ${g.progress.length}`);
    // NOT actually writing — just demonstrating parse worked
  }

  section('DONE');
}

run().catch(e => { console.error('FAIL:', e); process.exit(1); });
