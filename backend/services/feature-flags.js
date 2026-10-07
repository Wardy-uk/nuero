'use strict';

// Feature switches that are Nick's decision, settable in Settings.
//
// Every one of these was `process.env.X === 'true'` captured into a module-level
// const at require time, so changing his mind meant an SSH session, an .env edit
// and a pm2 restart. Two of them — the day planner and its health rule — are
// recorded in CLAUDE.md as HIS calls, which made them exactly the wrong things
// to bury behind six steps of friction on a system whose stated premise is that
// his bottleneck is initiation.
//
// Same shape as `notion-sync` and the OpenRouter key before it: the value lives
// in `agent_state`, the environment still WINS where explicitly set, and it is
// read at CALL time so a toggle takes effect immediately.
//
// ⚠ Read at call time is the load-bearing half. A module-level const captured at
// require time is why the .env edit needed a restart in the first place; moving
// the value to the DB without moving the READ would have changed nothing.

const db = require('../db/database');

const STATE_PREFIX = 'feature_flag:';

/**
 * ⚠ The two default polarities are NOT cosmetic and must be preserved exactly.
 *
 *   default false — the switch must be turned ON deliberately, because the thing
 *     it enables writes to the outside world or acts on Nick's behalf.
 *   default true  — the switch is a KILL SWITCH for behaviour that is already
 *     live and wanted; flipping the default would silently disable a working
 *     feature the moment this file shipped.
 */
