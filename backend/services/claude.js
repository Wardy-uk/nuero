const Anthropic = require('@anthropic-ai/sdk');
const db = require('../db/database');
const obsidian = require('./obsidian');

const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514';

// Reverse geocode lat/lng to a human-readable place name
// Uses OSM Nominatim — free, no key required
async function reverseGeocode(lat, lng) {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&zoom=14&addressdetails=0`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'NEURO-personal-agent/1.0 (nick.ward@nurtur.tech)' },
      signal: AbortSignal.timeout(5000)
    });
    if (!res.ok) return null;
    const data = await res.json();
    // Return neighbourhood + town, or just town, or display_name truncated
    const addr = data.address || {};
    const parts = [
      addr.suburb || addr.neighbourhood || addr.hamlet,
      addr.town || addr.city || addr.village || addr.county
    ].filter(Boolean);
    return parts.length > 0 ? parts.join(', ') : (data.display_name || '').split(',').slice(0, 2).join(',').trim();
  } catch {
    return null;
  }
}
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:1.5b';

// Extract meaningful search keywords from a user message
// Strips common stop words and short tokens, returns the best 1-2 terms to search
function extractSearchTerms(message) {
  const STOP_WORDS = new Set([
    'what', 'when', 'where', 'who', 'why', 'how', 'is', 'are', 'was', 'were',
    'did', 'do', 'does', 'can', 'could', 'would', 'should', 'have', 'has',
    'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
    'of', 'with', 'my', 'me', 'i', 'you', 'we', 'it', 'this', 'that', 'about',
    'tell', 'show', 'find', 'get', 'give', 'help', 'please', 'need', 'want',
    'know', 'think', 'look', 'see', 'any', 'some', 'all', 'from', 'into'
  ]);

  const words = message
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 4 && !STOP_WORDS.has(w));

  // Return up to 2 most meaningful terms (longer words tend to be more specific)
  return words
    .sort((a, b) => b.length - a.length)
    .slice(0, 2);
}

const SYSTEM_PROMPT = `You are NUERO (Nick's Unified Executive Resource Orchestrator) — Nick's personal AI chief of staff. Nick is Head of Technical Support at Nurtur Limited (formerly BriefYourMarket), having just started this SMT-level role on 16 March 2026. He knows the organisation deeply but is navigating a transition to senior leadership.

Nick's 90-day plan:
- Days 1-30: Visibility and baseline metrics
- Days 30-60: Tiered support model, Engineering relationship, QA framework
- Days 60-90: Optimise and evidence progress

Nick is neurodivergent. His brain tends toward avoidance and distraction when facing uncomfortable tasks. Surface blockers directly and ask "what's the actual blocker?" when something has been sitting too long. Be proactive, direct, outcome-focused.

Key systems: Jira Service Management (primary queue), SQL Server (reporting), Grafana (metrics), Obsidian vault (knowledge base/second brain).

Task priority hierarchy (top to bottom):
1. 90-day plan tasks — these are the strategic commitments tied to Nick's new role. Always highest priority.
2. Vault tasks — tasks added within the Obsidian vault from decisions, meetings, or manually. These are Nick's own commitments.
3. MS Planner & MS ToDo — organisational/team tasks. Important but lower priority than Nick's own vault tasks.

When discussing priorities, respect this hierarchy. 90-day plan tasks should never be buried under Planner items.

When Nick makes a decision in conversation, flag it with [DECISION] so it can be logged.

Nick's direct reports:
2nd Line: Abdi Mohamed, Arman Shazad, Luke Scaife, Stephen Mitchell, Willem Kruger, Nathan Rutland
1st Line: Adele Norman-Swift, Heidi Power, Hope Goodall, Maria Pappa, Naomi Wentworth, Sebastian Broome, Zoe Rees
Digital Design: Isabel Busk, Kayleigh Russell`;

function isWeekend() {
  const day = new Date().getDay();
  return day === 0 || day === 6;
}

const WEEKEND_SYSTEM_PROMPT = `You are NUERO — Nick's personal AI assistant. It's the weekend.

Nick is Head of Technical Support at Nurtur Limited. He's been navigating a big career step and works hard during the week. Weekends are for recharging.

Weekend mode — your priorities shift:
- De-prioritise Jira queue, SLA timers, and 90-day plan urgency. Don't surface these unless Nick explicitly asks.
- Lead with personal energy: rest, hobbies (D&D, OU study, home tinkering), family, or anything non-work.
- If Nick asks about work topics, help him — but don't initiate work framing.
- Keep a lighter tone. Less chief-of-staff, more thinking partner.
- If Nick mentions feeling like he should be working: gently remind him that rest is part of the strategy.

Nick's interests: D&D, Raspberry Pi / home automation, Open University (MU123, TM254, TT284), cooking, reading.

Still available: vault notes, capture, calendar, todos — but frame them lightly. A weekend todo is different from a work sprint.

When Nick makes a decision in conversation, flag it with [DECISION] so it can be logged.`;

function isConfigured() {
  // At least one backend is available
  return !!process.env.ANTHROPIC_API_KEY || true; // Ollama is always local
}

function anthropicAvailable() {
  return !!process.env.ANTHROPIC_API_KEY;
}

function buildContextBlock(queueSummary, dailyNote, previousNote, standupContent, todos, ninetyDayPlan, weekend = false, vaultResults = [], locationContext = null) {
  // Location context — injected regardless of weekend mode
  const locationLine = locationContext ? `\n\n**${locationContext}**` : '';

  if (weekend) {
    // Weekend mode — skip queue and 90-day plan, keep daily note and todos only
    const parts = [];
    if (dailyNote) parts.push(`## Today's Note\n${dailyNote}`);
    else if (previousNote) parts.push(`## Previous Note (${previousNote.date})\n${previousNote.content}`);
    if (todos && todos.active && todos.active.length > 0) {
      const personal = todos.active.filter(t => {
        const src = (t.source || '').toLowerCase();
        return !src.includes('ms ') && !src.includes('planner');
      });
      if (personal.length > 0) {
        parts.push(`## Personal Todos\n` + personal.slice(0, 8).map(t => `- ${t.text}`).join('\n'));
      }
    }
    if (vaultResults && vaultResults.length > 0) {
      parts.push(`## Relevant Vault Notes\n` +
        vaultResults.map(r => `### ${r.name}\n${r.excerpts.join('\n...\n')}`).join('\n\n')
      );
    }
    return (parts.join('\n\n---\n\n') || '(Weekend — no work context loaded)') + locationLine;
  }

  const parts = [];
  const diagnostics = [];

  // Queue
  if (queueSummary && queueSummary.total > 0) {
    parts.push(`## Current Queue Status
- Total open tickets: ${queueSummary.total}
- At-risk (SLA < 2h): ${queueSummary.at_risk_count}
- Open P1/Critical: ${queueSummary.open_p1s}

${queueSummary.at_risk_tickets.length > 0 ? '### At-Risk Tickets\n' + queueSummary.at_risk_tickets.slice(0, 5).map(t =>
  `- ${t.ticket_key}: ${t.summary} (${t.sla_remaining_minutes ? Math.round(t.sla_remaining_minutes) + ' min remaining' : 'SLA unknown'}, assigned: ${t.assignee})`
).join('\n') : ''}`);
    diagnostics.push('queue: yes');
  } else {
    parts.push('## Queue Status\nNo Jira data available yet.');
    diagnostics.push('queue: empty');
  }

  // Behavioural patterns from activity log
  try {
    const activity = require('./activity');
    const patternsBlock = activity.getPatternsContextBlock(7);
    if (patternsBlock) {
      parts.push(patternsBlock);
      diagnostics.push('patterns: ok');
    }
  } catch (e) {
    diagnostics.push('patterns: error');
  }

  // Daily note (today or previous as fallback)
  if (dailyNote) {
    parts.push(`## Today's Daily Note\n${dailyNote}`);
    diagnostics.push('daily: today');
  } else if (previousNote) {
    parts.push(`## Previous Daily Note (${previousNote.date})\n${previousNote.content}`);
    diagnostics.push(`daily: fallback ${previousNote.date}`);
  } else {
    diagnostics.push('daily: none');
  }

  if (standupContent) {
    parts.push(`## Standup Template\n${standupContent}`);
    diagnostics.push('standup: yes');
  } else {
    diagnostics.push('standup: none');
  }

  // Meeting prep — upcoming meetings in the next 3 hours
  try {
    const meetingPrep = obsidian.getMeetingPrepContext(3);
    if (meetingPrep.length > 0) {
      let prepBlock = `## Upcoming Meetings (next 3 hours)`;
      for (const meeting of meetingPrep) {
        prepBlock += `\n### ${meeting.time} — ${meeting.subject}`;
        for (const person of meeting.people) {
          prepBlock += `\n**${person.name}** (${person.role})`;
          if (person.lastMeeting) prepBlock += ` — last 1-2-1: ${person.lastMeeting}`;
          if (person.notes) prepBlock += `\n${person.notes}`;
        }
      }
      parts.push(prepBlock);
      diagnostics.push(`meetingPrep: ${meetingPrep.length}`);
    }
  } catch (e) {
    diagnostics.push('meetingPrep: error');
  }

  // Recent decisions from decision log
  try {
    const recentDecisions = obsidian.getRecentDecisions(14);
    if (recentDecisions.length > 0) {
      parts.push(`## Recent Decisions (last 14 days)\n` + recentDecisions.map(d => `- ${d.date}: ${d.text}`).join('\n'));
      diagnostics.push(`decisions: ${recentDecisions.length}`);
    }
  } catch (e) { diagnostics.push('decisions: error'); }

  // Todos from vault — grouped by hierarchy: 90-day plan > vault tasks > MS Planner/ToDo
  if (todos && todos.active && todos.active.length > 0) {
    const formatTask = t => `- ${t.text}${t.due_date ? ` (due: ${t.due_date})` : ''}`;

    // Split by source hierarchy
    const planTasks = todos.active.filter(t => (t.source || '').includes('Daily') && t.priority === 'high');
    const vaultTasks = todos.active.filter(t => {
      const src = (t.source || '').toLowerCase();
      return src.includes('master') || (src.includes('daily') && t.priority !== 'high');
    });
    const msTasks = todos.active.filter(t => {
      const src = (t.source || '').toLowerCase();
      return src.includes('ms ') || src.includes('planner') || src.includes('todo');
    });

    let todoBlock = `## Active Tasks (${todos.active.length} total — hierarchy: 90-day plan → vault → MS Planner/ToDo)`;

    if (planTasks.length > 0) {
      todoBlock += `\n### Focus Today (from daily note)\n` + planTasks.slice(0, 8).map(formatTask).join('\n');
    }
    if (vaultTasks.length > 0) {
      todoBlock += `\n### Vault Tasks\n` + vaultTasks.slice(0, 10).map(formatTask).join('\n');
    }
    if (msTasks.length > 0) {
      todoBlock += `\n### MS Planner / ToDo\n` + msTasks.slice(0, 8).map(formatTask).join('\n');
    }

    parts.push(todoBlock);
    diagnostics.push(`todos: ${todos.active.length} (plan:${planTasks.length} vault:${vaultTasks.length} ms:${msTasks.length})`);
  } else {
    diagnostics.push('todos: none');
  }

  // 90-day plan summary
  if (ninetyDayPlan) {
    let planBlock = `## 90-Day Plan — Day ${ninetyDayPlan.currentDay} of 90`;
    planBlock += `\n- Progress: ${ninetyDayPlan.totalDone}/${ninetyDayPlan.totalTasks} tasks complete`;
    planBlock += `\n- Next checkpoint: ${ninetyDayPlan.nextCheckpoint.label} (${ninetyDayPlan.daysToCheckpoint} working days away)`;
    if (ninetyDayPlan.overdueTasks.length > 0) {
      planBlock += `\n- Overdue: ${ninetyDayPlan.overdueTasks.length} tasks`;
      planBlock += '\n' + ninetyDayPlan.overdueTasks.slice(0, 5).map(t =>
        `  - Day ${t.day}: ${t.text}`
      ).join('\n');
    }
    if (ninetyDayPlan.todayTasks.length > 0) {
      planBlock += `\n### Today's 90-Day Tasks`;
      planBlock += '\n' + ninetyDayPlan.todayTasks.map(t =>
        `- [${t.status === 'x' ? 'x' : ' '}] ${t.text}`
      ).join('\n');
    }
    parts.push(planBlock);
    diagnostics.push(`90day: day ${ninetyDayPlan.currentDay}`);
  } else {
    diagnostics.push('90day: none');
  }

  // Inbox
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
      diagnostics.push(`inbox: ${inbox.items.length}`);
    } else {
      diagnostics.push('inbox: empty');
    }
  } catch (e) {
    diagnostics.push('inbox: unavailable');
  }

  // Upcoming 1-2-1s
  try {
    const upcoming121s = obsidian.getUpcoming121s(3);
    if (upcoming121s.length > 0) {
      const lines = upcoming121s.map(u =>
        `- ${u.name}: ${u.overdue ? '⚠️ OVERDUE (was ' + u.dueDate + ')' : 'due ' + u.dueDate + ' (' + u.daysUntil + ' day' + (u.daysUntil !== 1 ? 's' : '') + ')'}`
      );
      parts.push(`## Upcoming 1-2-1s\n${lines.join('\n')}`);
      diagnostics.push(`121s: ${upcoming121s.length}`);
    }
  } catch (e) { diagnostics.push('121s: error'); }

  // Location
  if (locationContext) {
    parts.push(`## Location\n${locationContext}`);
    diagnostics.push('location: yes');
  }

  // Vault search results
  if (vaultResults && vaultResults.length > 0) {
    const vaultBlock = `## Relevant Vault Notes\n` +
      vaultResults.map(r =>
        `### ${r.name} (${r.path})\n${r.excerpts.join('\n...\n')}`
      ).join('\n\n');
    parts.push(vaultBlock);
    diagnostics.push(`vault: ${vaultResults.length} notes`);
  }

  console.log('[Context] Sources:', diagnostics.join(', '));
  return parts.join('\n\n---\n\n');
}

