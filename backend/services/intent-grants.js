'use strict';

/**
 * Human-originated action provenance (9 Oct 2026).
 *
 * ── The problem ────────────────────────────────────────────────────────────
 *
 * Build 7 made every A4 action wait for Nick's approval code, because the PIN
 * proves only that a caller holds NEURO's credential. That was right for what
 * NEURO drafts and wrong for what Nick does himself: pressing Book on a 1-2-1
 * he has just picked produced a card in Actions and a code prompt — the same
 * decision asked twice. Nick: "a mechanism to differentiate between ME doing
 * something and NEURO doing it — that doesn't involve multiple steps or me
 * entering a PIN".
 *
 * ── The mechanism: a one-use intent grant ──────────────────────────────────
 *
 * When Nick presses the final button on an attended NEURO surface, the screen
 * asks for a GRANT for the exact action it is showing: its id, version and
 * payload hash. A grant is:
 *   • refused to any machine caller (API token, MCP, a declared
 *     X-Neuro-Machine-Client) — the route never mints one for them;
 *   • only for an action a human button prepared (HUMAN_ORIGINS) — anything
 *     NEURO drafted keeps the approval-code path;
 *   • 60 seconds, single use, burned atomically with the approval that spends
 *     it, and refused if the action changed in between (a new version, a new
 *     hash, an edit);
 *   • kept for ever (no-delete trigger) as the audit of who did what.
 *
 * Nothing the client SAYS about who it is is believed: initiated_by is derived
 * here from the action's origin and the proof spent, never read from a body.
 *
 * ⚠ The honest boundary, unchanged from Build 7's: something that holds the
 * PIN and does NOT declare itself a machine can mint a grant, exactly as it can
 * press any other button in NEURO. What stops an agent is the authority guard
 * (declared machines and the API token are refused) and the grant being bound
 * to one prepared action of a human origin — an agent cannot use it to send
 * anything NEURO drafted, or anything it did not first prepare through the
 * same human-only route.
 */

const crypto = require('crypto');
const db = require('../db/database');

const TTL_MS = 60 * 1000;
const SURFACES = Object.freeze(['neuro-web', 'neuro-ios', 'saim-kiosk']);
const MECHANISM = 'intent-grant';
const USER = 'nick';

// Origins whose final click IS the decision. Every other origin keeps the
// approval-code path. Email (the Inbox composer) is the next to move here.
const HUMAN_ORIGINS = Object.freeze({
  '1to1-book': 'human_direct',
  '1to1-move': 'human_direct',
  'event-composer': 'human_direct',
});

// What started an action, from its origin alone. Never from a request body.
const ORIGIN_INITIATOR = Object.freeze({
  ...HUMAN_ORIGINS,
  composer: 'human_direct',
  'chase-button': 'human_assisted',
  'weekly-risk': 'human_assisted',
  risk: 'neuro_autonomous',
  'meeting-triage': 'neuro_autonomous',
  draft_reply: 'neuro_autonomous',
  chat: 'neuro_autonomous',
});

const msOf = (v) => (v instanceof Date ? v.getTime() : typeof v === 'number' ? v : Date.now());
const iso = (ms) => new Date(ms).toISOString();

function initiatedByFor(origin) {
  if (origin === 'machine-client') return 'machine:client';
  if (typeof origin === 'string' && origin.startsWith('machine:')) return origin;
  return ORIGIN_INITIATOR[origin] || 'neuro_autonomous';
}

/** Who is calling, from what NEURO's own middleware established — never a body. */
function callerOf(req) {
  const machine = require('./authority-guard').machineName(req);
  return { machine: machine || null, attended: req.attendedSurface || null };
}

const refuse = (code, error, reason) => ({ ok: false, code, error, reason });

/**
 * Mint a grant for one prepared action. `caller` comes from callerOf(req).
 */
