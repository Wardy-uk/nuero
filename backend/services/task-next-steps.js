'use strict';

/**
 * What to do with Claude's finished work — the task presents its own next steps
 * (31 Oct 2026, Nick: "I shouldn't have to work them out").
 *
 * When Claude on the laptop returns a result to a task (task-agent.returnFromClaude),
 * NEURO thinks ONCE about that result — one model call per result, cached in
 * agent_state `task_next_steps:<taskId>:<resultId>`, never re-bought for the
 * same result; "Rethink" forces a new one — and turns it into up to five
 * ordered steps from a CLOSED set of kinds, each mapped to something NEURO can
 * already do:
 *
 *   send               a two-line covering email from Nick's WORK address with the
 *                      result attached as a .docx — a governed compose_email,
 *                      sent on his one press (intent grant + execute-direct)
 *   follow-up-task     a NEURO task (deduped: "already on your list: #N")
 *   meeting            a governed calendar invite, sent on his one press
 *   discuss-with-chris a line on the "To discuss with Chris" list
 *   complete           mark this task done
 *   drop-time          drop a prepared move's suggested time — present ONLY when a
 *                      waiting prepared move exists, decided by the facts, never by the model
 *   manual             a step only Nick can do; "Done" just records it here
 *
 * The model proposes; the server validates. An unknown kind becomes `manual`
 * (title kept). A person is resolved to ONE address by exact name, never
 * guessed; an unresolved one leaves the address box empty for Nick. When the
 * model is unavailable, refuses or answers nonsense, a deterministic fallback
 * is shown and labelled as such.
 *
 * Each step's outcome persists per result (`state`), so progress survives a reload.
 * Nothing here sends, books or completes without Nick's press on that step.
 */

const db = require('../db/database');

const KINDS = ['send', 'follow-up-task', 'meeting', 'discuss-with-chris', 'complete', 'drop-time', 'manual'];
const MAX_STEPS = 5;
const MAX_DOC_CHARS = 12000;
const PLAN_KEY = (taskId, resultId) => `task_next_steps:${taskId}:${resultId}`;
const SEND_ORIGIN = 'task-claude-send';
const MEETING_ORIGIN = 'task-claude-meeting';
const LIVE = ['prepared', 'approved', 'executing', 'execution_uncertain', 'executed', 'verified'];
const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const FALLBACK_LABEL = 'Suggested steps (NEURO couldn’t think this through just now)';
const inflight = new Map();

const clip = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
const londonDay = (ms) => new Date(ms).toLocaleString('sv-SE', { timeZone: 'Europe/London' }).slice(0, 10);

// ── reads ────────────────────────────────────────────────────────────────────

function _results(taskId) { return require('./task-agent').claudeResults(taskId); }
function _task(taskId) { return require('./task-store').getTask(Number(taskId)); }

function loadPlan(taskId, resultId) {
  try { const v = JSON.parse(db.getState(PLAN_KEY(taskId, resultId)) || 'null'); return v && Array.isArray(v.steps) ? v : null; } catch { return null; }
}
function _savePlan(plan) { db.setState(PLAN_KEY(plan.taskId, plan.resultId), JSON.stringify(plan)); return plan; }

/** The open promise this task belongs to, with Nick's owed-to answer overlaid. null when none. */
function promiseFor(taskId, { deps = {}, now = Date.now() } = {}) {
  let ledger;
  try { ledger = deps.ledger || require('./promise-ledger').read({ now }); } catch { return null; }
  const found = ((ledger && ledger.promises) || []).find((p) => (p.taskIds || []).includes(Number(taskId)));
  if (!found) return null;
  try { return deps.owed === false ? found : require('./promise-owed').overlay([found])[0]; } catch { return found; }
}

function _contacts(deps) {
  if (deps.contacts) return deps.contacts;
  try { return require('./contact-directory').fromPeopleNotes(); } catch { return []; }
}

/**
 * ONE address for a name, or why not. The owed person goes through
 * promise-delivery.recipientFor (the same rule its readiness uses); any other
 * name must match a People note by its exact full name (case-insensitive).
 */
