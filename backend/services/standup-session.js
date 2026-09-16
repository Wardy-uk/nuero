'use strict';

/**
 * Standup / EOD as a collaborative session.
 *
 * The old guided flow asked three fixed questions into text boxes and posted the
 * lot at the end. Two things were wrong with it, and they are the two things this
 * replaces:
 *
 *   1. It could not respond. "Ship the QA framework" and "I'll try to look at
 *      QA" got the same silent acceptance, so the ritual recorded intent without
 *      ever testing it. Yesterday's commitments were shown but never chased.
 *   2. Everything lived in browser state until the final POST. One dropped
 *      request — a backend restart mid-session is routine here — and the whole
 *      thing was gone, which is exactly what happened.
 *
 * So: a real conversation, with tools, and the transcript persisted server-side
 * after EVERY turn. Close the tab, restart the Pi, come back — `resume()` picks
 * it up where it stopped. Nothing typed is ever held only in the client.
 *
 * The model can act during the session (close a carried commitment, create a
 * task, set today's focus) rather than producing prose that a human then has to
 * transcribe. The daily note is written by an explicit finish step, not by
 * scraping a ===MARKER=== out of the model's output and hoping it got the
 * format right.
 */

const db = require('../db/database');
const obsidian = require('./obsidian');

// The per-round cap on the tool path. Covers the prose AND every tool call the
// round makes; see the note at the call site for what 400 cost.
const TOOL_TURN_MAX_TOKENS = 1200;

const KIND_STANDUP = 'standup';
const KIND_EOD = 'eod';

// Sessions live in the KV store rather than a new table: this is one short-lived
// document per day per kind, and a schema migration on a live DB is a bigger
// risk than the query convenience is worth.
function _key(dateKey, kind) {
  return `standup_session_${kind}_${dateKey}`;
}

function _today() {
  return obsidian.todayDateString();
}

// ── Persistence ──────────────────────────────────────────────────────────────

