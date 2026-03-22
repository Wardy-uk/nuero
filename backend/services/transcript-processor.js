'use strict';

const fs = require('fs');
const path = require('path');
const obsidian = require('./obsidian');

const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514';

const EXTRACT_PROMPT = `You are Nick's meeting transcript processor. Nick is Head of Technical Support at Nurtur Limited. He manages 15 direct reports.

Analyze this PLAUD transcript and extract structured information. Return a JSON object with:

{
  "summary": "2-3 sentence summary of the meeting",
  "meetingDate": "YYYY-MM-DD if detectable, null otherwise",
  "is121": true/false — whether this appears to be a 1-2-1 meeting,
  "peopleNames": ["First Last", ...] — names of people mentioned or participating,
  "actionItems": ["action item text", ...] — tasks, follow-ups, or commitments made,
  "keyTopics": ["topic", ...] — main topics discussed (max 5)
}

RULES:
- Only include real people names, not generic references
- Action items should be concise and actionable
- If the transcript is unclear or very short, return minimal data rather than guessing
- Return ONLY the JSON object, no markdown or explanation`;

async function processTranscript(filePath) {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('[TranscriptProcessor] No Claude API key — skipping');
    return null;
  }

  if (!fs.existsSync(filePath)) {
    console.error('[TranscriptProcessor] File not found:', filePath);
    return null;
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  const body = content.replace(/^---[\s\S]*?---\n*/, '');

  if (body.trim().length < 50) {
    console.log('[TranscriptProcessor] Transcript too short to process');
    return null;
  }

  console.log(`[TranscriptProcessor] Processing ${path.basename(filePath)}...`);

  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const response = await client.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 1024,
      system: EXTRACT_PROMPT,
      messages: [{
        role: 'user',
        content: `Transcript (${path.basename(filePath)}):\n\n${body.slice(0, 8000)}`
      }]
    });

    const text = response.content[0]?.text || '{}';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    const extracted = JSON.parse(jsonMatch ? jsonMatch[0] : '{}');

    console.log(`[TranscriptProcessor] Extracted: ${extracted.peopleNames?.length || 0} people, ${extracted.actionItems?.length || 0} actions`);

    // Match people against vault People notes
    const knownPeople = obsidian.listPeopleNotes();
    const matchedPeople = [];

    for (const name of (extracted.peopleNames || [])) {
      const match = knownPeople.find(known => {
        const nameLower = name.toLowerCase();
        const knownLower = known.toLowerCase();
        // Exact match or first/last name match
        if (nameLower === knownLower) return true;
        const nameParts = nameLower.split(' ');
        const knownParts = knownLower.split(' ');
        return nameParts.some(p => p.length > 2 && knownParts.includes(p));
      });
      matchedPeople.push({
        mentioned: name,
        vaultMatch: match || null
      });
    }

    // If it's a 1-2-1, update the matched person's note with last-1-2-1 date
    const meetingDate = extracted.meetingDate || obsidian.todayDateString();
    if (extracted.is121 && matchedPeople.length > 0) {
      const personMatch = matchedPeople.find(p => p.vaultMatch);
      if (personMatch) {
        try {
          obsidian.updatePersonNote(personMatch.vaultMatch, {
            last121: meetingDate
          });
          personMatch.updated121 = true;
          console.log(`[TranscriptProcessor] Updated ${personMatch.vaultMatch} last-1-2-1 to ${meetingDate}`);
        } catch (e) {
          console.error(`[TranscriptProcessor] Failed to update person note:`, e.message);
        }
      }
    }

    const result = {
      summary: extracted.summary || null,
      meetingDate,
      is121: extracted.is121 || false,
      people: matchedPeople,
      actionItems: extracted.actionItems || [],
      keyTopics: extracted.keyTopics || [],
      sourceFile: path.basename(filePath)
    };

    // Persist result to agent_state for display in ImportsPanel
    try {
      const db = require('../db/database');
      const stateKey = `transcript_${path.basename(filePath, '.md')}`;
      db.setState(stateKey, JSON.stringify(result));
    } catch (e) {
      console.warn('[TranscriptProcessor] Failed to persist result:', e.message);
    }

    return result;
  } catch (err) {
    console.error('[TranscriptProcessor] Processing error:', err.message);
    return null;
  }
}

// Get the most recent transcript processing result
function getLastResult(fileName) {
  try {
    const db = require('../db/database');
    const stateKey = `transcript_${fileName.replace('.md', '')}`;
    const val = db.getState(stateKey);
    return val ? JSON.parse(val) : null;
  } catch {
    return null;
  }
}

module.exports = { processTranscript, getLastResult };