function resolvePerson(name, { promise = null, contacts = [] } = {}) {
  const pd = require('./promise-delivery');
  const want = clip(name, 120).toLowerCase();
  const owedName = promise && promise.owedTo && promise.owedTo.resolved;
  if (promise && (!want || (owedName && (owedName.toLowerCase() === want || owedName.toLowerCase().split(' ')[0] === want)))) {
    const r = pd.recipientFor(promise, contacts);
    return r.ok ? { ok: true, name: r.recipient.name, email: r.recipient.email } : { ok: false, name: owedName || name || null, why: r.why };
  }
  if (!want) return { ok: false, name: null, why: 'NEURO doesn’t know who this goes to — type their address' };
  const hits = contacts.filter((c) => String(c.name || '').toLowerCase() === want && EMAIL_RE.test(String(c.email || '')));
  if (hits.length === 1) return { ok: true, name: hits[0].name, email: String(hits[0].email).toLowerCase() };
  if (hits.length > 1) return { ok: false, name, why: `more than one People note is called ${name} — type the address` };
  return { ok: false, name, why: `no single address for ${name} in your People notes — type it` };
}

/** A waiting prepared move for this task with a suggested time, or null. FACT, never the model. */
function waitingMove(taskId, { now = Date.now() } = {}) {
  const store = require('./prepared-move-store');
  const moveKey = `saim-move:v2:project-note:task:${Number(taskId)}`;
  let rec;
  try { rec = store.latest(moveKey); } catch { return null; }
  if (!rec) return null;
  let st;
  try { st = require('./promise-moves').stateOf(rec, { now, store, extra: {}, ref: null, moveKey }); } catch { return null; }
  if (!st || !['needs-decision', 'ready', 'offer'].includes(st.state)) return null;
  const s = rec.packet && rec.packet.selected;
  const slot = ((s && s.decision && s.decision.slots) || [])[0] || null;
  if (!slot || !slot.date) return null;
  const d = new Date(`${slot.date}T12:00:00Z`);
  const day = d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  return { recordId: rec.id, version: rec.version, slot, say: `${day} ${slot.start}` };
}

// ── the covering email ───────────────────────────────────────────────────────

function lowerFirst(s) {
  const t = String(s || '').trim().replace(/[.!]+$/, '');
  if (!t) return 'work';
  return /^[A-Z][A-Z0-9]/.test(t) ? t : t.charAt(0).toLowerCase() + t.slice(1);
}
function coveringEmail(task, toName) {
  const first = toName ? String(toName).trim().split(/\s+/)[0] : null;
  const wording = String((task && task.text) || 'the work').trim();
  const subject = wording.length > 120 ? `${wording.slice(0, 117).trimEnd()}…` : wording;
  const body = `${first ? `Hi ${first},` : 'Hi,'}\n\nAttached is the ${lowerFirst(wording)} you asked for.\n\nNick`;
  return { subject, body };
}

// ── the plan: model, validation, fallback ────────────────────────────────────

function buildPrompt({ task, promise, result, move, today }) {
  const owed = promise && promise.owedTo ? (promise.owedTo.resolved || (promise.owedTo.people || []).map((p) => p.name).join(', ') || 'not known') : 'no promise recorded';
  const doc = String(result.markdown || '').slice(0, MAX_DOC_CHARS);
  return [
    'You are NEURO, Nick Ward\'s assistant. Claude has just finished a piece of work for one of Nick\'s tasks. Work out what Nick should do NEXT with it.',
    `Today is ${today}.`,
    `Task: ${task.text}`,
    `Task due: ${task.due_date || 'no date'}. Origin: ${task.origin || 'not recorded'}.`,
    `Owed to: ${owed}.`,
    `A prepared suggested time for this task: ${move ? move.say : 'none'}.`,
    '',
    'The finished work (markdown):',
    '<<<', doc, '>>>',
    '',
    'Answer with STRICT JSON only, no prose: {"steps":[{"kind":"...","title":"...","why":"...","params":{}}]}',
    `Up to ${MAX_STEPS} steps, in the order Nick should do them. title: a short imperative in Nick's voice. why: one line, taken from the document.`,
    'kind is EXACTLY one of:',
    '- "send" params {"to":"Full Name"} — send the work to that person (a covering email with it attached).',
    '- "follow-up-task" params {"text":"...","due":"YYYY-MM-DD optional","domain":"work|personal optional"} — a new task the document says is needed.',
    '- "meeting" params {"with":["Full Name"],"subject":"...","minutes":30} — a meeting the document says should happen.',
    '- "discuss-with-chris" params {"text":"..."} — something to raise with Chris Middleton, Nick\'s manager.',
    '- "complete" params {} — mark this task done. Include it last unless work remains for Nick on THIS task.',
    '- "manual" params {} — anything else only Nick can do.',
    'Use only names that appear in the task or the document. Never invent people, dates or facts.',
  ].join('\n');
}

