'use strict';

/**
 * What Nick said HE would do, in the email he sent (5 Oct 2026).
 *
 * `email-actions` reads mail Nick RECEIVED for what somebody asked of him;
 * meeting notes give `action-candidates` what he agreed in a room. Neither read
 * his Sent Items, so "I'll send you the breakdown by Friday" — a promise in his
 * own words, to a named person — was the one commitment NEURO never saw.
 *
 * Same contract as `email-actions`, deliberately:
 *   1. REVIEW-ONLY. It emits `capture_todo` into the same queue ("Spotted,
 *      waiting on you"); nothing is promoted here, and there is no path to
 *      task-store in this file.
 *   2. Only Nick's OWN words: Graph's `uniqueBody` is the new part of a reply,
 *      never the thread quoted under it, so somebody else's promise further
 *      down cannot be read as his.
 *   3. An answer is bought ONCE per message (a ledger of both outcomes); a
 *      failed batch records nothing and is retried.
 *   4. No invented due date — timing stays in the reason line.
 *   5. Automated mail sent in his name (accept/decline, "has shared", out of
 *      office) is skipped before the model is asked — the same filter the
 *      progress-evidence rules had to learn.
 */

const db = require('../db/database');
const actionCandidates = require('./action-candidates');
const todoIntelligence = require('./todo-intelligence');

const ENABLED = process.env.SENT_COMMITMENTS_ENABLED !== 'false';
const LEDGER_KEY = 'sent_commitments_seen';
const LOOKBACK_DAYS = 14;
const BATCH = 8;
const MAX_PER_RUN = Number(process.env.SENT_COMMITMENTS_MAX_PER_RUN || 40);
// Below email-actions' 0.62: a model reading one line of his own email is
// still weaker evidence than a checkbox typed in a meeting note.
const CONFIDENCE = 0.6;
const MIN_TEXT = 8;
const MAX_TEXT = 220;

// Mail sent in his name that is not him writing.
const AUTOMATED = /^(accepted|declined|tentative|canceled|cancelled|automatic reply|out of office)\b|has shared|shared .* with you|left a comment|invitation:/i;

function sourcePathFor(id) { return `email:${String(id)}`; }

