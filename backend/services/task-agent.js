'use strict';

/**
 * "Do this" — NEURO takes ownership of progressing ONE task as far as it safely
 * can (23 Oct 2026). Full contract: docs/task-agent.md.
 *
 * The rule it is built on: ask Nick only for a real ambiguity, a missing fact, a
 * manual step only he can do, or authority only he can give. Otherwise keep
 * going — gather the permitted context, draft, organise, prepare, and report
 * exactly what was done and what remains.
 *
 * ⚠ IT GRANTS NO AUTHORITY. The agent's tools are read / private-output only,
 * plus ONE preparing tool (a governed `compose_email` draft, origin `task-agent`)
 * that hands over at the EXISTING approval screen and sends nothing. There is no
 * tool that ticks a task, writes the vault, books the calendar, or contacts a
 * person — those are not refused at run time, they simply do not exist here.
 *
 * ⚠ ONE ATTEMPT PER TASK, stored in agent_state (`task_agent_run:<taskId>`), the
 * standup-session precedent: the run is a workspace, not a second task store.
 * A press while a run exists RETURNS it — never a second model call, draft or
 * prepared action. Only an explicit "fresh" press on a settled run starts again,
 * and the old run is kept in history.
 *
 * ⚠ THE PROMPT IS NEVER STORED. Each turn rebuilds it from the task, the context
 * Nick can see, and the run's own outputs; what is kept is what Nick sees (the
 * understanding, the sources' titles and provenance, the steps, the outputs, the
 * question and his answers) plus model, tokens and cost.
 *
 * ⚠ CONTEXT IS NICK'S OWN VIEW, NEVER WIDER: task-context.forTask with viewer
 * 'owner'. A restricted note contributes only its task-bounded excerpt; a hard
 * exclusion contributes nothing (not even its title). A note is read in full only
 * through task-context.readForAgent, which applies the scan's own screen.
 */

const db = require('../db/database');

const KEY = (id) => `task_agent_run:${id}`;
const HISTORY_KEY = (id) => `task_agent_history:${id}`;
const CONTRACT = 'task-agent-v1';
const MODEL = () => process.env.TASK_AGENT_MODEL || 'claude-sonnet-5';
const MAX_ROUNDS = 12;
const MAX_OUTPUT_TOKENS = 4000;
const STALE_MS = 10 * 60 * 1000;      // a 'running' run with no heartbeat this long was interrupted
const MAX_OUTPUTS = 8;
const MAX_OUTPUT_CHARS = 20000;
const MAX_READ_CHARS = 8000;
const MAX_STEPS = 60;

const STATUS = Object.freeze(['running', 'needs-answer', 'needs-manual', 'needs-decision', 'ready', 'failed', 'interrupted', 'stopped']);
const AWAITING = new Set(['needs-answer', 'needs-manual', 'needs-decision']);
const SETTLED = new Set(['ready', 'stopped', 'failed', 'interrupted']);
const QUESTION_KINDS = Object.freeze(['ambiguity', 'missing', 'manual', 'authority']);
const OUTPUT_KINDS = Object.freeze(['draft', 'plan', 'brief', 'checklist', 'agenda', 'breakdown', 'answer', 'investigation', 'notes']);

const RUNNING = new Map(); // taskId -> promise of the turn in flight (this process)

// ── deps (the test seam; production wiring below) ───────────────────────────
let _deps = null;
function deps() {
  if (_deps) return _deps;
  return {
    now: () => Date.now(),
    provider: require('./providers/anthropic-provider'),
    isCloudAllowed: (t) => require('./ai-routing').isCloudAllowed(t),
    fallbackReason: () => { try { return require('./ai-routing').getStatus?.().lastFallbackReason || null; } catch { return null; } },
    recordUsage: (u, m) => { try { require('./ai-routing').recordUsage(u, m); } catch { /* bookkeeping never fails a run */ } },
    resolveCost: (u, model) => { try { return require('./ai-cost').resolveCost(u, model, 'anthropic'); } catch { return { costUsd: null }; } },
    getTask: (id) => require('./task-store').getTask(id),
    forTask: (id) => require('./task-context').forTask(id, { viewer: 'owner' }),
    readNote: (rel) => require('./task-context').readForAgent(rel),
    search: async (q) => {
      const r = await require('./retrieval').searchWithHealth(q, { maxResults: 8 });
      return (r && r.results) || [];
    },
    resolveName: (name) => require('./contact-directory').resolveName(name),
    prepareCompose: (args) => require('./prepared-actions').prepareCompose(args),
    actionStatus: (id) => { try { return db.get('SELECT action_id, status FROM prepared_actions WHERE action_id = ?', [id]); } catch { return null; } },
  };
}