function parseJson(text) {
  const t = String(text || '').trim().replace(/^```[a-z]*\s*\n?|\n?```\s*$/g, '');
  try { return JSON.parse(t); } catch { /* try the outermost object */ }
  const a = t.indexOf('{'); const b = t.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('no JSON object in the answer');
  return JSON.parse(t.slice(a, b + 1));
}

/** PURE. The model's answer → validated steps. Throws when there is no usable list at all. */
function validateSteps(raw, { today }) {
  const list = raw && Array.isArray(raw.steps) ? raw.steps : null;
  if (!list) throw new Error('the answer had no steps list');
  const out = [];
  let complete = null;
  for (const s of list) {
    if (!s || typeof s !== 'object') continue;
    const title = clip(s.title, 120);
    if (!title) continue;
    const why = clip(s.why, 200) || null;
    const p = s.params && typeof s.params === 'object' ? s.params : {};
    let kind = KINDS.includes(s.kind) ? s.kind : 'manual';
    let params = {};
    if (kind === 'drop-time') continue; // the facts decide that one
    if (kind === 'send') params = { to: clip(p.to, 120) || null };
    else if (kind === 'follow-up-task') {
      const text = clip(p.text, 300);
      if (!text) kind = 'manual';
      else params = { text, due: DAY_RE.test(String(p.due || '')) && p.due >= today ? p.due : null, domain: ['work', 'personal'].includes(p.domain) ? p.domain : null };
    } else if (kind === 'meeting') {
      const withNames = (Array.isArray(p.with) ? p.with : [p.with]).map((x) => clip(x, 120)).filter(Boolean).slice(0, 8);
      const minutes = Number.isInteger(p.minutes) && p.minutes >= 15 && p.minutes <= 120 ? p.minutes : 30;
      params = { with: withNames, subject: clip(p.subject, 120) || title, minutes };
    } else if (kind === 'discuss-with-chris') {
      const text = clip(p.text, 400);
      if (!text) kind = 'manual'; else params = { text };
    }
    if (kind === 'complete') { complete = { kind, title, why, params: {} }; continue; }
    if (kind === 'manual') params = {};
    out.push({ kind, title, why, params });
  }
  const steps = out.slice(0, complete ? MAX_STEPS - 1 : MAX_STEPS);
  if (complete) steps.push(complete);
  if (!steps.length) throw new Error('the answer had no usable steps');
  return steps;
}

/** PURE. The deterministic plan when the model could not answer. */
function fallbackSteps({ promise }) {
  const steps = [];
  const owed = promise && promise.owedTo && promise.owedTo.resolved;
  if (owed) steps.push({ kind: 'send', title: `Send it to ${owed.split(' ')[0]}`, why: 'This task is owed to them.', params: { to: owed } });
  steps.push({ kind: 'complete', title: 'Mark the task done', why: 'Claude has returned the finished work.', params: {} });
  return steps;
}

const withIds = (steps) => steps.map((s, i) => ({ id: `s${i + 1}`, ...s, state: null }));

