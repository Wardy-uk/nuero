'use strict';

const fs = require('fs');
const path = require('path');
const obsidian = require('./obsidian');

// One model call per PLAUD transcript. It reads the WHOLE transcript and returns
// the meeting's actions with their owners, which feed Nick's review queue
// (action-candidates.syncTranscriptActions). PLAUD's own summary changes layout
// with whichever template its auto-summary picks, so the transcript is the stable
// source. Until 30 Oct 2026 this read only the first 8,000 characters and stored
// owner-less actions where nothing read them.

// ~30k tokens. A two-hour meeting fits; anything longer is cut and SAID.
const MAX_CHARS = 120000;

const EXTRACT_PROMPT = `You read meeting transcripts for Nick Ward, Head of Technical Support at Nurtur Limited.

The transcript has speaker labels. Return ONLY a JSON object:

{
  "summary": "2-3 sentence summary of the meeting",
  "is121": true/false — a one-to-one between Nick and one other person,
  "peopleNames": ["Full Name", ...] — people who SPOKE in the meeting,
  "actions": [
    { "owner": "Full Name", "task": "what they will do", "due": "YYYY-MM-DD or null" }
  ],
  "keyTopics": ["topic", ...] — at most 5
}

Rules for actions:
- An action is something a person agreed or was asked to do after the meeting. Not a fact, not a discussion point.
- "owner" is the ONE person who will do it, by full name as in the speaker labels. Nick is "Nick Ward".
- If an action is shared, give one entry per person.
- If you cannot tell who owns it, use "unknown". Never guess Nick.
- "Speak with Nick about X" belongs to the person who will speak, not Nick.
- Write "task" as a short instruction starting with a verb, in the meeting's words.
- "due" only when a date or day is stated; convert relative days using the meeting date. Otherwise null.
- If the transcript is short or unclear, return fewer actions rather than guessing.`;

function relativeToVault(filePath) {
  const vault = process.env.OBSIDIAN_VAULT_PATH;
  if (!vault) return null;
  const rel = path.relative(vault, filePath);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

function meetingDateOf(content) {
  const m = content.match(/^(?:start_at|date|created_at):\s*"?(\d{4}-\d{2}-\d{2})/m);
  return m ? m[1] : null;
}

async function processTranscript(filePath) {
  const aiRouting = require('./ai-routing');
  if (aiRouting.getAIMode() === 'off') {
    console.log('[TranscriptProcessor] AI mode is off — skipping');
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

  const truncated = body.length > MAX_CHARS;
  if (truncated) {
    console.warn(`[TranscriptProcessor] ${path.basename(filePath)} is ${body.length} chars — reading the first ${MAX_CHARS}; later actions are not read`);
  }
  const meetingDate = meetingDateOf(content);
  console.log(`[TranscriptProcessor] Processing ${path.basename(filePath)}...`);

  try {
    const aiProvider = require('./ai-provider');
    const result = await aiProvider.processTranscript(
      EXTRACT_PROMPT,
      `Meeting date: ${meetingDate || 'unknown'}\nTranscript (${path.basename(filePath)}):\n\n${body.slice(0, MAX_CHARS)}`,
      { maxTokens: 3000 }
    );

    if (!result || !result.text || result.provider === 'none') {
      console.log('[TranscriptProcessor] No AI response — skipping');
      return null;
    }

    const jsonMatch = result.text.match(/\{[\s\S]*\}/);
    let extracted;
    try {
      extracted = JSON.parse(jsonMatch ? jsonMatch[0] : '');
    } catch {
      // An unreadable answer queues NOTHING and claims nothing, so PLAUD's summary
      // stays the source for this recording.
      console.warn('[TranscriptProcessor] Answer was not readable JSON — no actions taken from it');
      return null;
    }
    console.log(`[TranscriptProcessor] Processed via ${result.provider}`);

    const actions = Array.isArray(extracted.actions)
      ? extracted.actions.filter((a) => a && typeof a.task === 'string')
      : null;
    console.log(`[TranscriptProcessor] Extracted: ${extracted.peopleNames?.length || 0} people, ${actions ? actions.length : 0} actions`);

    // People are matched for routing hints only. A 1-2-1 date is NOT stamped from
    // the model's guess: 1-2-1s are detected from the written-up note.
    const knownPeople = obsidian.listPeopleNotes();
    const matchedPeople = (extracted.peopleNames || []).map((name) => {
      const nameLower = String(name).toLowerCase();
      const match = knownPeople.find((known) => known.toLowerCase() === nameLower);
      return { mentioned: name, vaultMatch: match || null };
    });

    // Feed the queue. A 1-2-1 is NOVA's — it extracts and tracks those actions
    // itself, so they are left to the summary path, which already excludes them.
    let queued = null;
    const relativePath = relativeToVault(filePath);
    if (actions && relativePath && !extracted.is121) {
      try {
        queued = require('./action-candidates').syncTranscriptActions(relativePath, content, actions);
        console.log(`[TranscriptProcessor] Queue: ${queued.created} new, ${queued.folded || 0} folded, ${queued.supersededFromNotes} summary candidates superseded`);
      } catch (e) {
        console.warn('[TranscriptProcessor] Could not queue actions:', e.message);
      }
    }

    const output = {
      summary: extracted.summary || null,
      meetingDate,
      is121: extracted.is121 || false,
      people: matchedPeople,
      actionItems: (actions || []).map((a) => `${a.owner || 'unknown'}: ${a.task}`),
      actions: actions || [],
      queued: queued ? { created: queued.created, folded: queued.folded || 0 } : null,
      truncated,
      keyTopics: extracted.keyTopics || [],
      sourceFile: path.basename(filePath),
    };

    try {
      const db = require('../db/database');
      db.setState(`transcript_${path.basename(filePath, '.md')}`, JSON.stringify(output));
    } catch (e) {
      console.warn('[TranscriptProcessor] Failed to persist result:', e.message);
    }

    return output;
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

module.exports = { processTranscript, getLastResult, EXTRACT_PROMPT, MAX_CHARS };
