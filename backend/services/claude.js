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
function extractTemporalContext(message) {
  const patterns = [
    { regex: /last week/i, days: 7 },
    { regex: /last month/i, days: 30 },
    { regex: /yesterday/i, days: 1 },
    { regex: /this week/i, days: 7 },
    { regex: /(\d+)\s+days?\s+ago/i, daysFromMatch: true },
    { regex: /in (january|february|march|april|may|june|july|august|september|october|november|december)/i, monthMatch: true }
  ];

  for (const p of patterns) {
    const m = message.match(p.regex);
    if (!m) continue;
    if (p.daysFromMatch) {
      const days = parseInt(m[1]);
      const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
      return { from: from.toISOString().split('T')[0], to: new Date().toISOString().split('T')[0] };
    }
    if (p.monthMatch) {
      const months = ['january','february','march','april','may','june','july','august','september','october','november','december'];
      const monthIdx = months.indexOf(m[1].toLowerCase());
      const year = new Date().getFullYear();
      const from = new Date(year, monthIdx, 1);
      const to = new Date(year, monthIdx + 1, 0);
      return { from: from.toISOString().split('T')[0], to: to.toISOString().split('T')[0] };
    }
    const days = p.days;
    const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    return { from: from.toISOString().split('T')[0], to: new Date().toISOString().split('T')[0] };
  }
  return null;
}

// Detect query intent to scope context — reduces token usage
function detectQueryIntent(message) {
  const msg = message.toLowerCase();
  if (/queue|ticket|sla|at.risk|escalat|jira|nt-\d/i.test(msg)) return 'queue';
  if (/heidi|abdi|arman|luke|stephen|willem|nathan|adele|hope|maria|naomi|sebastian|zoe|isabel|kayleigh|person|team|1.2.1|one.to.one/i.test(msg)) return 'people';
  if (/plan|90.day|outcome|checkpoint|milestone|objective/i.test(msg)) return 'planning';
  if (/health|hrv|sleep|strava|run|exercise|energy|recovery|wellbeing|feeling/i.test(msg)) return 'wellbeing';
  if (/standup|yesterday|today|focus|blocker|carry/i.test(msg)) return 'standup';
  if (/email|inbox|triage|message|teams/i.test(msg)) return 'inbox';
  if (/calendar|meeting|schedule|appointment/i.test(msg)) return 'calendar';
  return 'general';
}

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

Chat commands — use these proactively when appropriate:
- [ADD TODO: text] — adds an action item directly to Nick's Master Todo inbox
- [MEETING NOTE: Title] — saves this conversation as a meeting note in the vault
- [DECISION: text] — already in use, logs decisions to vault
- [UPDATE PERSON: Name] — signals Nick to update a person note (shows UI prompt)

Use [ADD TODO] when you identify a clear action Nick should take. Use [MEETING NOTE]
when a conversation has substantive content worth archiving. Always prefer explicit
markers over just mentioning things — if it's worth doing, capture it.

Nick's direct reports:
2nd Line: Abdi Mohamed, Arman Shazad, Luke Scaife, Stephen Mitchell, Willem Kruger, Nathan Rutland
1st Line: Adele Norman-Swift, Heidi Power, Hope Goodall, Maria Pappa, Naomi Wentworth, Sebastian Broome, Zoe Rees
Digital Design: Isabel Busk, Kayleigh Russell

Drafting from vault — when Nick asks you to draft something for a person or situation:
1. Tell him what vault context you found before drafting (e.g. "I can see your notes on Heidi from 3 1-2-1s — drafting from those now")
2. Use [MEETING NOTE: Draft - Title] marker if the draft is worth saving
3. Structure: context summary → draft → suggested next step
4. If asking about a team member, always pull their People note context first

Draft triggers — recognise these phrasings and treat as drafting requests:
- "draft / write / put together [X] for [person]"
- "help me respond to [person] about [topic]"
- "what would you say to [person] about [topic]"
- "I need to tell [person] about [topic]"
- "update for [person]"`;

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

async function buildContextBlock(queueSummary, dailyNote, previousNote, standupContent, todos, ninetyDayPlan, weekend = false, vaultResults = [], locationContext = null, intent = 'general') {
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

  // Queue — only for queue/general/standup intent
  if (['queue', 'general', 'standup'].includes(intent) && queueSummary && queueSummary.total > 0) {
    parts.push(`## Current Queue Status
- Total open tickets: ${queueSummary.total}
- At-risk (SLA < 2h): ${queueSummary.at_risk_count}
- Open P1/Critical: ${queueSummary.open_p1s}