function load(kind, dateKey = _today()) {
  try {
    const raw = db.getState(_key(dateKey, kind));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function save(session) {
  db.setState(_key(session.dateKey, session.kind), JSON.stringify(session));
  return session;
}

function clear(kind, dateKey = _today()) {
  db.setState(_key(dateKey, kind), '');
}

// ── Working schedule ─────────────────────────────────────────────────────────

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// The one shared predicate (#25). This was a bare Mon-Fri check, so the standup
// would plan Nick a full day on a bank holiday — it knew the weekday and had no
// idea about the calendar.
const _workingDays = require('./working-days');
const _isWorkingDay = (d) => _workingDays.isWorkingDay(d);

// Local getters, never toISOString() — the Pi may run in UTC, which would roll
// the date forward an hour early on a BST evening. Same rule as everywhere else.
function _dateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function _addDays(d, n) {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return out;
}

/**
 * Nick works Monday to Friday. The context used to carry a bare date string and
 * no weekday at all, so on a Friday evening the EOD would tell him what to do
 * "tomorrow morning, before anything else" and hand tasks Saturday due dates —
 * it knew the date, never the day, so every plan it made ran into the weekend.
 */
function buildSchedule(now = new Date()) {
  const tomorrow = _addDays(now, 1);
  let next = tomorrow;
  while (!_isWorkingDay(next)) next = _addDays(next, 1);
  return {
    today: { name: DAY_NAMES[now.getDay()], date: _dateStr(now), working: _isWorkingDay(now), reason: _workingDays.nonWorkingReason(now) },
    tomorrow: { name: DAY_NAMES[tomorrow.getDay()], date: _dateStr(tomorrow), working: _isWorkingDay(tomorrow), reason: _workingDays.nonWorkingReason(tomorrow) },
    nextWorkingDay: { name: DAY_NAMES[next.getDay()], date: _dateStr(next) },
  };
}

/** "the weekend" / "a bank holiday" — a plan has to say which, or it reads wrong. */
function _whyNotWorking(day) {
  if (day.reason === 'holiday') {
    const h = _workingDays.holidayOn(day.date);
    return h ? `a bank holiday (${h.title})` : 'a bank holiday';
  }
  if (day.reason === 'leave') return 'leave';
  return 'the weekend';
}

function _renderSchedule(s) {
  if (!s) return null;
  const lines = [
    `TODAY: ${s.today.name} ${s.today.date}${s.today.working ? '' : ` — a NON-working day (${_whyNotWorking(s.today)})`}.`,
  ];
  if (s.tomorrow.working) {
    lines.push(`Tomorrow is ${s.tomorrow.name} ${s.tomorrow.date}, a working day.`);
  } else {
    lines.push(`Tomorrow is ${s.tomorrow.name} ${s.tomorrow.date} — NOT a working day: ${_whyNotWorking(s.tomorrow)}. Nick works Monday to Friday.`);
    lines.push(`The next working day is ${s.nextWorkingDay.name} ${s.nextWorkingDay.date}. Say "${s.nextWorkingDay.name}", never "tomorrow" or "first thing in the morning", and never give a task a due date on a weekend or a bank holiday.`);
  }
  return lines.join('\n');
}

// ── Context ──────────────────────────────────────────────────────────────────

/**
 * Everything the session needs to hold Nick to account, gathered deterministically.
 * The model gets facts; it does not go looking for them mid-conversation, because
 * a standup that takes thirty seconds to think is a standup that gets skipped.
 */
// How many finished items the context names. A cap, not a summary: whatever it
// drops is reported as a count rather than quietly left out.
const CLOSED_LIMIT = 15;

async function buildContext(kind) {
  const ctx = { kind, dateKey: _today(), schedule: buildSchedule() };

  try {
    const { buildAccountability } = require('./standup-accountability');
    ctx.accountability = buildAccountability();
  } catch (e) {
    console.warn('[StandupSession] Accountability failed:', e.message);
    ctx.accountability = null;
  }

  try {
    const wm = await require('./working-memory').getContext();
    // ctx.queue removed 27 Aug 2026 with the Jira queue cache — see
    // db/database.js. Escalations below are live and are what actually needs
    // naming in a standup.
    ctx.escalations = wm.unseenEscalationList || [];
    ctx.calendar = (wm.calendar || [])
      .filter(e => !e.is_all_day)
      .slice(0, 8)
      .map(e => ({ subject: e.subject, start: e.start_time }));
    ctx.plan = wm.ninetyDayPlan
      ? { day: wm.ninetyDayPlan.currentDay, done: wm.ninetyDayPlan.totalDone, total: wm.ninetyDayPlan.totalTasks }
      : null;
  } catch (e) {
    console.warn('[StandupSession] Working memory failed:', e.message);
  }

  // The week's task target. Only the MORNING standup asks for it — an EOD is
  // for closing the day, and being asked to commit to a number at 5pm is the
  // wrong moment. Failures leave it null, which renders as nothing rather than
  // as "no target set": we could not look, which is a different fact.
  // What SAiM has quietened, and how her prompts are doing. EOD ONLY — this is
  // her confession, and the morning is not the moment for it.
  //
  // ⚠ This is what makes going quiet SAFE. She mutes a prompt that is not
  // helping without asking, which is what Nick wanted, and the whole reason that
  // is not just "SAiM silently breaking" is that she says so here and he can
  // turn any of it back on in the same breath.
  if (kind === 'eod') {
    try {
      const learning = require('./attention-learning');
      ctx.muted = learning.mutedList();
      ctx.promptStats = learning.summary();
    } catch (e) {
      // A failure means she cannot say what she muted — which must read as
      // "I could not check", never as "I have muted nothing".
      console.warn('[StandupSession] Attention learning read failed:', e.message);
      ctx.mutedUnknown = e.message;
    }
  }

  if (kind !== 'eod') {
    try {
      ctx.weeklyTarget = require('./weekly-target').snapshot();
    } catch (e) {
      console.warn('[StandupSession] Weekly target failed:', e.message);
      ctx.weeklyTarget = null;
    }
  }

  // What actually got FINISHED. The task list below is the OPEN pool, so a task
  // closed yesterday leaves it and leaves no trace anywhere else in this
  // context — which is how SAiM came to chase a commitment Nick had already
  // ticked off and told her about at EOD the night before. The wins ledger is
  // the one place a completion is recorded independently of the daily note:
  // ticking a task in NEURO does not tick a note line.
  //
  // The morning asks about the day the accountability scan calls "yesterday",
  // so the two cannot disagree about which day that was (on a Monday it is
  // Friday). EOD asks about today, the day it is closing.
  //
  // ⚠ Commits are excluded — folded one row per repo per day, they would
  // dominate a list whose job is to name closed COMMITMENTS. Rituals go too:
  // "Standup done" is already stated by the block above, and on the first live
  // run the two of them took two of the twelve slots off real work. ⚠ A failed
  // read is a NAMED GAP, never an empty list: "nothing was finished" and "I
  // could not look" license opposite things to say. ⚠ And the cap is COUNTED,
  // never swallowed — a truncated list of what he finished reads as the whole
  // of it, which is the one thing this block exists to stop being wrong about.
  try {
    const wins = require('./wins');
    const day = kind === 'eod'
      ? ctx.dateKey
      : (ctx.accountability?.yesterday?.date || _dateStr(_addDays(new Date(), -1)));
    const all = wins.winsForDate(day).filter(w => w.source !== 'git' && w.source !== 'ritual');
    ctx.closed = {
      known: true,
      date: day,
      total: all.length,
      items: all.slice(0, CLOSED_LIMIT).map(w => ({ text: w.text, source: w.source })),
    };
  } catch (e) {
    console.warn('[StandupSession] Wins read failed:', e.message);
    ctx.closed = { known: false, date: null, reason: e.message };
  }

  // ── Effort that did not finish ────────────────────────────────────────────
  //
  // `closed` above is finished work, and on a bad day it is empty. But a day
  // where Nick started four things, cut two of them down to something startable
  // and put estimates on six tasks is NOT an empty day — it is a day of exactly
  // the work he finds hardest, and until this landed the EOD could not see any
  // of it. So the one evening that could say "you got going on four things"
  // instead had nothing true to say on the days that most needed it.
  //
  // ⚠ Never allowed to fail the session: it is context, and a reflection that
  // refuses to start because a derived count could not be read is worse than
  // one that runs without it.
  try {
    ctx.initiation = require('./initiation-signals').build(new Date());
  } catch (e) {
    console.warn('[StandupSession] Initiation signals unavailable:', e.message);
    ctx.initiation = null;
  }

  try {
    const taskStore = require('./task-store');
    const today = ctx.dateKey;
    ctx.musts = taskStore.activeTodos()
      .filter(t => t.moscow === 'must')
      .slice(0, 8)
      .map(t => ({ id: t.task_id, text: t.text, due: t.due_date, overdue: !!(t.due_date && t.due_date.split('T')[0] < today) }));
  } catch (e) {
    console.warn('[StandupSession] Task load failed:', e.message);
    ctx.musts = [];
  }

  try {
    _linkCommitments(ctx.accountability?.openCommitments);
  } catch (e) {
    // Context, not a gate: an unlinked commitment is the old behaviour.
    console.warn('[StandupSession] Commitment→task link failed:', e.message);
  }

  return ctx;
}

// A carried commitment and the NEURO task it is. Until 11 Sep 2026 nothing
// joined them: the note held "Review the Krista issue and respond to Maria's
// details", the store held #30 "Review the "Krista" issue first thing after
// Maria sends details", and the standup could only ever treat the note line as a
// thing of its own — so committing to it put a second copy on the list instead
// of putting #30 in the diary.
//
// MEASURED, on every Focus/Carry line in the daily notes since 12 Aug against
// the 94 open tasks: the Krista pair scores 0.796 and the best WRONG match 0.427
// ("Prep admin work for the weekend" → a weekend-cover task). 0.6 sits in that
// gap. It is a small sample (one true pair in 30 lines), which is why a match is
// only a HINT the model names out loud — a line already carrying a
// `<!--task:N-->` marker is a link, and outranks it.
const LINK_HINT_SCORE = 0.6;

function _linkCommitments(open) {
  if (!open?.length) return;
  const taskStore = require('./task-store');
  for (const c of open) {
    if (c.taskId) {
      const row = taskStore.getTask(c.taskId);
      c.task = row ? { id: row.id, text: row.text, status: row.status, linked: true } : null;
      continue;
    }
    const hit = taskStore.findSimilar(c.text, { minScore: LINK_HINT_SCORE });
    if (hit) c.task = { id: hit.id, text: hit.text, status: hit.status, linked: false, score: hit.score };
  }
}

function _renderContext(ctx) {
  const parts = [];
  const acc = ctx.accountability;

  // First, because everything below is relative to it. Recomputed when a session
  // predates this block, so a resumed session isn't left day-blind.
  parts.push(_renderSchedule(ctx.schedule || buildSchedule()));

  if (acc?.yesterday) {
    // ⚠ This read acc.yesterday.focus, a key that object has never carried, so
    // every standup opened with "committed to 0 things, 0 done" however full
    // the note was, and the checkbox list beneath it was always empty. The
    // counts were computed correctly all along and then not used.
    const y = acc.yesterday;
    parts.push(`YESTERDAY (${y.date}): committed to ${y.committed} thing${y.committed === 1 ? '' : 's'}, ${y.done} ticked off in the note.`);
    for (const item of (y.items || []).slice(0, 6)) {
      parts.push(`  [${item.done ? 'x' : ' '}] ${item.text}`);
    }
    // What the EOD conversation itself reported. Distinct from a ticked box: it
    // is his own account of the day, and until now it was written into the note
    // and read back by nothing.
    if (y.eodItems?.length) {
      parts.push(`  At EOD he said these were done: ${y.eodItems.map(t => `"${t}"`).join('; ')}.`);
    } else if (y.eodDone) {
      parts.push('  He did an EOD but listed nothing as done.');
    } else {
      parts.push('  No EOD was done, so there is no account of how the day went.');
    }
  }

  // Finished work, from the ledger rather than from a checkbox.
  const closed = ctx.closed;
  if (closed?.known) {
    if (closed.items.length) {
      parts.push(`\nFINISHED ON ${closed.date} (recorded by NEURO, independent of the note — treat these as DONE):`);
      for (const c of closed.items) parts.push(`  - ${c.text} [${c.source}]`);
      const more = (closed.total || closed.items.length) - closed.items.length;
      if (more > 0) parts.push(`  (and ${more} more not listed — he finished more than is shown here.)`);
      parts.push('If something below is on this list, it is done. Confirm and close it — do NOT chase it.');
    } else {
      parts.push(`\nFINISHED ON ${closed.date}: nothing was recorded as finished.`);
    }
  } else if (closed) {
    parts.push('\nFINISHED WORK: could not be read. Do not treat anything below as untouched — say you cannot see what was closed.');
  }

  // Effort that did not necessarily finish. This is the half a completion
  // ledger cannot see, and on a hard day it is the only true good news there is.
  const init = ctx.initiation;
  if (init && init.known) {
    const bits = [];
    if (init.starts?.today) bits.push(`started ${init.starts.today} thing(s)`);
    if (init.triage?.today) bits.push(`decided the shape of ${init.triage.today} task(s)`);
    if (init.triage?.firstEstimatesToday) {
      bits.push(`put a first estimate on ${init.triage.firstEstimatesToday} of them`);
    }
    if (bits.length) {
      parts.push(`\nGETTING GOING: he ${bits.join(', ')}.`);
      // ⚠ The wording matters more here than anywhere else in this block. A
      // task cut down is a fact about the WORK, and phrasing it as a struggle
      // is the one thing `friction.js` and `initiation-signals` both forbid.
      for (const rung of (init.shrinks?.ladder || []).slice(0, 2)) {
        parts.push(`  - cut "${rung.from}" down to "${rung.to}" to get it started`);
      }
      parts.push('This is the work he finds hardest. If the day finished nothing, this is still a day of real effort — say so, once, without ceremony.');
    }
  }

  // The week's target, and whether it still needs setting. Deliberately placed
  // BEFORE the carried commitments: on a Monday the number frames everything
  // below it, and after the list it reads as an afterthought.
  const wt = ctx.weeklyTarget;
  if (wt) {
    if (wt.state === 'unset') {
      parts.push(
        `\nWEEKLY TARGET: NOT SET for the week starting ${wt.weekStart}. `
        + `${wt.done} task${wt.done === 1 ? '' : 's'} closed so far this week. `
        + 'ASK Nick what he is aiming for, ONCE, near the end — a number he picks, '
        + 'not one you propose. If he gives one, call set_weekly_target. If he '
        + 'deflects or says not now, drop it and do not raise it again this session.'
      );
    } else if (wt.state === 'unknown') {
      parts.push('\nWEEKLY TARGET: could not be counted, so do not ask about it or refer to it.');
    } else {
      // Already set: state it as context, never re-ask. Being asked again for a
      // number already given is how a ritual starts feeling like a form.
      parts.push(`\nWEEKLY TARGET: ${wt.say} (do not ask to change it — it is already set.)`);
    }
  }

  // ⚠ An empty CARRIED block does not stop a chase the model ALREADY STARTED.
  // 16 Sep 2026: the session opened at 08:37 chasing four commitments; they were
  // then reconciled closed, the carried list correctly went empty — and the very
  // next turn asked again for "the answer on the AI messaging workflow", because
  // the only place that item still existed was the model's own earlier message,
  // and nothing in the context said that question was settled. Absence is not
  // an instruction; this block is.
  if (acc?.closedCommitments?.length) {
    parts.push(`\nALREADY CLOSED — these are finished or decided. Never chase them and never ask for a decision on them, EVEN IF YOU ASKED ABOUT ONE EARLIER IN THIS CONVERSATION: that question is settled. If you did, say so in a few words and move on to today:`);
    for (const c of acc.closedCommitments.slice(0, 12)) {
      const when = c.closedOn ? ` on ${c.closedOn}` : '';
      parts.push(`  - "${c.text}" — ${c.decision}${when}`);
    }
  }

  if (acc?.openCommitments?.length) {
    parts.push(`\nCARRIED (these are the ones to chase — a commitment on day 3+ needs a decision, not another carry):`);
    for (const c of acc.openCommitments.slice(0, 8)) {
      // A commitment he told an EOD he had finished is not one to chase again.
      // It is his own account rather than a tick, so it is stated as evidence
      // and never folded away: the standup asks him to confirm and close it.
      const said = c.reportedDoneOn
        ? ` — HE REPORTED THIS DONE AT EOD ON ${c.reportedDoneOn}; confirm and close it rather than chasing it`
        : '';
      let task = '';
      if (c.task && (c.task.status === 'done' || c.task.status === 'dropped')) {
        task = ` — THIS IS TASK #${c.task.id}, ALREADY ${c.task.status.toUpperCase()} IN NEURO; confirm and close it rather than chasing it`;
      } else if (c.task) {
        task = c.task.linked
          ? ` [task #${c.task.id}]`
          : ` [likely task #${c.task.id} "${c.task.text}"]`;
      }
      parts.push(`  - "${c.text}" — carried ${c.daysCarried} day${c.daysCarried === 1 ? '' : 's'}${said}${task} [key: ${c.key}]`);
    }
  }

  if (acc?.skippedDays?.length) {
    parts.push(`\nNo standup on: ${acc.skippedDays.join(', ')}.`);
  }

  if (ctx.escalations?.length) {
    parts.push(`ESCALATIONS unanswered: ${ctx.escalations.slice(0, 4).map(e => `${e.key} (${e.summary})`).join('; ')}`);
  }
  if (ctx.calendar?.length) {
    parts.push(`\nTODAY'S CALENDAR: ${ctx.calendar.map(e => `${new Date(e.start).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })} ${e.subject}`).join(', ')}`);
    parts.push(`(Meeting load is a real constraint — do not let him commit to more than the free time allows.)`);
  }
  if (ctx.musts?.length) {
    parts.push(`\nMUST-DO TASKS: ${ctx.musts.map(m => `#${m.id} ${m.text}${m.overdue ? ' (OVERDUE)' : ''}`).join(' | ')}`);
  }
  if (ctx.plan) {
    parts.push(`\n90-DAY PLAN: day ${ctx.plan.day}, ${ctx.plan.done}/${ctx.plan.total} done.`);
  }

  return parts.join('\n');
}

// ── Prompts ──────────────────────────────────────────────────────────────────

// The voice is SAiM's, from the one place it is defined — this file used to
// carry its own summary of her, which is how the ritual ended up sounding like
// a different assistant from the one in chat. Only what is specific to running
// a ritual is stated here.
const { VOICE_FULL } = require('./saim-voice');

const SHARED_VOICE = `${VOICE_FULL}

## Running a ritual
You are running Nick's daily ritual. This is a conversation, not a form — react to what he actually says, and if he goes somewhere more useful than the script, go with him.

The context opens with today's weekday and the next working day — read it. Never say "tomorrow" without checking what tomorrow actually is, and never set a due date on a non-working day.`;

const STANDUP_PROMPT = `${SHARED_VOICE}

## Your job this morning
Get him to ONE clear, specific set of commitments for today, and hold him to what he said yesterday.

Run it roughly like this, adapting to his answers:
1. Open with the single most important thing from the context — a carried commitment, an unanswered escalation, a heavy meeting day. Not a greeting and a list.
2. Chase anything carried 3+ days. That is not a task any more, it is a decision. Make him pick: do it today, give it a date, or drop it. "Carry it again" is not on the menu — say so plainly, once, without lecturing. Record the outcome with resolve_commitment — and if he says one is already finished, resolve it "done" straight away. Never tell him something is cleared unless resolve_commitment came back ok.
3. Agree today's focus. Two or three things, not ten. If he names something vague ("look at QA", "catch up on tickets"), push once for what "done" looks like by end of day. Once.
4. Check it fits the calendar. If he has five hours of meetings and three big commitments, say so.
5. When you have the focus, call set_focus, then tell him you're done and he can go.

## Rules
- If today's focus IS a carried commitment, resolve it with resolve_commitment("today") — do NOT also list it as a new focus item. They are one job, and treating them as two is how the list breeds.
- The carried list is what the NOTES say, not what Nick remembers. If he says he never committed to something, or has no idea what it refers to, believe him: drop it with resolve_commitment and move on. Do not argue him through it, and do not keep re-asking about the same item.
- Challenge vague commitments ONCE, then accept what he gives you and move on. Pushing twice is nagging, and nagging is what makes him close the tab.
- If he says he is struggling, drop the process. Ask what is in the way. The ritual matters less than the answer.
- Never guess a commitment key or task id — use the ones in the context.
- A carried line marked [task #N] or [likely task #N] IS that task, not a new one. Pass its task_id to resolve_commitment, and name the task in passing ("that's #30, the Krista one") so he can say if it is not. If he says it is not, resolve it without task_id. Never call create_task for work that is already a task.
- When he gives a time for work ("put it in 14:30 to 16:00"), call block_time with the task ids of everything going in that window — the existing tasks, not copies of them. Only if something has no task at all, call create_task first and use the id it returns. If he names no start time, ask once; if he still does not, do not book it.
- Never say something is booked, blocked or in the diary unless block_time came back ok. If it refused, tell him why in plain words.
- Do not write the daily note yourself. When the focus is agreed, call set_focus; the system writes the note.
- Keep every message under about 60 words.
- If the context says today is not a working day, he has chosen to do this on his day off. Keep it short, do not chase carried work, and do not build him a full day's plan.`;

const EOD_PROMPT = `${SHARED_VOICE}

## Your job this evening
This is a REFLECTION, not a status report. Nick's words, 31 Aug 2026: the EOD
should be "more journal/reflection than specifically work related". He has spent
all day being Head of Technical Support; do not make the last conversation of it
another one about the queue.

You are running this — you started it, he did not come and find you.

1. Open on the DAY, not the work. How was it. One question, and mean it.
2. Reflect back what actually happened from the context — work, movement, what
   he finished — but as material for the conversation, not as a list to confirm.
   Do not ask "what did you get done?" when you can already see it.
   ⚠ NEURO DETECTED this, he did not report it, so some of it he will genuinely
   not remember doing — ADHD working memory drops finished work and the day then
   feels emptier than it was. Naming one or two specific things he had forgotten
   is the single most useful thing this conversation does. Say them as fact, not
   as a quiz, and never as "you forgot".
   ⚠ If the day finished little but the GETTING GOING block has something in it,
   lead with that instead. Starting things and cutting them down to a size he
   could begin is the work he finds hardest, and a day of it is not a wasted day.
   Do not spin it and do not congratulate him for it — state it and move on.
3. Follow what he gives you. If the thing on his mind is a person, or how tired
   he is, or something that has nothing to do with Nurtur, go there. A day is
   not only its tasks and this is the one ritual that can say so.
4. If something slipped that he also committed to yesterday, name it once —
   gently, as a fact. Twice in a row is a pattern worth saying out loud. Do not
   moralise, and do not turn the evening into a review because of it.
   ⚠ If he says a CARRIED commitment is finished, or is no longer happening,
   call resolve_commitment with its key ("done" or "dropped") in the same turn.
   That call is the ONLY thing that stops tomorrow's standup chasing it again —
   a summary line does not. Never tell him something is "cleared" unless
   resolve_commitment came back ok.
5. If there is a first thing for the NEXT WORKING DAY — on a Friday that is
   Monday — capture it with create_task. Only if he names one. Do not fish.
6. Acknowledge what went right, without ceremony. "That's a good day's work",
   not "Amazing!".
7. When you have enough, call set_eod_summary and tell him he is done.

## What you have quietened — say this, every time there is something to say
The context may carry a "muted" list: prompts you have STOPPED sending him
because they were measurably not making any difference, plus "promptStats" for
the rest.

⚠ You quietened these on your own. That is only fair if you own up to it, so say
so plainly and once — what you muted, and the number that made you: "I have
stopped nagging you about water. Eleven times, it changed nothing, so I have
knocked it off." Then tell him he can have any of it back, and if he asks, call
resume_prompt. Do not defend the decision and do not labour it: it is one or two
sentences near the end, not the centre of the conversation.

If "mutedUnknown" is set you could not check — say that, rather than implying
there is nothing.

## Rules
- He is tired. Be shorter than you are in the morning. Under 50 words a message.
- Do not open new work at 6pm. If he raises something big, park it: capture it
  and say it is tomorrow's problem.
- Never end without acknowledging something that went right, even on a bad day.
  Especially on a bad day.`;

// ── Tools ────────────────────────────────────────────────────────────────────

/**
 * Ritual-specific tools, plus a few borrowed from chat-tools. Deliberately a
 * small set: a standup that starts searching the vault has stopped being a
 * standup. Everything here either records a decision or captures an action.
 */
const SESSION_TOOLS = [
  {
    name: 'resolve_commitment',
    description: 'Record what happens to a commitment carried over from a previous day. Use the exact key from the context. "carry" is only valid for something carried fewer than 3 days.',
    input_schema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'The commitment key from the context.' },
        decision: { type: 'string', enum: ['today', 'scheduled', 'dropped', 'done', 'carry'], description: 'today = doing it today; scheduled = has a real date now; dropped = not doing it; done = already finished; carry = rolling again.' },
        due_date: { type: 'string', description: 'YYYY-MM-DD, required when decision is "scheduled".' },
        note: { type: 'string', description: 'Short reason, in his words where possible.' },
        task_id: { type: 'integer', description: 'The NEURO task this commitment is, from [task #N] or [likely task #N] in the context. Omit if it has none, or he said it is not that task.' },
      },
      required: ['key', 'decision'],
    },
  },
  {
    name: 'block_time',
    description: 'Put tasks into ONE time block in his calendar, when he has named a time for them. Takes existing task ids — a task already sitting in an earlier block is moved into this one, not copied. Only say it is booked if this returns ok.',
    input_schema: {
      type: 'object',
      properties: {
        task_ids: { type: 'array', items: { type: 'integer' }, description: 'Every task going into this window.' },
        start: { type: 'string', description: 'HH:MM, 24-hour.' },
        end: { type: 'string', description: 'HH:MM, 24-hour, if he gave one.' },
        date: { type: 'string', description: 'YYYY-MM-DD. Omit for today.' },
      },
      required: ['task_ids', 'start'],
    },
  },
  {
    name: 'set_focus',
    description: 'Record the agreed focus for today and finish the standup. Call this once, when the commitments are settled.',
    input_schema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: { type: 'string' },
          description: 'Two or three specific commitments, in his words. Each should be something you could tell was done or not by end of day.',
        },
        blockers: { type: 'string', description: 'Anything in the way, if he named one.' },
        mood: { type: 'string', description: 'How he sounds, one short phrase. Only if he said something about it.' },
      },
      required: ['items'],
    },
  },
  {
    name: 'resume_prompt',
    description: 'Turn a prompt back on that SAiM had quietened. Use the exact kind from the muted list in the context. Only when Nick asks for it.',
    input_schema: {
      type: 'object',
      properties: {
        kind: { type: 'string', description: 'The prompt kind, e.g. low-water, sedentary, no-exercise.' },
      },
      required: ['kind'],
    },
  },
  {
    name: 'set_eod_summary',
    description: 'Record the end-of-day reflection and finish the EOD. Call this once, when you have enough.',
    input_schema: {
      type: 'object',
      properties: {
        done: { type: 'array', items: { type: 'string' }, description: 'What actually got finished.' },
        didnt_go: { type: 'string', description: 'What did not go to plan. Empty string if nothing.' },
        tomorrow_first: { type: 'string', description: 'The first thing on the next WORKING day, if he named one — on a Friday that is Monday.' },
        mood: { type: 'string', description: 'How the day felt, one short phrase.' },
      },
      required: ['done'],
    },
  },
  {
    name: 'set_weekly_target',
    description: 'Record how many tasks Nick is aiming to finish this week. Only call this if the context says the target is NOT SET and he has given you a number. Never invent one, and never call it to change a target already set.',
    input_schema: {
      type: 'object',
      properties: {
        target: {
          type: 'integer',
          description: 'The number of tasks he committed to, as a whole number. His number, not a suggestion of yours.',
        },
      },
      required: ['target'],
    },
  },
  {
    name: 'create_task',
    description: 'Capture a real action that came out of the conversation. Use when he commits to something that is not already on the list.',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The action, phrased as something to do.' },
        moscow: { type: 'string', enum: ['must', 'should', 'could'], description: 'How firm the commitment sounded.' },
        due_date: { type: 'string', description: 'YYYY-MM-DD if he gave a date.' },
        force: { type: 'boolean', description: 'Only true when this refused because a similar task exists AND he has said this one is different.' },
      },
      required: ['text'],
    },
  },
  {
    name: 'complete_task',
    description: 'Mark a must-do task done when he says he finished it. Use the #id from the context.',
    input_schema: {
      type: 'object',
      properties: { task_id: { type: 'integer' } },
      required: ['task_id'],
    },
  },
];