function readLedger() {
  try { const v = JSON.parse(db.getState(LEDGER_KEY) || '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
}
function writeLedger(l) {
  try { db.setState(LEDGER_KEY, JSON.stringify(l)); } catch (e) { console.warn('[SentCommitments] ledger not saved:', e.message); }
}

/** Keep only entries inside the lookback (plus a margin); the rest cannot come back. */
function pruneLedger(ledger, now = Date.now()) {
  const cutoff = now - (LOOKBACK_DAYS + 7) * 86400000;
  const next = {};
  for (const [id, v] of Object.entries(ledger || {})) if (Date.parse(v && v.at) >= cutoff) next[id] = v;
  return next;
}

function recipients(m) {
  const list = [...(m.to || []), ...(m.cc || [])].map((r) => r.name || r.email).filter(Boolean);
  return list.length > 3 ? `${list.slice(0, 3).join(', ')} +${list.length - 3}` : list.join(', ');
}

function buildPrompt(batch) {
  const list = batch.map((m, i) => [
    `[${i}]`,
    `To: ${recipients(m) || '(unknown)'}`,
    `Subject: ${m.subject || '(no subject)'}`,
    `What Nick wrote: ${String(m.text || '').slice(0, 900) || '(empty)'}`,
  ].join('\n')).join('\n\n');
  return `These are emails Nick Ward SENT. Nick is Head of Technical Support at Nurtur.

For each email, find anything NICK HIMSELF said he will do — a promise in his own words, such as "I'll send you…", "I will look into…", "leave it with me", "I'll get back to you by…", "I'll set up…".

Rules:
- Only Nick's OWN commitments. What he asks someone else to do is not his task. Thanks, updates and opinions are not tasks.
- Write each as a short action starting with a verb, under 15 words, naming who it is for where the email says (e.g. "Send Dan the UAT availability for the team").
- At most two per email. If there is none, answer null. Most emails are null.
- Do not invent a deadline or a date.

Respond with ONLY a JSON array, one entry per email:
[{"index": 0, "actions": ["Send Chris the headcount numbers"]}, {"index": 1, "actions": null}]

The ${batch.length} emails:

${list}`;
}

function parseAnswer(text, batchSize) {
  const clean = String(text || '').replace(/```json|```/g, '').trim();
  const match = clean.match(/\[[\s\S]*\]/);
  if (!match) throw new Error(`unparseable answer (${clean.length} chars)`);
  const parsed = JSON.parse(match[0]);
  if (!Array.isArray(parsed)) throw new Error('answer was not an array');
  const out = new Map();
  for (const row of parsed) {
    if (!Number.isInteger(row && row.index) || row.index < 0 || row.index >= batchSize) continue;
    const list = Array.isArray(row.actions) ? row.actions : (row.actions ? [row.actions] : []);
    out.set(row.index, list.map((t) => String(t || '').replace(/\s+/g, ' ').trim())
      .filter((t) => t.length >= MIN_TEXT && t.length <= MAX_TEXT && !/^(null|none|n\/a)$/i.test(t)).slice(0, 2));
  }
  return out;
}

function buildCandidate(m, text) {
  const sourcePath = sourcePathFor(m.id);
  const to = recipients(m);
  const signature = actionCandidates.buildSemanticSignature(text);
  return {
    type: 'capture_todo',
    text,
    confidence: CONFIDENCE,
    reason: `You said you would — in your email${to ? ` to ${to}` : ''}, "${String(m.subject || '').slice(0, 60)}"`,
    sourcePath,
    focusItemId: actionCandidates.buildFocusItemId(sourcePath, text),
    autoPromote: false,
    payload: {
      text,
      sourcePath,
      semanticSignature: signature,
      extractedFrom: 'sent-email',
      origin: 'sent-email-candidate',
      source: 'sent-email-promotion',
      email: { id: m.id, to: to || null, subject: m.subject || null, sent: m.sentAt || null, direction: 'sent' },
      metadata: todoIntelligence.triageTodo({ text, sourcePath, dueDate: null }),
    },
  };
}

/** Pure: which messages are worth asking about. */
function eligible(messages, ledger) {
  return (messages || []).filter((m) => m && m.id && !ledger[String(m.id)]
    && String(m.text || '').trim().length >= 12 && !AUTOMATED.test(String(m.subject || '')));
}

async function scan({ now = Date.now(), limit = MAX_PER_RUN } = {}) {
  if (!ENABLED) return { ok: true, skipped: 'disabled', created: 0 };
  const sinceIso = new Date(now - LOOKBACK_DAYS * 86400000).toISOString();
  const read = await require('./microsoft').fetchSentMailText({ sinceIso, maxResults: 150 });
  // Could not ask Graph: a gap, never "you sent nothing".
  if (!read) return { ok: false, gap: 'Sent Items could not be read', created: 0 };

  const ledger = pruneLedger(readLedger(), now);
  const todo = eligible(read.messages, ledger).slice(0, limit);
  const result = { ok: true, read: read.messages.length, asked: todo.length, withCommitment: 0, created: 0, failedBatches: 0 };
  const aiRouting = require('./ai-routing');

  for (let off = 0; off < todo.length; off += BATCH) {
    const batch = todo.slice(off, off + BATCH);
    let answers;
    try {
      const res = await aiRouting.runTask('email_summary', { prompt: buildPrompt(batch), maxTokens: 800, temperature: 0.1 });
      if (!res || !res.text) throw new Error(`no text from ${(res && res.provider) || 'any provider'}`);
      answers = parseAnswer(res.text, batch.length);
    } catch (e) {
      result.failedBatches += 1;
      console.warn(`[SentCommitments] batch failed: ${e.message}`);
      continue; // nothing recorded, so these are asked again next run
    }
    batch.forEach((m, i) => {
      if (!answers.has(i)) return; // skipped row: retried
      const actions = answers.get(i);
      ledger[String(m.id)] = { at: new Date(now).toISOString(), commitments: actions.length };
      if (!actions.length) return;
      result.withCommitment += 1;
      for (const text of actions) {
        const c = buildCandidate(m, text);
        try {
          const existing = db.getSaimActionsBySource(c.sourcePath, 'capture_todo');
          if (existing.some((a) => a.focus_item_id === c.focusItemId || (a.payload && a.payload.semanticSignature === c.payload.semanticSignature))) continue;
          const handled = actionCandidates.reviewStatusFor(c.sourcePath, c.payload.semanticSignature);
          if (handled === 'rejected' || handled === 'executed' || handled === 'ignored') continue;
          db.createSaimAction(c.type, c.payload, c.confidence, c.reason, c.focusItemId);
          result.created += 1;
        } catch (e) {
          console.warn(`[SentCommitments] could not queue "${text.slice(0, 50)}": ${e.message}`);
        }
      }
    });
  }
  writeLedger(ledger);
  if (result.created || result.failedBatches) {
    console.log(`[SentCommitments] ${result.asked} sent emails read, ${result.withCommitment} carried a promise, ${result.created} queued for review`
      + (result.failedBatches ? `, ${result.failedBatches} batch(es) failed — retried next run` : ''));
  }
  return result;
}

module.exports = { scan, eligible, buildPrompt, parseAnswer, buildCandidate, pruneLedger, AUTOMATED, CONFIDENCE, LEDGER_KEY };
