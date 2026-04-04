'use strict';

/**
 * AI Provider — unified interface for AI tasks.
 *
 * Delegates to ai-routing.js which handles Ollama/OpenAI selection,
 * failover, and cost controls. This module adds task-specific
 * prompt engineering and output validation.
 *
 * Phase 3A: Ollama-first local reasoning
 * Phase 3B: OpenAI escalation for high-value tasks
 */

const aiRouting = require('./ai-routing');

/**
 * Rewrite shortlist reasons into natural decision-oriented language.
 * @param {Array} items - Focus items with reason fields
 * @returns {Array} Items with enhanced _aiReason field (or original if AI unavailable)
 */
async function enhanceShortlistReasons(items) {
  if (!items || items.length === 0) return items;

  // Only enhance top 5
  const toEnhance = items.slice(0, 5);
  const summary = toEnhance.map((item, i) =>
    `${i + 1}. [${item.type}] ${item.title} — ${item.reason}`
  ).join('\n');

  const result = await aiRouting.runTask('shortlist_reasoning', {
    systemPrompt: 'You rewrite task priority explanations into concise, action-oriented language for a busy manager. One short sentence per item. No numbering. No fluff. Be direct.',
    messages: [{ role: 'user', content: `Rewrite these priority reasons to be clearer and more actionable:\n\n${summary}` }],
    maxTokens: 200,
    temperature: 0.3,
  });

  if (!result.text || result.provider === 'none') return items;

  // Parse response — expect one line per item
  const lines = result.text.trim().split('\n').filter(l => l.trim());
  for (let i = 0; i < Math.min(lines.length, toEnhance.length); i++) {
    const clean = lines[i].replace(/^\d+[\.\)]\s*/, '').trim();
    if (clean.length > 5 && clean.length < 200) {
      toEnhance[i]._aiReason = clean;
    }
  }

  return items;
}

/**
 * Synthesise observations into compact human-readable summary.
 * @param {Array} observations - Working memory observations
 * @returns {string} Summary text or empty string
 */
async function synthesiseObservations(observations) {
  if (!observations || observations.length === 0) return '';

  const obsText = observations.map(o => `- ${o.message}`).join('\n');

  const result = await aiRouting.runTask('observation_synthesis', {
    systemPrompt: 'You summarise system observations into 2-3 concise bullets for a daily note. Be factual and brief. No opinions.',
    messages: [{ role: 'user', content: `Summarise these observations from today:\n\n${obsText}` }],
    maxTokens: 150,
    temperature: 0.2,
  });

  return result.text || '';
}

/**
 * Generate a short framing header for a drill-down view.
 * @param {string} context - e.g. "5 overdue tasks, top is 90-day plan, 179 stale"
 * @returns {string} One-line framing sentence
 */
async function generateDrilldownFraming(context) {
  const result = await aiRouting.runTask('drilldown_framing', {
    prompt: `Write one short sentence explaining why these items are shown first. Context: ${context}. Be concise and helpful, under 20 words.`,
    maxTokens: 50,
    temperature: 0.3,
  });

  const text = (result.text || '').trim();
  // Validate: must be short, no garbage
  if (text.length > 5 && text.length < 150 && !text.includes('{') && !text.includes('```')) {
    return text;
  }
  return '';
}

/**
 * Suggest a next-action phrase for an item.
 * @param {object} item - Focus item
 * @returns {string} Short action phrase or empty string
 */
async function suggestAction(item) {
  const result = await aiRouting.runTask('action_suggestion', {
    prompt: `Given this task: "${item.title}" (${item.reason}), suggest ONE short action phrase (2-5 words). Examples: "reply now", "review before meeting", "delegate to team", "close the loop". Just the phrase, nothing else.`,
    maxTokens: 20,
    temperature: 0.4,
  });

  const text = (result.text || '').trim().toLowerCase();
  // Validate: must be short phrase
  if (text.length >= 3 && text.length <= 40 && !text.includes('\n')) {
    return text;
  }
  return '';
}

/**
 * Run the full streaming chat through the routing layer.
 */
async function streamChat(systemPrompt, messages, res, options = {}) {
  return aiRouting.runStreamingChat(systemPrompt, messages, res, options);
}

/**
 * Classify a vault import file using AI.
 * @param {string} prompt - Classification prompt
 * @returns {{ text: string, provider: string }}
 */
async function classifyImport(prompt) {
  return aiRouting.runTask('import_classification', {
    prompt,
    maxTokens: 256,
    temperature: 0.2,
  });
}

/**
 * Triage emails using AI.
 * @param {string} prompt - Triage prompt
 * @returns {{ text: string, provider: string }}
 */
async function triageEmails(prompt) {
  return aiRouting.runTask('email_triage', {
    prompt,
    maxTokens: 1024,
    temperature: 0.2,
  });
}

/**
 * Process a transcript using AI (escalation-worthy task).
 * @param {string} systemPrompt
 * @param {string} content
 * @returns {{ text: string, provider: string }}
 */
async function processTranscript(systemPrompt, content) {
  return aiRouting.runTask('transcript_processing', {
    systemPrompt,
    messages: [{ role: 'user', content }],
    maxTokens: 1024,
    temperature: 0.3,
  }, { confidence: 0.3 }); // low confidence → eligible for OpenAI escalation
}

/**
 * Generate journal prompts using AI.
 * @param {string} prompt
 * @returns {{ text: string, provider: string }}
 */
async function generateJournalPrompts(prompt) {
  return aiRouting.runTask('journal_prompts', {
    prompt,
    maxTokens: 300,
    temperature: 0.7,
  });
}

/**
 * Get the current AI system status.
 */
function getStatus() {
  return aiRouting.getStatus();
}

module.exports = {
  enhanceShortlistReasons,
  synthesiseObservations,
  generateDrilldownFraming,
  suggestAction,
  streamChat,
  classifyImport,
  triageEmails,
  processTranscript,
  generateJournalPrompts,
  getStatus,
};
