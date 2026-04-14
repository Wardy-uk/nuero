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

server.tool('get_person_timeline',
  'Get a chronological timeline of events for a direct report (meetings, reviews, development plan progress, action items) over the last N days.',
  {
    person: z.string().describe('Person name, must match People/{name}.md'),
    daysBack: z.number().optional().describe('How far back to look (default 60)'),
  },
  async ({ person, daysBack }) => {
    const qs = new URLSearchParams();
    if (daysBack) qs.set('daysBack', String(daysBack));
    const data = await neuroApi(`/api/person/${encodeURIComponent(person)}/timeline?${qs.toString()}`);
    const { counts, events } = data;
    const lines = [`# Timeline: ${data.person} (last ${data.daysBack} days)`, ''];
    lines.push(`**${counts.total} events** — meetings:${counts.meetings} reviews:${counts.reviews} plan:${counts.planEntries} actions:${counts.actions}`);
    lines.push('');
    for (const e of events.slice(0, 40)) {
      const icon = e.type === 'meeting' ? '📅' : e.type === 'review' ? '📊' : e.type === 'plan' ? '🎯' : '✓';
      lines.push(`${icon} **${e.date}** — ${e.title}`);
      if (e.excerpt) lines.push(`  > ${e.excerpt}`);
      if (e.path) lines.push(`  [[${e.path.replace(/\.md$/, '')}]]`);
      lines.push('');
    }
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  });

server.tool('team_health_snapshot',
  'Get a prioritised list of issues across direct reports. Defaults to HIGH severity only — the things requiring Nick\'s immediate attention. Override with severity="medium" to include elevated items or severity="all" for the full picture.',
  {
    team: z.string().optional().describe('Filter to a single team ("2nd Line Technical Support", "1st Line Customer Care", "Digital Design")'),
    severity: z.enum(['high', 'medium', 'low', 'all']).optional().describe('Minimum severity to include. Default: "high" (only urgent items). "medium" includes high+med. "all" or "low" returns everything.'),
  },
  async ({ team, severity }) => {
    const qs = new URLSearchParams();
    if (team) qs.set('team', team);
    if (severity) qs.set('severity', severity);
    const data = await neuroApi(`/api/team-health?${qs.toString()}`);
    const { counts, issues, severityFilter, filteredCount } = data;
    const lines = [`# Team Health — ${data.team}`, ''];
    lines.push(`**Filter:** ${severityFilter}  (showing ${filteredCount} of ${counts.high + counts.med + counts.low} total issues)`);
    lines.push(`**All severities:** 🔴 ${counts.high} high · 🟡 ${counts.med} med · ⚪ ${counts.low} low  (${counts.peopleWithIssues} people with issues, ${counts.peopleClean} clean)`);
    lines.push('');
    if (!issues.length) {
      lines.push(`_No issues at severity '${severityFilter}' or above. Use severity='all' to see the full picture._`);
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }
    const byPerson = {};
    for (const i of issues) {
      if (!byPerson[i.person]) byPerson[i.person] = [];
      byPerson[i.person].push(i);
    }
    for (const [person, list] of Object.entries(byPerson)) {
      lines.push(`## ${person} _(${list[0].team})_`);
      for (const i of list) {
        const dot = i.severity === 'high' ? '🔴' : i.severity === 'med' ? '🟡' : '⚪';
        lines.push(`- ${dot} **${i.type}** — ${i.title}`);
      }
      lines.push('');
    }
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  });

// ═══════════════════════════════════════════════════════
// Tools: Tier 3 — Profile, Plan, Weekly, KB
// ═══════════════════════════════════════════════════════

server.tool('manage_person_profile',
  'Create or modify a person profile file in People/. Actions: create (new note), update (merge frontmatter), add_meeting (append to 1-2-1 history table), add_task (add a tagged task bullet).',
  {
    action: z.enum(['create', 'update', 'add_meeting', 'add_task']),
    person: z.string().describe('Person name (must match People/{name}.md)'),
    frontmatter: z.record(z.string(), z.any()).optional().describe('Frontmatter fields to set (for create/update)'),
    date: z.string().optional().describe('ISO date (for add_meeting/add_task, default today)'),
    meetingType: z.string().optional().describe('For add_meeting — e.g. "1-2-1", "Probation check-in"'),
    peopleHR: z.string().optional().describe('For add_meeting — "✅" or "❌"'),
    notes: z.string().optional().describe('For add_meeting — row notes cell'),
    task: z.string().optional().describe('For add_task — the task description'),
    accepted: z.boolean().optional().describe('For add_task — tag as #accepted (true) or #watch (false)'),
    force: z.boolean().optional().describe('Overwrite existing file on create'),
  },
  async (args) => {
    const data = await neuroApi('/api/person-profile', {
      method: 'POST',
      body: JSON.stringify(args),
    });
    return { content: [{ type: 'text', text: `**${data.status}** — ${data.path}\n${(data.changes || []).join('\n')}` }] };
  });