function toolDefinitions() {
  return SESSION_TOOLS.map(({ name, description, input_schema }) => ({ name, description, input_schema }));
}

/**
 * Execute a session tool. Mutates the session's outcome record, which is what
 * the finish step later turns into the daily note — so a dropped connection
 * after this point still leaves the decision recorded.
 */
async function executeTool(session, name, input = {}) {
  const result = await _executeTool(session, name, input);
  // ⚠ A TOOL THAT REFUSES MUST LEAVE A TRACE. The session transcript stores
  // assistant TEXT only — tool calls, their arguments and their results are
  // discarded — so a refused call used to be reconstructible from nothing at
  // all. On 11 Sep 2026 that cost a morning of guesswork over a standup that
  // kept asking for a number it had already been given: the model was relaying
  // a tool error to Nick in the tool's own vocabulary ("as separate strings")
  // and no log line anywhere recorded that a call had been refused.
  if (result && result.ok === false) {
    console.warn(`[StandupSession] ${name} refused: ${result.error || 'no reason given'}`);
  }
  return result;
}

async function _executeTool(session, name, input = {}) {
  const chatTools = require('./chat-tools');

  switch (name) {
    case 'resolve_commitment': {
      if (!input.key) return { ok: false, error: 'key is required' };
      const taskStore = require('./task-store');
      const carried = (session.context?.accountability?.openCommitments || []).find(c => c.key === input.key);
      let taskId = null;
      if (input.task_id != null) {
        const row = taskStore.getTask(Number(input.task_id));
        if (!row) return { ok: false, error: `No task #${input.task_id}. Use an id from the context, or leave task_id out.` };
        taskId = row.id;
      }
      session.outcome.commitments = session.outcome.commitments.filter(c => c.key !== input.key);
      session.outcome.commitments.push({
        key: input.key,
        decision: input.decision,
        due_date: input.due_date || null,
        note: input.note || null,
        task_id: taskId,
      });
      if (taskId) _noteLink(session, carried?.text || input.key, taskId);
      // ⚠ PERSISTED NOW, not at finish. Until 16 Sep 2026 this decision lived
      // only in the session: the morning note rendered it as a `## Decided` line
      // nothing read back, and the EOD rendered it not at all — so an item
      // closed twice was carried a third time. The ledger is one of the closure
      // sources standup-accountability reconciles against. A failed write is
      // REPORTED, never ok:true, so SAiM cannot tell him it is cleared.
      try {
        require('./commitment-ledger').record({
          key: input.key,
          text: carried?.text || null,
          decision: input.decision,
          date: session.dateKey,
          taskId,
          source: session.kind,
        });
      } catch (e) {
        console.warn(`[StandupSession] Could not persist decision on "${input.key}": ${e.message}`);
        return { ok: false, error: `Decision noted in this conversation but NOT saved — tomorrow's standup would still carry it. (${e.message})` };
      }
      // "Scheduled" is only real if it becomes a dated task — otherwise it is a
      // carry wearing a different word, which is the exact failure this replaces.
      // ⚠ When the commitment already IS a task, that task gets the date. And a
      // new one takes the commitment's own words: it used to take `note`, the
      // model's one-line REASON, so the task list gained "Blocked until Maria
      // replies" as a thing to do.
      if (input.decision === 'scheduled' && input.due_date) {
        try {
          if (taskId) {
            taskStore.updateTask(taskId, { due_date: input.due_date });
          } else {
            const created = taskStore.createTask({
              text: carried?.text || input.key,
              due_date: input.due_date,
              source: 'standup-session',
            });
            if (created?.id) _noteLink(session, carried?.text || input.key, created.id);
          }
        } catch (e) {
          console.warn(`[StandupSession] Could not date "${input.key}": ${e.message}`);
        }
      }
      return { ok: true, recorded: input.decision, task_id: taskId };
    }

    case 'block_time': {
      const ids = [...new Set((input.task_ids || []).map(Number).filter(Number.isInteger))];
      if (!ids.length) return { ok: false, error: 'task_ids is required. For work with no task yet, call create_task first and use its id.' };
      const toMin = (s) => {
        const m = String(s || '').trim().match(/^(\d{1,2}):(\d{2})$/);
        return m && Number(m[1]) < 24 && Number(m[2]) < 60 ? Number(m[1]) * 60 + Number(m[2]) : null;
      };
      const start = toMin(input.start);
      if (start == null) return { ok: false, error: 'start must be HH:MM, 24-hour.' };
      let minutes = null;
      if (input.end) {
        const end = toMin(input.end);
        if (end == null || end <= start) return { ok: false, error: 'end must be HH:MM and after start.' };
        minutes = end - start;
      }
      const date = input.date || session.dateKey;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, error: 'date must be YYYY-MM-DD.' };
      const startTime = `${String(Math.floor(start / 60)).padStart(2, '0')}:${String(start % 60).padStart(2, '0')}`;

      const res = await require('./task-blocks').scheduleMoving(ids, { date, startTime, minutes });
      // A block row exists even when Outlook refused the event, so the link
      // is real either way — the note line should still point at the task.
      if (res.ok || res.blockId) {
        const taskStore = require('./task-store');
        for (const id of ids) {
          const row = taskStore.getTask(id);
          if (row) _noteLink(session, row.text, id);
        }
      }
      if (!res.ok) {
        return { ok: false, error: res.error, inNeuroButNotOutlook: Boolean(res.blockId) };
      }
      const slot = res.slot || {};
      return {
        ok: true,
        already: Boolean(res.already),
        booked: `${slot.date || date} ${slot.startTime || startTime}${slot.endTime ? `-${slot.endTime}` : ''}`,
        tasks: (res.tasks || []).map(t => `#${t.id} ${t.text}`),
        movedFrom: (res.movedFrom || []).map(m => `${m.taskIds.map(id => `#${id}`).join(', ')} out of the ${m.date} ${m.startTime} block`),
        deadlinesPushedLater: (res.dueUpdates || []).filter(d => d.later).map(d => `#${d.taskId} was due ${d.from}`),
        note: 'Booked. Say the time, and anything moved out of an older block, in one sentence.',
      };
    }

    case 'set_focus': {
      const items = (input.items || []).filter(Boolean);
      if (!items.length) return { ok: false, error: 'items is required' };
      session.outcome.focus = items;
      session.outcome.blockers = input.blockers || null;
      session.outcome.mood = input.mood || null;
      session.state = 'ready';
      return { ok: true, focus: items, note: 'Focus recorded. Tell Nick he is done — the system writes the note.' };
    }

    case 'resume_prompt': {
      // ⚠ `unmute` also clears the history that produced the mute. Without that
      // the next sweep re-mutes it on the same evidence and his instruction
      // lasts one night — an escape hatch that does not let you out is not one.
      const result = require('./attention-learning').unmute(String(input.kind || '').trim());
      return result.ok
        ? { ok: true, kind: result.kind, note: 'Back on. It starts from scratch, so it will not be muted again on the old evidence.' }
        : { ok: false, error: `"${input.kind}" was not muted.` };
    }

    case 'set_eod_summary': {
      session.outcome.done = (input.done || []).filter(Boolean);
      session.outcome.didntGo = input.didnt_go || null;
      session.outcome.tomorrowFirst = input.tomorrow_first || null;
      session.outcome.mood = input.mood || null;
      session.state = 'ready';
      if (input.tomorrow_first) {
        try {
          require('./task-store').createTask({ text: input.tomorrow_first, moscow: 'must', source: 'eod-session' });
        } catch {}
      }
      return { ok: true, note: 'Reflection recorded. Tell Nick he is done.' };
    }

    case 'set_weekly_target': {
      // setTarget REPORTS rather than throws, so a daft number comes back as a
      // sentence the model can put to Nick instead of a dead turn.
      const result = require('./weekly-target').setTarget(input.target, { source: 'standup' });
      if (!result.ok) return result;
      const snap = require('./weekly-target').snapshot();
      return {
        ok: true,
        target: result.target,
        weekStart: result.weekStart,
        // Hand back the composed line so the model repeats NEURO's phrasing
        // rather than inventing a second way to say the same number.
        note: `Target set. ${snap.say}`,
      };
    }

    case 'create_task': {
      // "It's adding new tasks when I commit to doing things" (11 Sep 2026). In
      // chat, a similar match is only REPORTED because nobody is there to ask;
      // in a standup Nick is right there, so a likely existing task stops the
      // create and the model asks — `force` is the way through once he has.
      if (!input.force) {
        const similar = require('./task-store').findSimilar(String(input.text || ''), { minScore: LINK_HINT_SCORE });
        if (similar) {
          return {
            ok: false,
            existing: { id: similar.id, text: similar.text },
            error: `Already a task: #${similar.id} "${similar.text}". Use #${similar.id} instead of making a copy. Only if he says this is different, call create_task again with force: true.`,
          };
        }
      }
      const created = await chatTools.execute(name, input);
      if (created?.ok && created.task_id) _noteLink(session, created.text || input.text, created.task_id);
      return created;
    }

    case 'complete_task':
      return chatTools.execute(name, input);

    default:
      return { ok: false, error: `Unknown tool: ${name}` };
  }
}

