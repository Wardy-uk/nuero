const Anthropic = require('@anthropic-ai/sdk');
const db = require('../db/database');
const obsidian = require('./obsidian');

const SYSTEM_PROMPT = `You are Nick's personal AI chief of staff. Nick is Head of Technical Support at Nurtur Limited (formerly BriefYourMarket), having just started this SMT-level role on 16 March 2026 after 5+ years running the support team. He knows the organisation deeply but is navigating a transition to senior leadership — this is a mindset shift, not a new environment.

Nick's 90-day plan:
- Days 1-30: Visibility and baseline metrics
- Days 30-60: Tiered support model, Engineering relationship, QA framework
- Days 60-90: Optimise and evidence progress

Nick is neurodivergent. His brain tends toward avoidance and distraction when facing uncomfortable tasks. You should surface blockers directly and ask "what's the actual blocker?" when something has been sitting too long. You are proactive — you surface the right information before he asks. You are direct — you don't pad responses. You think in outcomes, not tasks.

Key systems: Jira Service Management (primary queue), SQL Server (reporting), Grafana (metrics), Obsidian (knowledge base/second brain).

When Nick makes a decision in conversation, flag it with [DECISION] so it can be logged to his Decision Log automatically.

Nick's direct reports:

2nd Line Technical Support:
- Abdi Mohamed (ID: D2V00471) — 2nd Line Support Analyst
- Arman Shazad (ID: D2V00451) — 2nd Line Support Analyst
- Luke Scaife (ID: D2V00506) — 2nd Line Support Analyst
- Stephen Mitchell (ID: D2V00391) — Support Analyst, trialling queue hygiene lead role
- Willem Kruger (ID: D2V00255) — 2nd Line Support Analyst
- Nathan Rutland (ID: D2V00269) — Senior Service Desk Analyst

1st Line Customer Care:
- Adele Norman-Swift (ID: D2V00427) — Customer Service Agent
- Heidi Power (ID: D2V00505) — Customer Service Agent, active improvement window, SMART metrics required
- Hope Goodall (ID: 520) — Customer Service Agent, transitioning from call-listening to call-taking
- Maria Pappa (ID: D2V00403) — Customer Service Agent
- Naomi Wentworth (ID: D2V00509) — Customer Service Agent, Confluence triage guide owner
- Sebastian Broome (ID: D2V00500) — 1st Line Support Analyst
- Zoe Rees (ID: 517) — Customer Service Agent

Digital Design (also reporting to Nick):
- Isabel Busk (ID: D2V00359) — Digital Design Executive
- Kayleigh Russell (ID: D2V00318) — Digital Design Executive`;

function isConfigured() {
  return !!process.env.ANTHROPIC_API_KEY;
}

function getClient() {
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

function buildContextBlock(queueSummary, dailyNote, standupContent) {
  const parts = [];

  // Queue context
  if (queueSummary && queueSummary.total > 0) {
    parts.push(`## Current Queue Status
- Total open tickets: ${queueSummary.total}
- At-risk (SLA < 2h): ${queueSummary.at_risk_count}
- Open P1/Critical: ${queueSummary.open_p1s}

${queueSummary.at_risk_tickets.length > 0 ? '### At-Risk Tickets\n' + queueSummary.at_risk_tickets.map(t =>
  `- ${t.ticket_key}: ${t.summary} (${t.sla_remaining_minutes ? Math.round(t.sla_remaining_minutes) + ' min remaining' : 'SLA unknown'}, assigned: ${t.assignee})`
).join('\n') : ''}`);
  } else {
    parts.push('## Queue Status\nNo Jira data available (not configured or no open tickets).');
  }

  // Daily note
  if (dailyNote) {
    parts.push(`## Today's Daily Note\n${dailyNote}`);
  }

  // Standup
  if (standupContent) {
    parts.push(`## Standup Template\n${standupContent}`);
  }

  return parts.join('\n\n---\n\n');
}

async function streamChat(conversationId, userMessage, res) {
  if (!isConfigured()) {
    res.write(`data: ${JSON.stringify({ error: 'Anthropic API key not configured' })}\n\n`);
    res.end();
    return;
  }

  const client = getClient();

  // Save user message
  db.saveMessage(conversationId, 'user', userMessage);

  // Gather context
  const history = db.getConversationHistory(conversationId, 20);
  const queueSummary = db.getQueueSummary();

  let dailyNote = null;
  let standupContent = null;
  try {
    dailyNote = obsidian.readTodayDailyNote();
  } catch (e) { /* no daily note today */ }
  try {
    standupContent = obsidian.readStandup();
  } catch (e) { /* no standup file */ }

  const contextBlock = buildContextBlock(queueSummary, dailyNote, standupContent);

  // Calculate day count for context
  const startDate = new Date('2026-03-16');
  const today = new Date();
  const dayCount = Math.floor((today - startDate) / (1000 * 60 * 60 * 24));

  const systemPrompt = `${SYSTEM_PROMPT}

---

## Live Context (auto-injected)

Today is ${today.toISOString().split('T')[0]}. Day ${dayCount} of Nick's new role.

${contextBlock}`;

  // Build messages array
  const messages = history.map(msg => ({
    role: msg.role,
    content: msg.content
  }));

  // Set SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });

  try {
    let fullResponse = '';

    const stream = client.messages.stream({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      system: systemPrompt,
      messages: messages
    });

    stream.on('text', (text) => {
      fullResponse += text;
      res.write(`data: ${JSON.stringify({ type: 'text', content: text })}\n\n`);
    });

    stream.on('end', () => {
      // Save assistant response
      db.saveMessage(conversationId, 'assistant', fullResponse);

      // Check for decisions
      const decisionRegex = /\[DECISION\]\s*(.*?)(?:\n|$)/g;
      let match;
      while ((match = decisionRegex.exec(fullResponse)) !== null) {
        db.saveDecision(conversationId, match[1].trim());
        // Also write to Obsidian decision log
        try {
          obsidian.appendDecision(match[1].trim());
        } catch (e) {
          console.error('[Claude] Failed to write decision to vault:', e.message);
        }
      }

      res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
      res.end();
    });

    stream.on('error', (err) => {
      console.error('[Claude] Stream error:', err.message);
      res.write(`data: ${JSON.stringify({ type: 'error', content: err.message })}\n\n`);
      res.end();
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
