// SAiM Alt v2 — fixtures for tests and screenshots ONLY.
//
// Synthetic, shaped like the live canonical payloads (checked against a live
// read on 14 Oct 2026) but with invented work and no real names — the repo is
// public. Nothing here is imported by App.jsx, sends anything, or writes.

const DAY = [2026, 9, 14]; // 14 Oct 2026, a Wednesday (local time)
export const at = (h, m) => new Date(DAY[0], DAY[1], DAY[2], h, m).getTime();
const iso = (h, m) => `2026-10-14T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00.0000000`;

const APPS = ['browser', 'claude', 'code', 'excel', 'music', 'neuro', 'obsidian', 'outlook', 'word']
  .map((id) => ({ id, label: ({ browser: 'Browser', claude: 'Claude', code: 'VS Code', excel: 'Excel', music: 'Music', neuro: 'NEURO', obsidian: 'Obsidian', outlook: 'Outlook', word: 'Word' })[id] }));

const work = (app = 'code', extra = {}) => ({
  known: true, kind: 'app', task: null, taskIds: [], app, confidence: 'low', source: 'desktop-activity',
  atDesk: true, deskKnown: true, host: 'LAPTOP-FIXTURE', canOpen: APPS.map((a) => a.id),
  deskOffer: { known: true, host: 'LAPTOP-FIXTURE', apps: APPS, why: null }, ...extra,
});
const context = (activity, level = 'high') => ({ activity, confidence: { score: 0.9, level, basis: ['clock'], rationale: 'fixture' } });
const ev = (sh, sm, eh, em, subject, attendeesOther, now) => ({
  start: iso(sh, sm), end: iso(eh, em), subject, allDay: false, attendeesOther,
  minutesAway: Math.round((at(sh, sm) - now) / 60000),
  running: at(sh, sm) <= now && now < at(eh, em),
});
const act = (recordId, action, say, extra = {}) => ({ say, intent: { kind: 'act', action, recordId, ...extra }, phrases: [say] });
const blockRow = (blockId, sh, sm, eh, em, tasks, now, status = 'scheduled') => ({
  blockId, tasks: tasks.map((text, i) => ({ taskId: blockId * 10 + i, text, awaiting: false, allottedMinutes: null })),
  dateKey: '2026-10-14', startTime: `${String(sh).padStart(2, '0')}:${String(sm).padStart(2, '0')}`,
  endTime: `${String(eh).padStart(2, '0')}:${String(em).padStart(2, '0')}`,
  minutes: (eh * 60 + em) - (sh * 60 + sm), minutesAssumed: false, notePath: null, noteExists: false,
  status, passed: at(eh, em) <= now, webLink: null, vaultError: null,
});
const blockNowOf = (row, now) => ({
  blockId: row.blockId, startTime: row.startTime, endTime: row.endTime, minutes: row.minutes, minutesAssumed: false,
  startsInMinutes: Math.round((at(...row.startTime.split(':').map(Number)) - now) / 60000),
  running: at(...row.startTime.split(':').map(Number)) <= now,
  tasks: row.tasks.map((t) => ({ taskId: t.taskId, text: t.text, allottedMinutes: null, running: false })),
  allTicked: false, anyRunning: false,
});

export const BRIEFING = {
  ok: true,
  briefing: {
    id: 99, kind: 'daily', date: '2026-10-14', dayType: 'work', createdAt: '2026-10-14T07:00:00Z', updatedAt: '2026-10-14T07:00:00Z',
    delivery: { at: '2026-10-14T07:00:04Z' },
    payload: {
      dayLabel: 'Wednesday 14 October', dayType: 'work', context: { weather: 'Dry, 12°C' }, needsYouCount: 2, held: { work: 0 }, gaps: [],
      close: 'Two things need you before lunch; the afternoon is yours to build.',
      sections: [
        { id: 'needs-you', label: 'Needs you', items: [
          { key: 'a', kind: 'commitment', title: 'Rota draft owed to the team leads', detail: 'Promised in Monday’s meeting for today.', why: 'You said today.', needsYou: true, items: [], source: 'commitments', link: null },
          { key: 'b', kind: 'email', title: 'Customer escalation reply waiting', detail: 'From the account manager, 08:12.', why: null, needsYou: true, items: [], source: 'email', link: null },
        ] },
        { id: 'today', label: 'Today', items: [
          { key: 'c', kind: 'diary', title: '3 meetings, 2 task blocks', detail: null, why: null, needsYou: false, items: ['11:00 Weekly support leads', '15:00 Supplier call', '16:30 Team check-in'], source: 'calendar', link: null },
        ] },
        { id: 'worth-knowing', label: 'Worth knowing', items: [
          { key: 'd', kind: 'health', title: 'Slept 7h40 — about usual', detail: null, why: null, needsYou: false, items: [], source: 'health', link: null },
        ] },
      ],
    },
  },
};