/** Remember that `text` is task #taskId, so the note line can say so. One entry per task. */
function _noteLink(session, text, taskId) {
  const links = (session.outcome.taskLinks = session.outcome.taskLinks || []);
  const found = links.find(l => l.taskId === taskId);
  if (found) { if (text && !found.texts.includes(text)) found.texts.push(text); return; }
  links.push({ taskId, texts: text ? [text] : [] });
}

// ── Turn loop ────────────────────────────────────────────────────────────────

function _emptySession(kind, ctx) {
  return {
    kind,
    dateKey: ctx.dateKey,
    state: 'active', // active → ready → finished
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    messages: [],
    context: ctx,
    outcome: { commitments: [], focus: [], done: [], taskLinks: [] },
  };
}

/**
 * Run one assistant turn. Returns the session with the reply appended.
 *
 * The session is saved before returning, always — including when the model call
 * fails. A failed turn must never cost Nick what he already typed.
 */
// A session's context is built once, when it starts, and then stored — so a
// session opened at 08:30 kept offering commitments that were closed at 08:45,
// by a task tick, an earlier decision, or a note written since. Every read of
// the carried list re-asks standup-accountability, which is the one place that
// decides whether a commitment is still live.
function _refreshCarried(session) {
  const acc = session?.context?.accountability;
  if (!acc?.openCommitments) return;
  try {
    const { reconcile } = require('./standup-accountability');
    const { open, closed } = reconcile(acc.openCommitments);
    acc.openCommitments = open;
    const known = new Set((acc.closedCommitments || []).map(c => c.key));
    acc.closedCommitments = [...(acc.closedCommitments || []), ...closed.filter(c => !known.has(c.key))];
  } catch (e) {
    // Context, not a gate — the stored list is the old behaviour.
    console.warn('[StandupSession] Carried-list reconcile failed:', e.message);
  }
}

