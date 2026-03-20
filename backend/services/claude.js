const Anthropic = require('@anthropic-ai/sdk');
const db = require('../db/database');
const obsidian = require('./obsidian');

const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514';

const SYSTEM_PROMPT = `You are NUERO (Nick's Unified Executive Resource Orchestrator) — Nick's personal AI chief of staff. Nick is Head of Technical Support at Nurtur Limited (formerly BriefYourMarket), having just started this SMT-level role on 16 March 2026. He knows the organisation deeply but is navigating a transition to senior leadership.

Nick's 90-day plan:
- Days 1-30: Visibility and baseline metrics
- Days 30-60: Tiered support model, Engineering relationship, QA framework
- Days 60-90: Optimise and evidence progress

Nick is neurodivergent. His brain tends toward avoidance and distraction when facing uncomfortable tasks. Surface blockers directly and ask "what's the actual blocker?" when something has been sitting too long. Be proactive, direct, outcome-focused.

Key systems: Jira Service Management (primary queue), SQL Server (reporting), Grafana (metrics), Obsidian vault (knowledge base/second brain).

When Nick makes a decision in conversation, flag it with [DECISION] so it can be logged.

Nick's direct reports:
2nd Line: Abdi Mohamed, Arman Shazad, Luke Scaife, Stephen Mitchell, Willem Kruger, Nathan Rutland
1st Line: Adele Norman-Swift, Heidi Power, Hope Goodall, Maria Pappa, Naomi Wentworth, Sebastian Broome, Zoe Rees
Digital Design: Isabel Busk, Kayleigh Russell`;

function isConfigured() {
  return !!process.env.ANTHROPIC_API_KEY;
}

function buildContextBlock(queueSummary, dailyNote, standupContent) {
  const parts = [];

  if (queueSummary && queueSummary.total > 0) {
    parts.push(`## Current Queue Status
- Total open tickets: ${queueSummary.total}
- At-risk (SLA < 2h): ${queueSummary.at_risk_count}
- Open P1/Critical: ${queueSummary.open_p1s}

${queueSummary.at_risk_tickets.length > 0 ? '### At-Risk Tickets\n' + queueSummary.at_risk_tickets.slice(0, 5).map(t =>
  `- ${t.ticket_key}: ${t.summary} (${t.sla_remaining_minutes ? Math.round(t.sla_remaining_minutes) + ' min remaining' : 'SLA unknown'}, assigned: ${t.assignee})`
).join('\n') : ''}`);
  } else {
    parts.push('## Queue Status\nNo Jira data available.');
  }

  if (dailyNote) {
    parts.push(`## Today's Daily Note\n${dailyNote}`);
  }

  if (standupContent) {
    parts.push(`## Standup Template\n${standupContent}`);
  }

  try {
    const scanner = require('./inbox-scanner');
    const inbox = scanner.getFlaggedItems();
    if (inbox.items.length > 0) {
      const highItems = inbox.items.filter(i => i.urgency === 'high');
      const medItems = inbox.items.filter(i => i.urgency === 'medium');
      let inboxBlock = `## Inbox Triage (${inbox.items.length} flagged)`;
      if (highItems.length > 0) {
        inboxBlock += `\n### Urgent (${highItems.length}):\n` +
          highItems.map(i => `- **${i.from}**: ${i.subject} — ${i.summary}`).join('\n');
      }
      if (medItems.length > 0) {
        inboxBlock += `\n### This Week (${medItems.length}):\n` +
          medItems.map(i => `- **${i.from}**: ${i.subject} — ${i.summary}`).join('\n');
      }
      parts.push(inboxBlock);
    }
  } catch (e) { /* scanner not loaded yet */ }

  return parts.join('\n\n---\n\n');
}

async function streamChat(conversationId, userMessage, res) {
  // Save user message
  db.saveMessage(conversationId, 'user', userMessage);

  // Gather context
  const history = db.getConversationHistory(conversationId, 10);
  const queueSummary = db.getQueueSummary();

  let dailyNote = null;
  let standupContent = null;
  try { dailyNote = obsidian.readTodayDailyNote(); } catch (e) {}
  try { standupContent = obsidian.readStandup(); } catch (e) {}

  const contextBlock = buildContextBlock(queueSummary, dailyNote, standupContent);

  const startDate = new Date('2026-03-16');
  const today = new Date();
  const dayCount = Math.floor((today - startDate) / (1000 * 60 * 60 * 24));

  const systemPrompt = `${SYSTEM_PROMPT}

---

## Live Context (auto-injected)

Today is ${today.toISOString().split('T')[0]}. Day ${dayCount} of Nick's new role.

${contextBlock}`;

  // Build messages array (Anthropic format: no system in messages array)
  const messages = history.map(msg => ({ role: msg.role, content: msg.content }));

  console.log(`[Claude] Model: ${CLAUDE_MODEL}, system prompt: ${systemPrompt.length} chars, ${messages.length} messages`);

  // Set SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });

  try {
    const client = new Anthropic();

    const stream = client.messages.stream({
      model: CLAUDE_MODEL,
      max_tokens: 4096,
      system: systemPrompt,
      messages: messages
    });

    let fullResponse = '';

    stream.on('text', (text) => {
      fullResponse += text;
      res.write(`data: ${JSON.stringify({ type: 'text', content: text })}\n\n`);
    });

    stream.on('error', (err) => {
      console.error('[Claude] Stream error:', err.message);
      res.write(`data: ${JSON.stringify({ type: 'error', content: err.message })}\n\n`);
      res.end();
    });

    stream.on('end', () => {
      // Save assistant response
      db.saveMessage(conversationId, 'assistant', fullResponse);

      // Check for decisions
      const decisionRegex = /\[DECISION\]\s*(.*?)(?:\n|$)/g;
      let match;
      while ((match = decisionRegex.exec(fullResponse)) !== null) {
        db.saveDecision(conversationId, match[1].trim());
        try {
          obsidian.appendDecision(match[1].trim());
        } catch (e) {
          console.error('[Claude] Failed to write decision to vault:', e.message);
        }
      }

      res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
      res.end();
    });

    // Handle client disconnect
    res.on('close', () => {
      stream.abort();
    });

  } catch (err) {
    console.error('[Claude] Error:', err.message);
    res.write(`data: ${JSON.stringify({ type: 'error', content: err.message })}\n\n`);
    res.end();
  }
}

module.exports = {
  isConfigured,
  streamChat
};
