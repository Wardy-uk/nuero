#!/usr/bin/env node

/**
 * NEURO MCP Server — exposes local brain/cortex to external chat clients.
 *
 * Connects to the NEURO backend API and exposes tools for:
 *   - Focus / SARA state
 *   - Vault search and note reading
 *   - Queue / SLA status
 *   - Meeting prep
 *   - Task management
 *   - Daily note operations
 *   - People notes
 *   - Action management
 *
 * Usage:
 *   NEURO_URL=http://localhost:3001 NEURO_PIN=123456 node index.js
 *
 * Or configure in Claude Desktop / Claude Code MCP settings.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const NEURO_URL = process.env.NEURO_URL || 'http://localhost:3001';
const NEURO_PIN = process.env.NEURO_PIN || '';
const VAULT_API_KEY = process.env.NEURO_VAULT_KEY || '';

// ── API helper ──
async function neuroApi(path, options = {}) {
  const url = `${NEURO_URL}${path}`;
  const headers = {
    'Content-Type': 'application/json',
    ...(NEURO_PIN ? { 'X-Neuro-Pin': NEURO_PIN } : {}),
    ...(VAULT_API_KEY && path.startsWith('/api/vault') ? { 'X-Api-Key': VAULT_API_KEY } : {}),
    ...options.headers,
  };

  const res = await fetch(url, {
    ...options,
    headers,
    signal: AbortSignal.timeout(options.timeout || 15000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`NEURO API ${res.status}: ${body.substring(0, 200)}`);
  }
  return res.json();
}

// ── Create MCP Server ──
const server = new McpServer({
  name: 'neuro',
  version: '1.0.0',
});

// ═══════════════════════════════════════════════════════
// Tools: Focus / SARA
// ═══════════════════════════════════════════════════════

server.tool('get_focus', 'Get current Focus — what matters now (prioritised items + SARA directive)', {}, async () => {
  const data = await neuroApi('/api/focus?noai=true');
  const items = (data.items || []).map(i => `- [${i.type}] ${i.title}: ${i.reason}`).join('\n');
  const sara = data.sara?.primary?.message || 'No directive';
  return {
    content: [{
      type: 'text',
      text: `## Focus (${data.returned} items, ${data.suppressed} suppressed)\n\nSARA: ${sara}\n${data.sara?.ignore || ''}\n\n${items}\n\nTone: ${data.tone}, Mode: ${data.mode}`,
    }],
  };
});

server.tool('get_suggestions', 'Get SARA action suggestions (pending)', {}, async () => {
  const data = await neuroApi('/api/actions');
  const pending = (data.pending || []).map(a => `- [${a.id}] ${a.type}: ${a.reason}`).join('\n');
  return { content: [{ type: 'text', text: pending || 'No pending suggestions.' }] };
});

server.tool('approve_action', 'Approve a SARA suggested action', { actionId: z.number().describe('Action ID to approve') }, async ({ actionId }) => {
  const data = await neuroApi(`/api/actions/${actionId}/approve`, { method: 'POST' });
  return { content: [{ type: 'text', text: data.ok ? `Approved: ${data.detail}` : `Failed: ${data.error}` }] };
});

// ═══════════════════════════════════════════════════════
// Tools: Vault / Knowledge
// ═══════════════════════════════════════════════════════

server.tool('search_vault', 'Search the Obsidian vault for notes', {
  query: z.string().describe('Search query'),
  maxResults: z.number().optional().describe('Max results (default 5)'),
}, async ({ query, maxResults }) => {
  const data = await neuroApi(`/api/vault/search?query=${encodeURIComponent(query)}&limit=${maxResults || 5}`, {
    headers: VAULT_API_KEY ? { 'X-Api-Key': VAULT_API_KEY } : {},
  });
  const results = (data.results || []).map(r => {
    const title = r.name || r.path?.split('/').pop()?.replace('.md', '') || 'Untitled';
    const excerpt = r.excerpt || r.preview || (r.matches || []).map(m => m.text).join('\n') || '';
    return `### ${title}\nPath: ${r.path || '?'}\n${excerpt}`;
  }).join('\n\n');
  return { content: [{ type: 'text', text: results || 'No results found.' }] };
});

server.tool('read_note', 'Read a specific vault note by path', {
  path: z.string().describe('Relative path in vault, e.g. "People/Stephen Mitchell.md"'),
}, async ({ path }) => {
  const data = await neuroApi(`/api/vault/read?path=${encodeURIComponent(path)}`, {
    headers: VAULT_API_KEY ? { 'X-Api-Key': VAULT_API_KEY } : {},
  });
  return { content: [{ type: 'text', text: data.content?.substring(0, 3000) || 'Note not found.' }] };
});

server.tool('get_daily_note', 'Get today\'s daily note content', {}, async () => {
  const data = await neuroApi('/api/obsidian/daily-note');
  return { content: [{ type: 'text', text: data.content?.substring(0, 2000) || 'No daily note today.' }] };
});

server.tool('append_daily_note', 'Append content to today\'s daily note', {
  content: z.string().describe('Content to append'),
}, async ({ content }) => {
  await neuroApi('/api/obsidian/daily/append', {
    method: 'POST',
    body: JSON.stringify({ content }),
  });
  return { content: [{ type: 'text', text: 'Appended to daily note.' }] };
});

server.tool('get_person', 'Get full detail about a person from the vault', {
  name: z.string().describe('Person name, e.g. "Stephen Mitchell"'),
}, async ({ name }) => {
  const data = await neuroApi(`/api/person/${encodeURIComponent(name)}`);
  const parts = [`# ${data.name}`];
  if (data.vaultNote?.frontmatter?.role) parts.push(`Role: ${data.vaultNote.frontmatter.role}`);
  if (data.meetings?.length) parts.push(`\n## Meetings (${data.meetings.length})\n${data.meetings.slice(0, 5).map(m => `- ${m.date}: ${m.title}`).join('\n')}`);
  if (data.tasks?.length) parts.push(`\n## Tasks (${data.tasks.length})\n${data.tasks.map(t => `- ${t.text}`).join('\n')}`);
  if (data.decisions?.length) parts.push(`\n## Decisions (${data.decisions.length})\n${data.decisions.map(d => `- ${d.date}: ${d.text}`).join('\n')}`);
  return { content: [{ type: 'text', text: parts.join('\n') }] };
});

server.tool('list_people', 'List all people in the vault', {}, async () => {
  const data = await neuroApi('/api/person/list');
  return { content: [{ type: 'text', text: (data.people || []).join(', ') }] };
});

// ═══════════════════════════════════════════════════════
// Tools: Operational Context
// ═══════════════════════════════════════════════════════

server.tool('get_queue', 'Get Jira queue summary — tickets, SLA risk, escalations', {}, async () => {
  const data = await neuroApi('/api/queue');
  const atRisk = (data.at_risk_tickets || []).map(t => `- ${t.ticket_key}: ${t.summary} (${Math.round(t.sla_remaining_minutes || 0)}m SLA)`).join('\n');
  return {
    content: [{
      type: 'text',
      text: `Queue: ${data.total || 0} tickets, ${data.at_risk_count || 0} at risk, ${data.open_p1s || 0} P1s\n\n${atRisk || 'No at-risk tickets.'}`,
    }],
  };
});

server.tool('get_next_meeting_prep', 'Get meeting prep for next upcoming calendar meeting (automatic, no params)', {}, async () => {
  const data = await neuroApi('/api/meeting-prep');
  if (!data.meeting) return { content: [{ type: 'text', text: 'No upcoming meetings.' }] };
  const m = data.meeting;
  const prep = m.prep || {};
  const attendees = (prep.attendees || []).map(a => `- ${a.name}${a.role ? ` (${a.role})` : ''}`).join('\n');
  const topics = (prep.suggestedTopics || []).map(t => `- ${t}`).join('\n');
  return {
    content: [{
      type: 'text',
      text: `## ${m.subject}\n${m.startFormatted}–${m.endFormatted}${m.location ? ` · ${m.location}` : ''}\n\n### Attendees\n${attendees || 'None matched'}\n\n### Topics\n${topics || 'None'}\n\n### Checklist\n${(prep.checklist || []).map(c => `- [ ] ${c}`).join('\n')}`,
    }],
  };
});

server.tool('get_todos', 'Get prioritised todo shortlist', {
  filter: z.enum(['overdue', 'today', 'all']).optional().describe('Filter (default: overdue)'),
}, async ({ filter }) => {
  const data = await neuroApi(`/api/todos/focus?filter=${filter || 'overdue'}&limit=10`);
  const items = (data.items || []).map(t => `- [${t._score}] ${t.text} (${t._scoreReason})`).join('\n');
  return { content: [{ type: 'text', text: `${data.totalCount} total, showing ${data.returned}:\n\n${items}` }] };
});

// ═══════════════════════════════════════════════════════
// Tools: Actions
// ═══════════════════════════════════════════════════════

server.tool('create_task', 'Create a new task in the vault Master Todo', {
  text: z.string().describe('Task text'),
}, async ({ text }) => {
  await neuroApi('/api/capture/todo', {
    method: 'POST',
    body: JSON.stringify({ text }),
  });
  return { content: [{ type: 'text', text: `Task created: ${text}` }] };
});

// ═══════════════════════════════════════════════════════
// Tools: 1:1 Meeting Workflow
// ═══════════════════════════════════════════════════════

server.tool('generate_1to1_prep',
  'Generate a 1:1 meeting prep document for a direct report and save it to the vault (Meetings/YYYY/MM/...). Pulls latest performance review, development plan, open actions, and recent meetings.',
  {
    person: z.string().describe('Person name, must match People/{name}.md (e.g. "Heidi Power")'),
    date: z.string().optional().describe('ISO date (YYYY-MM-DD). Default: today'),
    force: z.boolean().optional().describe('Overwrite existing prep file if it exists'),
  },
  async ({ person, date, force }) => {
    const data = await neuroApi('/api/1to1/prep', {
      method: 'POST',
      body: JSON.stringify({ person, date, force }),
    });
    const changes = (data.changes || []).map(c => `- ${c}`).join('\n');
    return {
      content: [{
        type: 'text',
        text: `**${data.status}** — ${data.path}\n\n${changes}\n\nSections included: review=${data.sections?.hasReview}, plan=${data.sections?.hasPlan}, actions=${data.sections?.actionCount}, meetings=${data.sections?.meetingCount}`,
      }],
    };
  });

server.tool('manage_meeting_note',
  'Create, append to, or update a structured meeting note in the vault.',
  {
    action: z.enum(['create', 'append', 'update']).describe('create: new note; append: add to end; update: replace a section'),
    title: z.string().describe('Meeting title (becomes filename slug)'),
    date: z.string().optional().describe('ISO date (default today)'),
    type: z.enum(['1-1', 'team', 'project', 'external']).optional().describe('Meeting type (default 1-1)'),
    people: z.array(z.string()).optional().describe('Attendee names (must match People/{name}.md)'),
    body: z.string().optional().describe('Body content (for create/append)'),
    section: z.string().optional().describe('Section name to replace (for update), e.g. "Action Items"'),
    content: z.string().optional().describe('New section content (for update)'),
  },
  async (args) => {
    const data = await neuroApi('/api/1to1/notes', {
      method: 'POST',
      body: JSON.stringify(args),
    });
    return { content: [{ type: 'text', text: `**${data.status}** — ${data.path}\n${(data.changes || []).join('\n')}` }] };
  });

server.tool('find_action_items',
  'Find open (or closed) action items across the vault, optionally filtered by person.',
  {
    person: z.string().optional().describe('Filter to actions assigned to or mentioning this person'),
    status: z.enum(['open', 'done', 'all']).optional().describe('Default: open'),
    daysBack: z.number().optional().describe('Only scan dated files within this many days (default 90)'),
  },
  async ({ person, status, daysBack }) => {
    const qs = new URLSearchParams();
    if (person) qs.set('person', person);
    if (status) qs.set('status', status);
    if (daysBack) qs.set('daysBack', String(daysBack));
    const data = await neuroApi(`/api/vault-actions?${qs.toString()}`);
    const items = (data.items || []).slice(0, 30).map(a => {
      const check = a.done ? '[x]' : '[ ]';
      const due = a.dueDate ? ` 📅 ${a.dueDate}` : '';
      const who = a.assignee ? ` 👤 ${a.assignee}` : '';
      return `- ${check} ${a.text}${due}${who}\n  _(${a.file}:${a.lineNumber})_`;
    }).join('\n');
    return {
      content: [{
        type: 'text',
        text: `Found ${data.count} action items${person ? ` for ${person}` : ''}.\n\n${items || '(none)'}`,
      }],
    };
  });

server.tool('manage_development_plan',
  'Read or update a direct report\'s development plan (Documents/HR/{Person} - Development Plan.md).',
  {
    action: z.enum(['read', 'update_progress', 'add_goal', 'complete_goal']),
    person: z.string().describe('Person name'),
    goalNumber: z.number().optional().describe('Goal number (for update_progress / complete_goal)'),
    progressNote: z.string().optional().describe('Progress note to append'),
    newGoal: z.object({
      title: z.string(),
      targetDate: z.string(),
      what: z.string().optional(),
      why: z.string().optional(),
      measure: z.string().optional(),
    }).optional().describe('New goal payload (for add_goal)'),
    date: z.string().optional().describe('Override date (default today)'),
  },
  async (args) => {
    const data = await neuroApi('/api/development-plan', {
      method: 'POST',
      body: JSON.stringify(args),
    });
    if (args.action === 'read') {
      const goals = (data.goals || []).map(g =>
        `**Goal ${g.number}${g.complete ? ' ✅' : ''} — ${g.title}** (target: ${g.targetDate || '—'})\n  Progress: ${g.progress.length} entries`
      ).join('\n\n');
      return { content: [{ type: 'text', text: `${data.path}\n\n${goals || '(no goals)'}` }] };
    }
    return { content: [{ type: 'text', text: `**${data.status}** — ${data.path}\n${(data.changes || []).join('\n')}` }] };
  });

// Training matrix sync is owned by the n8n "Training Matrix Sync" workflow
// which fetches NOVA /api/public/training-export and POSTs to NEURO
// /api/training/apply-matrix on a schedule. No MCP tool exposes this — there
// is no useful manual-trigger story from a chat client since the caller would
// still need NOVA data to pass through.

// ═══════════════════════════════════════════════════════
// Tools: System
// ═══════════════════════════════════════════════════════

server.tool('get_status', 'Get NEURO system status — AI, integrations, health', {}, async () => {
  const data = await neuroApi('/api/status');
  return {
    content: [{
      type: 'text',
      text: `NEURO v${data.version}, uptime: ${Math.round(data.uptime / 60)}min\nAI: ${data.ai?.mode || '?'}\nOllama: ${data.ollamaReachable ? 'OK' : 'down'}\nJira: ${data.jira?.status || '?'}\nMicrosoft: ${data.microsoft?.source || 'none'}`,
    }],
  };
});

// ── Start server ──
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[NEURO MCP] Server started — connected via stdio');
  console.error(`[NEURO MCP] Backend: ${NEURO_URL}`);
}

main().catch(e => {
  console.error('[NEURO MCP] Fatal:', e);
  process.exit(1);
});
