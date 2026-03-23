'use strict';

const db = require('../db/database');
const obsidian = require('./obsidian');
const webpush = require('./webpush');

const LOOK_AHEAD_MINUTES = 25;

async function checkUpcomingMeetings() {
  if (!obsidian.isConfigured()) return;

  const now = new Date();
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

    if (matchedPeople.length === 0) continue;

    // Build notification
    const timeStr = startTime.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    const person = matchedPeople[0];
    const parts = [];
    if (person.role) parts.push(person.role);
    if (person.last121) parts.push(`last 1-2-1: ${person.last121}`);
    if (person.notes) parts.push(person.notes.substring(0, 80));

    const body = parts.length > 0 ? parts.join(' · ') : 'No notes found';
    const title = `Meeting in ${Math.round(minutesUntil)} min — ${event.subject}`;

    console.log(`[MeetingPrep] Notifying for: ${event.subject} at ${timeStr}`);

    // Mark as notified before sending (prevent double-fire)
    db.setState(notifyKey, new Date().toISOString());

    await webpush.sendToAll(title, body, {
      type: 'meeting_prep',
      url: '/people'
    }).catch(e => console.warn('[MeetingPrep] Push failed:', e.message));
  }
}

module.exports = { checkUpcomingMeetings };