const base = (now, over = {}) => ({
  canonical: {
    available: true, poolAvailable: true, quiet: false, context: context('working'), primary: null, transition: null,
    nextMeeting: null, agenda: { known: true, scope: 'today', events: [] }, utterances: [], dropped: [], work: work(), ...over.canonical,
  },
  adhd: { blockNow: null, ...over.adhd },
  taskBlocks: { ok: true, blocks: [], minOutcomeChars: 25, ...over.taskBlocks },
  session: { session: null, ...over.session },
  briefing: BRIEFING,
  now,
});

/** The six scenarios the brief asks for. */
export function scenario(id) {
  switch (id) {
    case 'active-block': {
      const now = at(9, 52);
      const b = blockRow(201, 9, 30, 10, 30, ['Build the Q4 cover rota spreadsheet'], now);
      const next = blockRow(202, 12, 0, 12, 45, ['Reply to the supplier contract questions'], now);
      return base(now, {
        canonical: {
          context: context('in-focus-session'),
          agenda: { known: true, scope: 'today', events: [
            ev(9, 30, 10, 30, 'Task block: Build the Q4 cover rota spreadsheet', false, now),
            ev(11, 0, 11, 45, 'Weekly support leads', true, now),
            ev(12, 0, 12, 45, 'Task block: Reply to the supplier contract questions', false, now),
            ev(14, 0, 15, 0, 'Focus — no meetings', false, now),
          ] },
          work: work('chrome'),
          utterances: [
            { say: 'That’s done', intent: { kind: 'session', action: 'finish' }, phrases: ['That’s done'] },
            { say: 'I got pulled away', intent: { kind: 'session', action: 'step-away' }, phrases: ['I got pulled away'] },
          ],
        },
        adhd: { blockNow: blockNowOf(b, now) },
        taskBlocks: { blocks: [next, b] },
        session: { session: { id: 's1', status: 'active', taskId: 2010, text: b.tasks[0].text, nextStep: 'Fill in the week-1 shift breakdown', startedAt: '2026-10-14T08:31:00Z' } },
      });
    }
    case 'upcoming-meeting': {
      const now = at(10, 44);
      const rec = 'att_fx_meet_1';
      return base(now, {
        canonical: {
          context: context('pre-meeting'),
          primary: { kind: 'item', type: 'meeting', title: 'Weekly support leads', say: 'In 16 minutes.', reason: 'In 16 min', recordId: rec, urgency: 'high' },
          nextMeeting: { key: 'id:fx::2026-10-14T11:00', subject: 'Weekly support leads', time: '11:00' },
          agenda: { known: true, scope: 'today', events: [
            ev(11, 0, 11, 45, 'Weekly support leads', true, now),
            ev(12, 0, 12, 45, 'Task block: Reply to the supplier contract questions', false, now),
          ] },
          utterances: [act(rec, 'acknowledge', 'Seen it'), act(rec, 'defer', 'Not now — an hour', { minutes: 60, reason: 'not-now' })],
        },
        taskBlocks: { blocks: [blockRow(202, 12, 0, 12, 45, ['Reply to the supplier contract questions'], now)] },
      });
    }
    case 'protected-block': {
      const now = at(14, 12);
      return base(now, {
        canonical: {
          context: context('steady', 'moderate'),
          agenda: { known: true, scope: 'today', events: [
            ev(14, 0, 15, 0, 'Focus — no meetings', false, now),
            ev(15, 0, 15, 30, 'Supplier call', true, now),
          ] },
        },
      });
    }
    case 'out-of-hours': {
      const now = at(20, 15);
      return base(now, {
        canonical: {
          context: context('off'), quiet: false,
          agenda: { known: true, scope: 'tomorrow', events: [{ start: '2026-10-15T09:00:00.0000000', end: '2026-10-15T09:15:00.0000000', subject: 'Team standup', allDay: false, attendeesOther: true, minutesAway: null, running: false }] },
          work: work(null, { atDesk: false, app: null }),
        },
      });
    }
    case 'notify-saim': {
      const s = scenario('active-block');
      return { ...s, notification: { type: 'task_block', key: 'block:201', blockId: 201, title: 'Block started', body: 'Build the Q4 cover rota spreadsheet' } };
    }
    case 'notify-neuro': {
      const s = scenario('active-block');
      return { ...s, notification: { type: 'email', key: 'email:fixture-1', url: '/?view=inbox', title: 'Urgent email', body: 'Customer escalation reply waiting' } };
    }
    default: throw new Error(`unknown scenario ${id}`);
  }
}

export const SCENARIOS = Object.freeze(['active-block', 'upcoming-meeting', 'protected-block', 'out-of-hours', 'notify-saim', 'notify-neuro']);
