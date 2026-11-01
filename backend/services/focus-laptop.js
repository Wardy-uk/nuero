'use strict';

/**
 * The laptop, ready for a focus block (1 Nov 2026, Nick's ask).
 *
 * When Nick picks a task on a focus block — or, for a block he made by hand
 * with ONE task already in it, at the block's "ready" moment five minutes
 * before — the laptop opens what that task needs: its pinned vault note, its
 * Jira ticket, its saved draft; when NEURO knows none of those, the task in
 * NEURO itself. At most three.
 *
 * ⚠ THROUGH THE EXISTING PULL ONLY. Each open is a desk intent of the narrow
 *   `open-url` kind (desk-intents.queueUrl): a URL NEURO built here, on one of
 *   three exact shapes, refused at queue, at claim and again on the laptop.
 *   Nothing listens on the laptop; the agent collects it on its own poll.
 * ⚠ NEVER INTO A LOCKED OR SILENT LAPTOP. If the laptop is not reporting, is
 *   locked, or he is not at it, nothing is queued — the request would only
 *   expire, or fire at a machine nobody is in front of — and the card says the
 *   laptop is not reachable. An agent that has not declared `open-url` (one
 *   older than this) is the same: nothing queued, and the card says why.
 * ⚠ ONCE PER BLOCK AND TASK. A second choose of the same task, or the ready
 *   moment followed by the choose, never opens the same things twice.
 *
 * Also here: what the card says about the laptop's notifications. Windows 11
 * offers no supported way for an unpackaged process to turn Do Not Disturb on
 * (tested on Nick's machine, 1 Nov 2026 — see desktop-agent/focus-laptop.ps1),
 * so the agent only READS the state and the card says what it is.
 */

const db = require('../db/database');
const deskIntents = require('./desk-intents');

const STATE_PREFIX = 'focus_block_laptop:';
const MAX_OPENS = 3;

function neuroBase() {
  return String(process.env.NEURO_DESKTOP_URL || 'https://nuero.nickward.co.uk').replace(/\/+$/, '');
}
function jiraBase() {
  return String(process.env.JIRA_BASE_URL || '').replace(/\/+$/, '');
}
function vaultName() {
  return process.env.OBSIDIAN_VAULT_NAME || 'Nicks knowledge base';
}

function obsidianUrl(rel) {
  return `obsidian://open?vault=${encodeURIComponent(vaultName())}&file=${encodeURIComponent(String(rel).replace(/\.md$/i, ''))}`;
}

/**
 * PURE. What to open for one task, from the context focus-blocks gathers
 * (`prepareContext`): { notes:[{title, open:{kind,path}}], jira, draft }.
 * Order: the pinned note, the Jira ticket, the draft; the task in NEURO only
 * when there is none of those. Every URL is built HERE and must pass the same
 * allowlist the queue applies — one that does not is dropped, not sent.
 */
function opensFor(taskId, context = {}, { allowed = deskIntents.urlAllowed } = {}) {
  const out = [];
  const ctx = context || {};
  const note = (ctx.notes || []).find((n) => n && n.open && n.open.kind === 'note' && n.open.path);
  if (note) out.push({ kind: 'note', label: `“${note.title || note.open.path}” in Obsidian`, url: obsidianUrl(note.open.path) });
  if (ctx.jira && jiraBase()) out.push({ kind: 'jira', label: `${ctx.jira} in Jira`, url: `${jiraBase()}/browse/${ctx.jira}` });
  if (ctx.draft) out.push({ kind: 'draft', label: 'your draft in NEURO', url: `${neuroBase()}/?view=drafts` });
  if (!out.length && Number.isInteger(Number(taskId))) {
    out.push({ kind: 'task', label: 'the task in NEURO', url: `${neuroBase()}/?view=task&taskId=${Number(taskId)}` });
  }
  return out.filter((o) => allowed(o.url)).slice(0, MAX_OPENS);
}

/**
 * PURE. Can the laptop be asked right now? From desktop-activity's `run()`.
 * → { ok, host } | { ok:false, why }
 */
function reachable(run) {
  if (!run || !run.known) return { ok: false, why: 'the laptop isn’t reachable' };
  if (!run.host || run.app == null) return { ok: false, why: 'the laptop isn’t reachable — it’s locked or you’re away from it' };
  if (!Array.isArray(run.canOpen) || !run.canOpen.includes(deskIntents.URL_APP)) {
    return { ok: false, why: 'the laptop agent can’t open links yet — restart it to pick up the new version' };
  }
  return { ok: true, host: run.host };
}

