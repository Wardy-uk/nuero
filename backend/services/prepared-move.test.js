'use strict';

/**
 * prepared-move: SAiM works one real commitment up before asking.
 * Pure screens and composer, then the real prepare() over a scratch DB and a
 * scratch vault — everything real except production's decision, which is
 * injected (the live decision path is exercised by scripts/prepared-move-demo.js
 * against a Pi snapshot). Fixtures are dated off the wall clock.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prepared-move-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'agent.db');
process.env.OBSIDIAN_VAULT_PATH = path.join(tmp, 'vault');
process.env.NEURO_TIMEZONE = 'Europe/London';
for (const k of ['HA_TOKEN', 'HA_URL', 'PROMISE_SHADOW_ENABLED', 'NOVA_AGENT_ID']) delete process.env[k];

const db = require('../db/database');
const pm = require('./prepared-move');

const V = process.env.OBSIDIAN_VAULT_PATH;
const put = (rel, text) => { fs.mkdirSync(path.dirname(path.join(V, rel)), { recursive: true }); fs.writeFileSync(path.join(V, rel), text); };
const DAY = 86400000;
const ymd = (ms) => new Date(ms).toLocaleString('sv-SE', { timeZone: 'Europe/London' }).slice(0, 10);
const NOW = Date.now();
const DUE = ymd(NOW - 3 * DAY);
const FORUM = ymd(NOW + 3 * DAY);
const roster = { full: ['Nick Ward', 'Melanie Ellis', 'Alex Example'], firstNames: new Map(), aliases: new Map() };

const HR_NOTE = [
  '# Weekly meeting',
  '- Alex Example on sick leave for six weeks; fit note received.',
  '- Alex Example submitted a flexible working request.',
  '### Hybrid incentive',
  '- Consider a hybrid incentive tied to achievable targets.',
  '- [ ] Define achievable targets for the hybrid incentive',
].join('\n');

function seedVault() {
  put('People/Nick Ward.md', '---\nemail: nickw@example.test\n---\n# Nick Ward\n');
  put('People/Melanie Ellis.md', '---\nemail: melanie.ellis@example.test\n---\n# Melanie Ellis\n');
  put('People/Alex Example.md', '---\nemail: alex@example.test\n---\n# Alex Example\n');
  put('Tasks/Microsoft Tasks.md', `# Microsoft Tasks\n\n## Planner\n\n### Widget Plan\n- [ ] Written criteria for what each team accepts 📅 ${DUE} <!--id:PLANNER-ID-1-->\n\n## ToDo\n`);
  put('Projects/Widget Plan/WP - Action Register.md', [
    '# WP - Action Register', '',
    '| ID | Action | Source | Owner | Planner status | Due | Notes | Planner ID |',
    '|---|---|---|---|---|---|---|---|',
    '| T1 | Publish triage and escalation acceptance criteria for every team, with rejections stating what is missing | Review: 30-day | Nick, Mel Ellis | Added | 02/10 | Added 23/09 | PLANNER-ID-1 |',
  ].join('\n'));
  put('Projects/Widget Plan/WP - Review.md', [
    '# Review',
    '| Define and publish clear triage and escalation criteria for Team Alpha, Team Beta and Team Gamma. | Leads | Fewer bounces |',
    '| Introduce a simple rule that every escalation must show the current customer ask, blocker and named owner. | Leads | Clearer |',
    '- Stop teams returning tickets without stating exactly what is missing.',
  ].join('\n'));
  put('Meetings/2026/09/2026-09-01 – Weekly Meeting.md', HR_NOTE);
}

function seedDb({ calendarAgeMin = 10 } = {}) {
  const fetched = new Date(NOW - calendarAgeMin * 60000).toISOString().replace('T', ' ').slice(0, 19);
  db.run(`DELETE FROM calendar_cache`);
  db.run(`INSERT INTO calendar_cache (event_id, subject, start_time, end_time, is_all_day, show_as, fetched_at, attendees_other, source, is_organizer) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ['ev-forum', 'Widget Plan', `${FORUM}T16:00:00`, `${FORUM}T16:30:00`, 0, 'tentative', fetched, 1, 'graph', 0]);
  db.run(`DELETE FROM tasks WHERE id = 9`);
  db.run(`INSERT INTO tasks (id, text, status, due_date, source, origin_path, dedupe_key, domain, created_at, updated_at) VALUES (9, ?, 'open', ?, 'meeting-promotion', ?, ?, 'work', datetime('now'), datetime('now'))`,
    ['Define achievable targets for the hybrid incentive', DUE, 'Meetings/2026/09/2026-09-01 – Weekly Meeting.md', 'define achievable targets for the hybrid incentive']);
  db.run(`DELETE FROM wm_meetings`); db.run(`DELETE FROM wm_meeting_participants`);
  const at = new Date(NOW).toISOString();
  db.run(`INSERT INTO wm_meetings (meeting_id, provider, provider_event_id, title, start_local, end_local, status, organizer_email, response_status, kind, provenance_kind, observed_at, received_at, evidence_json, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ['graph:forum', 'graph', 'forum', 'Widget Plan', `${FORUM}T16:00`, `${FORUM}T16:30`, 'scheduled', 'melanie.ellis@example.test', 'notResponded', 'meeting', 'observed', at, at, '{}', at]);
  db.run(`INSERT INTO wm_meeting_participants (meeting_id, email, name, response) VALUES (?,?,?,?)`, ['graph:forum', 'melanie.ellis@example.test', 'Melanie Ellis', 'none']);
  db.run(`INSERT INTO wm_meeting_participants (meeting_id, email, name, response) VALUES (?,?,?,?)`, ['graph:forum', 'nickw@example.test', 'Nick Ward', 'none']);
}

const TODO = { id: 'todo-overdue-summary', type: 'todo', title: 'Written criteria for what each team accepts', reason: 'Marked high priority · 3 days overdue' };
const CAPACITY = { id: 'capacity-start-9', type: 'capacity', title: 'Not enough time before task 9 is due', meta: { taskId: 9 } };
const decisionOf = (lead, held, pool) => async () => ({
  nowView: { saim: { lead, held, decidedAt: new Date(NOW).toISOString(), policyVersion: 'test' }, candidates: { constraints: { workingWindow: { todayIsWorking: true } } }, gaps: [] },
  pool, gaps: [],
});

let fetchCalls = 0;
test.before(async () => {
  await db.init();
  seedVault();
  global.fetch = async () => { fetchCalls += 1; throw new Error('no network in tests'); };
});
test.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp */ } });

