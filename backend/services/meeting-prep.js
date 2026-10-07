'use strict';

const db = require('../db/database');
const obsidian = require('./obsidian');
const webpush = require('./webpush');

const LOOK_AHEAD_MINUTES = 25;

// Build 17U: RETIRED by default. Interruption parity on real meetings (5–7 Oct
// 2026) found every old-only push was context (a role, a last 1-2-1) or noise
// (Nick's own name, solo blocks) — never a risk the unified pipeline missed —
// and the context still lives in prep (the prep view and meeting-intelligence
// read the same People notes). Retired = the comparison is still recorded,
// nothing is sent. The way back is the Settings switch "Legacy meeting-prep
// pushes" (`meeting_prep_legacy`), or MEETING_PREP_MODE=live|retired, which
// wins when set.
function prepMode() {
  const env = String(process.env.MEETING_PREP_MODE || '').toLowerCase();
  if (env === 'live' || env === 'retired') return env;
  try { return require('./feature-flags').isEnabled('meeting_prep_legacy') ? 'live' : 'retired'; } catch { return 'retired'; }
}

// The ONLY things the legacy push body is built from — so it can carry
// context, never a risk or an action (pinned by a test).
const OLD_PUSH_FIELDS = Object.freeze(['role', 'last121', 'notes']);

/** Record what this path decided about one meeting, beside the new pipeline's answer. Never throws. */
function recordOldSide(event, side) {
  try {
    const startLocal = String(event.start || '').slice(0, 16);
    const key = `graph:${event.id}@${startLocal}`;
    const iso = new Date().toISOString();
    db.run(`INSERT INTO meeting_prep_comparisons (meeting_key, title, start_local, old_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(meeting_key) DO UPDATE SET old_json = excluded.old_json, updated_at = excluded.updated_at`,
    [key, event.subject || null, startLocal, JSON.stringify(side), iso, iso]);
  } catch (e) { console.warn('[MeetingPrep] comparison not recorded:', e.message); }
}

/** Build 17W: record a CHANGE of mode once, for Activity. Never throws. */
function noteModeChange() {
  try {
    const mode = prepMode();
    if (db.getState('meeting_prep_mode_last') === mode) return;
    db.setState('meeting_prep_mode_last', mode);
    const env = String(process.env.MEETING_PREP_MODE || '').toLowerCase();
    db.logActivity('meeting_prep_mode', { mode, basis: env ? 'MEETING_PREP_MODE' : 'meeting_prep_legacy switch (default off since Build 17)' });
  } catch { /* bookkeeping only */ }
}