// ── storage ──────────────────────────────────────────────────────────────────
function _load(taskId) {
  const raw = db.getState(KEY(taskId));
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return { unreadable: true }; }
}
function _save(run) { db.setState(KEY(run.taskId), JSON.stringify(run)); return run; }
function _archive(run) {
  let list = [];
  try { list = JSON.parse(db.getState(HISTORY_KEY(run.taskId)) || '[]'); } catch { list = []; }
  list.unshift({ id: run.id, status: run.status, startedAt: run.startedAt, updatedAt: run.updatedAt, summary: run.summary, outputs: (run.outputs || []).map((o) => ({ kind: o.kind, title: o.title })), usage: run.usage });
  db.setState(HISTORY_KEY(run.taskId), JSON.stringify(list.slice(0, 5)));
}
function _iso(ms) { return new Date(ms).toISOString(); }
function _step(run, kind, say) {
  run.steps = run.steps || [];
  run.steps.push({ at: _iso(deps().now()), kind, say: String(say).slice(0, 300) });
  if (run.steps.length > MAX_STEPS) run.steps = run.steps.slice(-MAX_STEPS);
}
function _audit(event, run, extra = {}) {
  // Activity carries ids, counts and status — never prompt text or output bodies.
  try {
    db.logActivity('task_agent', {
      event, taskId: run.taskId, runId: run.id, status: run.status,
      model: run.usage && run.usage.model, promptTokens: run.usage && run.usage.promptTokens,
      completionTokens: run.usage && run.usage.completionTokens, costUsd: run.usage && run.usage.costUsd,
      sources: (run.sources || []).filter((s) => s.used).map((s) => s.key), ...extra,
    });
  } catch { /* never fails a run */ }
}

// ── the task and its context ────────────────────────────────────────────────
/** PURE. Is this an employment / people matter? Then NEURO prepares and stops at Nick's decision. */
function sensitivityOf(task, context) {
  const why = [];
  try {
    const hr = require('./promise-ledger').hrSensitivity(task.text || '');
    if (hr.sensitive) why.push('hr-wording');
  } catch { why.push('unscreened'); }
  for (const r of (context && context.pinned) || []) {
    for (const c of r.restrictedCodes || []) if (['employee-cases-note', 'hr-wording', 'pip-deliverable'].includes(c) && !why.includes(c)) why.push(c);
  }
  return { sensitive: why.length > 0, why };
}

/**
 * PURE. The context sources the agent may use, as Nick sees them. A hard
 * exclusion is dropped entirely; a restricted note keeps its excerpt only.
 */
function sourcesFrom(context) {
  const out = [];
  for (const r of (context && context.pinned) || []) {
    if (r.hardExcluded) continue;
    if (r.type === 'note') {
      const restricted = Boolean(r.restricted);
      const ex = r.excerpt ? (typeof r.excerpt === 'string' ? r.excerpt : r.excerpt.text || null) : null;
      const text = restricted ? ex : (ex || r.preview || null);
      if (restricted && !text) continue; // nothing Nick can see beyond the title — and the title alone tells the agent nothing it should act on
      out.push({ key: `ctx:${r.id}`, kind: 'note', title: r.title, provenance: r.provenance || r.reason || 'Linked to this task.', path: restricted ? null : (r.ref || null), restricted, excerpt: text, readable: !restricted && Boolean(r.ref), used: false });
    } else {
      out.push({ key: `ctx:${r.id}`, kind: r.type, title: r.title, provenance: r.provenance || r.reason || 'Linked to this task.', path: null, restricted: false, excerpt: (r.scopeItems || []).slice(0, 8).map((i) => i.title || i).join('; ') || null, readable: false, used: false });
    }
  }
  return out;
}