async function think(taskId, result, { deps = {}, now = Date.now() } = {}) {
  const task = _task(taskId);
  if (!task) throw new Error('no such task');
  const promise = promiseFor(taskId, { deps, now });
  const move = waitingMove(taskId, { now });
  const today = londonDay(now);
  const base = { taskId: Number(taskId), resultId: result.id, at: new Date(now).toISOString() };
  try {
    const run = deps.run || ((prompt) => require('./ai-routing').runTask('task_next_steps', { prompt, maxTokens: 1200 }, { forceCloud: true, timeout: 60000 }));
    const r = await run(buildPrompt({ task, promise, result, move, today }));
    if (!r || !r.text) throw new Error((r && r.reason) || 'no AI provider answered');
    const steps = validateSteps(parseJson(r.text), { today });
    return _savePlan({ ...base, source: 'model', steps: withIds(steps) });
  } catch (e) {
    return _savePlan({ ...base, source: 'fallback', label: FALLBACK_LABEL, reason: clip(e.message, 200), steps: withIds(fallbackSteps({ promise })) });
  }
}

/** Think about the newest result unless that is already cached (or force). One call in flight per result. */
function ensure(taskId, { force = false, deps = {}, now = Date.now() } = {}) {
  const result = _results(taskId)[0];
  if (!result) return Promise.resolve(null);
  const key = PLAN_KEY(taskId, result.id);
  if (!force) { const cached = loadPlan(taskId, result.id); if (cached) return Promise.resolve(cached); }
  if (inflight.has(key)) return inflight.get(key);
  const p = think(taskId, result, { deps, now }).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

// ── the view: the cached plan with today's facts applied ─────────────────────

function _liveSend(taskId, resultId) {
  try {
    const rows = db.all(`SELECT action_id, status, evidence_json FROM prepared_actions WHERE evidence_json LIKE ? ORDER BY created_at`, [`%"resultId":"${resultId}"%`]);
    const mine = rows.filter((r) => { try { const e = JSON.parse(r.evidence_json); return e.taskId === Number(taskId) && e.resultId === resultId && e.nextStep === 'send' && LIVE.includes(r.status); } catch { return false; } });
    return mine.length ? mine[mine.length - 1].action_id : null;
  } catch { return null; }
}

function _actionView(actionId) {
  if (!actionId) return null;
  const a = require('./prepared-actions').get(actionId);
  if (!a) return null;
  return { actionId: a.actionId, version: a.version, payloadHash: a.payloadHash, status: a.status, actionType: a.actionType,
    to: (a.draft && a.draft.to) || [], subject: a.draft && a.draft.subject, body: a.draft && a.draft.body,
    start: a.draft && a.draft.start, end: a.draft && a.draft.end,
    attachments: ((a.draft && a.draft.attachments) || []).map((x) => ({ name: x.name, size: x.size })) };
}

function sendingEnabled() { try { return require('./feature-flags').isEnabled('governed_execution'); } catch { return null; } }
function calendarEnabled() { try { return require('./feature-flags').isEnabled('governed_calendar'); } catch { return null; } }

function nextMorning(now) {
  let d;
  try { d = require('./working-days').nextWorkingDay(new Date(now)); } catch { d = null; }
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) { d = new Date(now); d.setDate(d.getDate() + 1); }
  return `${londonDay(d.getTime())}T10:00`;
}