const tableCounts = () => Object.fromEntries(db.all(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`).map(({ name }) => [name, db.all(`SELECT COUNT(*) n FROM "${name}"`)[0].n]));

// ── Pure ─────────────────────────────────────────────────────────────────────

test('employment screen: a note discussing named people\'s employment marks anything from it, without repeating it', () => {
  const s = pm.employmentScreen({ sourceText: HR_NOTE, roster });
  assert.deepEqual(s, { sensitive: true, categories: ['employee-cases-note'] });
  assert.equal(pm.employmentScreen({ sourceText: '- Alex Example will demo the portal.\n- Ship the portal.', roster }).sensitive, false, 'an operational note naming a person is not an employment matter');
  assert.deepEqual(pm.employmentScreen({ wording: 'Confirm the end date and notice period' }).categories, ['hr-wording']);
  assert.deepEqual(pm.employmentScreen({ kind: 'weekly_risk' }).categories, ['pip-deliverable']);
});

test('freshness: an unreadable or over-age source withholds; within limits passes', () => {
  const ok = pm.freshnessScreen([{ kind: 'calendar', ref: 'c', observedAt: new Date(NOW - 30 * 60000).toISOString() }], NOW);
  assert.equal(ok.ok, true);
  const stale = pm.freshnessScreen([{ kind: 'calendar', ref: 'c', observedAt: new Date(NOW - 5 * 3600000).toISOString() }], NOW);
  assert.equal(stale.ok, false);
  assert.equal(pm.freshnessScreen([{ kind: 'availability', ref: 'a', observedAt: null }], NOW).ok, false, 'unknown age is never fresh');
});

test('draft: every section is built from a cited line; nothing it cannot find is filled in', () => {
  const lines = [
    { path: 'R.md', line: 3, text: '| Introduce a simple rule that every escalation must show the current customer ask, blocker and named owner. | x |' },
    { path: 'R.md', line: 2, text: '| Define and publish clear triage and escalation criteria for Team Alpha, Team Beta and Team Gamma. | x |' },
  ];
  const d = pm.draftFromEvidence({ action: 'Publish criteria', registerRef: { id: 'T1', path: 'Reg.md', line: 5, source: 'Review' }, lines, consolidation: null });
  assert.deepEqual(d.fields, ['current customer ask', 'blocker', 'named owner']);
  assert.deepEqual(d.teams, ['Team Alpha', 'Team Beta', 'Team Gamma']);
  assert.ok(d.markdown.includes('_from R.md:3_') && d.markdown.includes('_Team list from R.md:2_'));
  assert.equal(/fixed list/.test(d.markdown), false, 'no "reason from a fixed list" without evidence that rejections are free text today');
  const empty = pm.draftFromEvidence({ action: 'Publish criteria', registerRef: { id: 'T1', path: 'Reg.md', line: 5, source: 'Review' }, lines: [], consolidation: null });
  assert.deepEqual(empty.gaps, ['the minimum fields an escalation must carry', 'which teams receive escalations']);
});

test('production order: the lead, then what it held — an attention-item lead resolves to its pool item', () => {
  const order = pm.productionOrder({ lead: { ref: 'item:capacity-start-9', kind: 'attention-item', rule: 'S7 top item' }, held: [{ ref: 'held:todo-overdue-summary' }] }, [TODO, CAPACITY]);
  assert.deepEqual(order.map((o) => [o.role, o.item && o.item.id]), [['lead', 'capacity-start-9'], ['held', 'todo-overdue-summary']]);
});

test('production order: outside a meeting the decision names attention RECORDS — tied back by their dedupe key', () => {
  const lc = require('./attention-lifecycle');
  const order = pm.productionOrder(
    { lead: { ref: 'item:att_x_1', kind: 'attention-item', rule: 'S2 critical risk' }, held: [{ ref: 'item:att_x_2' }, { ref: 'item:att_gone' }] },
    [TODO, CAPACITY],
    { att_x_1: lc.dedupeKeyFor(CAPACITY), att_x_2: lc.dedupeKeyFor(TODO) },
  );
  assert.deepEqual(order.map((o) => o.item && o.item.id), ['capacity-start-9', 'todo-overdue-summary', null], 'an unknown record resolves to nothing, never a guess');
});

// ── Real prepare() over a scratch DB and vault ───────────────────────────────

test('trustworthy: the held Planner card is worked up into a full packet; the employment item ahead of it is withheld by category only', async () => {
  seedDb();
  const before = tableCounts();
  const out = await pm.prepare({ now: NOW, deps: { readDecision: decisionOf({ ref: 'item:capacity-start-9', kind: 'attention-item', rule: 'S7 top item', title: 'capacity' }, [{ ref: 'held:todo-overdue-summary', title: 'todo' }], [TODO, CAPACITY]) } });

  assert.equal(out.contract, 'prepared-move-v1');
  const w = out.withheld.find((x) => x.ref === 'item:capacity-start-9');
  assert.equal(w.reason, 'employment-route');
  assert.deepEqual(w.categories, ['employee-cases-note']);
  const json = JSON.stringify(out);
  assert.equal(json.includes('hybrid incentive'), false, 'the employment item\'s wording is never repeated');
  assert.equal(/sick leave|fit note|flexible working/i.test(json), false, 'nothing from the HR note is quoted anywhere');

  const s = out.selected;
  assert.ok(s, `a packet was prepared: ${JSON.stringify(out.withheld)}`);
  assert.deepEqual(s.record, { system: 'planner', msId: 'PLANNER-ID-1', plan: 'Widget Plan' });
  for (const k of ['observed', 'judgement', 'outcome', 'preparation', 'decision', 'authority', 'verification']) assert.ok(s[k], `contract has ${k}`);
  assert.ok(s.observed.every((o) => o.source && o.source.kind && o.source.ref && o.kind === 'observation'), 'every observation carries its source and is marked an observation');
  assert.ok(s.observed.some((o) => /T1 in the Widget Plan action register/.test(o.fact)), 'the register row is found by the Planner id');
  assert.ok(s.observed.some((o) => /"Widget Plan" is on .* organised by Melanie Ellis/.test(o.fact)), 'the forum is the project\'s own meeting, organised by the co-owner');
  assert.equal(s.judgement.kind, 'inference');
  assert.ok(s.judgement.because.some((b) => /"Mel Ellis" is taken to be Melanie Ellis.*\(inference\)/.test(b)), 'a nickname resolution is said as an inference');
  assert.equal(s.outcome.stated, false);
  assert.ok(/You never wrote this goal down/.test(s.outcome.basis));
  assert.ok(s.preparation.every((p) => /^none/.test(p.sideEffect)), 'everything prepared has no side effect');
  const draft = s.preparation.find((p) => p.draft).draft;
  assert.ok(draft.includes('| Team Alpha |') && draft.includes('- Current customer ask'));
  assert.match(s.decision.ask, /^Book .+ to finish this draft before Widget Plan/);
  assert.equal(s.decision.smallest, 'one yes');
  assert.ok(s.authority.mustNot.some((m) => /Email, message or invite/.test(m)));
  assert.ok(s.authority.needsApproval.every((a) => /no attendees|vault note/.test(a)), 'only a solo block and a vault note are ever proposed');
  assert.ok(s.verification.checks.length >= 3);

  assert.equal(fetchCalls, 0, 'no network call was made');
  assert.deepEqual(tableCounts(), before, 'nothing in the database changed');
});

test('stale: a calendar that has not synced for hours withholds the candidate and names the source', async () => {
  seedDb({ calendarAgeMin: 300 });
  const out = await pm.prepare({ now: NOW, deps: { readDecision: decisionOf({ ref: 'item:todo-overdue-summary', kind: 'attention-item', rule: 'S7 top item' }, [], [TODO]) } });
  assert.equal(out.selected, null);
  const w = out.withheld.find((x) => x.ref === 'item:todo-overdue-summary');
  assert.equal(w.reason, 'stale');
  assert.ok(w.missing.some((m) => /calendar_cache \(5h old, limit 2h\)/.test(m)), JSON.stringify(w.missing));
  assert.ok(out.noneBecause);
});

test('ambiguous: two records with the same words are never guessed between', async () => {
  seedDb();
  const mirror = fs.readFileSync(path.join(V, 'Tasks/Microsoft Tasks.md'), 'utf8');
  put('Tasks/Microsoft Tasks.md', mirror.replace('\n## ToDo', `- [ ] Written criteria for what each team accepts 📅 ${DUE} <!--id:PLANNER-ID-2-->\n\n## ToDo`));
  try {
    const out = await pm.prepare({ now: NOW, deps: { readDecision: decisionOf({ ref: 'item:todo-overdue-summary', kind: 'attention-item', rule: 'S7 top item' }, [], [TODO]) } });
    assert.equal(out.selected, null);
    assert.equal(out.withheld[0].reason, 'ambiguous');
  } finally { put('Tasks/Microsoft Tasks.md', mirror); }
});