// ── the prompt (rebuilt every turn, never stored) ───────────────────────────
function systemPrompt(run) {
  return [
    'You are NEURO, Nick Ward\'s executive assistant, progressing ONE of his tasks as far as you safely can.',
    'Nick is Head of Technical Support at Nurtur (proptech SaaS). Write in plain British English, briefly.',
    '',
    'HOW TO WORK',
    '- Do the work, do not describe it. Use the sources given, search the vault if useful, then produce real outputs with save_output: a finished working draft, plan, checklist, agenda, brief, breakdown or answer.',
    '- Continue through several steps without pausing. Resolve ordinary ambiguity from the sources when the evidence is clear, and say which source settled it.',
    '- Call ask_nick ONLY for: a task with more than one reasonable interpretation that the sources do not settle (ambiguity); a fact or preference you cannot safely infer (missing); a step only Nick can perform, like opening a system you cannot reach, attending a meeting or checking the real world (manual); or a decision, commitment, contact or change that needs his authority (authority). One focused question, with why it matters and, where possible, the options. Never ask because the task is hard.',
    '- After ask_nick, stop calling tools. The run resumes when he answers.',
    '- End with finish: what you completed, what remains, and why.',
    '',
    'WHAT YOU MAY NOT DO',
    '- You cannot tick or change tasks, write to the vault, change the calendar, or contact anyone. Do not claim you did. Outputs you save are private working drafts that only Nick sees.',
    '- prepare_email only PREPARES an email draft for Nick to approve on NEURO\'s Actions screen; it sends nothing. Use it only when the task clearly calls for an email and the recipient is named in the task or the sources.',
    '- Never invent a fact, a quote, a source, a name or an email address. If a source does not say it, it is unknown — say so.',
    run.sensitive && run.sensitive.sensitive
      ? '- THIS TASK IS AN EMPLOYMENT / PEOPLE MATTER. Prepare a private decision brief (facts from the sources, options, risks, open questions) and then ask_nick with kind "authority" for the decision. Make no decision, promise, contact or change, and do not prepare any email. Do not speculate about the person beyond what the sources say.'
      : '',
  ].filter((l) => l !== '').join('\n');
}

function userPrompt(run, task) {
  const lines = [];
  lines.push(`TASK #${task.id}: ${task.text}`);
  const facts = [];
  if (task.moscow) facts.push(`MoSCoW ${task.moscow}`);
  if (task.priority) facts.push(`priority ${task.priority}`);
  if (task.due_date) facts.push(`due ${task.due_date}`);
  if (task.origin) facts.push(`origin ${task.origin}`);
  if (task.status) facts.push(`status ${task.status}`);
  if (facts.length) lines.push(facts.join(' · '));
  lines.push(`Today is ${new Date(deps().now()).toISOString().slice(0, 10)}.`);
  lines.push('', 'SOURCES NICK HAS LINKED TO THIS TASK (refer to them by key):');
  if (!run.sources.length) lines.push('(none)');
  for (const s of run.sources) {
    lines.push(`[${s.key}] ${s.kind} — ${s.title}${s.restricted ? ' (restricted: excerpt only, do not ask for more)' : ''}${s.readable ? ' (read_note available)' : ''}`);
    if (s.excerpt) lines.push(`    ${String(s.excerpt).replace(/\s+/g, ' ').slice(0, 600)}`);
  }
  if (run.outputs && run.outputs.length) {
    lines.push('', 'OUTPUTS YOU HAVE ALREADY SAVED (update by saving again with the same title):');
    for (const o of run.outputs) lines.push(`--- ${o.kind}: ${o.title}\n${o.markdown}`);
  }
  if (run.handoffs && run.handoffs.length) {
    lines.push('', 'ALREADY PREPARED FOR NICK\'S APPROVAL (do not prepare again):');
    for (const h of run.handoffs) lines.push(`- ${h.say}`);
  }
  if (run.answers && run.answers.length) {
    lines.push('', 'NICK\'S ANSWERS SO FAR:');
    for (const a of run.answers) lines.push(`Q (${a.kind}): ${a.question}\nA: ${a.text}`);
    lines.push('', 'Continue from here with his answer.');
  } else {
    lines.push('', 'Start the work now.');
  }
  return lines.join('\n');
}

