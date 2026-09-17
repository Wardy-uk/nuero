'use strict';

/**
 * Recording a ritual that happened somewhere else.
 *
 * On 17 Sep 2026 Sara ran Nick's full morning standup in ChatGPT and saved it
 * with the generic note capture, because that was the only write she could find.
 * It landed in `Imports/2026-09-17-08-10-39-Morning-Stand-up-17-September-2026.md`
 * — correct prose, in a folder the ritual system does not read — and NEURO went
 * on reporting NO STANDUP all morning. The evening before went the same way into
 * `Reflections/`.
 *
 * Nothing was broken. `standupDoneIn` wants a real item under `## Focus Today`
 * (or a `## Standup` heading) in `Daily/<date>.md`, and it correctly found
 * neither: the day's note existed but held only the `## SAiM Actions` the alert
 * logger had written. The ritual had no door.
 *
 * (!) THE FIX IS NOT A SECOND FORMAT. `recordExternal` is `finish()` with the
 * conversation removed — the same session shape, the SAME `_renderDailyNote` /
 * `_renderEodSection`, the same completion markers. That is the only thing that
 * makes every existing reader recognise it without being taught a new source,
 * and it is what these tests pin.
 *
 * The merge half is PURE, so it pins without a vault.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const VAULT = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-ritual-'));
fs.mkdirSync(path.join(VAULT, 'Daily'), { recursive: true });
process.env.OBSIDIAN_VAULT_PATH = VAULT;

const session = require('./standup-session');
const { mergeRitual, recordExternal, _renderDailyNote } = session;
const { standupDoneIn, parseDailyNote } = require('./standup-accountability');

// The 17 Sep note as it actually stood: created by the alert logger, with no
// ritual content anywhere in it.
const LOGGED_ONLY = `

## SAiM Actions
- 09:00 — Meeting prep: "Maintenance Tickets Group" in 15 min

- 09:45 — "Team Standup" starts in 15 min — prep now
`;

const STANDUP = `---
type: daily
date: 2026-09-17
week: 2026-W38
---
# Daily Note — Thursday, 17 September 2026

## Focus Today
- [ ] Protect the green #focus
- [ ] Record the podcast #focus

## Carry-Overs
- None

## Blockers
- Nothing pressing
`;

const EOD = `
## EOD

**Done:**
- Recorded the podcast
**Didn't go to plan:** Nothing
**Tomorrow starts with:** The inbox
`;

// ── The merge ───────────────────────────────────────────────────────────────

test('THE REPORTED BUG: the ritual lands and the logged alerts survive', () => {
  const merged = mergeRitual(LOGGED_ONLY, STANDUP);
  assert.equal(standupDoneIn(merged), true, 'the detector must now agree');
  // (!) The positive half. `writeTodayDailyNote(render)` would also satisfy the
  // detector — by destroying the morning's alerts on the way.
  assert.match(merged, /## SAiM Actions/);
  assert.match(merged, /Maintenance Tickets Group/);
  assert.match(merged, /Team Standup/);
});

test('the ritual sits at the TOP; the log stays below it', () => {
  const merged = mergeRitual(LOGGED_ONLY, STANDUP);
  assert.ok(merged.indexOf('## Focus Today') < merged.indexOf('## SAiM Actions'));
});

test('recording twice leaves one of each section', () => {
  const once = mergeRitual(LOGGED_ONLY, STANDUP);
  const twice = mergeRitual(once, STANDUP);
  assert.equal(twice, once, 'idempotent');
  assert.equal(twice.match(/^## Focus Today$/gm).length, 1);
  assert.equal(twice.match(/^## SAiM Actions$/gm).length, 1);
});

test('a changed standup REPLACES the old one rather than stacking', () => {
  const first = mergeRitual(LOGGED_ONLY, STANDUP);
  const second = mergeRitual(first, STANDUP.replace('Protect the green', 'Protect the amber'));
  assert.match(second, /Protect the amber/);
  assert.doesNotMatch(second, /Protect the green/);
  assert.equal(second.match(/^## Focus Today$/gm).length, 1);
});

test('the EOD block appends at the END and is idempotent', () => {
  const morning = mergeRitual(LOGGED_ONLY, STANDUP);
  const evening = mergeRitual(morning, EOD);
  assert.match(evening, /^## EOD$/m);
  assert.ok(evening.indexOf('## EOD') > evening.indexOf('## SAiM Actions'),
    'the evening describes a day the log already recorded');
  assert.equal(mergeRitual(evening, EOD), evening);
  assert.equal(parseDailyNote(evening).eodDone, true);
  // Still a standup — the evening must not cost the morning.
  assert.equal(standupDoneIn(evening), true);
});

test("⚠ the evening's Decided cannot eat the morning's", () => {
  // The renderers emit `## Decided` on BOTH sides. A name-anywhere match would
  // find the morning's copy first and overwrite four closed commitments with the
  // evening's one. The forward scan is what prevents it.
  const morning = mergeRitual(LOGGED_ONLY, STANDUP.replace(
    '## Blockers',
    '## Decided\n- ~~Chase the Guild backlog~~ (already done)\n\n## Blockers',
  ));
  const evening = mergeRitual(morning, `${EOD}\n## Decided\n- ~~Book the Naomi 1-2-1~~ (already done)\n`);
  assert.match(evening, /Chase the Guild backlog/, "the morning's decisions survive");
  assert.match(evening, /Book the Naomi 1-2-1/);
  assert.equal(evening.match(/^## Decided$/gm).length, 2);
  const decided = parseDailyNote(evening).decided.map(d => d.text);
  assert.equal(decided.length, 2, 'and both are still parsed back');
});

test('an empty note takes the rendered ritual whole, byte for byte', () => {
  // The merge must not quietly reformat what `_renderDailyNote` produces, or the
  // claim that this writes NEURO's own format stops being true.
  for (const empty of ['', null, undefined, '\n\n']) {
    assert.equal(mergeRitual(empty, STANDUP), STANDUP, JSON.stringify(empty));
  }
});

test("existing frontmatter and title WIN — they are the note's identity", () => {
  const owned = '---\ntype: daily\ndate: 2026-09-17\ncustom: kept\n---\n# My own title\n\n## SAiM Actions\n- x\n';
  const merged = mergeRitual(owned, STANDUP);
  assert.match(merged, /custom: kept/);
  assert.match(merged, /# My own title/);
  assert.doesNotMatch(merged, /week: 2026-W38/);
});

test('CRLF in, LF out — a line-anchored reader must not see stray \\r', () => {
  const merged = mergeRitual(LOGGED_ONLY.replace(/\n/g, '\r\n'), STANDUP);
  assert.doesNotMatch(merged, /\r/);
  assert.equal(standupDoneIn(merged), true);
});

test('a ### subheading is content, not a section boundary', () => {
  const withSub = '## Notes\n### A sub head\n- body\n';
  const merged = mergeRitual(withSub, STANDUP);
  assert.match(merged, /### A sub head/);
  assert.equal(merged.match(/^## Notes$/gm).length, 1);
});

// ── The date ────────────────────────────────────────────────────────────────

test('the note is dated from its OWN dateKey, not the wall clock', () => {
  const note = _renderDailyNote({
    dateKey: '2026-09-17',
    outcome: { focus: ['Ship it'], commitments: [], taskLinks: [] },
    context: { accountability: null },
  });
  assert.match(note, /date: 2026-09-17/);
  assert.match(note, /Thursday, 17 September 2026/);
});

test('⚠ the dateKey is parsed as LOCAL midnight, never as UTC', () => {
  // `new Date('2026-09-17')` is midnight UTC, which renders as 16 September west
  // of here — the calendar bug this repo has paid for three times.
  //
  // ⚠⚠ THE OBVIOUS TEST FOR THIS IS WORTHLESS ON THIS MACHINE, and was written
  // and discarded before this one. Asserting the rendered title says "Thursday,
  // 17 September" passes under `new Date(dateKey)` too, because Europe/London is
  // EAST of UTC — the bug needs a negative offset to show. Mutation-checked: the
  // UTC form scored 17/17. And `TZ=America/Los_Angeles` does not help, because
  // Windows ignores it in-process (`Intl` still resolves Europe/London), so a
  // zone-flipped test would pass for the wrong reason here and only ever bite on
  // the Pi. So there are two halves, and the SECOND one is the reliable one.

  // 1. Behavioural. Exact under any non-UTC zone; silently vacuous at offset 0,
  //    which Europe/London is every winter — hence the source scan below.
  const { _dateOf } = require('./standup-session');
  const got = _dateOf('2026-09-17');
  assert.equal(got.getTime(), new Date(2026, 8, 17).getTime());
  assert.equal(got.getFullYear(), 2026);
  assert.equal(got.getMonth(), 8);
  assert.equal(got.getDate(), 17);

  // 2. The construction form itself, which is what actually decides the answer
  //    and is the same on every machine in every month.
  const src = fs.readFileSync(path.join(__dirname, 'standup-session.js'), 'utf8').replace(/\r\n/g, '\n');
  const body = src.slice(src.indexOf('function _dateOf('));
  const fn = body.slice(0, body.indexOf('\n}\n') + 3);
  assert.ok(/new Date\(Number\(m\[1\]\), Number\(m\[2\]\) - 1, Number\(m\[3\]\)\)/.test(fn),
    '_dateOf must build from local Y/M/D components');
  assert.ok(!/new Date\((?!\)|Number)/.test(fn),
    '_dateOf must never hand a string to the Date constructor');
});

test('an unparseable dateKey falls back to today rather than an Invalid Date', () => {
  // Every comparison against NaN is false, so an Invalid Date would render a
  // note titled "Invalid Date" without anything throwing.
  const { _dateOf } = require('./standup-session');
  for (const bad of ['', null, undefined, 'today', '17/09/2026']) {
    assert.ok(!Number.isNaN(_dateOf(bad).getTime()), JSON.stringify(bad));
  }
});

// ── The refusals ────────────────────────────────────────────────────────────

test('⚠ a standup with nothing committed is REFUSED, not written as a scaffold', () => {
  // NEURO writes `- [ ]` into every daily note itself, so a record that accepted
  // an empty focus list would create the evidence for its own done-test — the
  // exact bug `standup-done.test.js` exists for, arriving by a new door.
  for (const bad of [{}, { focus: [] }, { focus: ['', '   '] }, { focus: 'not an array' }]) {
    assert.throws(() => recordExternal('standup', bad, { dateKey: '2026-09-17' }), /focus must contain/);
  }
});

test('an EOD with nothing in it is refused too', () => {
  assert.throws(() => recordExternal('eod', {}, { dateKey: '2026-09-16' }), /at least one of/);
  // Any ONE of the four is enough — the evening is legitimately thin some days.
  for (const ok of [{ done: ['a'] }, { didntGo: 'x' }, { tomorrowFirst: 'y' }, { mood: 'z' }]) {
    assert.doesNotThrow(() => recordExternal('eod', ok, { dateKey: '2026-09-16' }));
  }
});

test('a malformed date and an unknown kind are refused by name', () => {
  assert.throws(() => recordExternal('standup', { focus: ['a'] }, { dateKey: '17/09/2026' }), /YYYY-MM-DD/);
  assert.throws(() => recordExternal('standup', { focus: ['a'] }, { dateKey: 'today' }), /YYYY-MM-DD/);
  assert.throws(() => recordExternal('weekly', { focus: ['a'] }, { dateKey: '2026-09-17' }), /Unknown ritual kind/);
});

// ── The whole round trip, against a real vault ──────────────────────────────

const read = (d) => fs.readFileSync(path.join(VAULT, 'Daily', `${d}.md`), 'utf-8');

test('round trip: record → the file on disk → the detector agrees', () => {
  const day = '2026-09-17';
  fs.writeFileSync(path.join(VAULT, 'Daily', `${day}.md`), LOGGED_ONLY, 'utf-8');

  const result = recordExternal('standup', {
    focus: ['Protect the green', 'Record the podcast', 'No admin debt'],
    blockers: 'Nothing pressing',
  }, { dateKey: day });

  assert.equal(result.ok, true);
  assert.equal(result.created, false, 'the note already existed');

  const note = read(day);
  assert.equal(standupDoneIn(note), true);
  assert.equal(parseDailyNote(note).focus.length, 3);
  assert.match(note, /## SAiM Actions/, 'and the log is still there');
});

test('round trip: an EOD recorded the MORNING AFTER lands on the right day', () => {
  // The 16 Sep reflection was captured at 20:08 and reconciled the next day.
  // Writing it to "today" would put the evening on the wrong date.
  const yesterday = '2026-09-16';
  fs.writeFileSync(path.join(VAULT, 'Daily', `${yesterday}.md`),
    '## Focus Today\n- [x] Get Sara working #focus\n', 'utf-8');

  recordExternal('eod', {
    done: ['Got Sara properly working'],
    didntGo: 'Nothing',
    tomorrowFirst: 'The podcast',
    mood: 'Tired but content',
  }, { dateKey: yesterday });

  const note = read(yesterday);
  assert.equal(parseDailyNote(note).eodDone, true);
  assert.match(note, /Got Sara properly working/);
  assert.equal(standupDoneIn(note), true, "and yesterday's standup is untouched");
  // (!) The negative: today must not have been written.
  assert.equal(parseDailyNote(read('2026-09-17')).eodDone, false);
});

test('a day with no note at all is created from nothing', () => {
  const result = recordExternal('standup', { focus: ['Start fresh'] }, { dateKey: '2026-09-18' });
  assert.equal(result.created, true);
  assert.equal(standupDoneIn(read('2026-09-18')), true);
});
