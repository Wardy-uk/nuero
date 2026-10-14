'use strict';

/**
 * ONE answer to "what should SAiM lead with right now?" — `attention-decision-v1`
 * (Nick, 14 Oct 2026).
 *
 * Why it exists. At 17:00 on 14 Oct the same /api/canonical/now payload carried
 * THREE different leads, chosen by three selectors that never saw each other:
 *   - attention.gate's `primary`   → the EOD ritual context card;
 *   - presentation-intent's mode   → "Something needs you" (a drafted agenda
 *     request — ANY pending approval made the mode needs-attention);
 *   - SAiM Alt's own client model  → the 16:00–17:30 task block.
 * The control rendered the second and Alt the third, so two SAiM surfaces
 * disagreed about Nick's current situation while reading identical data.
 *
 * The rule now: this module decides, every surface renders. A surface may
 * differ in LAYOUT; it may not pick a different primary. It adds no candidates
 * (decision-engine still generates, attention.gate still filters) — it orders
 * what the payload already holds into primary / context / secondary and says
 * which rule chose each, in `trace`.
 *
 * PURE: `decide()` takes the payload plus the live block, block rows and focus
 * session (read by `gather()`), and a clock. No DB, no network.
 *
 * PRECEDENCE (first rule that applies wins the primary):
 *   P1 blind        — the pool could not be read. Nothing else can be trusted.
 *   P2 critical     — an attention item rated critical (a breaching escalation).
 *   P3 meeting      — a running meeting with other people in it.
 *   P4 deadline     — a governed approval whose window closes within
 *                     APPROVAL_INTERRUPT_MINUTES. Only a near deadline earns the
 *                     right to interrupt protected time.
 *   P5 block        — a RUNNING task block. Protected: it outranks rituals,
 *                     due-today work, ordinary attention items and approvals
 *                     with time to spare, which are all held as secondary.
 *   P6 approvals    — a waiting approval, when no block is protecting the time.
 *   P7 item         — attention's top item (decision-engine's ranking).
 *   P8 protected    — a running solo diary entry that is not a task block.
 *   P9 upcoming     — a task block starting within its lead window.
 *   P10 ritual      — the standup / end-of-day wrap, when nothing above holds.
 *   P11 none        — nothing; said honestly, never padded.
 *
 * THE APPROVAL QUESTION (Nick asked for it to be decided, 14 Oct 2026): a
 * drafted agenda request does NOT interrupt an active task block. It stays
 * visible as a secondary judgement item ("needs your judgement") while the block
 * is protected, and becomes primary when (a) no block is running, or (b) its own
 * window closes within the hour. Reason: an approval is a hand-off to the
 * desktop that can wait for the end of a block (Build 9 deliberately kept it out
 * of the decision pool and the operation phases); a block is the one thing Nick
 * has already decided to be doing, and his difficulty is starting, not knowing.
 */

const CONTRACT = 'attention-decision-v1';
const APPROVAL_INTERRUPT_MINUTES = 60;
const BLOCK_OUTRANKS_ACTIVITY = new Set(['ritual', 'steady', 'working']);