async function _turn(session) {
  _refreshCarried(session);
  const prompt = `${session.kind === KIND_EOD ? EOD_PROMPT : STANDUP_PROMPT}\n\n---\nCONTEXT (${session.dateKey}):\n${_renderContext(session.context)}`;

  const aiRouting = require('./ai-routing');
  let reply = '';

  // Tool path first, on whichever provider the routing policy picks (OpenRouter
  // by preference). Being configured only proves a key exists — it can still
  // fail at call time (expired key, no credit, rate limit), and when it does the
  // ritual must degrade, not die. A standup without tools is worth far more than
  // no standup; it simply cannot record decisions itself, so finish() writes
  // whatever was agreed in the transcript.
  const picked = aiRouting.getToolProvider('standup_interactive');
  if (picked) {
    try {
      const result = await picked.provider.chatWithTools(
        prompt,
        session.messages,
        toolDefinitions(),
        (name, input) => executeTool(session, name, input),
        // ⚠ THIS IS A TOOL-BLOCK BUDGET, NOT A PROSE BUDGET, and it was 400.
        // Message length is governed by the prompt ("under about 60 words"),
        // not by this number — what this has to cover is the prose PLUS every
        // tool call the turn makes, and the wrap-up turn legitimately makes
        // several at once. Measured on 11 Sep 2026: the closing turn emitted
        // five resolve_commitment calls, ran out at 400, delivered the fifth as
        // `{}` and never reached the `set_weekly_target` carrying the number
        // Nick had just given — so his target was dropped in silence and SAiM
        // asked him for it again. The providers now refuse a cut-off call
        // rather than running it, which makes the failure loud; this is what
        // stops it happening in the first place.
        { maxTokens: TOOL_TURN_MAX_TOKENS, maxRounds: 4 }
      );
      reply = result.text || '';
      session.degraded = false;
      try {
        aiRouting.recordUsage(result.usage, {
          provider: picked.name,
          model: result.model || null,
          taskType: `${session.kind || 'standup'}_tools`,
        });
      } catch {}
    } catch (e) {
      console.warn(`[StandupSession] Tool path (${picked.name}) failed, degrading:`, e.message);
      session.degradedReason = e.message.slice(0, 120);
    }
  }

  // Tool-less fallback — routes through the normal tiers (OpenAI → OpenRouter →
  // local Ollama), so this still works with the Pi offline from every cloud.
  if (!reply.trim()) {
    try {
      const result = await aiRouting.runTask('standup_interactive', {
        systemPrompt: prompt,
        messages: session.messages,
        maxTokens: 400,
      });
      reply = result.text || '';
      if (reply.trim()) session.degraded = true;
    } catch (e) {
      console.error('[StandupSession] Fallback failed too:', e.message);
    }
  }

  if (!reply.trim()) {
    const detail = session.degradedReason || 'no AI provider available';
    session.lastError = detail;
    save(session);
    throw new Error(`Could not reach any AI provider (${detail})`);
  }

  session.messages.push({ role: 'assistant', content: reply });
  session.updatedAt = new Date().toISOString();
  session.lastError = null;
  save(session);
  return session;
}