// ── Post-response processing (shared by both backends) ──

function handleResponse(conversationId, fullResponse) {
  db.saveMessage(conversationId, 'assistant', fullResponse);

  const decisionRegex = /\[DECISION\]\s*(.*?)(?:\n|$)/g;
  let match;
  while ((match = decisionRegex.exec(fullResponse)) !== null) {
    db.saveDecision(conversationId, match[1].trim());
    try {
      obsidian.appendDecision(match[1].trim());
    } catch (e) {
      console.error('[AI] Failed to write decision to vault:', e.message);
    }
  }
}

// ── Claude API streaming ──

async function streamClaude(systemPrompt, messages, res) {
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

  res.on('close', () => {
    stream.abort();
  });

  return new Promise((resolve) => {
    stream.on('end', () => resolve(fullResponse));
  });
}

// ── Ollama streaming ──

async function streamOllama(systemPrompt, messages, res) {
  const ollamaMessages = [
    { role: 'system', content: systemPrompt },
    ...messages
  ];

  const response = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      messages: ollamaMessages,
      stream: true,
      options: { temperature: 0.7, num_ctx: 4096, num_predict: 1024 }
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Ollama error ${response.status}: ${errText}`);
  }

  let fullResponse = '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const chunk = decoder.decode(value, { stream: true });
    const lines = chunk.split('\n').filter(l => l.trim());

    for (const line of lines) {
      try {
        const data = JSON.parse(line);
        if (data.message && data.message.content) {
          fullResponse += data.message.content;
          res.write(`data: ${JSON.stringify({ type: 'text', content: data.message.content })}\n\n`);
        }
      } catch (e) { /* partial chunk */ }
    }
  }

  return fullResponse;
}

// ── Main entry point ──

async function streamChat(conversationId, userMessage, res, location = null) {
  db.saveMessage(conversationId, 'user', userMessage);
  try { require('./activity').trackChatMessage(userMessage); } catch {}

  const history = db.getConversationHistory(conversationId, 10);
  const queueSummary = db.getQueueSummary();

  let dailyNote = null;
  let previousNote = null;
  let standupContent = null;
  let todos = null;
  let ninetyDayPlan = null;

  try { dailyNote = obsidian.readTodayDailyNote(); } catch (e) { console.warn('[Context] Daily note error:', e.message); }
  if (!dailyNote) {
    try { previousNote = obsidian.readPreviousDailyNote(); } catch (e) { console.warn('[Context] Previous note error:', e.message); }
  }
  try { standupContent = obsidian.readStandup(); } catch (e) { console.warn('[Context] Standup error:', e.message); }
  try { todos = obsidian.parseVaultTodos(); } catch (e) { console.warn('[Context] Todos error:', e.message); }
  try { ninetyDayPlan = obsidian.parseNinetyDayPlan(); } catch (e) { console.warn('[Context] 90-day plan error:', e.message); }

  // Vault search — find relevant notes based on user's message
  let vaultSearchResults = [];
  try {
    const terms = extractSearchTerms(userMessage);
    if (terms.length > 0) {
      // Search for each term, merge results, deduplicate by path
      const seen = new Set();
      for (const term of terms) {
        const hits = obsidian.searchVault(term, 4);
        for (const hit of hits) {
          if (!seen.has(hit.path)) {
            seen.add(hit.path);
            vaultSearchResults.push(hit);
          }
        }
      }
      if (vaultSearchResults.length > 0) {
        console.log(`[Context] Vault search for "${terms.join(', ')}" → ${vaultSearchResults.length} hits`);
      }
    }
  } catch (e) {
    console.warn('[Context] Vault search error:', e.message);
  }

  // Reverse geocode location if provided
  let locationContext = null;
  if (location && location.lat && location.lng) {
    try {
      const place = await reverseGeocode(location.lat, location.lng);
      locationContext = place
        ? `Nick's current location: ${place} (±${location.accuracy || '?'}m)`
        : `Nick's current location: ${location.lat.toFixed(4)}, ${location.lng.toFixed(4)}`;
    } catch (e) {
      console.warn('[Context] Geocode failed:', e.message);
    }
  }

  const weekend = isWeekend();
  const contextBlock = buildContextBlock(queueSummary, dailyNote, previousNote, standupContent, todos, ninetyDayPlan, weekend, vaultSearchResults, locationContext);

  const startDate = new Date('2026-03-16');
  const today = new Date();
  const dayCount = Math.floor((today - startDate) / (1000 * 60 * 60 * 24));

  const basePrompt = weekend ? WEEKEND_SYSTEM_PROMPT : SYSTEM_PROMPT;

  const systemPrompt = `${basePrompt}

---

## Live Context (auto-injected)

Today is ${today.toISOString().split('T')[0]}. Day ${dayCount} of Nick's new role.

${contextBlock}`;

  const messages = history.map(msg => ({ role: msg.role, content: msg.content }));

  // Set SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });

  // Try Claude API first, fall back to Ollama
  const useClaude = anthropicAvailable();
  const backend = useClaude ? 'Claude' : 'Ollama';
  console.log(`[${backend}] Model: ${useClaude ? CLAUDE_MODEL : OLLAMA_MODEL}, system: ${systemPrompt.length} chars, ${messages.length} msgs`);

  try {
    let fullResponse;
    if (useClaude) {
      try {
        fullResponse = await streamClaude(systemPrompt, messages, res);
      } catch (claudeErr) {
        // Claude failed — fall back to Ollama
        console.error('[Claude] Failed, falling back to Ollama:', claudeErr.message);
        res.write(`data: ${JSON.stringify({ type: 'text', content: '*[Falling back to local model]*\n\n' })}\n\n`);
        fullResponse = '*[Falling back to local model]*\n\n' + await streamOllama(systemPrompt, messages, res);
      }
    } else {
      fullResponse = await streamOllama(systemPrompt, messages, res);
    }

    handleResponse(conversationId, fullResponse);
    res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
    res.end();
  } catch (err) {
    console.error(`[${backend}] Error:`, err.message);
    res.write(`data: ${JSON.stringify({ type: 'error', content: err.message })}\n\n`);
    res.end();
  }
}

module.exports = {
  isConfigured,
  streamChat
};