function _read(blockId) {
  try { const raw = db.getState(STATE_PREFIX + blockId); return raw ? JSON.parse(raw) : null; } catch { return null; }
}
function _write(blockId, v) {
  try { db.setState(STATE_PREFIX + blockId, JSON.stringify(v)); } catch (e) { console.warn('[FocusLaptop] could not save:', e.message); }
}

/**
 * Get the laptop ready for this block's task. Never throws; a failure here must
 * never cost the choose or the ready moment it rides on.
 */
function openForBlock({ blockId, taskId, context = null, now = new Date(), deps = {} } = {}) {
  try {
    const prev = _read(blockId);
    if (prev && Number(prev.taskId) === Number(taskId) && (prev.opens || []).length) {
      return { ...prev, already: true };
    }
    const run = deps.run ? deps.run(now) : require('./desktop-activity').run(now);
    const reach = reachable(run);
    if (!reach.ok) {
      const v = { taskId: Number(taskId), at: now.toISOString(), opens: [], reason: reach.why };
      _write(blockId, v);
      return v;
    }
    let ctx = context;
    if (!ctx) {
      try { ctx = (require('./focus-blocks').prepareContext([Number(taskId)]) || {})[Number(taskId)] || {}; } catch { ctx = {}; }
    }
    const queue = deps.queueUrl || deskIntents.queueUrl;
    const opens = [];
    for (const o of opensFor(taskId, ctx)) {
      const r = queue(o.url, { host: reach.host, why: `focus-block:${blockId}`, label: o.label });
      if (r && r.ok) opens.push({ intentId: r.intent.id, kind: o.kind, label: o.label });
    }
    const v = { taskId: Number(taskId), at: now.toISOString(), host: reach.host, opens, reason: opens.length ? null : 'nothing could be queued for the laptop' };
    _write(blockId, v);
    return v;
  } catch (e) {
    console.warn('[FocusLaptop] open failed:', e.message);
    return { taskId: Number(taskId), opens: [], reason: 'the laptop couldn’t be asked' };
  }
}

/** PURE. The sentence for one open, from desk-intents' status. */
function openSay(label, st) {
  const s = st && st.state;
  if (s === 'opened') return `Opened ${label} on your laptop`;
  if (s === 'failed') return `Couldn’t open ${label} on your laptop${st.detail ? ` — ${st.detail}` : ''}`;
  if (s === 'expired') return `The laptop didn’t pick up ${label} in time`;
  return `Opening ${label} on your laptop`;
}

/** PURE. The DND line, from the agent's report and the hold. */
function dndSay(dnd, holdActive) {
  if (!dnd || !holdActive) return null;
  if (dnd.state === 'on') return 'Laptop: Do not disturb is on';
  if (dnd.state === 'off') return 'Laptop notifications are still on — Win+N, then Do not disturb';
  return null;
}

/** What the focus card shows about the laptop. Null when there is nothing to say. */
function viewFor(blockId, { holdActive = false, deps = {} } = {}) {
  try {
    const v = _read(blockId);
    let dnd = null;
    try {
      const hosts = deps.hosts ? deps.hosts() : require('./desktop-activity').hosts();
      const h = (v && v.host ? hosts.find((x) => x.host === v.host) : null) || hosts[0] || null;
      dnd = h && h.dnd ? h.dnd : null;
    } catch { dnd = null; }
    const status = deps.status || deskIntents.status;
    const opens = ((v && v.opens) || []).map((o) => {
      const st = status(o.intentId) || {};
      return { kind: o.kind, label: o.label, state: st.state || 'waiting', say: openSay(o.label, st) };
    });
    const out = {
      opens,
      unreachable: v && !opens.length ? v.reason || null : null,
      dnd: dnd ? { state: dnd.state, at: dnd.at || null } : null,
      dndSay: dndSay(dnd, holdActive),
    };
    if (!out.opens.length && !out.unreachable && !out.dndSay) return null;
    return out;
  } catch { return null; }
}

module.exports = { opensFor, reachable, openForBlock, viewFor, openSay, dndSay, obsidianUrl, STATE_PREFIX, MAX_OPENS };