/** Start a session, or hand back today's if one is already going. */
async function start(kind, { restart = false } = {}) {
  const existing = load(kind);
  if (existing && !restart && existing.state !== 'finished') {
    _refreshCarried(existing);
    save(existing);
    return existing;
  }

  const ctx = await buildContext(kind);
  const session = _emptySession(kind, ctx);
  session.messages.push({
    role: 'user',
    content: kind === KIND_EOD ? "Let's do my end of day." : "Let's do my standup.",
  });
  save(session);
  return _turn(session);
}

// One turn at a time per (kind, date). Two tabs open, or a double-tap on send,
// and both requests would read the session, both append, and the slower write
// would clobber the faster one — losing a message in a flow whose entire point
// is that nothing typed gets lost. Held in memory deliberately: it guards a
// single process against itself, and only one backend serves this.
const _turnsInFlight = new Set();

/** Add Nick's reply and run the next turn. */
async function reply(kind, message) {
  const session = load(kind);
  if (!session) throw new Error('No session in progress — start one first');
  if (session.state === 'finished') throw new Error('This session is already finished');

  const text = String(message || '').trim();
  if (!text) throw new Error('message is required');

  const lock = `${kind}:${session.dateKey}`;
  if (_turnsInFlight.has(lock)) {
    const err = new Error('Still thinking about your last message — give it a second');
    err.code = 'TURN_IN_FLIGHT';
    throw err;
  }
  _turnsInFlight.add(lock);

  try {
    // Saved before the model is called, so a failed turn keeps what he typed.
    session.messages.push({ role: 'user', content: text });
    session.updatedAt = new Date().toISOString();
    save(session);

    return await _turn(session);
  } finally {
    _turnsInFlight.delete(lock);
  }
}