function mint({ actionId, version, payloadHash, surface, sessionId, caller = {}, now = Date.now() } = {}) {
  if (caller.machine) return refuse(403, 'Only Nick, in NEURO, can confirm this — a machine client cannot.', 'machine');
  if (!SURFACES.includes(surface)) return refuse(400, `surface must be one of ${SURFACES.join(', ')}`, 'surface');
  // The kiosk may confirm only as the kiosk, and only with its own credential.
  if ((surface === 'saim-kiosk') !== (caller.attended === 'kiosk')) return refuse(403, 'that surface cannot confirm actions from here', 'surface');
  if (typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(sessionId)) return refuse(400, 'sessionId is required', 'session');
  if (!actionId || typeof payloadHash !== 'string') return refuse(400, 'actionId and payloadHash are required', 'input');

  const pa = require('./prepared-actions');
  const a = pa.get(actionId);
  if (!a) return refuse(404, 'no such prepared action', 'missing');
  if (!HUMAN_ORIGINS[a.origin]) return refuse(403, 'NEURO drafted this — it needs approving in Actions.', 'origin');
  if (!require('./action-registry').isCalendarType(a.actionType)) return refuse(403, 'this kind of action cannot be confirmed directly yet', 'type');
  if (a.status !== 'prepared') return refuse(409, `it is already ${a.status}`, 'status');
  if (Number(version) !== Number(a.version || 1) || payloadHash !== a.payloadHash) {
    return refuse(409, 'This action needs confirming again — it changed since it was shown.', 'changed');
  }

  const nowMs = msOf(now);
  const id = `ig_${crypto.randomBytes(16).toString('hex')}`;
  db.run(`INSERT INTO human_action_intents (id, user_id, action_capability, action_id, action_version, payload_hash, session_id, surface,
            initiated_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [id, USER, a.actionType, a.actionId, Number(a.version || 1), a.payloadHash, sessionId, surface,
    HUMAN_ORIGINS[a.origin], iso(nowMs), iso(nowMs + TTL_MS)]);
  return { ok: true, grantId: id, expiresAt: iso(nowMs + TTL_MS), actionId: a.actionId, version: Number(a.version || 1), payloadHash: a.payloadHash };
}

/**
 * Spend a grant. BURNED before anything is checked, so a double click or a
 * replay gets exactly one try. Must run inside the approval's transaction.
 */
function consume({ grantId, actionId, version, payloadHash, now = Date.now() } = {}) {
  const nowMs = msOf(now);
  const again = 'This action needs confirming again.';
  if (typeof grantId !== 'string') return refuse(403, again, 'missing');
  const g = db.get('SELECT * FROM human_action_intents WHERE id = ?', [grantId]);
  if (!g) return refuse(403, again, 'unknown');
  const burned = db.run(`UPDATE human_action_intents SET consumed_at = ?, outcome = 'pending' WHERE id = ? AND consumed_at IS NULL`, [iso(nowMs), grantId]);
  if (!burned.changes) return refuse(409, 'That confirmation has already been used.', 'used');
  const finish = (outcome) => db.run('UPDATE human_action_intents SET outcome = ? WHERE id = ?', [outcome, grantId]);
  if (Date.parse(g.expires_at) <= nowMs) { finish('expired'); return refuse(403, `${again} (it expired)`, 'expired'); }
  if (g.action_id !== actionId || Number(g.action_version) !== Number(version) || g.payload_hash !== payloadHash) {
    finish('mismatch');
    return refuse(409, `${again} (it changed since it was shown)`, 'mismatch');
  }
  finish('executed');
  return { ok: true, grant: { id: g.id, initiatedBy: g.initiated_by, surface: g.surface, sessionId: g.session_id } };
}

function get(grantId) { return db.get('SELECT * FROM human_action_intents WHERE id = ?', [grantId]) || null; }
function forAction(actionId) { return db.all('SELECT * FROM human_action_intents WHERE action_id = ? ORDER BY created_at', [actionId]); }

module.exports = { TTL_MS, SURFACES, MECHANISM, HUMAN_ORIGINS, initiatedByFor, callerOf, mint, consume, get, forAction };