const FLAGS = [
  {
    key: 'day_planner',
    env: 'DAY_PLANNER_ENABLED',
    default: false,
    label: 'Auto-plan focus blocks',
    description: 'Books real calendar events twice a day (07:15 and 12:30, Mon–Fri) '
      + 'against gaps in your diary.',
    impact: 'writes to your calendar',
  },
  {
    key: 'day_planner_health',
    env: 'DAY_PLANNER_HEALTH_CAPACITY',
    default: false,
    label: 'Lighter plan on a low-recovery day',
    description: 'Plans one shorter block when readiness is down. It only ever REDUCES, '
      + 'never reorders, and an unknown reading plans as normal. '
      + 'Measured: no effect on output (p = 0.97) — this is a preference, not a prediction.',
    requires: 'day_planner',
  },
  {
    key: 'capture_dedupe',
    env: 'CAPTURE_DEDUPE_ENABLED',
    default: true,
    description: 'Folds the same commitment extracted from several meeting notes into one '
      + 'action. Measured: 258 pending actions collapse to 54.',
    label: 'Fold duplicate captured commitments',
  },
  {
    key: 'teams_dm',
    env: 'TEAMS_DM_ENABLED',
    default: true,
    label: 'Send chases as a Teams DM',
    description: 'Falls back to email when Teams cannot deliver. Dark until the '
      + 'ChatMessage.Send scope is consented by a tenant admin.',
  },
  {
    key: 'vesta_photo',
    env: 'VESTA_PHOTO_ENABLED',
    default: false,
    label: 'Read the fridge from a photo',
    description: 'Lets the household surface turn a photograph of a shelf into a proposed '
      + 'list somebody confirms. It writes nothing on its own. The condition was to '
      + 'prove the typed path first — and it is the only route on the public mount that '
      + 'spends money, so it is capped per account per day.',
    impact: 'costs money per photo',
  },
  {
    key: 'jira_assigned_sync',
    env: 'JIRA_ASSIGNED_SYNC_ENABLED',
    default: false,
    label: 'Turn Jira tickets assigned to you into tasks',
    description: 'Hourly on weekdays: a ticket assigned to you becomes a task, and the task '
      + 'closes when the ticket does. Preview exactly what it would do first — the dry run '
      + 'on Jira status in NEURO Health works whether this is on or off.',
    impact: 'creates and closes tasks in your list',
  },
  {
    key: 'governed_execution',
    env: 'GOVERNED_EXECUTION_ENABLED',
    // ⚠ Build 7: default FALSE. It shipped default-true in Build 6, but it
    // sends email as Nick, and the rule at the top of this list says such a
    // switch is turned ON deliberately. Measured before changing it: the live
    // Pi had NO stored value — it was on purely by default, never chosen — so
    // this changes no decision Nick made. A stored 'true' or 'false' (his
    // choice in Settings) still wins over this default, and the env var wins
    // over both.
    //
    // ⚠ Build 8: ONE switch for every governed outbound type — chases, email
    // replies, agenda requests and the weekly risk report. There is
    // deliberately no per-type switch: a second switch is a second way for one
    // kind of email to be "on" while Nick believes sending is off.
    default: false,
    label: 'Send approved emails',
    description: 'Covers every email NEURO can send as you: chases, replies from the Inbox, agenda requests '
      + 'to meeting organisers, and the weekly risk report. When this is on and you approve a drafted '
      + 'email with your approval code, NEURO sends exactly that email and then checks Sent Items to '
      + 'confirm it went. It never bypasses approval: nothing is sent unless you approved those exact '
      + 'words and recipients. While it is off, NEURO still drafts them for you to read, edit or reject, '
      + 'but will not let you approve one — approving would send nothing. Turning it off after approving '
      + 'holds the send; the approval then expires after 24 hours.',
    impact: 'sends email as you, only after you approve it',
  },
  {
    key: 'governed_calendar',
    env: 'GOVERNED_CALENDAR_ENABLED',
    // ⚠ Build 11K: default FALSE, for the same reason as the email switch — it
    // makes Microsoft send invitations, updates and cancellations to other
    // people as Nick. Deliberately its OWN switch: turning email sending on
    // must not quietly start sending calendar invites too.
    default: false,
    label: 'Send approved calendar changes',
    description: 'Covers every calendar change NEURO can make that other people are told about: a new invite '
      + '(1-2-1 Book, the event composer, a meeting from chat), moving a meeting, and cancelling one. When '
      + 'this is on and you approve one with your approval code, NEURO makes exactly that change and then '
      + 'reads the event back to confirm it. While it is off, NEURO still prepares them for you to read or '
      + 'reject, but will not let you approve one. Your own solo blocks (focus blocks, Plaud admin blocks) are '
      + 'not affected — nobody else is told about those.',
    impact: 'invites, moves and cancels meetings as you, only after you approve it',
  },
  {
    key: 'source_blind_live',
    env: 'SOURCE_BLIND_LIVE',
    // ⚠ Build 13O: the ONE evaluator promoted from shadow to live, and this is
    // its kill switch. Default FALSE so a fresh install stays in shadow; on the
    // Pi it is stored ON. `SOURCE_BLIND_MODE` (shadow|live|off), when set in
    // the environment, still wins over this switch.
    default: false,
    label: 'Tell me when a sense has really stopped',
    description: 'Lets the source-blindness check put a card on Now, and offer one push, when a sense NEURO '
      + 'depends on has genuinely stopped: three deliveries in a row failing, or nothing heard for 30 hours. '
      + 'An app iOS simply has not woken overnight is NOT raised (measured: every such gap healed within 24h). '
      + 'The attention rules still decide whether it interrupts you. Off = record only, as before.',
    impact: 'may notify you on your own devices; never contacts anyone else',
  },
  {
    // Build 15: a KILL SWITCH (default on). Self-healing is one named,
    // read-only retry of a source's own sync, once per outage, only at high
    // confidence, and it is only called a recovery when the source is seen to
    // recover. Off = every fix stays a recommendation.
    key: 'self_heal',
    env: 'SELF_HEAL_ENABLED',
    default: true,
    label: 'Let NEURO retry a stopped sync by itself',
    description: 'When a sense stops and NEURO is confident why, it may re-run that '
      + "source's own sync ONCE, then checks it really recovered. Nothing that "
      + 'sends, invites or changes anything outside NEURO ever runs by itself.',
  },
  {
    // Build 17U: the way back from retiring the legacy meeting push. Default
    // OFF — retired on measured interruption parity. MEETING_PREP_MODE
    // (live|retired), when set, still wins over this switch.
    key: 'meeting_prep_legacy',
    env: 'MEETING_PREP_LEGACY',
    default: false,
    label: 'Legacy meeting-prep pushes',
    description: 'The old "Meeting in 20 min" push that named a colleague\'s role and last 1-2-1. Retired '
      + 'in Build 17: that context is in meeting prep, and the unified meeting check raises anything at risk. '
      + 'Turn this on to bring the old push back alongside it.',
    impact: 'may notify you before meetings; never contacts anyone else',
  },
  {
    key: 'dnd_vault_read_only',
    env: 'DND_VAULT_READ_ONLY',
    default: false,
    label: 'D&D vault mirror is read-only',
    description: 'Blocks writes through the D&D vault API. Notion is the source for that '
      + 'tree, so the mirror should not be edited from here.',
  },
];