/** Resume today's session, if there is one. */
function resume(kind, dateKey = _today()) {
  return load(kind, dateKey);
}

// ── Finish ───────────────────────────────────────────────────────────────────

function _weekString(d) {
  const jan1 = new Date(d.getFullYear(), 0, 1);
  const weekNum = Math.ceil(((d - jan1) / 86400000 + jan1.getDay() + 1) / 7);
  return `${d.getFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

// The same commitment worded two ways is one commitment. Reuses task-dedupe's
// matcher at the CAPTURE threshold (0.85), not its own 0.42 — measured on Nick's
// real note: "Verify and compile her response" against "Verify and compile
// Phillipa's email response" scores 1.0 (containment), while "Handle Phillipa's
// email" against "Collate Phillipa's data and reply within the hour" scores
// 0.076 and correctly stays a separate line. Conservative on purpose: a missed
// merge leaves a visible duplicate, a wrong merge silently deletes a commitment
// from the note Nick works from.
const FOCUS_DUPE_SCORE = 0.85;

function _findDuplicate(text, existing) {
  if (!existing.length) return -1;
  try {
    const hit = require('./task-dedupe').findEquivalent(text, existing, { minScore: FOCUS_DUPE_SCORE });
    return hit ? hit.index : -1;
  } catch {
    // No matcher is not a reason to lose a line — fall back to exact text.
    return existing.findIndex(e => e.trim().toLowerCase() === String(text).trim().toLowerCase());
  }
}

/**
 * Build the morning daily note. Same section headings as the old guided flow —
 * standup-accountability parses them back tomorrow to work out what was carried,
 * so the format is a contract, not a preference.
 */
function _renderDailyNote(session) {
  const d = new Date();
  const o = session.outcome;
  const acc = session.context.accountability;
  const byKey = new Map((o.commitments || []).map(c => [c.key, c]));

  // ⚠ Today's focus and the carried list OVERLAP, and until 27 Aug 2026 nothing
  // reconciled them. `o.focus` is what Nick agreed this morning; the carried
  // list is what he agreed on previous mornings — and the commonest case by far
  // is that they are THE SAME COMMITMENT, because a thing he did not finish
  // yesterday is exactly the thing he commits to today.
  //
  // Rendered separately, one job appeared twice in Focus Today: his note on
  // 27 Aug held "Review Vantage prototype and sign off" byte-identically twice,
  // and "Verify and compile her response" beside "Verify and compile Phillipa's
  // email response". Six lines for three jobs.
  //
  // It compounds, which is what made it worth chasing rather than tidying:
  // today's Focus Today is what standup-accountability parses as tomorrow's
  // carry source, so every duplicate is re-read as another distinct open
  // commitment the next morning. That is why SAiM opened the standup insisting
  // on "four escalations" Nick had no memory of and could not find in his
  // calendar, then contradicted herself about which day they came from. She was
  // not malfunctioning; she was reasoning faithfully over a list that had been
  // quietly breeding.
  //
  // The carried version WINS on a match, because `#carried-Nd` is the useful
  // half — it is the only thing on the line that says how long this has been
  // rolling, and that age is what the day-3 decision rule keys on.
  // ⚠ A line that IS a NEURO task says so (11 Sep 2026). Without the marker
  // the note's wording and the task's wording are two items on the task list —
  // the Krista task showed as #30 AND as the standup's own copy of it — and
  // tomorrow's standup cannot tell the line has a task to put in a block. The
  // marker is an HTML comment, so the carry key is unchanged by it.
  const links = o.taskLinks || [];
  const taskForText = (text) => {
    for (const l of links) if (_findDuplicate(text, l.texts || []) !== -1) return l.taskId;
    return null;
  };
  const marker = (id) => (id ? ` <!--task:${id}-->` : '');

  const seen = [];
  const focus = [];
  const addFocus = (text, suffix, taskId = null) => {
    const dupIndex = _findDuplicate(text, seen);
    if (dupIndex !== -1) {
      // Same job, said twice. Keep whichever line carries the provenance, and
      // whichever of the two knew its task.
      const cur = focus[dupIndex];
      if (suffix.includes('#carried')) { cur.text = text; cur.suffix = suffix; }
      cur.taskId = cur.taskId || taskId;
      return;
    }
    seen.push(text);
    focus.push({ text, suffix, taskId });
  };

  for (const text of (o.focus || [])) addFocus(text, '#focus', taskForText(text));

  const carried = [];
  const dropped = [];
  // A commitment decided in THIS session is already closed by the ledger, so it
  // has left openCommitments — but it still owes the note its `## Decided` line.
  const decidedHere = (acc?.closedCommitments || []).filter(c => byKey.has(c.key));
  for (const c of [...(acc?.openCommitments || []), ...decidedHere]) {
    const decision = byKey.get(c.key);
    const tag = `#carried-${c.daysCarried}d`;
    // A likely match (`c.task`, unconfirmed) is NOT a link — only a marker
    // already on the line, or a task_id the standup recorded, is.
    const taskId = decision?.task_id || c.taskId || null;
    if (!decision) {
      // Not decided this morning — but if today's focus already covers it, it
      // must NOT also sit in Carry-Overs, or tomorrow reads one job as two.
      if (_findDuplicate(c.text, seen) === -1) carried.push(`- [ ] ${c.text} ${tag}${marker(taskId)}`);
      continue;
    }
    if (decision.decision === 'today') addFocus(c.text, `#focus ${tag}`, taskId);
    else if (decision.decision === 'dropped') dropped.push(`- ~~${c.text}~~ (dropped after ${c.daysCarried} days)`);
    else if (decision.decision === 'scheduled') dropped.push(`- ${c.text} → scheduled for ${decision.due_date || 'a date'}`);
    else if (decision.decision === 'done') dropped.push(`- ~~${c.text}~~ (already done)`);
    else if (_findDuplicate(c.text, seen) === -1) carried.push(`- [ ] ${c.text} ${tag}${marker(taskId)}`);
  }

  const focusLines = focus.map(f => `- [ ] ${f.text} ${f.suffix}${marker(f.taskId)}`);
  if (!focusLines.length) focusLines.push('- [ ] (no focus agreed) #focus');

  return `---
type: daily
date: ${session.dateKey}
week: ${_weekString(d)}
---
# Daily Note — ${d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}

## Focus Today
${focusLines.join('\n')}

## Carry-Overs
${carried.length ? carried.join('\n') : '- None'}
${dropped.length ? `\n## Decided\n${dropped.join('\n')}\n` : ''}
## Blockers
- ${o.blockers || 'None'}
${o.mood ? `\n## Mood\n- ${o.mood}\n` : ''}`;
}

/** The EOD section, appended to whatever the morning wrote. */
function _renderEodSection(session) {
  const o = session.outcome;
  const lines = ['', '## EOD', ''];
  if (o.done?.length) {
    lines.push('**Done:**');
    for (const item of o.done) lines.push(`- ${item}`);
  }
  lines.push(`**Didn't go to plan:** ${o.didntGo || 'Nothing'}`);
  if (o.tomorrowFirst) lines.push(`**Tomorrow starts with:** ${o.tomorrowFirst}`);
  if (o.mood) lines.push(`**Mood:** ${o.mood}`);

  // ⚠ The EOD dropped every resolve_commitment decision until 16 Sep 2026: an
  // evening that closed four carried commitments wrote none of it down. The
  // ledger is the authority now; these lines are the human-readable copy, in
  // the exact shapes standup-accountability parses back.
  const acc = session.context?.accountability;
  const textFor = (key) => [...(acc?.openCommitments || []), ...(acc?.closedCommitments || [])]
    .find(c => c.key === key)?.text || key;
  const decided = [];
  for (const d of (o.commitments || [])) {
    if (d.decision === 'done') decided.push(`- ~~${textFor(d.key)}~~ (already done)`);
    else if (d.decision === 'dropped') decided.push(`- ~~${textFor(d.key)}~~ (dropped)`);
    else if (d.decision === 'scheduled') decided.push(`- ${textFor(d.key)} → scheduled for ${d.due_date || 'a date'}`);
  }
  if (decided.length) lines.push('', '## Decided', ...decided);
  return lines.join('\n') + '\n';
}