async function checkUpcomingMeetings({ now = new Date() } = {}) {
  noteModeChange();
  if (!obsidian.isConfigured()) return;

  const isWeekday = now.getDay() >= 1 && now.getDay() <= 5;
  if (!isWeekday) return;

  // Fetch today's calendar events via the microsoft service (uses bridge)
  let events = [];
  try {
    const microsoft = require('./microsoft');
    const today = now.toISOString().split('T')[0];
    const fetched = await microsoft.fetchCalendarEvents(today, today);
    if (fetched) events = fetched;
  } catch (e) {
    console.warn('[MeetingPrep] Calendar fetch failed:', e.message);
    return;
  }

  // Build 16K: who Nick is, to tell a meeting from a solo block. Unknown is
  // fine — see soloBlock() below.
  let me = null;
  try { me = await require('./microsoft').getSignedInAddress(); } catch { me = null; }

  for (const event of events) {
    if (event.showAs === 'cancelled') continue;

    const startTime = new Date(event.start);
    const minutesUntil = (startTime - now) / 60000;

    // Only fire for meetings 15-25 minutes away
    if (minutesUntil < 15 || minutesUntil > LOOK_AHEAD_MINUTES) continue;

    // Check if already notified for this meeting today
    const notifyKey = `meeting_prep_${now.toISOString().split('T')[0]}_${event.id}`;
    if (db.getState(notifyKey)) continue;

    // Find People note matches
    const peopleDir = require('path').join(process.env.OBSIDIAN_VAULT_PATH || '', 'People');
    const fs = require('fs');
    if (!fs.existsSync(peopleDir)) continue;

    const peopleFiles = fs.readdirSync(peopleDir).filter(f => f.endsWith('.md'));
    const matchedPeople = [];

    for (const file of peopleFiles) {
      const name = file.replace('.md', '');
      const nameParts = name.split(' ');
      const matches = nameParts.some(part =>
        part.length > 2 && event.subject.toLowerCase().includes(part.toLowerCase())
      );
      if (!matches) continue;

      const content = fs.readFileSync(require('path').join(peopleDir, file), 'utf-8');
      // Inline frontmatter parse
      const fm = (() => {
        if (!content.startsWith('---')) return {};
        const end = content.indexOf('---', 3);
        if (end === -1) return {};
        const result = {};
        content.substring(3, end).trim().split('\n').forEach(line => {
          const ci = line.indexOf(':');
          if (ci > 0) result[line.substring(0, ci).trim()] = line.substring(ci + 1).trim();
        });
        return result;
      })();

      const body = content.replace(/^---[\s\S]*?---\n*/, '')
        .replace(/```dataview[\s\S]*?```/g, '')
        .split('\n')
        .filter(l => l.trim() && !l.startsWith('#'))
        .slice(0, 3)
        .join(' ')
        .substring(0, 150);

      matchedPeople.push({
        name,
        role: fm.role || fm.title || '',
        last121: fm['last-1-2-1'] || fm['last-contact'] || null,
        notes: body
      });
    }

    // ⚠ Build 16K: a SOLO block is not a meeting. Measured since 7 Sep: 31 of
    // this path's 42 sends (74%) were "Task block" / "Plaud admin" entries whose
    // titles happen to contain a colleague's name. Skipped only when the
    // attendee list POSITIVELY says nobody else is in it; an undecidable event
    // keeps the old behaviour, so this can only remove false positives.
    if (soloBlock(event, me)) {
      recordOldSide(event, { wouldNotify: false, why: 'solo block — nobody else is in it', matchedPeople: matchedPeople.map(p => p.name), mode: prepMode(), sent: false });
      continue;
    }

    if (matchedPeople.length === 0) {
      recordOldSide(event, { wouldNotify: false, why: 'no People note name part in the title', matchedPeople: [], mode: prepMode(), sent: false });
      continue;
    }

    // Build notification
    const timeStr = startTime.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    const person = matchedPeople[0];
    const parts = [];
    if (person.role) parts.push(person.role);
    if (person.last121) parts.push(`last 1-2-1: ${person.last121}`);
    if (person.notes) parts.push(person.notes.substring(0, 80));

    const body = parts.length > 0 ? parts.join(' · ') : 'No notes found';
    const title = `Meeting in ${Math.round(minutesUntil)} min — ${event.subject}`;

    // Mark as notified before sending (prevent double-fire)
    db.setState(notifyKey, new Date().toISOString());

    const content = Object.fromEntries(OLD_PUSH_FIELDS.filter(f => person[f]).map(f => [f, true]));
    const side = { wouldNotify: true, matchedPeople: matchedPeople.map(p => p.name), title, body, content, mode: prepMode(), sent: false };
    if (prepMode() === 'retired') {
      console.log(`[MeetingPrep] (retired) would have notified for: ${event.subject} at ${timeStr} — not sent`);
      recordOldSide(event, side);
      continue;
    }

    console.log(`[MeetingPrep] Notifying for: ${event.subject} at ${timeStr}`);
    recordOldSide(event, { ...side, sent: true });

    await webpush.sendToAll(title, body, {
      type: 'meeting_prep',
      url: '/people',
      // ⚠ Build 16K: the attention record is keyed on THIS OCCURRENCE. Keyed on
      // the title (the old default), a weekly 1-2-1 was "already notified,
      // nothing changed" for ever — Nick Catch Up was suppressed 7 of 7 times.
      key: occurrenceKey(event),
    }).catch(e => console.warn('[MeetingPrep] Push failed:', e.message));
  }
}

/** One meeting occurrence, for the push's attention identity. PURE. */
function occurrenceKey(event) {
  return `meeting_prep:${event.id || event.subject || 'meeting'}@${String(event.start || '').slice(0, 16)}`;
}

/**
 * Is this POSITIVELY a solo block? PURE. Only a readable attendee list and a
 * known signed-in address can say so; anything undecidable is `false` (not
 * known solo), which keeps the legacy behaviour rather than inventing a skip.
 */
function soloBlock(event, me) {
  if (!me || !event || !Array.isArray(event.attendees)) return false;
  try {
    return require('./plaud-admin-blocks').attendeesOther(event, me).length === 0;
  } catch { return false; }
}

module.exports = { checkUpcomingMeetings, prepMode, occurrenceKey, soloBlock, noteModeChange, OLD_PUSH_FIELDS };