/** The plan for the newest result, with facts applied. Kicks off thinking when nothing is cached. */
function view(taskId, { deps = {}, now = Date.now() } = {}) {
  const results = _results(taskId);
  if (!results.length) return null;
  const result = results[0];
  const plan = loadPlan(taskId, result.id);
  if (!plan) { ensure(taskId, { deps, now }).catch(() => {}); return { forResultId: result.id, thinking: true, steps: [] }; }
  const task = _task(taskId);
  const promise = promiseFor(taskId, { deps, now });
  const contacts = _contacts(deps);
  const move = waitingMove(taskId, { now });
  const steps = [];
  for (const s of plan.steps) {
    const v = { id: s.id, kind: s.kind, title: s.title, why: s.why, state: s.state || null };
    if (s.kind === 'send') {
      const who = resolvePerson(s.params.to, { promise, contacts });
      const mail = coveringEmail(task, who.ok ? who.name : null);
      const actionId = (s.state && s.state.actionId) || _liveSend(taskId, result.id);
      v.send = { to: who.ok ? { name: who.name, email: who.email } : null, toName: who.name || s.params.to || null, why: who.ok ? null : who.why,
        subject: mail.subject, body: mail.body, attachmentName: require('./markdown-docx').docxName(result.markdown, task && task.text),
        action: _actionView(actionId), sendingEnabled: sendingEnabled() };
    } else if (s.kind === 'follow-up-task') {
      const created = s.state && s.state.taskId ? { id: s.state.taskId } : null;
      let similar = null;
      if (!created) { try { similar = require('./task-store').findSimilar(s.params.text, { excludeId: Number(taskId) }); } catch { similar = null; } }
      v.followUp = { text: s.params.text, due: s.params.due, domain: s.params.domain, already: similar ? { id: similar.id, text: similar.text } : null };
    } else if (s.kind === 'meeting') {
      const people = s.params.with.map((n) => ({ name: n, ...resolvePerson(n, { contacts }) }));
      v.meeting = { subject: s.params.subject, minutes: s.params.minutes, attendees: people.filter((p) => p.ok).map((p) => ({ name: p.name, email: p.email })),
        unresolved: people.filter((p) => !p.ok).map((p) => ({ name: p.name, why: p.why })), suggestedStart: nextMorning(now),
        action: _actionView(s.state && s.state.actionId), calendarEnabled: calendarEnabled() };
    } else if (s.kind === 'discuss-with-chris') {
      v.discuss = { text: s.params.text };
    } else if (s.kind === 'complete') {
      if (task && task.status === 'done' && !v.state) v.state = { status: 'done', say: 'Task marked done.' };
    }
    if (s.kind === 'complete' && move && !steps.some((x) => x.kind === 'drop-time')) steps.push(_dropStep(plan, move));
    steps.push(v);
  }
  // A waiting move with no complete step to sit before: at the end.
  if (move && !steps.some((x) => x.kind === 'drop-time')) steps.push(_dropStep(plan, move));
  // A drop already done stays visible as done even after the move has gone.
  const dropped = (plan.done || {})['drop-time'];
  if (!move && dropped) steps.push({ id: 'drop-time', kind: 'drop-time', title: 'Drop the suggested time', why: null, state: dropped });
  return { forResultId: result.id, source: plan.source, label: plan.source === 'fallback' ? FALLBACK_LABEL : null, reason: plan.reason || null,
    at: plan.at, taskStatus: task ? task.status : null, steps };
}

function _dropStep(plan, move) {
  return { id: 'drop-time', kind: 'drop-time', title: `Drop the suggested time (${move.say})`, why: 'SAiM suggested a time for this task — it isn’t needed now the work is back.',
    state: (plan.done || {})['drop-time'] || null, dropTime: { recordId: move.recordId, version: move.version, say: move.say } };
}

// ── acting on one step (Nick's press) ────────────────────────────────────────

function _record(taskId, resultId, stepId, state) {
  const plan = loadPlan(taskId, resultId);
  if (!plan) return;
  const at = new Date().toISOString();
  if (stepId === 'drop-time') plan.done = { ...(plan.done || {}), 'drop-time': { ...state, at } };
  else plan.steps = plan.steps.map((s) => (s.id === stepId ? { ...s, state: { ...state, at } } : s));
  _savePlan(plan);
}

function _strict(body, allowed) {
  const extra = Object.keys(body || {}).filter((k) => !allowed.includes(k));
  return extra.length ? `Unexpected field: ${extra.join(', ')}` : null;
}

/**
 * Nick pressed a step. → { ok, step: <view of that step>, action?, recurred?, msPush? } or { ok:false, status, error }.
 * send/meeting PREPARE a governed action (the client then spends an intent grant);
 * the rest act at once.
 */