test('nothing trustworthy: a meeting lead and nothing held is said plainly, never filled', async () => {
  seedDb();
  const out = await pm.prepare({ now: NOW, deps: { readDecision: decisionOf({ ref: 'meeting:13:00:Wedding anniversary', kind: 'meeting', rule: 'S3 meeting', title: 'Wedding anniversary' }, [], []) } });
  assert.equal(out.selected, null);
  assert.equal(out.withheld[0].reason, 'not-a-commitment');
  assert.ok(out.findings.some((f) => /personal phone-calendar entry/.test(f)));
});

test('the faster employment screen gives the SAME verdict as the original name-first rule', () => {
  const ledger = require('./promise-ledger');
  const pm = require('./prepared-move');
  const roster = { full: ['Hope Goodall', 'Melanie Ellis', 'Abdi Musa'], firstNames: new Map([['hope', 'Hope Goodall'], ['melanie', 'Melanie Ellis'], ['abdi', 'Abdi Musa']]) };
  // The rule as it was: names first, then the topic test, count every line.
  const naive = (text) => {
    let n = 0;
    for (const raw of String(text).split('\n')) {
      if (!raw.trim()) continue;
      const named = ledger.namesIn(raw, roster);
      if (!named.people.length && !named.ambiguous.length) continue;
      if (ledger.CONTEXT_PATTERNS.some((re) => re.test(raw))) n += 1;
    }
    return n >= 2;
  };
  const lines = ['Hope Goodall is off sick this week', 'Melanie Ellis returns from maternity leave', 'Abdi Musa owns the T1 criteria', 'the team agreed the escalation fields',
    'Hope Goodall has a fit note until Friday', 'flexible working request from Melanie Ellis', 'Absence review with Abdi Musa', 'SLA breach on Tier 2', 'Hope Goodall', '',
    // The two case-SENSITIVE patterns: "HR" and "RTW" count, "hr" and "rtw" do not.
    'HR call with Hope Goodall', 'an hr chat with Melanie Ellis', 'RTW meeting for Abdi Musa', 'rtw notes on Abdi Musa'];
  // Every pair and triple of lines, in order — sensitive and not.
  let checked = 0; let sensitive = 0;
  for (let a = 0; a < lines.length; a++) for (let b = 0; b < lines.length; b++) for (let c = 0; c < lines.length; c += 3) {
    const text = [lines[a], lines[b], lines[c]].join('\n');
    const got = pm.employmentScreen({ sourceText: text, roster }).categories.includes('employee-cases-note');
    assert.equal(got, naive(text), text);
    checked += 1; if (got) sensitive += 1;
  }
  assert.ok(sensitive > 0 && sensitive < checked, `both verdicts exercised (${sensitive}/${checked})`);
});

