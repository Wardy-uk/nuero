// Deterministic accountability scan for the standup ritual.
// No AI — reads recent daily notes and works out what Nick actually committed to,
// what he did, and what has been quietly rolling forward day after day.

const fs = require('fs');
const path = require('path');

function vaultPath() {
  return process.env.OBSIDIAN_VAULT_PATH || '';
}

function dateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Normalised key for matching the same commitment across days
function commitmentKey(text) {
  return text
    .toLowerCase()
    .replace(/\[\[([^|]*?\|)?([^\]]*?)\]\]/g, '$2')
    .replace(/#[\w-]+/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 60);
}

// Written by standup-session onto a daily-note line that stands for a NEURO
// task, so the line and the task are one item rather than two. Read here and by
// obsidian.parseTaskLine, which suppresses the line from the task list.
const TASK_MARKER_RE = /<!--task:(\d+)-->/;

function cleanTaskText(raw) {
  return raw
    .replace(/<!--.*?-->/g, '')
    .replace(/\[\[([^|]*?\|)?([^\]]*?)\]\]/g, '$2')
    .replace(/due::\d{4}-\d{2}-\d{2}/g, '')
    .replace(/📅\s*\d{4}-\d{2}-\d{2}/g, '')
    .replace(/#[\w-]+/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// Parse one daily note into the bits accountability cares about
function parseDailyNote(content) {
  const focus = [];
  const carry = [];
  const eodItems = [];
  const decided = [];
  let eodDone = false;
  let didntGo = null;
  // Are we inside the EOD section's `**Done:**` list? Cleared by the next bold
  // label, so "Tomorrow starts with" cannot be read back as work finished.
  let inEodDone = false;

  let section = null;
  for (const line of content.split('\n')) {
    if (/^##\s+Focus Today/i.test(line)) { section = 'focus'; continue; }
    if (/^##\s+Carry/i.test(line)) { section = 'carry'; continue; }
    if (/^##\s+EOD/i.test(line)) { section = 'eod'; eodDone = true; continue; }
    if (/^##\s+Decided/i.test(line)) { section = 'decided'; continue; }
    if (/^##\s/.test(line)) { section = null; continue; }

    if (section === 'eod') {
      // The `**Done:**` bullets are the only durable record of what the EOD
      // conversation concluded — the session itself lives in agent_state under
      // its own date key and is never loaded again. Discarding them is why the
      // morning standup could not see work Nick reported finishing the night
      // before, and chased a commitment he had already closed.
      if (/^\s*\*\*Done:\*\*/i.test(line)) { inEodDone = true; continue; }
      if (/^\s*\*\*/.test(line)) inEodDone = false;
      if (inEodDone) {
        const b = line.match(/^\s*-\s+(?:\[[ x>/]\]\s+)?(.+)$/i);
        if (b) {
          const text = cleanTaskText(b[1]);
          if (text && !/^none$/i.test(text)) eodItems.push({ text, key: commitmentKey(text) });
          continue;
        }
        if (line.trim()) inEodDone = false;
      }
      const m = line.match(/\*\*Didn't go to plan:\*\*\s*(.+)/i);
      if (m && !/^nothing/i.test(m[1].trim())) didntGo = m[1].trim();
      continue;
    }

    // ⚠ `## Decided` is what the morning note writes for a commitment Nick
    // closed ("already done", "dropped", "scheduled"). Until 16 Sep 2026 nothing
    // read it back, so a decision recorded twice was still carried a third time.
    if (section === 'decided') {
      const d = parseDecidedLine(line);
      if (d) decided.push(d);
      continue;
    }

    if (section !== 'focus' && section !== 'carry') continue;
    const m = line.match(/^\s*-\s+\[([ x>/])\]\s+(.+)$/i);
    if (!m) continue;
    const text = cleanTaskText(m[2]);
    if (!text || /^none$/i.test(text)) continue;
    // The NEURO task this line IS, when the standup linked one (11 Sep 2026).
    // cleanTaskText strips the comment, so the key is unchanged by the marker.
    const link = m[2].match(TASK_MARKER_RE);
    const item = { text, key: commitmentKey(text), done: m[1].toLowerCase() === 'x', taskId: link ? Number(link[1]) : null };
    (section === 'focus' ? focus : carry).push(item);
  }

  const standupDone = focus.length > 0 || /^##\s+Standup/im.test(content);
  return { focus, carry, eodItems, decided, eodDone, didntGo, standupDone };
}

// The `## EOD` section has TWO generations, and the reader has to know both.
//
// The old guided flow (`POST /api/standup/eod/submit-guided`) wrote three inline
// labels: `**Win:**`, `**Didn't go to plan:**`, `**Feeling:**`. The session
// renderer that replaced it on 14 Aug 2026 writes `**Done:**` as a BULLET LIST
// plus `**Mood:**` — and `GET /api/standup/eod-history` was never updated, so it
// went on matching `Win:` and `Feeling:` and returned `win: null, feeling: null`
// for every EOD written since. Measured on the live vault: 7 notes in the new
// shape against 4 in the old, so the history view was blank for the majority of
// the entries it existed to show. No error, no empty list, just nulls — the
// wrong-label species this repo has paid for as `sleep_core_hours`,
// `meeting_alert` and `summary_type`.
//
// (!) THIS IS DELIBERATELY NOT `parseDailyNote`'s EOD ARM, which reads the same
// text and answers a DIFFERENT question. That one is accountability's: it folds
// `**Done:**` into `eodItems` so a commitment Nick reported finishing can be
// chased, and it NULLS a `didntGo` of "Nothing" because nothing went wrong. A
// history view must render what he actually wrote, "Nothing" included, and must
// not put a legacy `Win:` into the commitment stream. Reading for display and
// reading for accountability are the same split as `extractSectionFlexible` vs
// `extractMarkdownSection`: reading may be lenient where rewriting may not.
//
// PURE, so it pins without a vault.
const EOD_SECTION_RE = /## EOD[^\n]*\n([\s\S]*?)(?=\n##|$)/;

function parseEodEntry(content) {
  if (typeof content !== 'string' || !content) return null;
  // Vault notes are mixed CRLF/LF and `\r` is a JS line terminator, so a
  // line-anchored match silently fails on half of them.
  const m = EOD_SECTION_RE.exec(content.replace(/\r\n/g, '\n'));
  if (!m) return null;
  const text = m[1].trim();
  if (!text) return null;

  const done = [];
  let win = null;
  let didntGo = null;
  let feeling = null;
  let inDone = false;

  for (const line of text.split('\n')) {
    // Any bold label ends the Done list, including Done itself.
    const label = /^\s*\*\*([^*]+?):\*\*\s*(.*)$/.exec(line);
    if (label) {
      const key = label[1].trim().toLowerCase();
      const value = label[2].trim();
      inDone = key === 'done';
      // (!) An empty value is ABSENT, never the empty string — requirement 4:
      // a missing optional field stays missing rather than being fabricated
      // into a falsy-but-present one.
      if (value) {
        if (key === 'win') win = value;
        // Both generations feed ONE slot. First non-empty wins, so a note
        // carrying both (a legacy note re-run through the session flow) is not
        // silently overwritten by whichever happens to sit lower.
        else if ((key === 'feeling' || key === 'mood') && !feeling) feeling = value;
        // (!) Verbatim, "Nothing" included — see the divergence noted above.
        else if (/^didn'?t go to plan$/.test(key)) didntGo = value;
      }
      if (key === 'win' && value) done.push(value);
      continue;
    }
    if (!inDone) continue;
    const bullet = /^\s*-\s+(?:\[[ x>/]\]\s+)?(.+)$/.exec(line);
    if (bullet) {
      const item = bullet[1].trim();
      if (item) done.push(item);
      continue;
    }
    // A non-empty, non-bullet line ends the list (the `<!-- daily-nav -->`
    // footer and its link line both land here).
    if (line.trim()) inDone = false;
  }

  // (!) `win` is the single HIGHLIGHT and is only filled where there genuinely
  // is one. A lone `Done:` item IS that day's win, so it fills the slot — but
  // 2026-09-08 lists SEVEN ("Ticket type analysis for Mel", "Prep for Risk
  // meeting", ...), and neither picking the first nor joining them is a win: it
  // is emphasis this note never expressed. Those days carry `done` instead and
  // leave `win` null, which is requirement 4 applied to the field that provoked
  // the fix. Measured: 6 of the 7 new-format notes are multi-item.
  if (!win && done.length === 1) win = done[0];

  return { done, win, didntGo, feeling };
}

// The three shapes standup-session._renderDailyNote writes under `## Decided`.
function parseDecidedLine(line) {
  let m = line.match(/^\s*-\s+~~(.+?)~~\s*\((already done|dropped[^)]*)\)/i);
  if (m) {
    const text = cleanTaskText(m[1]);
    return text ? { text, key: commitmentKey(text), decision: /^already/i.test(m[2]) ? 'done' : 'dropped' } : null;
  }
  m = line.match(/^\s*-\s+(.+?)\s+→\s+scheduled for\b/i);
  if (m) {
    const text = cleanTaskText(m[1]);
    return text ? { text, key: commitmentKey(text), decision: 'scheduled' } : null;
  }
  return null;
}

// ── Is this commitment still live? ─────────────────────────────────────────
//
// ⚠ THE ONE ANSWER. Morning standup, EOD, the accountability route and anything
// reading it through MCP all resolve here; nothing else decides it.
//
// A carry-forward is rebuilt from unticked daily-note lines, and a line never
// changes once its day has passed — so "closed" can only come from later
// evidence that outranks it. Four sources, each something Nick said or did:
//   * ledger  — a resolve_commitment decision (done/dropped/scheduled), written
//               the moment it is made (services/commitment-ledger.js);
//   * decided — the `## Decided` lines older notes already hold: the same
//               decision, persisted before the ledger existed. This is what
//               repairs the existing stale data without a migration;
//   * eod     — an EOD `**Done:**` bullet, his own account of the day;
//   * task    — the NEURO task the line is linked to is done or dropped.
//
// A closure counts only if it is dated ON OR AFTER the newest unticked
// mention. Re-committing to the same thing on a later day is a new, live
// commitment — that is the way back, and it is what Nick does when he picks
// something up again.

// MEASURED on every Focus/Carry line in the notes since 10 Aug 2026 (33 keys):
// rewordings of ONE commitment ("Verify and compile Phillipa's email response"
// / "…her response"; the podcast script line with and without its tail) score
// 1.00 with weighted jaccard 0.60–0.69. Every wrong or partial pair had jaccard
// ≤ 0.46 — "NDC data fixes" inside the NDC split (0.28), "Weekly report to
// Chris" vs the management report (0.26), and "Record full podcast" vs the
// podcast SCRIPT line, which scores 1.00 on containment alone. Score without
// jaccard would close unfinished work and hide it in the place Nick looks for
// what he owes, so both bars apply.
const EQUIV_SCORE = 0.85;
const EQUIV_JACCARD = 0.5;

function sameCommitment(a, b, pool = []) {
  if (!a || !b) return false;
  if (a.key && b.key && a.key === b.key) return true;
  if (!a.text || !b.text) return false;
  try {
    // Lazy: task-dedupe pulls in the task store, which the parser must not.
    const { findEquivalent } = require('./task-dedupe');
    // IDF from the whole pool so it reflects Nick's real vocabulary, and b must
    // be a's BEST match, not merely a good one.
    const others = [b.text, ...pool.filter(t => t && t !== a.text && t !== b.text)];
    const hit = findEquivalent(a.text, others, { minScore: EQUIV_SCORE });
    return !!(hit && hit.index === 0 && hit.jaccard >= EQUIV_JACCARD);
  } catch {
    // Cannot compare → not the same. An exact key has already been checked.
    return false;
  }
}

/** Every closure on record, oldest first. `days` are parsed notes. */
function gatherClosures(days, ledgerEntries = []) {
  const out = [];
  for (const e of ledgerEntries) out.push({ key: e.key, text: e.text || null, date: e.date, decision: e.decision, taskId: e.taskId || null, source: 'ledger' });
  for (const day of days) {
    if (!day.exists) continue;
    for (const d of (day.decided || [])) out.push({ ...d, date: day.date, source: 'decided' });
    for (const i of (day.eodItems || [])) out.push({ key: i.key, text: i.text, date: day.date, decision: 'done', source: 'eod' });
  }
  return out.sort((x, y) => x.date.localeCompare(y.date));
}

/**
 * PURE. The closure that ends `entry` ({key, text, lastSeen, taskId}), or null
 * when it is live. `taskStatus(id)` returns a task status or null (unknown).
 */
function closureFor(entry, closures, { taskStatus = () => null, pool = [] } = {}) {
  if (entry.taskId) {
    const status = taskStatus(entry.taskId);
    if (status === 'done' || status === 'dropped') {
      return { key: entry.key, text: entry.text, date: null, decision: status, taskId: entry.taskId, source: 'task' };
    }
  }
  let found = null;
  for (const c of closures) {
    if (entry.lastSeen && c.date < entry.lastSeen) continue;
    if (sameCommitment(entry, c, pool)) found = c; // newest wins
  }
  return found;
}

function _taskStatus(id) {
  try {
    const row = require('./task-store').getTask(Number(id));
    return row ? row.status : null;
  } catch {
    return null; // unknown → stays live
  }
}

function _ledger() {
  try { return require('./commitment-ledger').list(); } catch { return []; }
}

/**
 * Split commitments into still-live and closed against CURRENT evidence. Used
 * by buildAccountability, and by anything holding an older snapshot (a stored
 * session context), so a list built at 08:30 cannot resurrect something closed
 * at 08:45.
 */
function reconcile(commitments, { days = null, ledger = null, taskStatus = _taskStatus, lookbackDays = 14 } = {}) {
  const notes = days || readRecentNotes(lookbackDays);
  const closures = gatherClosures(notes, ledger || _ledger());
  const pool = [...commitments.map(c => c.text), ...closures.map(c => c.text)].filter(Boolean);
  const open = [];
  const closed = [];
  for (const c of commitments) {
    const hit = closureFor(c, closures, { taskStatus, pool });
    if (!hit) { open.push(c); continue; }
    closed.push({
      ...c, lastSeen: c.lastSeen || null, taskId: c.taskId || hit.taskId || null,
      closedOn: hit.date, decision: hit.decision, source: hit.source,
    });
  }
  return { open, closed };
}

/**
 * Has a standup actually been done, according to this daily note? PURE.
 *
 * ⚠ THE ONE PREDICATE. There were FOUR implementations of this question and
 * they disagreed, which is exactly how NEURO came to tell Nick "Standup already
 * done today" on a morning he had not done one:
 *
 *   * `parseDailyNote` (here)   — correct: a Focus item needs real text.
 *   * `nudges.js`               — correct, independently reimplemented.
 *   * `routes/standup.js`       — matched `- [ ]`, an EMPTY checkbox, so the
 *                                 skeleton NEURO writes into every daily note
 *                                 satisfied its own test. This is the one the
 *                                 screen read.
 *   * `activity.js`             — worst: the bare HEADING `## Focus Today`
 *                                 counted, so a note with nothing in it at all
 *                                 was a completed standup.
 *
 * So the nudge kept (correctly) asking for a standup while the screen said it
 * was already done. Same species as the `task-blocks` empty-stub rule: NEURO
 * writes the scaffold, so a detector that accepts the scaffold creates the
 * evidence for its own test and marks work done that nobody did.
 *
 * `## Focus Today` is a parsed CONTRACT (standup-session writes it, this reads
 * it back tomorrow), so the heading is not touched — only what counts as filled.
 */
function standupDoneIn(content) {
  if (!content || typeof content !== 'string') return false;
  return parseDailyNote(content).standupDone;
}

// Walk back over the last `lookbackDays` calendar days, newest first
function readRecentNotes(lookbackDays, asOf = new Date()) {
  const dir = path.join(vaultPath(), 'Daily');
  const days = [];
  if (!vaultPath() || !fs.existsSync(dir)) return days;

  const today = asOf instanceof Date ? asOf : new Date();
  for (let i = 1; i <= lookbackDays; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const ds = dateStr(d);
    const file = path.join(dir, `${ds}.md`);
    const isWeekend = d.getDay() === 0 || d.getDay() === 6;
    if (!fs.existsSync(file)) {
      days.push({ date: ds, isWeekend, exists: false });
      continue;
    }
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }
    days.push({ date: ds, isWeekend, exists: true, ...parseDailyNote(content) });
  }
  return days;
}

/**
 * PURE. A `YYYY-MM-DD` key as a LOCAL midnight Date.
 *
 * ⚠ NEVER `new Date('2026-09-19')`, which is midnight UTC and renders as the
 *   18th west of here. The rule this repo states everywhere else, and the one
 *   `_dateOf` already follows in `standup-session`.
 *
 * Anything unparseable falls back to now — an unreadable anchor must not stop
 * the standup, and "today" is the behaviour every caller had before this.
 */
function _asOfDate(asOf) {
  if (asOf instanceof Date) return asOf;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(asOf || ''));
  if (!m) return new Date();
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/**
 * Build the full accountability picture for a standup.
 * Everything here is derived from the vault — no AI, no guessing.
 *
 * ⚠⚠ `asOf` IS THE DAY BEING BUILT FOR, and defaulting it to today is what
 * every caller had before it existed. It matters because the scan walks from
 * the day BEFORE the anchor backwards, so the anchor day is excluded from its
 * own carry-over count — and without it, recording a PAST day's standup counted
 * the note it had just written as another day of carrying.
 *
 * Live symptom: `recordExternal` exists to reconcile a ritual captured
 * elsewhere, possibly yesterday, and recording yesterday's standup twice aged
 * every carried commitment by a day (`#carried-1d` → `#carried-2d`). It is also
 * simply the right question: the carry-overs for a given morning are what was
 * open BEFORE that morning, not what is open now.
 *
 * ⚠ `ledger` and `taskStatus` are deliberately still "as of NOW". They CLOSE
 * commitments rather than age them, and closing one that has since been done is
 * the safe direction — it stops a thing already finished being chased. Making
 * those historical would need a point-in-time task store, which does not exist.
 */
function buildAccountability({ lookbackDays = 14, asOf = null, ledger = null, taskStatus = _taskStatus } = {}) {
  const anchor = _asOfDate(asOf);
  const days = readRecentNotes(lookbackDays, anchor);
  const withNotes = days.filter(d => d.exists);
  const previous = withNotes[0] || null;

  // ── Today, if the standup has already run ──
  // Kept separate from the lookback: today's items aren't "carried" yet, but if
  // the standup is already done we should be tracking progress against them.
  let today = null;
  // ⚠ THE ANCHOR DAY, not the wall clock. Reading the real today while the rest
  //   of this picture is built for another day would mix two days into one
  //   answer — and on a re-record it is the note just written, which is exactly
  //   the self-counting this anchor removes.
  const todayStr = dateStr(anchor);
  const todayFile = path.join(vaultPath(), 'Daily', `${todayStr}.md`);
  if (vaultPath() && fs.existsSync(todayFile)) {
    try {
      const parsed = parseDailyNote(fs.readFileSync(todayFile, 'utf-8'));
      const all = [...parsed.focus, ...parsed.carry];
      today = {
        date: todayStr,
        standupDone: parsed.standupDone,
        eodDone: parsed.eodDone,
        committed: all.length,
        done: all.filter(i => i.done).length,
        items: all.map(i => ({ text: i.text, done: i.done })),
      };
    } catch {}
  }

  // ── Open commitments and how long they've been rolling ──
  // Walk oldest → newest so the newest mention wins.
  const tracked = new Map();
  for (const day of [...withNotes].reverse()) {
    for (const item of [...(day.focus || []), ...(day.carry || [])]) {
      const entry = tracked.get(item.key) || { text: item.text, dates: [], lastDone: false };
      entry.text = item.text; // keep the most recent wording
      entry.lastDone = item.done;
      // A link, once made, is not lost because a later line forgot to carry it.
      if (item.taskId) entry.taskId = item.taskId;
      if (!item.done) entry.dates.push(day.date);
      tracked.set(item.key, entry);
    }
  }

  // What an EOD said was DONE, keyed the same way commitments are, newest day
  // wins. This is evidence from Nick's own words, not a tick — so it never
  // closes a commitment on its own. It is attached below so the standup can say
  // "you told me this was done on Wednesday" instead of chasing it a fourth time.
  const eodReported = new Map();
  for (const day of [...withNotes].reverse()) {
    for (const item of (day.eodItems || [])) eodReported.set(item.key, day.date);
  }

  const candidates = [];
  for (const [key, entry] of tracked) {
    if (entry.lastDone || entry.dates.length === 0) continue;
    candidates.push({
      key,
      text: entry.text,
      daysCarried: entry.dates.length,
      firstSeen: entry.dates[0],
      lastSeen: entry.dates[entry.dates.length - 1],
      reportedDoneOn: eodReported.get(key) || null,
      taskId: entry.taskId || null,
    });
  }
  // ⚠ Reconciled BEFORE anything reads it, so nothing downstream can see a
  // commitment that has already been closed. See reconcile().
  const { open: openCommitments, closed: closedCommitments } = reconcile(candidates, { days, ledger, taskStatus });
  openCommitments.sort((a, b) => b.daysCarried - a.daysCarried);

  // ── Yesterday's scoreboard ──
  let yesterday = null;
  if (previous) {
    const all = [...(previous.focus || []), ...(previous.carry || [])];
    yesterday = {
      date: previous.date,
      committed: all.length,
      done: all.filter(i => i.done).length,
      items: all.map(i => ({ text: i.text, done: i.done })),
      eodItems: (previous.eodItems || []).map(i => i.text),
      eodDone: !!previous.eodDone,
      unresolved: previous.didntGo || null,
    };
  }

  // ── Days the ritual was skipped entirely (weekdays only) ──
  const skipped = days
    .filter(d => !d.isWeekend && (!d.exists || !d.standupDone))
    .map(d => d.date)
    .slice(0, 5);

  // ── Overdue must-dos ──
  const overdueMustDos = [];
  try {
    const obsidian = require('./obsidian');
    const todayStr = obsidian.todayDateString();
    for (const m of obsidian.parseVaultMustDos()) {
      if (!m.due_date || m.due_date >= todayStr) continue;
      const daysLate = Math.round(
        (new Date(todayStr) - new Date(m.due_date)) / 86400000
      );
      overdueMustDos.push({ text: m.text, due_date: m.due_date, daysLate });
    }
    overdueMustDos.sort((a, b) => b.daysLate - a.daysLate);
  } catch {}

  // Queue pressure removed 27 Aug 2026 with the Jira queue cache — see
  // db/database.js. Nothing read this field, and nothing produces the figures.

  // ── 90-day plan slippage ──
  let plan = null;
  try {
    const p = require('./obsidian').parseNinetyDayPlan();
    if (p) {
      plan = {
        currentDay: p.currentDay,
        totalDays: p.totalDays,
        done: p.totalDone,
        total: p.totalTasks,
        overdue: (p.overdueTasks || []).length,
      };
    }
  } catch {}

  // ── The blunt one-liner ──
  const stale = openCommitments.filter(c => c.daysCarried >= 3);
  let headline;
  if (today?.standupDone && today.committed > 0) {
    const open = today.committed - today.done;
    headline = open === 0
      ? `All ${today.committed} of today's commitments ticked off.`
      : `You committed to ${today.committed} thing${today.committed > 1 ? 's' : ''} today. ${today.done} done, ${open} still open.`;
  } else if (stale.length === 1) {
    headline = `"${stale[0].text}" has been on your list ${stale[0].daysCarried} days. Decide today.`;
  } else if (stale.length > 1) {
    headline = `${stale.length} things have been rolling for 3+ days. Commit or drop them.`;
  } else if (yesterday && yesterday.committed > 0 && yesterday.done === 0) {
    headline = `Nothing from ${yesterday.date} got ticked off. What actually happened?`;
  } else if (skipped.length >= 2) {
    headline = `You've skipped standup ${skipped.length} of the last few weekdays.`;
  } else if (openCommitments.length === 0 && yesterday) {
    headline = 'Clean slate — nothing carried over.';
  } else {
    headline = null;
  }

  return {
    headline,
    today,
    yesterday,
    openCommitments,
    closedCommitments,
    staleCount: stale.length,
    skippedDays: skipped,
    overdueMustDos,
    plan,
  };
}

module.exports = {
  buildAccountability, commitmentKey, parseDailyNote, parseEodEntry, standupDoneIn, TASK_MARKER_RE,
  reconcile, closureFor, gatherClosures, sameCommitment, EQUIV_SCORE, EQUIV_JACCARD,
};
