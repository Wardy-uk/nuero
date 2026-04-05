'use strict';

/**
 * Meeting Prep API — dedicated endpoint for meeting preparation.
 *
 * GET /api/meeting-prep       — next meeting with full prep context
 * GET /api/meeting-prep/all   — all meetings today with prep context
 */

const express = require('express');
const router = express.Router();
const db = require('../db/database');
const path = require('path');
const fs = require('fs');

const VAULT_PATH = process.env.OBSIDIAN_VAULT_PATH || '';

// Team members for attendee matching
const TEAM_MEMBERS = [
  'Abdi Mohamed', 'Arman Shazad', 'Luke Scaife', 'Stephen Mitchell',
  'Willem Kruger', 'Nathan Rutland', 'Adele Norman-Swift', 'Heidi Power',
  'Hope Goodall', 'Maria Pappa', 'Naomi Wentworth', 'Sebastian Broome',
  'Zoe Rees', 'Isabel Busk', 'Kayleigh Russell', 'Chris Middleton',
  'Beth', 'Paul', 'Damon', 'Ricky'
];

// GET /api/meeting-prep — next upcoming meeting with prep
router.get('/', (req, res) => {
  try {
    const meetings = _getUpcomingMeetings(4);
    if (meetings.length === 0) {
      return res.json({ meeting: null, message: 'No upcoming meetings in the next 4 hours' });
    }

    // Enrich the next meeting with full prep
    const next = meetings[0];
    const prep = _buildPrep(next);

    res.json({
      meeting: { ...next, prep },
      laterToday: meetings.slice(1).map(m => ({
        subject: m.subject,
        start: m.start_time,
        end: m.end_time,
        minutesAway: m.minutesAway,
      })),
    });
  } catch (e) {
    console.error('[MeetingPrep] Error:', e);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/meeting-prep/all — all today's meetings with prep
router.get('/all', (req, res) => {
  try {
    const meetings = _getUpcomingMeetings(12);
    const enriched = meetings.map(m => ({
      ...m,
      prep: _buildPrep(m),
    }));
    res.json({ meetings: enriched });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/meeting-prep/week — all meetings for the next 7 days with prep
router.get('/week', async (req, res) => {
  try {
    const daysAhead = parseInt(req.query.days) || 7;
    const now = new Date();
    const todayStr = now.toISOString().split('T')[0];
    const endDate = new Date(now.getTime() + daysAhead * 86400000);
    const endStr = endDate.toISOString().split('T')[0];

    // Use live calendar (Microsoft Graph) — DB cache only has today
    const obsidian = require('../services/obsidian');
    let events;
    try {
      events = await obsidian.fetchCalendarEvents(todayStr, endStr);
    } catch {
      // Fall back to DB cache if Microsoft unavailable
      events = db.getCalendarEvents(todayStr, endStr + 'T23:59:59');
    }

    // Normalise field names (live Graph API vs DB cache use different names)
    const normalised = events.map(e => ({
      event_id: e.event_id || e.id || '',
      subject: e.subject || '',
      start_time: e.start_time || e.start || '',
      end_time: e.end_time || e.end || '',
      is_all_day: e.is_all_day ?? e.isAllDay ?? false,
      location: e.location || null,
      organizer: e.organizer || null,
      attendees: e.attendees || [],
      showAs: e.showAs || e.show_as || null,
    })).filter(e => !e.is_all_day);

    // Group by date
    const byDate = {};
    for (const e of normalised) {
      const dateKey = e.start_time.split('T')[0];
      if (!byDate[dateKey]) byDate[dateKey] = [];

      const start = new Date(e.start_time);
      byDate[dateKey].push({
        ...e,
        startFormatted: start.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
        endFormatted: new Date(e.end_time).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
        dayLabel: start.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short' }),
      });
    }

    // Build prep for each meeting
    const days = Object.entries(byDate)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, meetings]) => ({
        date,
        dayLabel: meetings[0]?.dayLabel || date,
        meetings: meetings.map(m => ({
          ...m,
          prep: _buildPrep(m),
        })),
      }));

    res.json({ days, totalMeetings: events.length });
  } catch (e) {
    console.error('[MeetingPrep] Week error:', e);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/meeting-prep/:id — prep for a specific meeting by event_id
router.get('/:id', async (req, res) => {
  try {
    const now = new Date();
    const todayStr = now.toISOString().split('T')[0];
    const weekEnd = new Date(now.getTime() + 7 * 86400000).toISOString().split('T')[0];

    const obsidian = require('../services/obsidian');
    let events;
    try {
      events = await obsidian.fetchCalendarEvents(todayStr, weekEnd);
    } catch {
      events = db.getCalendarEvents(todayStr, weekEnd + 'T23:59:59');
    }

    // Normalise + find
    const event = events
      .map(e => ({
        event_id: e.event_id || e.id || '',
        subject: e.subject || '',
        start_time: e.start_time || e.start || '',
        end_time: e.end_time || e.end || '',
        is_all_day: e.is_all_day ?? e.isAllDay ?? false,
        location: e.location || null,
        organizer: e.organizer || null,
        attendees: e.attendees || [],
      }))
      .find(e => e.event_id === req.params.id);

    if (!event) return res.status(404).json({ error: 'Meeting not found' });

    const start = new Date(event.start_time);
    const enriched = {
      ...event,
      startFormatted: start.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
      endFormatted: new Date(event.end_time).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
      dayLabel: start.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short' }),
      minutesAway: Math.round((start - now) / 60000),
      prep: _buildPrep(event),
    };

    res.json({ meeting: enriched });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function _getUpcomingMeetings(hoursAhead) {
  const now = new Date();
  const todayStr = now.toISOString().split('T')[0];
  const tomorrowStr = new Date(now.getTime() + 86400000).toISOString().split('T')[0];
  const cutoff = new Date(now.getTime() + hoursAhead * 60 * 60 * 1000);

  const events = db.getCalendarEvents(todayStr, tomorrowStr);

  return events
    .filter(e => {
      if (e.is_all_day) return false;
      const start = new Date(e.start_time);
      return start > now && start <= cutoff;
    })
    .sort((a, b) => new Date(a.start_time) - new Date(b.start_time))
    .map(e => {
      const start = new Date(e.start_time);
      return {
        ...e,
        minutesAway: Math.round((start - now) / 60000),
        startFormatted: start.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
        endFormatted: new Date(e.end_time).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
      };
    });
}

function _buildPrep(meeting) {
  const prep = {
    attendees: [],
    recentDecisions: [],
    suggestedTopics: [],
    checklist: [],
  };

  // 1. Get attendees from Graph API data first, then fall back to subject matching
  const graphAttendees = (meeting.attendees || [])
    .filter(a => a.name && !a.email?.toLowerCase().includes('nickw@') && !a.email?.toLowerCase().includes('nick.ward@'))
    .map(a => a.name);

  // Merge: Graph attendees + subject/organizer matching (dedup)
  const subjectMatched = _matchPeople(meeting.subject, meeting.organizer);
  const allNames = [...new Set([...graphAttendees, ...subjectMatched])];
  const matchedPeople = allNames.length > 0 ? allNames : subjectMatched;

  // 2. Pull People notes for each attendee
  for (const person of matchedPeople) {
    const note = _readPersonNote(person);
    prep.attendees.push(note);
  }

  // Also add Graph attendees who don't have vault notes (show name + email)
  if (graphAttendees.length > 0) {
    const prepNames = new Set(prep.attendees.map(a => a.name.toLowerCase()));
    for (const att of (meeting.attendees || [])) {
      if (att.name && !prepNames.has(att.name.toLowerCase()) &&
          !att.email?.toLowerCase().includes('nickw@') && !att.email?.toLowerCase().includes('nick.ward@')) {
        prep.attendees.push({
          name: att.name,
          role: null,
          last121: null,
          next121Due: null,
          tags: [],
          recentNotes: null,
          email: att.email,
          rsvp: att.status,
        });
      }
    }
  }

  // 3. Pull recent decisions mentioning any attendee
  try {
    const obsidian = require('../services/obsidian');
    const decisions = obsidian.getRecentDecisions(14);
    if (decisions && decisions.length > 0) {
      const names = matchedPeople.map(p => p.toLowerCase());
      prep.recentDecisions = decisions
        .filter(d => names.some(n => d.text?.toLowerCase().includes(n)))
        .slice(0, 3)
        .map(d => ({ date: d.date, text: d.text }));
    }
  } catch {}

  // 4. Generate suggested topics from people notes
  for (const att of prep.attendees) {
    if (att.last121) {
      const daysSince = Math.round((Date.now() - new Date(att.last121).getTime()) / 86400000);
      if (daysSince > 14) {
        prep.suggestedTopics.push(`Catch up with ${att.name} — last 1-2-1 was ${daysSince} days ago`);
      }
    }
    if (att.recentNotes) {
      prep.suggestedTopics.push(`Follow up: ${att.recentNotes.substring(0, 60)}`);
    }
  }

  // 5. Checklist
  prep.checklist = [
    'Review agenda',
    ...(prep.attendees.length > 0 ? ['Check attendee notes'] : []),
    ...(prep.recentDecisions.length > 0 ? ['Review recent decisions'] : []),
    'Prepare key questions',
  ];

  return prep;
}

function _matchPeople(subject, organizer) {
  const matched = new Set();
  const subjectLower = (subject || '').toLowerCase();
  const organizerLower = (organizer || '').toLowerCase();

  for (const member of TEAM_MEMBERS) {
    const parts = member.split(' ');
    for (const part of parts) {
      if (part.length > 2 && (subjectLower.includes(part.toLowerCase()) || organizerLower.includes(part.toLowerCase()))) {
        matched.add(member);
        break;
      }
    }
  }

  return [...matched];
}

function _readPersonNote(name) {
  const result = {
    name,
    role: null,
    last121: null,
    next121Due: null,
    tags: [],
    recentNotes: null,
  };

  if (!VAULT_PATH) return result;

  // Try exact name, then first name match
  const peopleDir = path.join(VAULT_PATH, 'People');
  if (!fs.existsSync(peopleDir)) return result;

  const files = fs.readdirSync(peopleDir).filter(f => f.endsWith('.md'));
  const exactMatch = files.find(f => f.replace('.md', '').toLowerCase() === name.toLowerCase());
  const partialMatch = !exactMatch && files.find(f => {
    const fname = f.replace('.md', '').toLowerCase();
    return name.split(' ').some(p => p.length > 2 && fname.includes(p.toLowerCase()));
  });

  const matchFile = exactMatch || partialMatch;
  if (!matchFile) return result;

  try {
    const content = fs.readFileSync(path.join(peopleDir, matchFile), 'utf-8');

    // Parse frontmatter
    if (content.startsWith('---')) {
      const endIdx = content.indexOf('---', 3);
      if (endIdx !== -1) {
        const fm = content.substring(3, endIdx);
        const roleMatch = fm.match(/role:\s*(.+)/);
        const last121Match = fm.match(/last-1-2-1:\s*(.+)/);
        const next121Match = fm.match(/next-1-2-1-due:\s*(.+)/);
        const tagsMatch = fm.match(/tags:\s*\[(.+?)\]/);

        if (roleMatch) result.role = roleMatch[1].trim();
        if (last121Match) result.last121 = last121Match[1].trim();
        if (next121Match) result.next121Due = next121Match[1].trim();
        if (tagsMatch) result.tags = tagsMatch[1].split(',').map(t => t.trim());
      }
    }

    // Get recent notes (last dated section)
    const body = content.replace(/^---[\s\S]*?---\n*/, '')
      .replace(/```dataview[\s\S]*?```/g, '');
    const noteLines = body.split('\n')
      .filter(l => l.trim() && !l.startsWith('#'))
      .slice(-5)
      .join('\n');
    if (noteLines.length > 10) {
      result.recentNotes = noteLines.substring(0, 200);
    }
  } catch {}

  return result;
}

module.exports = router;