server.tool('manage_evidence_register',
  'Add or update an entry in the 90-Day Plan Evidence Register (Projects/90 Day Plan/Evidence Register.md). Entries are grouped by Outcome.',
  {
    action: z.enum(['add', 'update', 'list']),
    outcome: z.string().optional().describe('Outcome reference ("1", "Outcome 1", or substring of title). Required for add/update.'),
    evidence: z.string().optional().describe('Evidence description (new row for add, or substring to find for update)'),
    location: z.string().optional().describe('Where the evidence lives (URL or [[wiki-link]])'),
    checkpoint: z.string().optional().describe('Which checkpoint this satisfies — e.g. "Day 15", "Day 30 + Day 45"'),
  },
  async (args) => {
    const data = await neuroApi('/api/evidence', {
      method: 'POST',
      body: JSON.stringify(args),
    });
    if (args.action === 'list') {
      const lines = [`# Evidence Register\nPath: ${data.path}\n`];
      for (const o of data.outcomes || []) {
        lines.push(`## ${o.title} _(${o.rowCount} rows)_`);
        for (const r of o.rows.slice(0, 5)) {
          lines.push(`- ${r.evidence.substring(0, 80)} — ${r.checkpoint}`);
        }
        lines.push('');
      }
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }
    return { content: [{ type: 'text', text: `**${data.status}** — ${data.outcome || data.path}\n${(data.changes || []).join('\n')}` }] };
  });

server.tool('compare_checkpoint_progress',
  'Compare the 90-Day Plan deliverables for a checkpoint against the Evidence Register and return a gap analysis with completion %.',
  {
    checkpoint: z.string().describe('Checkpoint reference — e.g. "day-15", "day-30", "Day 60"'),
  },
  async ({ checkpoint }) => {
    const data = await neuroApi(`/api/checkpoint/${encodeURIComponent(checkpoint)}`);
    const a = data.analysis;
    const lines = [
      `# Checkpoint: ${data.checkpoint} (${data.plan.date})`,
      `**Status:** ${data.plan.status || 'n/a'}`,
      `**Completion:** ${a.covered} / ${a.total} (${a.completionPct}%)`,
      `**Evidence entries tagged:** ${data.evidence.count}`,
      '',
      '## Deliverables',
    ];
    for (const d of a.deliverables) {
      lines.push(`- ${d.covered ? '✅' : '❌'} ${d.deliverable}${d.covered ? ` _(${d.evidenceCount} evidence)_` : ''}`);
    }
    if (a.gaps.length) {
      lines.push('', '## Gaps');
      for (const g of a.gaps) lines.push(`- ${g}`);
    }
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  });

server.tool('summarize_week',
  'Generate a weekly summary markdown brief for Chris Middleton, aggregating meetings, reviews, dev plan updates, and action items from the week.',
  {
    weekStarting: z.string().optional().describe('ISO date (YYYY-MM-DD) of Monday. Defaults to this week\'s Monday.'),
  },
  async ({ weekStarting }) => {
    const qs = new URLSearchParams();
    if (weekStarting) qs.set('weekStarting', weekStarting);
    const data = await neuroApi(`/api/weekly-summary?${qs.toString()}`);
    return { content: [{ type: 'text', text: data.markdown }] };
  });

server.tool('find_knowledge_gaps',
  'Identify missing KB articles by scanning dev plans, meeting notes, and projects for "KBA" / "KB article" / "knowledge base" mentions.',
  {
    topic: z.string().optional().describe('Filter suggestions containing this substring'),
    daysBack: z.number().optional().describe('How far back to scan (default 90)'),
  },
  async ({ topic, daysBack }) => {
    const qs = new URLSearchParams();
    if (topic) qs.set('topic', topic);
    if (daysBack) qs.set('daysBack', String(daysBack));
    const data = await neuroApi(`/api/knowledge-gaps?${qs.toString()}`);
    const lines = [
      `# Knowledge Gap Suggestions`,
      `Scanned last ${data.daysBack} days. ${data.counts.uniqueTopics} unique topics from ${data.counts.planMentions + data.counts.meetingMentions + data.counts.projectMentions} mentions.`,
      `Existing KB articles in vault: ${data.counts.existingKbArticles}`,
      '',
      '## Top Suggestions',
    ];
    for (const s of (data.suggestions || []).slice(0, 15)) {
      const sources = s.sources.map(src => src.source).join(', ');
      lines.push(`- **${s.topic}** _(${s.count} mentions, sources: ${sources})_`);
    }
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  });

server.tool('manage_kb_article',
  'Create or update a KB article in KB/{category}/. Uses a standard 6-section template if content is not supplied.',
  {
    action: z.enum(['create', 'update']),
    title: z.string().describe('Article title'),
    category: z.string().optional().describe('Category subfolder (e.g. "Feeds", "Hub", "Valuation")'),
    content: z.string().optional().describe('Full article markdown (replaces body)'),
    tags: z.array(z.string()).optional().describe('Frontmatter tags'),
    force: z.boolean().optional().describe('Overwrite existing article on create'),
  },
  async (args) => {
    const data = await neuroApi('/api/kb-article', {
      method: 'POST',
      body: JSON.stringify(args),
    });
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