${queueSummary.at_risk_tickets.length > 0 ? '### At-Risk Tickets\n' + queueSummary.at_risk_tickets.slice(0, 5).map(t =>
  `- ${t.ticket_key}: ${t.summary} (${t.sla_remaining_minutes ? Math.round(t.sla_remaining_minutes) + ' min remaining' : 'SLA unknown'}, assigned: ${t.assignee})`
).join('\n') : ''}`);
    diagnostics.push('queue: yes');
  } else if (['queue', 'general', 'standup'].includes(intent)) {
    parts.push('## Queue Status\nNo Jira data available yet.');
    diagnostics.push('queue: empty');
  } else {
    diagnostics.push('queue: skipped (intent: ' + intent + ')');
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

  // Meeting prep — only for calendar/people/standup/general
  if (['calendar', 'people', 'standup', 'general'].includes(intent)) try {
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
  } else { diagnostics.push('meetingPrep: skipped'); }

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

  // 90-day plan — only for planning/standup/general
  if (['planning', 'standup', 'general'].includes(intent) && ninetyDayPlan) {
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
  } else if (['planning', 'standup', 'general'].includes(intent)) {
    diagnostics.push('90day: none');
  } else {
    diagnostics.push('90day: skipped');
  }

  if (['inbox', 'general'].includes(intent)) try {
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
  } else { diagnostics.push('inbox: skipped'); }

  if (['people', 'general'].includes(intent)) try {
    const upcoming121s = obsidian.getUpcoming121s(3);
    if (upcoming121s.length > 0) {
      const lines = upcoming121s.map(u =>
        `- ${u.name}: ${u.overdue ? '⚠️ OVERDUE (was ' + u.dueDate + ')' : 'due ' + u.dueDate + ' (' + u.daysUntil + ' day' + (u.daysUntil !== 1 ? 's' : '') + ')'}`
      );
      parts.push(`## Upcoming 1-2-1s\n${lines.join('\n')}`);
      diagnostics.push(`121s: ${upcoming121s.length}`);
    }
  } catch (e) { diagnostics.push('121s: error'); } else { diagnostics.push('121s: skipped'); }

  if (['wellbeing', 'general'].includes(intent) && locationContext) {
    parts.push(`## Location\n${locationContext}`);
    diagnostics.push('location: yes');
  }

  // Strava — only for wellbeing intent
  if (intent === 'wellbeing') try {
    const stravaService = require('./strava');
    if (stravaService.isConfigured() && stravaService.isAuthenticated()) {
      const activityCtx = await stravaService.getActivityContext();
      if (activityCtx) {
        parts.push(`## Today's Activity\n${activityCtx}`);
        diagnostics.push('strava: yes');
      } else {
        diagnostics.push('strava: no activity today');
      }
    }
  } catch (e) {
    diagnostics.push('strava: error');
  } else { diagnostics.push('strava: skipped'); }

  // Apple Health — only for wellbeing intent
  if (intent === 'wellbeing') try {
    const healthService = require('./health');
    const healthBlock = healthService.getHealthContextBlock();
    if (healthBlock) {
      parts.push(healthBlock);
      diagnostics.push('health: yes');
    }
  } catch (e) {
    diagnostics.push('health: error');
  } else { diagnostics.push('health: skipped'); }

  // OwnTracks — only for wellbeing/general
  if (['wellbeing', 'general'].includes(intent)) try {
    const locationService = require('./location');
    if (locationService.isConfigured()) {
      const locationBlock = await locationService.getLocationContextBlock();
      if (locationBlock) {
        parts.push(locationBlock);
        diagnostics.push('location: yes');
      }
    }
  } catch (e) {
    diagnostics.push('location: error');
  } else { diagnostics.push('owntracks: skipped'); }

  // Vault search results
  if (vaultResults && vaultResults.length > 0) {
    const vaultBlock = `## Relevant Vault Notes\n` +
      vaultResults.map(r =>
        `### ${r.name} (${r.path})\n${r.excerpts.join('\n...\n')}`
      ).join('\n\n');
    parts.push(vaultBlock);
    diagnostics.push(`vault: ${vaultResults.length} notes`);

    // Related notes — for each vault search result, find 1-2 related notes not already in results
    try {
      const seenPaths = new Set(vaultResults.map(r => r.path));
      const relatedAll = [];
      for (const result of vaultResults.slice(0, 2)) {
        const body = result.excerpts?.[0] || '';
        if (body.length < 20) continue;
        const related = await obsidian.searchVaultSemantic(body, 3);
        for (const r of (related || [])) {
          if (!seenPaths.has(r.path)) {
            seenPaths.add(r.path);
            relatedAll.push(r);
          }
        }
      }
      if (relatedAll.length > 0) {
        parts.push('## Related Vault Notes (connected context)\n' +
          relatedAll.slice(0, 3).map(r =>
            `### ${r.name}\n${r.excerpts?.[0]?.substring(0, 200) || ''}`
          ).join('\n\n')
        );
        diagnostics.push(`related: ${relatedAll.length}`);
      }
    } catch (e) {
      diagnostics.push('related: error');
    }
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

  // [ADD TODO: text] — add to Master Todo inbox
  const todoRegex = /\[ADD TODO:\s*(.+?)\]/g;
  while ((match = todoRegex.exec(fullResponse)) !== null) {
    try {
      obsidian.addTodoFromChat(match[1].trim());
      console.log('[Chat] Auto-added todo:', match[1].trim());
    } catch (e) {
      console.error('[Chat] Failed to add todo:', e.message);
    }
  }

  // [MEETING NOTE: title] — save meeting note
  const meetingRegex = /\[MEETING NOTE:\s*(.+?)\]/g;
  while ((match = meetingRegex.exec(fullResponse)) !== null) {
    try {
      const title = match[1].trim();
      // Get last few messages as summary
      const history = db.getConversationHistory(conversationId, 6);
      const summary = history
        .filter(m => m.role === 'user')
        .map(m => `- ${m.content.substring(0, 120)}`)
        .join('\n');
      obsidian.saveMeetingNoteFromChat(title, summary);
      console.log('[Chat] Meeting note saved:', title);
      try { require('./activity').trackVaultWrite('meeting-note'); } catch {}
    } catch (e) {
      console.error('[Chat] Failed to save meeting note:', e.message);
    }
  }

  // [UPDATE PERSON: Name] — trigger person note update via IMP-04's endpoint
  // This is handled client-side — the marker is detected in ChatPanel and a
  // confirmation dialog is shown. Backend just logs it.
  const personRegex = /\[UPDATE PERSON:\s*(.+?)\]/g;
  while ((match = personRegex.exec(fullResponse)) !== null) {
    console.log('[Chat] Person update requested for:', match[1].trim());
    // Client-side handler in ChatPanel.jsx will detect this and show UI
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
      options: { temperature: 0.7, num_ctx: 2048, num_predict: 512 }
    }),
    signal: AbortSignal.timeout(120000)
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

  // Use working memory for cached context (queue, todos, plan)
  let wmCtx = null;
  try { wmCtx = await require('./working-memory').getContext(); } catch {}

  const queueSummary = wmCtx?.queueSummary || db.getQueueSummary();
  const todos = wmCtx?.todos || (() => { try { return obsidian.parseVaultTodos(); } catch { return null; } })();
  const ninetyDayPlan = wmCtx?.ninetyDayPlan || (() => { try { return obsidian.parseNinetyDayPlan(); } catch { return null; } })();

  // Daily note and standup always read fresh — cheap and must be current
  let dailyNote = null;
  let previousNote = null;
  let standupContent = null;

  try { dailyNote = obsidian.readTodayDailyNote(); } catch (e) { console.warn('[Context] Daily note error:', e.message); }
  if (!dailyNote) {
    try { previousNote = obsidian.readPreviousDailyNote(); } catch (e) { console.warn('[Context] Previous note error:', e.message); }
  }
  try { standupContent = obsidian.readStandup(); } catch (e) { console.warn('[Context] Standup error:', e.message); }

  const queryIntent = detectQueryIntent(userMessage);

  // Detect synthesis queries — "summarise everything about X", "what do I know about X"
  const SYNTHESIS_PATTERNS = [
    /summaris[e|ing].*(everything|all).*(about|on|regarding)/i,
    /what (do i|have i).*(know|written|noted|captured).*(about|on)/i,
    /give me everything (i have |i.ve )?(on|about)/i,
    /pull (everything|all).*(on|about)/i,
    /full picture.*(on|about|of)/i,
    /everything (related|connected).*(to|about)/i
  ];

  const isSynthesisQuery = SYNTHESIS_PATTERNS.some(p => p.test(userMessage));
  const maxVaultResults = isSynthesisQuery ? 12 : queryIntent === 'general' ? 4 : 3;

  // Unified retrieval — keyword + semantic + temporal fused via RRF
  let vaultSearchResults = [];
  try {
    const retrieval = require('./retrieval');
    const terms = extractSearchTerms(userMessage);
    if (terms.length > 0) {
      const temporalCtx = extractTemporalContext(userMessage);

      // Detect person scope
      const TEAM_MEMBERS = [
        'Abdi', 'Arman', 'Luke', 'Stephen', 'Willem', 'Nathan',
        'Adele', 'Heidi', 'Hope', 'Maria', 'Naomi', 'Sebastian', 'Zoe',
        'Isabel', 'Kayleigh', 'Chris', 'Beth', 'Paul', 'Damon', 'Ricky'
      ];
      const mentionedPerson = TEAM_MEMBERS.find(name =>
        userMessage.toLowerCase().includes(name.toLowerCase())
      );

      // Build retrieval scope — person, folder, or none
      let retrievalScope = undefined;
      if (mentionedPerson) {
        retrievalScope = `person:${mentionedPerson}`;
      } else if (/\bmeeting[s]?\b/i.test(userMessage)) {
        retrievalScope = 'folder:Meetings';
      } else if (/\bdecision[s]?\b/i.test(userMessage)) {
        retrievalScope = 'folder:Decision Log';
      } else if (/\bproject[s]?\b/i.test(userMessage)) {
        retrievalScope = 'folder:Projects';
      } else if (/\bpeople\b|\bteam\b/i.test(userMessage)) {
        retrievalScope = 'folder:People';
      }

      const results = await retrieval.search(terms.join(' '), {
        maxResults: maxVaultResults,
        scope: retrievalScope,
        from: temporalCtx?.from,
        to: temporalCtx?.to
      });

      vaultSearchResults = results;
      if (results.length > 0) {
        const sources = [...new Set(results.flatMap(r => r.sources || []))];
        console.log(`[Context] Retrieval for "${terms.join(', ')}" → ${results.length} hits via ${sources.join('+')}${isSynthesisQuery ? ' (synthesis)' : ''}${retrievalScope ? ` (scope: ${retrievalScope})` : ''}`);
      }
    }
  } catch (e) {
    console.warn('[Context] Retrieval error:', e.message);
  }

  // Person-specific context — always pull person note if mentioned
  const TEAM_MEMBERS = [
    'Abdi', 'Arman', 'Luke', 'Stephen', 'Willem', 'Nathan',
    'Adele', 'Heidi', 'Hope', 'Maria', 'Naomi', 'Sebastian', 'Zoe',
    'Isabel', 'Kayleigh', 'Chris', 'Beth', 'Paul', 'Damon', 'Ricky'
  ];

  const mentionedPeople = TEAM_MEMBERS.filter(name =>
    userMessage.toLowerCase().includes(name.toLowerCase())
  );

  for (const personName of mentionedPeople.slice(0, 2)) {
    try {
      const personNote = obsidian.readPersonNote(personName) ||
        (() => {
          const allPeople = obsidian.listPeopleNotes();
          const match = allPeople.find(n => n.toLowerCase().includes(personName.toLowerCase()));
          return match ? obsidian.readPersonNote(match) : null;
        })();

      if (personNote && !vaultSearchResults.some(r => r.name?.toLowerCase().includes(personName.toLowerCase()))) {
        const body = personNote.replace(/^---[\s\S]*?---\n*/, '').substring(0, 600);
        vaultSearchResults.unshift({
          path: `People/${personName}.md`,
          name: personName,
          excerpts: [body],
          sources: ['person-note']
        });
      }
    } catch {}
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
  const contextBlock = await buildContextBlock(queueSummary, dailyNote, previousNote, standupContent, todos, ninetyDayPlan, weekend, vaultSearchResults, locationContext, queryIntent);

  const startDate = new Date('2026-03-16');
  const today = new Date();
  const dayCount = Math.floor((today - startDate) / (1000 * 60 * 60 * 24));

  const basePrompt = weekend ? WEEKEND_SYSTEM_PROMPT : SYSTEM_PROMPT;

  const synthesisSuffix = isSynthesisQuery ? `

---
SYNTHESIS MODE: Nick is asking you to synthesise everything across multiple vault notes.
Do NOT just list notes or excerpts. Instead:
1. Read all the vault notes provided in context carefully
2. Identify the key themes, patterns, and conclusions across them
3. Write a coherent synthesis — what the combined knowledge says
4. Flag any contradictions or gaps
5. End with: "Sources: [note names]"
This is a knowledge synthesis task, not a search result display.` : '';

  const systemPrompt = `${basePrompt}

---

## Live Context (auto-injected)

Today is ${today.toISOString().split('T')[0]}. Day ${dayCount} of Nick's new role.

${contextBlock}${synthesisSuffix}`;

  const messages = history.map(msg => ({ role: msg.role, content: msg.content }));

  // Set SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });

  // Use Ollama as primary (Claude credits exhausted)
  const useClaude = false;
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