const BY_KEY = new Map(FLAGS.map((f) => [f.key, f]));

/**
 * Did the environment explicitly say something?
 *
 * ⚠ `undefined` and `''` both mean "not set", and the distinction matters for a
 * default-TRUE flag: `!== 'false'` treats an unset variable as on, so an empty
 * string must not read as an explicit choice.
 */
function envValue(flag) {
  const raw = process.env[flag.env];
  if (raw === undefined || raw === '') return null;
  return raw === 'true';
}

function storedValue(flag) {
  try {
    const raw = db.getState(`${STATE_PREFIX}${flag.key}`);
    if (raw === null || raw === undefined || raw === '') return null;
    return raw === 'true';
  } catch { return null; }
}

/** Is this switch on? Env wins, then the stored value, then the default. */
function isEnabled(key) {
  const flag = BY_KEY.get(key);
  if (!flag) return false;

  // A dependent switch is off whenever its parent is, whatever it says itself —
  // otherwise the panel shows "lighter plan" as ON while the planner that would
  // act on it is not running, which is a claim about behaviour that cannot happen.
  if (flag.requires && !isEnabled(flag.requires)) return false;

  const fromEnv = envValue(flag);
  if (fromEnv !== null) return fromEnv;
  const stored = storedValue(flag);
  if (stored !== null) return stored;
  return flag.default;
}

function setEnabled(key, on) {
  const flag = BY_KEY.get(key);
  if (!flag) return { ok: false, error: `Unknown switch "${key}".` };
  if (envValue(flag) !== null) {
    return {
      ok: false,
      error: `${flag.env} is set in the environment, so it cannot be changed here.`,
    };
  }
  const before = isEnabled(key);
  db.setState(`${STATE_PREFIX}${flag.key}`, on ? 'true' : 'false');
  const after = isEnabled(key);
  // Build 15: a switch Nick flips is an Activity fact ("manual override").
  // Only a real change is recorded; never the env values.
  if (before !== after) {
    try { db.logActivity('feature_flag_changed', { key, label: flag.label, from: before, to: after }); } catch { /* never fails the toggle */ }
  }
  return { ok: true, key, enabled: after };
}

/** Everything the panel needs — never the raw env values. */
function list() {
  return FLAGS.map((flag) => ({
    key: flag.key,
    label: flag.label,
    description: flag.description,
    impact: flag.impact || null,
    requires: flag.requires || null,
    enabled: isEnabled(flag.key),
    // So the UI can disable the control and SAY why, rather than offering a
    // toggle that silently does nothing.
    lockedByEnv: envValue(flag) !== null,
    envVar: flag.env,
    default: flag.default,
    // A dependent switch that is off only because its parent is.
    blockedBy: flag.requires && !isEnabled(flag.requires) ? flag.requires : null,
  }));
}

module.exports = { FLAGS, STATE_PREFIX, isEnabled, setEnabled, list };