test('the in-memory note index never serves an old version of a note — any edit is re-read', () => {
  const pm = require('./prepared-move');
  const rel = 'Projects/Index Probe/probe.md';
  const abs = path.join(process.env.OBSIDIAN_VAULT_PATH, ...rel.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, 'first version of the note');
  assert.equal(pm._test.makeCorpus().read(rel), 'first version of the note');
  fs.writeFileSync(abs, 'second, longer version of the note');
  assert.equal(pm._test.makeCorpus().read(rel), 'second, longer version of the note', 'a size change is re-read');
  fs.writeFileSync(abs, 'third, longer version of the note'); // same size
  const t = new Date(Date.now() + 5000); fs.utimesSync(abs, t, t);
  assert.equal(pm._test.makeCorpus().read(rel), 'third, longer version of the note', 'a same-size edit is re-read by its time');
  fs.rmSync(path.dirname(abs), { recursive: true });
  const c = pm._test.makeCorpus(); c.files();
  assert.equal(pm._test.noteIndex.has(rel), false, 'a deleted note is forgotten');
  assert.equal(c.read(rel), null);
});

test('the startup warm-up fills the in-memory note index and writes nothing', async () => {
  const pm = require('./prepared-move');
  const dir = path.join(process.env.OBSIDIAN_VAULT_PATH, 'Projects', 'Warm Probe');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'a.md'), 'escalation criteria for every team');
  const dbRows = () => JSON.stringify(db.all("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").map((t) => [t.name, db.get(`SELECT COUNT(*) n FROM "${t.name}"`).n]));
  const before = dbRows();
  const vaultBefore = fs.readdirSync(dir).map((f) => [f, fs.statSync(path.join(dir, f)).mtimeMs]);
  const [r1, r2] = await Promise.all([pm.warmEvidenceIndex({ roster: { full: [] } }), pm.warmEvidenceIndex({ roster: { full: [] } })]);
  assert.equal(r1, r2, 'a second call joins the first');
  assert.ok(r1.notes >= 1);
  assert.ok(pm._test.noteIndex.has('Projects/Warm Probe/a.md'), 'the note is indexed');
  assert.ok(pm._test.noteIndex.get('Projects/Warm Probe/a.md').toks, 'and tokenised ahead of the first read');
  assert.equal(dbRows(), before, 'no database row changed');
  assert.deepEqual(fs.readdirSync(dir).map((f) => [f, fs.statSync(path.join(dir, f)).mtimeMs]), vaultBefore, 'no vault file changed');
  fs.rmSync(dir, { recursive: true });
});

test('the packet carries whether he is on duty, from the life read — off duty or unread holds it for the next working morning', async () => {
  seedDb();
  const lead = { ref: 'item:todo-overdue-summary', kind: 'attention-item', rule: 'S7 top item' };
  const withLife = (life) => async (ms) => { const d = await decisionOf(lead, [], [TODO])(ms); d.nowView.life = life; return d; };
  const off = await pm.prepare({ now: NOW, deps: { readDecision: withLife({ showWork: false, doing: 'relaxing' }) } });
  assert.ok(off.selected, 'it is still prepared');
  assert.deepEqual(off.duty, { onDuty: false, why: 'off-duty' });
  assert.equal(off.selected.presentAt, 'your next working morning');
  const on = await pm.prepare({ now: NOW, deps: { readDecision: withLife({ showWork: true, doing: 'working' }) } });
  assert.deepEqual(on.duty, { onDuty: true, why: 'working' });
  assert.equal(on.selected.presentAt, 'now');
  const unread = await pm.prepare({ now: NOW, deps: { readDecision: decisionOf(lead, [], [TODO]) } });
  assert.deepEqual(unread.duty, { onDuty: false, why: 'unknown' }, 'no life read fails closed');
});