// ── tools ───────────────────────────────────────────────────────────────────
const TOOLS = [
  { name: 'search_vault', description: 'Search Nick\'s vault for notes related to the task. Returns titles, paths and short snippets of notes you are permitted to read; restricted and excluded notes never appear.', input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'read_note', description: 'Read a note in full by its path. Only paths offered by the linked sources (marked read_note available) or by search_vault results.', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'save_output', description: 'Save (or replace, by the same title) a private working output for Nick: a draft, plan, brief, checklist, agenda, breakdown, investigation, answer or notes. Markdown. Cite source keys for facts.', input_schema: { type: 'object', properties: { kind: { type: 'string', enum: OUTPUT_KINDS }, title: { type: 'string' }, markdown: { type: 'string' }, sources: { type: 'array', items: { type: 'string' } } }, required: ['kind', 'title', 'markdown'] } },
  { name: 'prepare_email', description: 'Prepare (NOT send) an email draft for Nick to approve on NEURO\'s Actions screen. `to` is a person\'s full name as written in the task or a source.', input_schema: { type: 'object', properties: { to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' } }, required: ['to', 'subject', 'body'] } },
  { name: 'ask_nick', description: 'Ask Nick ONE focused question. Only for ambiguity, missing information, a manual step only he can do, or a decision needing his authority.', input_schema: { type: 'object', properties: { kind: { type: 'string', enum: QUESTION_KINDS }, question: { type: 'string' }, why: { type: 'string' }, options: { type: 'array', items: { type: 'string' } }, understanding: { type: 'string', description: 'One sentence: what you understand the task to be so far.' } }, required: ['kind', 'question', 'why'] } },
  { name: 'finish', description: 'Report the outcome: what you completed, what remains and why.', input_schema: { type: 'object', properties: { understanding: { type: 'string' }, completed: { type: 'array', items: { type: 'string' } }, remaining: { type: 'array', items: { type: 'string' } } }, required: ['completed', 'remaining'] } },
];

/** PURE helper: the set of literal email addresses present in text the agent was actually given. */
function addressesIn(text) {
  return new Set((String(text || '').match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || []).map((s) => s.toLowerCase()));
}

function makeRunTool(run, task, turn) {
  const d = deps();
  const readable = new Map(run.sources.filter((s) => s.readable && s.path).map((s) => [s.path, s]));
  const seenText = [task.text, ...run.sources.map((s) => s.excerpt || '')];
  return async function runTool(name, input = {}) {
    if (turn.stopped && name !== 'finish') return { ok: false, error: 'Waiting for Nick — do not call more tools.' };
    try {
      switch (name) {
        case 'search_vault': {
          const q = String(input.query || '').trim().slice(0, 200);
          if (q.length < 2) return { ok: false, error: 'query too short' };
          const raw = await d.search(q);
          const results = [];
          for (const r of raw) {
            const rel = r.relativePath || r.path || r.file || null;
            if (!rel) continue;
            const check = d.readNote(rel);
            if (!check.ok) continue; // restricted / excluded / unreadable never surface
            let src = run.sources.find((s) => s.path === check.rel);
            if (!src) {
              src = { key: `search:${run.sources.length + 1}`, kind: 'note', title: check.title, provenance: `Found by NEURO searching the vault for “${q}”.`, path: check.rel, restricted: false, excerpt: null, readable: true, used: false };
              run.sources.push(src);
            }
            readable.set(check.rel, src);
            results.push({ key: src.key, title: src.title, path: src.path, snippet: String((r.excerpts && r.excerpts[0]) || check.body.slice(0, 240)).replace(/\s+/g, ' ').slice(0, 240) });
            if (results.length >= 6) break;
          }
          _step(run, 'search', `Searched the vault for “${q}” — ${results.length} usable note${results.length === 1 ? '' : 's'}.`);
          return { ok: true, results };
        }
        case 'read_note': {
          const rel = String(input.path || '').replace(/\\/g, '/');
          const src = readable.get(rel);
          if (!src) return { ok: false, error: 'That note was not offered to you. Use a linked source path or a search_vault result.' };
          const n = d.readNote(rel);
          if (!n.ok) return { ok: false, error: `Cannot read: ${n.why}` };
          src.used = true;
          seenText.push(n.body);
          _step(run, 'read', `Read “${src.title}”.`);
          return { ok: true, key: src.key, title: n.title, text: n.body.slice(0, MAX_READ_CHARS), truncated: n.body.length > MAX_READ_CHARS };
        }
        case 'save_output': {
          const kind = OUTPUT_KINDS.includes(input.kind) ? input.kind : 'notes';
          const title = String(input.title || '').trim().slice(0, 140);
          const markdown = String(input.markdown || '').trim().slice(0, MAX_OUTPUT_CHARS);
          if (!title || !markdown) return { ok: false, error: 'title and markdown are required' };
          run.outputs = run.outputs || [];
          const cites = Array.isArray(input.sources) ? input.sources.map(String) : [];
          for (const k of cites) { const s = run.sources.find((x) => x.key === k); if (s) s.used = true; }
          const existing = run.outputs.find((o) => o.title.toLowerCase() === title.toLowerCase());
          const now = _iso(d.now());
          if (existing) Object.assign(existing, { kind, markdown, sources: cites, updatedAt: now });
          else {
            if (run.outputs.length >= MAX_OUTPUTS) return { ok: false, error: `at most ${MAX_OUTPUTS} outputs — update an existing one` };
            run.outputs.push({ id: `o${run.outputs.length + 1}`, kind, title, markdown, sources: cites, createdAt: now, updatedAt: now });
          }
          _step(run, 'output', `${existing ? 'Updated' : 'Wrote'} ${kind}: “${title}”.`);
          return { ok: true, saved: title, private: true };
        }
        case 'prepare_email': {
          if (run.sensitive && run.sensitive.sensitive) return { ok: false, error: 'Refused: this is an employment / people matter. Prepare the brief and ask Nick for the decision instead.' };
          if ((run.handoffs || []).some((h) => h.kind === 'prepared_action')) return { ok: false, error: 'An email is already prepared for this task — Nick will approve or edit it on Actions.' };
          const to = String(input.to || '').trim();
          let address = null; let name = null;
          if (/@/.test(to)) {
            const seen = addressesIn(seenText.join('\n'));
            if (!seen.has(to.toLowerCase())) return { ok: false, error: 'That address does not appear in the task or the sources. Use the person\'s name, or ask Nick.' };
            address = to;
          } else {
            const r = await d.resolveName(to);
            if (!r || r.status !== 'resolved' || r.source === 'literal' || !r.email) {
              return { ok: false, error: r && r.status === 'ambiguous' ? `“${to}” matches more than one person — ask Nick which.` : `No single email address is known for “${to}” — ask Nick.` };
            }
            address = r.email; name = r.name || to;
          }
          const res = d.prepareCompose({ from: 'work', to: [{ email: address, name: name || undefined }], subject: input.subject, body: input.body, origin: 'task-agent', generatedBy: `drafted by NEURO for task #${task.id} (Do this)`, evidence: { taskId: task.id, taskAgentRun: run.id } });
          if (!res || !res.ok) return { ok: false, error: (res && res.error) || 'could not prepare the email' };
          run.handoffs = run.handoffs || [];
          run.handoffs.push({ kind: 'prepared_action', actionId: res.action.actionId || res.action.id, actionType: 'compose_email', status: res.action.status || 'prepared', say: `Email to ${name || address}: “${String(input.subject).slice(0, 120)}” — prepared, not sent. Approve, edit or reject it on Actions.`, open: 'actions' });
          _step(run, 'prepared', `Prepared an email to ${name || address} for your approval (not sent).`);
          return { ok: true, prepared: true, sent: false, where: 'NEURO → Actions (needs Nick\'s approval code)' };
        }
        case 'ask_nick': {
          const kind = QUESTION_KINDS.includes(input.kind) ? input.kind : 'missing';
          const question = String(input.question || '').trim().slice(0, 500);
          if (!question) return { ok: false, error: 'question required' };
          if (turn.question) return { ok: false, error: 'You have already asked one question this turn. Stop.' };
          turn.question = { id: `q${(run.answers || []).length + 1}-${d.now()}`, kind, question, why: String(input.why || '').trim().slice(0, 400), options: (Array.isArray(input.options) ? input.options : []).map((o) => String(o).slice(0, 160)).slice(0, 5), askedAt: _iso(d.now()) };
          if (input.understanding) turn.understanding = String(input.understanding).slice(0, 600);
          turn.stopped = true;
          return { ok: true, asked: true, instruction: 'Stop now. Nick will answer and the run will continue.' };
        }
        case 'finish': {
          turn.finish = {
            understanding: input.understanding ? String(input.understanding).slice(0, 600) : null,
            completed: (input.completed || []).map((s) => String(s).slice(0, 300)).slice(0, 12),
            remaining: (input.remaining || []).map((s) => String(s).slice(0, 300)).slice(0, 12),
          };
          turn.stopped = true;
          return { ok: true };
        }
        default: return { ok: false, error: `unknown tool ${name}` };
      }
    } catch (e) {
      return { ok: false, error: `tool failed: ${e.message}` };
    }
  };
}

// ── one turn ────────────────────────────────────────────────────────────────
async function _turn(taskId) {
  const d = deps();
  const run = _load(taskId);
  if (!run || run.unreadable) return;
  const task = d.getTask(taskId);
  if (!task) { run.status = 'failed'; run.error = 'The task no longer exists.'; return _save(run); }

  if (!d.isCloudAllowed('task_agent') || !d.provider.isConfigured()) {
    run.status = 'failed';
    run.error = !d.provider.isConfigured()
      ? 'The Anthropic API key is not configured on NEURO, so this cannot run.'
      : `Cloud AI is not available for this right now${d.fallbackReason() ? ` — ${d.fallbackReason()}` : ''}. Nothing was sent to a model.`;
    _step(run, 'note', run.error);
    _audit('refused', run);
    return _save(run);
  }

  const turn = { question: null, finish: null, stopped: false };
  const model = MODEL();
  let result;
  try {
    result = await d.provider.chatWithTools(systemPrompt(run), [{ role: 'user', content: userPrompt(run, task) }], TOOLS, makeRunTool(run, task, turn), { model, maxTokens: MAX_OUTPUT_TOKENS, maxRounds: MAX_ROUNDS, callClass: 'task_agent' });
  } catch (e) {
    run.status = 'failed';
    run.error = `The model call failed: ${String(e.message || e).slice(0, 200)}. Press Do this to try again.`;
    run.heartbeatAt = null;
    _step(run, 'note', 'The model call failed.');
    _audit('failed', run);
    return _save(run);
  }

  const usage = result.usage || {};
  const cost = d.resolveCost(usage, model);
  run.usage = run.usage || { provider: 'anthropic', model, calls: 0, promptTokens: 0, completionTokens: 0, costUsd: 0, costUnknown: false };
  run.usage.model = model;
  run.usage.calls += 1;
  run.usage.promptTokens += usage.prompt_tokens || 0;
  run.usage.completionTokens += usage.completion_tokens || 0;
  if (cost && cost.costUsd != null) run.usage.costUsd = Math.round((run.usage.costUsd + cost.costUsd) * 1e6) / 1e6;
  else run.usage.costUnknown = true;
  d.recordUsage(usage, { provider: 'anthropic', model, taskType: 'task_agent' });

  // Only the model's STATED understanding is shown, never its stray closing text.
  const understood = (turn.finish && turn.finish.understanding) || turn.understanding || null;
  if (understood) run.understanding = understood;

  const sensitive = run.sensitive && run.sensitive.sensitive;
  if (turn.question) {
    run.question = turn.question;
    run.status = turn.question.kind === 'manual' ? 'needs-manual' : (turn.question.kind === 'authority' ? 'needs-decision' : 'needs-answer');
    _step(run, 'question', `Asked you: ${turn.question.question}`);
  } else if (sensitive) {
    // ⚠ Server-enforced, not left to the prompt: a people matter ends at Nick's decision.
    run.question = { id: `q${(run.answers || []).length + 1}-${d.now()}`, kind: 'authority', question: 'This is an employment / people matter. What do you decide, and should NEURO prepare anything further?', why: 'NEURO can prepare the material, but the decision, and any contact, promise or change, are yours.', options: [], askedAt: _iso(d.now()), byRule: true };
    run.status = 'needs-decision';
    _step(run, 'question', 'Stopped at your decision (people matter).');
  } else {
    run.question = null;
    run.status = 'ready';
  }
  // A question turn has no outcome to report yet; a turn that ended without finish
  // reports the model's own closing words.
  run.summary = turn.finish ? { completed: turn.finish.completed, remaining: turn.finish.remaining }
    : turn.question ? (run.summary || null)
      : (run.summary || { completed: [], remaining: [], said: String(result.text || '').slice(0, 1200) || null });
  if (result.truncated && !turn.question && !turn.finish) {
    run.summary.remaining = [...(run.summary.remaining || []), 'The run stopped before reporting — press Do this to continue it.'];
    run.status = 'interrupted';
  }
  run.heartbeatAt = null;
  run.updatedAt = _iso(d.now());
  _audit('turn', run, { turnStatus: run.status, outputs: (run.outputs || []).length, handoffs: (run.handoffs || []).length });
  return _save(run);
}

function _kick(taskId) {
  if (RUNNING.has(taskId)) return RUNNING.get(taskId);
  const p = (async () => {
    try { await _turn(taskId); } catch (e) {
      const run = _load(taskId);
      if (run && !run.unreadable) { run.status = 'failed'; run.error = `Unexpected error: ${e.message}`; run.heartbeatAt = null; _save(run); }
    } finally { RUNNING.delete(taskId); }
  })();
  RUNNING.set(taskId, p);
  return p;
}

// ── the public surface ──────────────────────────────────────────────────────
function _fresh(task, context) {
  const now = _iso(deps().now());
  const run = {
    contract: CONTRACT, id: `ta-${task.id}-${deps().now()}`, taskId: task.id, taskText: task.text,
    status: 'running', startedAt: now, updatedAt: now, heartbeatAt: now,
    understanding: null, sensitive: sensitivityOf(task, context), sources: sourcesFrom(context),
    contextGaps: context && context.ok === false ? [context.error || 'context could not be read'] : [],
    steps: [], outputs: [], handoffs: [], question: null, answers: [], summary: null, usage: null, error: null,
  };
  _step(run, 'note', `Started. ${run.sources.length} linked source${run.sources.length === 1 ? '' : 's'} usable.`);
  return run;
}

/** Did a 'running' run die with its process? Then it is interrupted, and a press resumes it. */
function _settleStale(run) {
  if (run && run.status === 'running' && !RUNNING.has(run.taskId)) {
    const hb = Date.parse(run.heartbeatAt || run.updatedAt || 0);
    if (!Number.isFinite(hb) || deps().now() - hb > STALE_MS) {
      run.status = 'interrupted';
      run.heartbeatAt = null;
      _step(run, 'note', 'The previous run was interrupted (NEURO restarted). Press Do this to continue.');
      _save(run);
    }
  }
  return run;
}

/** Current state, with live status of anything handed off. Writes nothing except settling a dead run. */
function view(taskId) {
  const id = Number(taskId);
  if (!Number.isInteger(id) || id <= 0) return { ok: false, status: 400, error: 'bad task id' };
  let run = _load(id);
  if (run && run.unreadable) return { ok: false, status: 500, error: 'The saved run could not be read.' };
  run = _settleStale(run);
  if (!run) return { ok: true, contract: CONTRACT, taskId: id, run: null };
  const handoffs = (run.handoffs || []).map((h) => {
    if (h.kind !== 'prepared_action') return h;
    const live = deps().actionStatus(h.actionId);
    return { ...h, status: live ? live.status : 'unknown' };
  });
  return { ok: true, contract: CONTRACT, taskId: id, run: { ...run, handoffs, running: RUNNING.has(id) } };
}

/**
 * The "Do this" press. Idempotent: an active or awaiting run is returned as it is;
 * an interrupted or failed one resumes (one new turn); a settled one is returned
 * unless `fresh` — then it is archived and a new attempt starts.
 */
function start(taskId, { fresh = false, awaitTurn = false } = {}) {
  const id = Number(taskId);
  if (!Number.isInteger(id) || id <= 0) return { ok: false, status: 400, error: 'bad task id' };
  const d = deps();
  const task = d.getTask(id);
  if (!task) return { ok: false, status: 404, error: 'No such task.' };
  if (task.status === 'done' || task.status === 'dropped') return { ok: false, status: 409, error: 'This task is already closed.' };
  let run = _settleStale(_load(id));
  if (run && run.unreadable) return { ok: false, status: 500, error: 'The saved run could not be read.' };

  let kicked = false;
  if (!run) {
    run = _save(_fresh(task, d.forTask(id)));
    kicked = true;
  } else if (run.status === 'running' || AWAITING.has(run.status)) {
    // Resume = the same attempt. No model call, no draft, no prepared action.
  } else if (run.status === 'interrupted' || run.status === 'failed') {
    run.status = 'running'; run.error = null; run.heartbeatAt = _iso(d.now()); run.updatedAt = run.heartbeatAt;
    _step(run, 'note', 'Resumed.');
    _save(run); kicked = true;
  } else if (fresh && SETTLED.has(run.status)) {
    _archive(run);
    run = _save(_fresh(task, d.forTask(id)));
    kicked = true;
  }
  const p = kicked ? _kick(id) : (RUNNING.get(id) || null);
  if (kicked) _audit('start', run);
  const done = () => ({ ...view(id), kicked });
  return awaitTurn && p ? p.then(done) : done();
}

/** Nick answers the open question (or says the manual step is done). The run continues at once. */
function answer(taskId, { questionId, text, manualDone = false, awaitTurn = false } = {}) {
  const id = Number(taskId);
  const run = _load(id);
  if (!run || run.unreadable) return { ok: false, status: 404, error: 'There is no run for this task.' };
  const q = run.question;
  // A repeat of an answer already taken is not an error and costs nothing.
  if (!q && (run.answers || []).some((a) => a.questionId === questionId)) return { ...view(id), kicked: false };
  if (!q || !AWAITING.has(run.status)) return { ok: false, status: 409, error: 'NEURO is not waiting on an answer for this task.' };
  if (questionId !== q.id) return { ok: false, status: 409, error: 'That question has changed — reload to see the current one.' };
  const said = String(text || '').trim();
  if (!said && !manualDone) return { ok: false, status: 400, error: 'Type an answer.' };
  const d = deps();
  run.answers = run.answers || [];
  run.answers.push({ questionId: q.id, kind: q.kind, question: q.question, text: manualDone ? `Done.${said ? ` ${said}` : ''}` : said.slice(0, 2000), at: _iso(d.now()) });
  _step(run, 'answer', manualDone ? 'You did the manual step.' : 'You answered.');
  run.question = null;
  run.status = 'running';
  run.heartbeatAt = _iso(d.now());
  run.updatedAt = run.heartbeatAt;
  _save(run);
  _audit('answer', run, { kind: q.kind });
  const p = _kick(id);
  const done = () => ({ ...view(id), kicked: true });
  return awaitTurn ? p.then(done) : done();
}

/** Stop: no further turns. Outputs and prepared actions are kept as they are. */
function stop(taskId) {
  const id = Number(taskId);
  const run = _load(id);
  if (!run || run.unreadable) return { ok: false, status: 404, error: 'There is no run for this task.' };
  if (run.status === 'running' && RUNNING.has(id)) return { ok: false, status: 409, error: 'A step is in progress — wait for it to finish, then stop.' };
  run.status = 'stopped'; run.question = null; run.updatedAt = _iso(deps().now());
  _step(run, 'note', 'You stopped this run.');
  _save(run);
  _audit('stop', run);
  return view(id);
}

/** For Drafts: every task with agent work in progress (outputs, a handoff or a question). */
function activeRuns() {
  let rows = [];
  try { rows = db.all("SELECT key, value FROM agent_state WHERE key LIKE 'task_agent_run:%'"); } catch { return { ok: false, runs: [] }; }
  const runs = [];
  for (const r of rows) {
    let run; try { run = JSON.parse(r.value); } catch { continue; }
    if (!run || run.status === 'stopped') continue;
    if (!(run.outputs || []).length && !(run.handoffs || []).length && !run.question) continue;
    runs.push({ taskId: run.taskId, taskText: run.taskText, status: run.status, updatedAt: run.updatedAt, question: run.question ? run.question.question : null, outputs: (run.outputs || []).map((o) => ({ kind: o.kind, title: o.title })), handoffs: (run.handoffs || []).length });
  }
  runs.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return { ok: true, runs };
}

module.exports = {
  CONTRACT, STATUS, QUESTION_KINDS, OUTPUT_KINDS, TOOLS,
  view, start, answer, stop, activeRuns,
  sensitivityOf, sourcesFrom, addressesIn,
  _internals: {
    setDeps: (o) => { _deps = o ? { ...deps(), ...o } : null; },
    waitFor: (id) => RUNNING.get(Number(id)) || Promise.resolve(),
    systemPrompt, userPrompt, KEY,
  },
};
