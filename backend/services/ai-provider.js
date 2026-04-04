'use strict';

/**
 * AI Provider — unified interface for AI tasks.
 *
 * Phase 3A Activation: Adds Focus enhancement (primary directive,
 * per-item guidance, ignore summary, adaptive tone), drill-down framing,
 * and action suggestions.
 *
 * All calls go through ai-routing.js for Ollama/OpenAI selection + cost control.
 */

const aiRouting = require('./ai-routing');

// ═══════════════════════════════════════════════════════
// Tone Selection (deterministic, no LLM)
// ═══════════════════════════════════════════════════════

/**
 * Select the adaptive tone based on context and observations.
 * Returns: 'calm' | 'focused' | 'assertive' | 'critical'
 */
function getTone(ctx) {
  const observations = ctx.observations || [];
  const snoozeCount = ctx.snoozeCount || 0;
  const dismissCount = ctx.dismissCount || 0;
  const hour = ctx.timeContext?.hour ?? new Date().getHours();

  // CRITICAL: operational urgency
  const hasCrisis = observations.some(o => o.type === 'queue_spike') &&
                    observations.some(o => o.type === 'sla_worsening');
  const hasNewEscalation = observations.some(o => o.type === 'new_escalation');
  if (hasCrisis || hasNewEscalation) return 'critical';

  // ASSERTIVE: avoidance patterns
  const hasSnoozePattern = observations.some(o => o.type === 'snooze_pattern');
  const standupLate = observations.some(o => o.type === 'standup_late');
  if (hasSnoozePattern || standupLate || snoozeCount >= 5 || dismissCount >= 4) return 'assertive';

  // CALM: overwhelm signals (high item count, lots of overdue)
  const todoCount = ctx.todos?.active?.length || 0;
  const overdueCount = (ctx.todos?.active || []).filter(t =>
    t.due_date && t.due_date.split('T')[0] < ctx.dateKey
  ).length;
  if (overdueCount > 50 || todoCount > 200) return 'calm';

  // FOCUSED: normal operating mode
  return 'focused';
}

const TONE_INSTRUCTIONS = {
  calm: 'The user is likely overwhelmed. Be grounding and simplifying. Emphasise what to ignore. Keep everything very short. Frame choices as "just do this one thing."',
  focused: 'Normal operating mode. Be clear, direct, and professional. One recommendation per item. No fluff.',
  assertive: 'The user may be avoiding something. Be firm but kind. Challenge drift gently. Use action language. Don\'t offer escape routes.',
  critical: 'Operational urgency is high. Be urgent and direct. No padding. Immediate action required. Cut everything non-essential.',
};


// ═══════════════════════════════════════════════════════
// Focus Enhancement (primary directive + item guidance)
// ═══════════════════════════════════════════════════════

/**
 * Enhance focus output with AI-generated directive, guidance, and ignore summary.
 *
 * @param {object} params
 * @param {Array} params.items - Decision engine focus items (max 5)
 * @param {object} params.context - Working memory context
 * @param {string} params.tone - Selected tone mode
 * @param {object} params.primaryItem - Primary item metadata from engine (or null)
 * @returns {object} { primary, items, ignore, provider } or null if AI unavailable
 */
async function enhanceFocus({ items, context, tone, primaryItem }) {
  if (!items || items.length === 0) return null;

  const toneGuide = TONE_INSTRUCTIONS[tone] || TONE_INSTRUCTIONS.focused;

  // Build a compact context summary for the prompt (keep it small)
  const contextLines = [];
  if (context.queueSummary?.total) contextLines.push(`Queue: ${context.queueSummary.total} tickets, ${(context.queueSummary.at_risk_tickets || []).length} at risk`);
  if (context.standupDone === false) contextLines.push('Standup not done yet');
  if (context.snoozeCount > 0) contextLines.push(`${context.snoozeCount} snoozes today`);
  const ctxStr = contextLines.length > 0 ? contextLines.join('. ') + '.' : 'Normal day.';

  const itemSummary = items.slice(0, 5).map((item, i) =>
    `${i + 1}. [${item.type}] "${item.title}" — ${item.reason}${item._override ? ` (OVERRIDE: ${item._override})` : ''}`
  ).join('\n');

  // Keep prompt minimal — Pi 5 generates at ~3 tok/s, so 100 output tokens = ~30s
  const systemPrompt = `SARA: decisive chief of staff. JSON only. Tone: ${tone}. ${toneGuide.split('.')[0]}.`;

  const userMessage = `${ctxStr}
Items: ${items.slice(0, 3).map((item, i) => `${i+1}. ${item.title}`).join('; ')}

Reply JSON: {"primary":{"message":"<10 words>","action":"<5 words>"},"ignore":"<10 words>"}
JSON only:`;

  try {
    const result = await aiRouting.runTask('focus_enhancement', {
      systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
      maxTokens: 80,
      temperature: 0.3,
    }, { timeout: 14000 }); // Must complete within Focus route's 15s timeout

    if (!result.text || result.provider === 'none') return null;

    // Parse and validate
    const parsed = _parseJSON(result.text);
    if (!parsed || !parsed.primary?.message) return null;

    // Validate — reject garbage
    if (parsed.primary.message.length > 80) return null;

    return {
      primary: {
        message: parsed.primary.message.substring(0, 80),
        action: (parsed.primary.action || '').substring(0, 40),
      },
      ignore: (parsed.ignore || '').substring(0, 80),
      provider: result.provider,
      tone,
    };
  } catch (e) {
    console.warn('[AIProvider] Focus enhancement failed:', e.message);
    return null;
  }
}

function _parseJSON(text) {
  // Try to extract JSON from potentially messy output
  const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    // Try to find a JSON object in the text
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try { return JSON.parse(match[0]); } catch {}
    }
    return null;
  }
}


// ═══════════════════════════════════════════════════════
// Existing functions (preserved from Phase 3A/B)
// ═══════════════════════════════════════════════════════

async function generateDrilldownFraming(context) {
  const result = await aiRouting.runTask('drilldown_framing', {
    prompt: `Write one short sentence explaining why these items are shown first. Context: ${context}. Be concise and helpful, under 20 words.`,
    maxTokens: 50,
    temperature: 0.3,
  }, { timeout: 4000 });

  const text = (result.text || '').trim();
  if (text.length > 5 && text.length < 150 && !text.includes('{') && !text.includes('```')) {
    return { text, provider: result.provider };
  }
  return { text: '', provider: 'none' };
}

async function streamChat(systemPrompt, messages, res, options = {}) {
  return aiRouting.runStreamingChat(systemPrompt, messages, res, options);
}

async function classifyImport(prompt) {
  return aiRouting.runTask('import_classification', {
    prompt,
    maxTokens: 256,
    temperature: 0.2,
  });
}

async function triageEmails(prompt) {
  return aiRouting.runTask('email_triage', {
    prompt,
    maxTokens: 1024,
    temperature: 0.2,
  });
}

async function processTranscript(systemPrompt, content) {
  return aiRouting.runTask('transcript_processing', {
    systemPrompt,
    messages: [{ role: 'user', content }],
    maxTokens: 1024,
    temperature: 0.3,
  }, { confidence: 0.3 });
}

async function generateJournalPrompts(prompt) {
  return aiRouting.runTask('journal_prompts', {
    prompt,
    maxTokens: 300,
    temperature: 0.7,
  });
}

function getStatus() {
  return aiRouting.getStatus();
}

module.exports = {
  getTone,
  enhanceFocus,
  generateDrilldownFraming,
  streamChat,
  classifyImport,
  triageEmails,
  processTranscript,
  generateJournalPrompts,
  getStatus,
};