async function act(taskId, stepId, body = {}, { deps = {}, now = Date.now() } = {}) {
  const id = Number(taskId);
  const result = _results(id)[0];
  if (!result) return { ok: false, status: 404, error: 'Nothing has come back from Claude for this task.' };
  const plan = loadPlan(id, result.id);
  if (!plan) return { ok: false, status: 409, error: 'NEURO is still working out the next steps — try again in a moment.' };
  const task = _task(id);
  if (!task) return { ok: false, status: 404, error: 'No such task.' };
  const step = stepId === 'drop-time' ? { id: 'drop-time', kind: 'drop-time', params: {} } : plan.steps.find((s) => s.id === stepId);
  if (!step) return { ok: false, status: 404, error: 'No such step.' };

  if (step.kind === 'send') {
    const bad = _strict(body, ['to']); if (bad) return { ok: false, status: 400, error: bad };
    const existing = (step.state && step.state.actionId) || _liveSend(id, result.id);
    if (existing) {
      const a = require('./prepared-actions').get(existing);
      if (a && LIVE.includes(a.status)) return { ok: true, already: true, action: a };
    }
    const promise = promiseFor(id, { deps, now });
    let to;
    if (body.to !== undefined && body.to !== null && body.to !== '') {
      const email = String(body.to).trim().toLowerCase();
      if (!EMAIL_RE.test(email)) return { ok: false, status: 400, error: 'that is not a valid email address' };
      const c = _contacts(deps).find((x) => String(x.email || '').toLowerCase() === email);
      to = { name: c ? c.name : null, email };
    } else {
      const who = resolvePerson(step.params.to, { promise, contacts: _contacts(deps) });
      if (!who.ok) return { ok: false, status: 409, recipientNeeded: true, error: who.why };
      to = { name: who.name, email: who.email };
    }
    const docx = require('./markdown-docx');
    const buf = docx.markdownToDocx(result.markdown);
    const mail = coveringEmail(task, to.name);
    const evidence = { taskId: id, resultId: result.id, nextStep: 'send', notePath: result.notePath || null,
      ...(promise ? { promiseKey: promise.key, move: 'deliver-email', taskIds: promise.taskIds } : {}) };
    const r = require('./prepared-actions').prepareCompose({
      from: 'work', to: [to], subject: mail.subject, body: mail.body, origin: SEND_ORIGIN,
      attachments: [{ name: docx.docxName(result.markdown, task.text), contentType: docx.DOCX_TYPE, dataBase64: buf.toString('base64') }],
      generatedBy: 'template (task next step: covering email for Claude\'s returned work, no model call)', evidence, now,
    });
    if (!r || !r.ok) return { ok: false, status: (r && r.code) || 400, error: (r && r.error) || 'could not prepare the email' };
    _record(id, result.id, step.id, { status: 'prepared', actionId: r.action.actionId, say: 'Email prepared — waiting for your Send.' });
    if (promise) { try { require('./canonical-read').invalidateKeepMyWord(); } catch { /* memo expires */ } }
    return { ok: true, already: false, action: r.action };
  }

  if (step.kind === 'follow-up-task') {
    const bad = _strict(body, []); if (bad) return { ok: false, status: 400, error: bad };
    if (step.state && step.state.taskId) return { ok: true, already: true, say: step.state.say };
    const store = require('./task-store');
    const similar = store.findSimilar(step.params.text, { excludeId: id });
    if (similar) {
      const say = `Already on your list: #${similar.id}.`;
      _record(id, result.id, step.id, { status: 'done', say, taskId: similar.id, existing: true });
      return { ok: true, already: true, say, taskId: similar.id };
    }
    const t = store.createTask({ text: step.params.text, source: 'task-claude-next-step', origin_path: result.notePath || null,
      due_date: step.params.due || null, ...(step.params.domain ? { domain: step.params.domain } : {}) });
    const say = `Task #${t.id} created.`;
    _record(id, result.id, step.id, { status: 'done', say, taskId: t.id });
    return { ok: true, say, taskId: t.id };
  }

  if (step.kind === 'meeting') {
    const bad = _strict(body, ['start', 'attendees']); if (bad) return { ok: false, status: 400, error: bad };
    if (step.state && step.state.actionId) {
      const a = require('./prepared-actions').get(step.state.actionId);
      if (a && LIVE.includes(a.status)) return { ok: true, already: true, action: a };
    }
    const start = String(body.start || '').slice(0, 16);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(start)) return { ok: false, status: 400, error: 'pick a start time' };
    const endMs = Date.parse(`${start}:00Z`) + step.params.minutes * 60000;
    const end = new Date(endMs).toISOString().slice(0, 16);
    const contacts = _contacts(deps);
    const resolved = step.params.with.map((n) => resolvePerson(n, { contacts })).filter((p) => p.ok).map((p) => ({ name: p.name, email: p.email }));
    const typed = Array.isArray(body.attendees) ? body.attendees.map((e) => String(e || '').trim().toLowerCase()).filter(Boolean) : [];
    if (typed.some((e) => !EMAIL_RE.test(e))) return { ok: false, status: 400, error: 'one of the addresses is not a valid email address' };
    const attendees = [...resolved, ...typed.filter((e) => !resolved.some((r) => r.email === e)).map((email) => ({ name: null, email }))];
    const r = require('./prepared-actions').prepareCalendarCreate({ title: step.params.subject, start, end, attendees, origin: MEETING_ORIGIN,
      context: { taskId: id, resultId: result.id, durationMinutes: step.params.minutes }, now });
    if (!r || !r.ok) return { ok: false, status: (r && r.code) || 400, error: (r && r.error) || 'could not prepare the invite' };
    _record(id, result.id, step.id, { status: 'prepared', actionId: r.action.actionId, say: 'Invite prepared — waiting for your Send.' });
    return { ok: true, already: !!r.already, action: r.action };
  }

  if (step.kind === 'discuss-with-chris') {
    const bad = _strict(body, []); if (bad) return { ok: false, status: 400, error: bad };
    const r = require('./chris-agenda').add(step.params.text, { source: 'task-claude-next-step' });
    const say = r.already ? 'Already on your list to discuss with Chris.' : 'Added to your list to discuss with Chris.';
    _record(id, result.id, step.id, { status: 'done', say });
    return { ok: true, say };
  }

  if (step.kind === 'complete') {
    const bad = _strict(body, []); if (bad) return { ok: false, status: 400, error: bad };
    const store = require('./task-store');
    const t = store.setStatus(id, 'done');
    if (!t) return { ok: false, status: 404, error: 'No such task.' };
    let msPush = null;
    try { const push = deps.pushMs || require('../routes/tasks').pushCompletionToMicrosoft; if (push) msPush = await push(t, 'nick'); } catch { msPush = null; }
    const recurred = t.recurred || null;
    const say = recurred ? (recurred.notice || 'Done — it repeats, so it is open again at its next date.') : 'Task marked done.';
    _record(id, result.id, step.id, { status: 'done', say });
    return { ok: true, say, recurred, msPush, task: t };
  }

  if (step.kind === 'drop-time') {
    const bad = _strict(body, []); if (bad) return { ok: false, status: 400, error: bad };
    const move = waitingMove(id, { now });
    if (!move) return { ok: false, status: 409, error: 'There is no suggested time waiting for this task any more.' };
    const r = require('./prepared-move-store').respond({ recordId: move.recordId, version: move.version, response: 'decline', by: 'nick', now });
    if (!r.ok) return { ok: false, status: r.code || 409, error: r.why };
    const say = `Suggested time (${move.say}) dropped.`;
    _record(id, result.id, 'drop-time', { status: 'done', say });
    return { ok: true, say };
  }

  // manual
  const bad = _strict(body, []); if (bad) return { ok: false, status: 400, error: bad };
  _record(id, result.id, step.id, { status: 'done', say: 'Done.' });
  return { ok: true, say: 'Done.' };
}

/** Rethink: a fresh model call for the newest result (step progress is not carried over). */
async function rethink(taskId, { deps = {}, now = Date.now() } = {}) {
  if (!_results(taskId).length) return { ok: false, status: 404, error: 'Nothing has come back from Claude for this task.' };
  await ensure(taskId, { force: true, deps, now });
  return { ok: true, nextSteps: view(taskId, { deps, now }) };
}

module.exports = {
  KINDS, PLAN_KEY, SEND_ORIGIN, MEETING_ORIGIN, FALLBACK_LABEL,
  view, ensure, act, rethink, think, loadPlan, validateSteps, fallbackSteps, parseJson, buildPrompt,
  resolvePerson, promiseFor, waitingMove, coveringEmail, lowerFirst,
  _inflight: inflight,
};