const pad = (n) => String(n).padStart(2, '0');
const dayKey = (ms) => { const t = new Date(ms); return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`; };
const hhmm = (ms) => { const t = new Date(ms); return `${pad(t.getHours())}:${pad(t.getMinutes())}`; };
const toMin = (s) => { const m = /^(\d{1,2}):(\d{2})/.exec(String(s || '')); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
/** Graph wall-clock string → HH:MM, sliced, never parsed (the BST rule). */
const slice = (iso) => (typeof iso === 'string' && iso.length >= 16 ? iso.slice(11, 16) : null);
const keyDays = (key) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ''));
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86400000 : null;
};

// ── Task wording ────────────────────────────────────────────────────────────

const BRACKET_DATE = /\s*\((?:\d{1,2}(?:st|nd|rd|th)?\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*(?:\s+\d{4})?|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?|\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\)/gi;
const TRAILING_WHEN = /\s+(?:tomorrow|today|tonight|this (?:morning|afternoon|evening|week))\s*$/i;

/** A task's wording tidied for a time-labelled slot. Display only; never stored. */
function displayTitle(text) {
  const raw = String(text || '').trim();
  if (!raw) return raw;
  let t = raw.split(/(?<=[.!?])\s+(?=[A-Z])/)[0];
  t = t.replace(BRACKET_DATE, '').replace(/[.!?]+$/, '').trim();
  t = t.replace(TRAILING_WHEN, '').trim().replace(/[\s,;:–—-]+$/, '').trim();
  return t.length >= 8 ? t : raw;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const FULL_DATE = /\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{4})\b|\b(\d{4})-(\d{2})-(\d{2})\b/gi;
const RELATIVE = /\b(tomorrow|tonight|today)\b/i;
const longDate = (key) => { const [y, m, d] = key.split('-').map(Number); return `${d} ${MONTH_NAMES[m - 1]} ${y}`; };

/**
 * Does the wording contradict the CURRENT planned date? Judged conservatively:
 * a relative day that no longer matches, or a full date (with a year) that
 * differs. A bare "September 30" may be the deadline the task is about, so it is
 * left alone. Returns the reason, or null.
 */
function staleWording(text, dueDate, now) {
  const due = keyDays(dueDate);
  const today = keyDays(dayKey(now));
  if (due == null || today == null) return null;
  const t = String(text || '');
  const dueWord = due === today ? 'today' : due === today + 1 ? 'tomorrow' : `on ${longDate(dueDate)}`;
  const rel = RELATIVE.exec(t);
  if (rel) {
    const word = rel[1].toLowerCase();
    if ((word === 'tomorrow' ? today + 1 : today) !== due) return `says “${word}” but it’s planned for ${dueWord}`;
  }
  FULL_DATE.lastIndex = 0;
  let m;
  while ((m = FULL_DATE.exec(t))) {
    const key = m[4] ? `${m[4]}-${m[5]}-${m[6]}`
      : `${m[3]}-${pad(MONTHS.indexOf(m[2].toLowerCase().slice(0, 3)) + 1)}-${pad(Number(m[1]))}`;
    if (keyDays(key) != null && keyDays(key) !== due) return `names ${longDate(key)} but it’s planned for ${dueWord}`;
  }
  return null;
}

// ── Readers over the payload ─────────────────────────────────────────────────

const commitmentsOf = (p) => {
  const s = p && p.situation && (p.situation.sections || p.situation);
  return Array.isArray(s && s.commitments) ? s.commitments : [];
};
const neuroTaskId = (c) => { const m = /^task:neuro:(\d+)$/.exec(String((c && c.taskId) || '')); return m ? Number(m[1]) : null; };
const todayAgenda = (p) => {
  const a = p && p.agenda;
  return a && a.known && a.scope === 'today' ? (a.events || []) : null;
};
const TASK_BLOCK_EVENT = /^task block:\s*/i;
const RITUAL = (title) => (/\beod\b|end.of.day/i.test(title || '') ? 'the end-of-day wrap' : /stand-?up/i.test(title || '') ? 'the morning standup' : null);
const utterancesOf = (p) => ((p && p.utterances) || []).filter((u) => u && u.say && u.intent);

function runningMeeting(p) {
  const ev = (todayAgenda(p) || []).find((e) => e && e.running && !e.allDay && e.attendeesOther === true);
  return ev ? { title: ev.subject || 'Meeting', start: slice(ev.start), end: slice(ev.end) } : null;
}

function protectedNow(p, rows) {
  const starts = new Set((rows || []).map((r) => r.startTime));
  const ev = (todayAgenda(p) || []).find((e) => e && e.running && !e.allDay && e.attendeesOther !== true
    && !TASK_BLOCK_EVENT.test(String(e.subject || '')) && !starts.has(slice(e.start)));
  return ev ? { title: ev.subject || 'Protected time', start: slice(ev.start), end: slice(ev.end) } : null;
}

function blockView(block, session) {
  if (!block || !block.blockId) return null;
  const tasks = Array.isArray(block.tasks) ? block.tasks : [];
  let state = block.running ? 'active' : 'upcoming';
  if (block.allTicked) state = 'complete';
  else if (block.running && session && (session.status === 'paused' || session.status === 'interrupted')) state = 'interrupted';
  const named = tasks.length === 1 ? tasks[0] : tasks.find((t) => t.running) || null;
  return {
    blockId: block.blockId, start: block.startTime, end: block.endTime, state,
    task: named ? { taskId: named.taskId, text: named.text } : null,
    taskIds: tasks.map((t) => t.taskId), taskCount: tasks.length,
  };
}

/** Everything still to start today — task blocks (solo or not), meetings and protected time. */
function upcomingToday(p, rows, { now, blocksKnown, exclude }) {
  const nowMin = toMin(hhmm(now));
  const today = dayKey(now);
  const items = [];
  for (const r of rows || []) {
    if (!r || r.dateKey !== today || r.passed || exclude.has(r.blockId) || toMin(r.startTime) <= nowMin) continue;
    const tasks = r.tasks || [];
    items.push({ kind: 'block', start: r.startTime, end: r.endTime, title: tasks.length === 1 ? displayTitle(tasks[0].text) : `${tasks.length} tasks` });
  }
  const starts = new Set(items.map((i) => i.start));
  for (const e of todayAgenda(p) || []) {
    const s = slice(e.start);
    if (!s || e.allDay || e.running || toMin(s) <= nowMin || starts.has(s)) continue;
    const subject = String(e.subject || '');
    if (TASK_BLOCK_EVENT.test(subject)) {
      // A solo task block IS a transition (rule 3). Shown from the block list
      // when that was read; from the diary when it was not.
      if (blocksKnown) continue;
      items.push({ kind: 'block', start: s, end: slice(e.end), title: displayTitle(subject.replace(TASK_BLOCK_EVENT, '')) });
    } else {
      items.push({ kind: e.attendeesOther === true ? 'meeting' : 'protected', start: s, end: slice(e.end), title: subject || 'Meeting' });
    }
  }
  return items.sort((a, b) => toMin(a.start) - toMin(b.start));
}

function owedToday(p, { now, exclude }) {
  const today = keyDays(dayKey(now));
  const out = [];
  for (const c of commitmentsOf(p)) {
    if (!c || c.state !== 'open' || c.direction !== 'i-owe' || !c.due || !c.due.date) continue;
    const id = neuroTaskId(c);
    if (id != null && exclude.has(id)) continue;
    const d = keyDays(c.due.date);
    if (d == null || d > today) continue;
    const late = today - d;
    const stale = staleWording(c.description, c.due.date, now);
    out.push({
      kind: late === 0 ? 'due-today' : 'overdue', taskId: id,
      title: displayTitle(c.description), fullTitle: stale ? null : c.description,
      why: late === 0 ? 'due today' : `${late} day${late === 1 ? '' : 's'} overdue`,
      stale: stale ? { taskId: id, reason: stale } : null,
    });
  }
  return out.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'overdue' ? -1 : 1));
}

function minutesUntil(iso, now) {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.round((t - now) / 60000) : null;
}

// ── The decision ─────────────────────────────────────────────────────────────

/**
 * @param {object} payload  the canonical Now payload (attention decision + situation)
 * @param {object} live     { block: task-blocks.liveBlock() | null, rows: listOutstanding rows | null, session: focus session | null }
 */
function decide(payload, live = {}, { now = Date.now() } = {}) {
  const p = payload || {};
  const rows = Array.isArray(live.rows) ? live.rows : null;
  const blocksKnown = Boolean(rows);
  const session = live.session || null;
  const sessionLive = Boolean(session && !['done', 'abandoned'].includes(session.status));
  const block = blockView(live.block, session);
  const blockActive = Boolean(block && (block.state === 'active' || block.state === 'interrupted'));
  const ctx = p.context || {};
  const ap = p.approvals && p.approvals.known !== false ? p.approvals : null;
  const approvalCount = ap ? (ap.needsApproval || 0) + (ap.needsReview || 0) : 0;
  const approvalMinutes = ap && ap.soonestExpiresAt ? minutesUntil(ap.soonestExpiresAt, now) : null;
  const card = p.primary || null;
  const item = card && card.kind === 'item' ? card : null;
  const ritualWord = card && card.kind === 'context' ? RITUAL(card.title) : null;
  const meeting = runningMeeting(p);
  const prot = blockActive ? null : protectedNow(p, rows);
  const critical = [item, ...(p.secondary || [])].find((s) => s && s.kind === 'item' && String(s.urgency || '').toLowerCase() === 'critical') || null;
  const blind = p.poolAvailable === false || p.available === false;
  const utter = utterancesOf(p);

  const trace = [];
  const rule = (id, applies, why) => { trace.push({ rule: id, applies: Boolean(applies), why }); return Boolean(applies); };

  let primary = null;
  const itemPrimary = (c, ruleId, reason) => ({
    kind: 'item', rule: ruleId, id: c.recordId || c.id || null, type: c.type || null,
    title: c.title || c.say || null, reason: reason || c.reason || c.say || null,
    actions: utter.filter((u) => u.intent.recordId && u.intent.recordId === c.recordId).map((u) => ({ say: u.say, intent: u.intent })),
  });
  const blockPrimary = (ruleId, reason) => {
    const actions = [];
    if (block.task && !sessionLive && (block.state === 'active' || block.state === 'upcoming')) {
      actions.push({ say: 'I’m on it', intent: { kind: 'start-block', taskId: block.task.taskId, text: block.task.text, blockId: block.blockId } });
    }
    for (const u of utter) if (u.intent.kind === 'session') actions.push({ say: u.say, intent: u.intent });
    let title = null; let stale = null;
    if (block.task) {
      title = displayTitle(block.task.text);
      const c = commitmentsOf(p).find((x) => neuroTaskId(x) === Number(block.task.taskId));
      const s = c && c.due && c.due.date ? staleWording(block.task.text, c.due.date, now) : null;
      if (s) stale = { taskId: block.task.taskId, reason: s };
    }
    return {
      kind: 'block', rule: ruleId, id: `block:${block.blockId}`, blockId: block.blockId, state: block.state,
      title, fullTitle: block.task && !stale ? block.task.text : null, start: block.start, end: block.end,
      taskCount: block.taskCount, stale, reason,
      note: !block.task && block.taskCount > 1 ? `${block.taskCount} tasks share this block — SAiM can’t tell which one you’re on.` : null,
      actions,
    };
  };

  if (rule('P1 blind', blind, blind ? 'the attention pool could not be read' : 'pool read')) {
    primary = { kind: 'blind', rule: 'P1 blind', id: 'blind', title: 'I can’t see your work right now', reason: 'This isn’t an all-clear.', actions: [] };
  } else if (rule('P2 critical', critical, critical ? `“${critical.title}” is rated critical` : 'no critical item')) {
    primary = itemPrimary(critical, 'P2 critical', critical.reason);
  } else if (rule('P3 meeting', meeting, meeting ? `“${meeting.title}” is running with other people in it` : 'no meeting running')) {
    primary = { kind: 'meeting', rule: 'P3 meeting', id: `meeting:${meeting.start}`, title: meeting.title, start: meeting.start, end: meeting.end,
      reason: 'You’re in a meeting; everything else is held.', actions: utter.filter((u) => u.intent.kind === 'meeting').map((u) => ({ say: u.say, intent: u.intent })) };
  } else if (rule('P4 deadline', approvalCount && approvalMinutes != null && approvalMinutes <= APPROVAL_INTERRUPT_MINUTES,
    approvalCount ? (approvalMinutes == null ? 'approval has no recorded deadline' : `approval window closes in ${approvalMinutes} min (interrupts at ≤ ${APPROVAL_INTERRUPT_MINUTES})`) : 'nothing waiting for approval')) {
    primary = { kind: 'needs-you', rule: 'P4 deadline', id: 'approvals', title: ap.say, reason: `Its window closes in ${approvalMinutes} minutes.`, handOff: ap.where || null, count: approvalCount, actions: [] };
  } else if (rule('P5 block', blockActive, block ? `block ${block.blockId} ${block.start}–${block.end} is ${block.state}` : 'no task block running')) {
    primary = blockPrimary('P5 block', 'The time you blocked for this — everything else is held until it ends.');
  } else if (rule('P6 approvals', approvalCount, approvalCount ? `${approvalCount} waiting and no block is protecting the time` : 'nothing waiting for approval')) {
    primary = { kind: 'needs-you', rule: 'P6 approvals', id: 'approvals', title: ap.say, reason: ap.where ? `Review in ${ap.where}.` : null, handOff: ap.where || null, count: approvalCount, actions: [] };
  } else if (rule('P7 item', item && item.type !== 'meeting', item ? `attention’s top item: “${item.title}”` : 'no attention item')) {
    primary = itemPrimary(item, 'P7 item');
  } else if (rule('P8 protected', prot, prot ? `“${prot.title}” is protected diary time` : 'no protected time running')) {
    primary = { kind: 'protected', rule: 'P8 protected', id: `protected:${prot.start}`, title: prot.title, start: prot.start, end: prot.end, reason: 'The diary protects this time, but no task block names what it’s for.', actions: [] };
  } else if (rule('P9 upcoming', block && block.state === 'upcoming', block ? `block ${block.blockId} starts at ${block.start}` : 'no block about to start')) {
    primary = blockPrimary('P9 upcoming', `Starts at ${block.start}.`);
  } else if (rule('P10 ritual', ritualWord || (item && item.type === 'meeting'), ritualWord ? `${ritualWord} is outstanding` : item ? 'a meeting is about to start' : 'no ritual outstanding')) {
    primary = ritualWord
      ? { kind: 'ritual', rule: 'P10 ritual', id: card.id || 'ritual', title: card.title, reason: card.reason || card.say || null, actions: [] }
      : itemPrimary(item, 'P10 ritual');
  } else {
    rule('P11 none', true, 'nothing applies');
    primary = { kind: 'none', rule: 'P11 none', id: null, title: null, reason: 'No task block is protecting this time, and nothing needs you.', actions: [] };
  }

  // ── Context: kept whether or not it won ──
  const context = {
    activity: ctx.activity || null,
    doing: blockActive && (!ctx.activity || BLOCK_OUTRANKS_ACTIVITY.has(ctx.activity)) ? 'in a task block' : null,
    meeting,
    block,
    ritual: ritualWord ? { id: card.id || null, title: card.title, phrase: ritualWord, reason: card.reason || null } : null,
    protected: prot,
    place: (p.life && p.life.place) || ctx.place || null,
    desk: p.work && typeof p.work.atDesk === 'boolean' && p.work.deskKnown !== false ? { atDesk: p.work.atDesk } : null,
  };

  // ── Secondary ──
  const held = [];
  if (ritualWord && primary.kind !== 'ritual') held.push({ kind: 'ritual', title: ritualWord.replace(/^the /, '').replace(/^./, (c) => c.toUpperCase()), why: card.reason || card.say || null, phrase: ritualWord });
  if (item && primary.id !== (item.recordId || item.id) && item.type !== 'meeting') held.push({ kind: 'item', title: item.title, why: item.reason || null, recordId: item.recordId || null });
  if (primary.kind !== 'item') {
    const exclude = new Set(block ? block.taskIds : []);
    held.push(...owedToday(p, { now, exclude }));
  }
  for (const d of p.dropped || []) held.push({ kind: d.type || 'other', title: d.title || d.type || 'Item', why: d.why || null });

  const next = upcomingToday(p, rows, { now, blocksKnown, exclude: new Set(block && primary.kind === 'block' ? [block.blockId] : []) });
  const nowMin = toMin(hhmm(now));
  const after = primary.end ? next.find((n) => toMin(n.start) >= toMin(primary.end)) || null : null;
  const judgement = ap
    ? { count: approvalCount, say: ap.say || null, where: ap.where || null, deadlineMinutes: approvalMinutes, primary: primary.kind === 'needs-you' }
    : null;

  return {
    contract: CONTRACT,
    decidedAt: new Date(now).toISOString(),
    primary,
    context,
    secondary: {
      held,
      next: next[0] ? { ...next[0], inMinutes: toMin(next[0].start) - nowMin } : null,
      after,
      judgement,
      corrections: [...(primary.stale ? [primary.stale] : []), ...held.filter((h) => h.stale).map((h) => h.stale)],
    },
    known: { blocks: blocksKnown, agenda: Boolean(todayAgenda(p)), approvals: Boolean(ap) },
    trace,
  };
}

/** Reads the live block, today's block rows and the focus session. Never throws. */
function gather({ now = Date.now() } = {}) {
  const out = { block: null, rows: null, session: null, gaps: [] };
  try { out.session = require('./focus-session').current(now) || null; } catch (e) { out.gaps.push({ input: 'session', why: e.message }); }
  try {
    const tb = require('./task-blocks');
    const r = tb.listOutstanding({ now: new Date(now) });
    if (r.error) out.gaps.push({ input: 'task-blocks', why: r.error });
    else out.rows = r.rows;
    out.block = tb.liveBlock(r.rows || [], new Date(now), { sessionTaskIds: out.session && out.session.taskId != null ? [out.session.taskId] : [] });
  } catch (e) { out.gaps.push({ input: 'task-blocks', why: e.message }); }
  return out;
}

module.exports = { CONTRACT, APPROVAL_INTERRUPT_MINUTES, decide, gather, staleWording, displayTitle };