/**
 * Write the ritual out and close the session.
 *
 * Allowed even when state is still 'active': if the model never got round to
 * calling set_focus, Nick should still be able to end the conversation and keep
 * what was agreed. A ritual you cannot exit is worse than one that ends untidily.
 */
// dateKey is explicit for the same reason load() and clear() take one: without
// it this resolved "today" internally, so anything addressing a specific day
// silently operated on a different one. A test pinned to a fixed date passed
// only while that date happened to be today, and started failing at midnight.
function finish(kind, dateKey = _today()) {
  const session = load(kind, dateKey);
  if (!session) throw new Error('No session to finish');
  if (session.state === 'finished') return { ok: true, alreadyFinished: true, session };

  // The note is tomorrow's carry source; render it from what is live NOW.
  _refreshCarried(session);

  if (kind === KIND_EOD) {
    const existing = obsidian.readTodayDailyNote() || '';
    if (existing.includes('## EOD')) {
      // Re-running EOD replaces the section rather than stacking a second one.
      obsidian.writeTodayDailyNote(existing.split('## EOD')[0].trimEnd() + '\n' + _renderEodSection(session));
    } else {
      obsidian.appendToDailyNote(_renderEodSection(session));
    }
    try { require('./nudges').markEodDone(); } catch {}
    try { require('./activity').trackEodDone(); } catch {}
  } else {
    obsidian.writeTodayDailyNote(_renderDailyNote(session));
    try { require('./nudges').markStandupDone(); } catch {}
    try { require('./activity').trackStandupDone(new Date().getHours(), true); } catch {}
  }

  try { require('./activity').trackVaultWrite('daily'); } catch {}

  session.state = 'finished';
  session.finishedAt = new Date().toISOString();
  save(session);
  return { ok: true, session };
}

module.exports = {
  KIND_STANDUP,
  KIND_EOD,
  start,
  reply,
  resume,
  finish,
  load,
  _renderDailyNote,
  _renderEodSection,
  save,
  clear,
  buildContext,
  buildSchedule,
  _renderSchedule,
  toolDefinitions,
  executeTool,
  _renderContext,
  _emptySession,
  _linkCommitments,
};
