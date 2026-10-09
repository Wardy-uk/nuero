'use strict';

/**
 * Human-approval provenance for A4 actions (Build 7E, 3 Oct 2026).
 *
 * ── The problem ────────────────────────────────────────────────────────────
 *
 * Every NEURO client authenticates with the same PIN: the desktop app, both
 * phone apps, the kiosk's proxy, and the LOCAL MCP server that Claude Code
 * sessions use. So a request carrying the PIN proves only that the caller holds
 * NEURO's credential — never that Nick, a human, pressed anything. Build 6 could
 * refuse the API token (n8n, the remote MCP gateway) but could not tell the
 * local MCP from Nick. Once an approval can send email as him, that is not
 * acceptable.
 *
 * ── The mechanism ──────────────────────────────────────────────────────────
 *
 * An approval needs TWO things no NEURO credential can produce:
 *
 *   1. A CHALLENGE NEURO issued for exactly this action: its id, version and
 *      payload hash. Single-use, five minutes, stored server-side. A replay, a
 *      challenge for a different action or version, or an expired one is
 *      refused — and a challenge is BURNED on its first use, right or wrong.
 *   2. Nick's APPROVAL CODE: a secret he types at the moment of approval. It is
 *      stored only as an scrypt hash, it is set ONLY from a shell on the Pi
 *      (Settings, or scripts/set-approval-code.js on the Pi — since 5 Oct 2026 a
 *      route sets it, but only the FIRST time or with the current code; see
 *      setCodeFromScreen), and no client
 *      stores it: the screen's field is a password input that is cleared after
 *      every use. Five wrong codes in fifteen minutes lock approval for fifteen
 *      minutes (persisted, so a restart does not reset the count).
 *
 * ⚠ What it does NOT trust: the User-Agent, the source address, any header a
 * client can set, or the PIN/API token itself. None of those is evidence of a
 * human.
 *
 * ⚠ The honest boundary: this stops anything that holds only NEURO's API
 * credentials. It does NOT stop something with a shell on pi5 — that can read
 * the database, set a new code, or call Graph directly, and no application-
 * level proof survives it. Setting the code therefore records WHEN it was set,
 * shown on the Actions screen and published as an event, so a change Nick did
 * not make is at least visible.
 */

const crypto = require('crypto');
const db = require('../db/database');

const CODE_KEY = 'approval_code';
const FAIL_KEY = 'approval_code_failures';
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const MAX_FAILURES = 5;
const FAIL_WINDOW_MS = 15 * 60 * 1000;
const LOCKOUT_MS = 15 * 60 * 1000;
const MIN_CODE_LENGTH = 6;
const MAX_CODE_LENGTH = 128;
const MECHANISM = 'approval-code+challenge';
// scrypt cost: ~50ms on the Pi 5. N=2^14, r=8, p=1 is node's default.
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

const msOf = (v) => (v instanceof Date ? v.getTime() : typeof v === 'number' ? v : Date.now());
const iso = (ms) => new Date(ms).toISOString();
const parse = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };

function _ensureTable() {
  db.run(`CREATE TABLE IF NOT EXISTS approval_challenges (
    challenge_id  TEXT PRIMARY KEY,
    action_id     TEXT NOT NULL,
    version       INTEGER NOT NULL,
    payload_hash  TEXT NOT NULL,
    issued_at     TEXT NOT NULL,
    expires_at    TEXT NOT NULL,
    issued_to     TEXT,
    used_at       TEXT,
    used_outcome  TEXT
  )`);
}

// ── the code ────────────────────────────────────────────────────────────────

function _stored() {
  const v = parse(db.getState(CODE_KEY));
  return v && v.hash && v.salt ? v : null;
}

/** Is a code set, and when? Never returns the hash. */
function codeStatus() {
  const v = _stored();
  return { set: !!v, setAt: v ? v.setAt || null : null, minLength: MIN_CODE_LENGTH };
}

function _derive(code, saltHex, p = SCRYPT) {
  return crypto.scryptSync(String(code), Buffer.from(saltHex, 'hex'), p.keylen, { N: p.N, r: p.r, p: p.p, maxmem: 64 * 1024 * 1024 });
}

/**
 * Set (or replace) the approval code. Called by scripts/set-approval-code.js on
 * the Pi and by setCodeFromScreen (the Settings route). Replacing requires the
 * current code.
 */
function setCode(code, { currentCode = null, now = Date.now(), by = 'pi-shell' } = {}) {
  const c = String(code || '');
  if (c.length < MIN_CODE_LENGTH || c.length > MAX_CODE_LENGTH) {
    return { ok: false, error: `the code must be ${MIN_CODE_LENGTH}–${MAX_CODE_LENGTH} characters` };
  }
  const existing = _stored();
  if (existing && !_matches(currentCode, existing)) return { ok: false, error: 'the current code is wrong — replacing a code needs the old one' };
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = _derive(c, salt).toString('hex');
  const nowIso = iso(msOf(now));
  db.setState(CODE_KEY, JSON.stringify({ v: 1, salt, hash, ...SCRYPT, setAt: nowIso, setBy: by }));
  db.setState(FAIL_KEY, '');
  // A new code revokes every trusted device: a token issued against the old
  // code must not outlive it.
  db.setState(DEVICES_KEY, '{}');
  try {
    require('./event-bus').publishEvent({
      type: 'action.approval_code.set', occurredAt: nowIso,
      source: { system: 'neuro', recordId: 'approval-code' },
      subject: { entityType: 'approval-code', entityId: 'nick' },
      idempotencyKey: `approval-code:set:${nowIso}`,
      payload: { setAt: nowIso, replaced: !!existing, by },
    }, { now: msOf(now) });
  } catch (e) { console.warn(`[ApprovalProof] could not record the code change: ${e.message}`); }
  return { ok: true, setAt: nowIso, replaced: !!existing };
}

function _matches(code, stored) {
  if (!stored || typeof code !== 'string' || !code.length || code.length > MAX_CODE_LENGTH) return false;
  const want = Buffer.from(stored.hash, 'hex');
  const got = _derive(code, stored.salt, { N: stored.N || SCRYPT.N, r: stored.r || SCRYPT.r, p: stored.p || SCRYPT.p, keylen: want.length });
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

// ── lockout ─────────────────────────────────────────────────────────────────

function _failures() {
  return parse(db.getState(FAIL_KEY)) || { count: 0, windowStart: null, lockedUntil: null };
}

function lockStatus({ now = Date.now() } = {}) {
  const f = _failures();
  const nowMs = msOf(now);
  const locked = !!(f.lockedUntil && Date.parse(f.lockedUntil) > nowMs);
  return { locked, lockedUntil: locked ? f.lockedUntil : null };
}

function _recordFailure(nowMs) {
  let f = _failures();
  if (!f.windowStart || nowMs - Date.parse(f.windowStart) > FAIL_WINDOW_MS) f = { count: 0, windowStart: iso(nowMs), lockedUntil: null };
  f.count += 1;
  if (f.count >= MAX_FAILURES) f.lockedUntil = iso(nowMs + LOCKOUT_MS);
  db.setState(FAIL_KEY, JSON.stringify(f));
  return f;
}

// ── challenges ──────────────────────────────────────────────────────────────

/**
 * Issue a challenge for the action as it stands NOW. Anyone holding the PIN may
 * ask for one — it is useless without the code.
 */
function issue({ actionId, version, payloadHash, issuedTo = null, now = Date.now() }) {
  _ensureTable();
  if (!codeStatus().set) {
    return { ok: false, code: 409, error: 'No approval code is set, so nothing can be approved yet. Set one in Settings → Approval code.' };
  }
  const nowMs = msOf(now);
  const lock = lockStatus({ now: nowMs });
  if (lock.locked) return { ok: false, code: 429, error: `Too many wrong codes — approval is locked until ${lock.lockedUntil.slice(11, 16)} UTC` };
  const challengeId = `ch_${crypto.randomBytes(16).toString('hex')}`;
  db.run(`INSERT INTO approval_challenges (challenge_id, action_id, version, payload_hash, issued_at, expires_at, issued_to)
          VALUES (?, ?, ?, ?, ?, ?, ?)`, [challengeId, actionId, Number(version) || 1, payloadHash, iso(nowMs), iso(nowMs + CHALLENGE_TTL_MS), issuedTo]);
  return { ok: true, challengeId, expiresAt: iso(nowMs + CHALLENGE_TTL_MS), actionId, version: Number(version) || 1, payloadHash };
}

/**
 * Spend a challenge. Returns { ok: true, proof } or { ok: false, code, error }.
 * The challenge is BURNED before the code is checked, so a replay — including
 * two concurrent requests with the same challenge — gets exactly one try.
 */
function consume({ challengeId, approvalCode, actionId, version, payloadHash, now = Date.now() }) {
  _ensureTable();
  const nowMs = msOf(now);
  const stored = _stored();
  if (!stored) return { ok: false, code: 409, error: 'No approval code is set — set one on the Pi before approving' };
  if (!challengeId || typeof challengeId !== 'string') return { ok: false, code: 403, error: 'an approval needs a challenge from NEURO and your approval code' };
  if (typeof approvalCode !== 'string' || !approvalCode.length) return { ok: false, code: 403, error: 'enter your approval code' };
  const lock = lockStatus({ now: nowMs });
  if (lock.locked) return { ok: false, code: 429, error: `Too many wrong codes — approval is locked until ${lock.lockedUntil.slice(11, 16)} UTC` };

  const ch = db.get('SELECT * FROM approval_challenges WHERE challenge_id = ?', [challengeId]);
  if (!ch) return { ok: false, code: 403, error: 'unknown challenge — ask for a fresh one' };
  if (ch.used_at) return { ok: false, code: 403, error: 'that challenge has already been used — approval challenges are single-use' };

  // Burn it first. One request wins this UPDATE; every other gets nothing.
  const burned = db.run('UPDATE approval_challenges SET used_at = ?, used_outcome = ? WHERE challenge_id = ? AND used_at IS NULL',
    [iso(nowMs), 'pending', challengeId]);
  if (!burned.changes) return { ok: false, code: 403, error: 'that challenge has already been used — approval challenges are single-use' };
  const finish = (outcome) => db.run('UPDATE approval_challenges SET used_outcome = ? WHERE challenge_id = ?', [outcome, challengeId]);

  if (Date.parse(ch.expires_at) <= nowMs) { finish('expired'); return { ok: false, code: 403, error: 'the challenge expired — approve again' }; }
  if (ch.action_id !== actionId || Number(ch.version) !== Number(version) || ch.payload_hash !== payloadHash) {
    finish('mismatch');
    return { ok: false, code: 409, error: 'that challenge was issued for a different action or version of it — reload and approve again' };
  }
  if (!_matches(approvalCode, stored)) {
    const f = _recordFailure(nowMs);
    finish('wrong-code');
    console.warn(`[ApprovalProof] wrong approval code for ${actionId} (${f.count} in this window)`);
    return { ok: false, code: 403, error: f.lockedUntil ? 'Wrong approval code. Too many attempts — approval is locked for 15 minutes.' : 'Wrong approval code.' };
  }
  finish('accepted');
  db.setState(FAIL_KEY, '');
  return { ok: true, proof: { mechanism: MECHANISM, challengeId, actionId, version: Number(version), payloadHash, at: iso(nowMs) } };
}

// ── setting the code from the NEURO screen (5 Oct 2026) ─────────────────────
//
// Nick: "I need to be able to set the approval code via the UI — not direct on
// the Pi." So a ROUTE can now set it, which Build 7 deliberately refused, with
// the guard that keeps it human proof:
//   • FIRST set (no code yet): allowed from the screen. The exposure is the
//     window before Nick sets it — something holding the PIN could set one
//     first. Recorded, shown, and the code he then cannot use tells him.
//   • CHANGE: needs the CURRENT code, with the same wrong-code lockout as an
//     approval, so a PIN holder cannot replace it.
//   • FORGOTTEN: the Pi shell (scripts/set-approval-code.js) stays the only
//     reset, because a reset with no proof is exactly the hole.
// Either way every trusted device is revoked (setCode does it).
function setCodeFromScreen({ newCode, currentCode = null, now = Date.now() } = {}) {
  const nowMs = msOf(now);
  const existing = _stored();
  if (existing) {
    const lock = lockStatus({ now: nowMs });
    if (lock.locked) return { ok: false, code: 429, error: `Too many wrong codes — locked until ${lock.lockedUntil.slice(11, 16)} UTC` };
    if (typeof currentCode !== 'string' || !currentCode.length) return { ok: false, code: 403, error: 'enter your current approval code to change it' };
    if (!_matches(currentCode, existing)) {
      const f = _recordFailure(nowMs);
      console.warn(`[ApprovalProof] wrong current code changing the approval code (${f.count} in this window)`);
      return { ok: false, code: 403, error: f.lockedUntil ? 'Wrong current code. Too many attempts — locked for 15 minutes.' : 'Wrong current code.' };
    }
  }
  const r = setCode(newCode, { currentCode, now: nowMs, by: 'neuro-settings' });
  if (!r.ok) return { ok: false, code: 400, error: r.error };
  return { ok: true, setAt: r.setAt, replaced: r.replaced };
}

// ── trusted devices (5 Oct 2026) ────────────────────────────────────────────
//
// Nick: "need a frictionless way for me to just send stuff" and "I don't want
// to have to keep unlocking it". So the approval code can be typed ONCE on a
// device to trust it; that browser keeps a token and Send is then one click.
//
// ⚠ Still human proof, not a PIN shortcut: a token is only ever issued in
// exchange for the code (same lockout), only its sha256 is stored, and the PIN
// and API token can never produce one — so the MCP server and AI sessions,
// which hold only those, still cannot send. What it does NOT stop is something
// that can read that browser's storage on that machine; the list of trusted
// devices (with last use) and one-click Revoke are the answer to that, and
// changing the approval code on the Pi revokes every device.
//
// ⚠ It approves only what prepared-actions lets it — replies Nick typed
// himself (origin 'composer'). A draft NEURO wrote still needs the code.
const DEVICES_KEY = 'approval_trusted_devices';
const DEVICE_MECHANISM = 'trusted-device';
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

function _devices() {
  const v = parse(db.getState(DEVICES_KEY));
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}
function _saveDevices(d) { db.setState(DEVICES_KEY, JSON.stringify(d)); }

/** Exchange the approval code for a device token. The token is returned ONCE. */
function trustDevice({ approvalCode, label = null, now = Date.now() } = {}) {
  const nowMs = msOf(now);
  const stored = _stored();
  if (!stored) return { ok: false, code: 409, error: 'No approval code is set yet. Set one in Settings → Approval code.' };
  const lock = lockStatus({ now: nowMs });
  if (lock.locked) return { ok: false, code: 429, error: `Too many wrong codes — locked until ${lock.lockedUntil.slice(11, 16)} UTC` };
  if (typeof approvalCode !== 'string' || !approvalCode.length) return { ok: false, code: 403, error: 'enter your approval code' };
  if (!_matches(approvalCode, stored)) {
    const f = _recordFailure(nowMs);
    console.warn(`[ApprovalProof] wrong approval code trusting a device (${f.count} in this window)`);
    return { ok: false, code: 403, error: f.lockedUntil ? 'Wrong approval code. Too many attempts — locked for 15 minutes.' : 'Wrong approval code.' };
  }
  db.setState(FAIL_KEY, '');
  const id = crypto.randomBytes(8).toString('hex');
  const secret = crypto.randomBytes(32).toString('hex');
  const devices = _devices();
  devices[id] = { id, hash: sha(secret), label: String(label || 'this browser').slice(0, 80), createdAt: iso(nowMs), lastUsedAt: null };
  _saveDevices(devices);
  return { ok: true, deviceId: id, token: `sd_${id}.${secret}`, label: devices[id].label };
}

function _deviceFor(token) {
  const m = /^sd_([0-9a-f]{16})\.([0-9a-f]{64})$/.exec(String(token || ''));
  if (!m) return null;
  const d = _devices()[m[1]];
  if (!d || !d.hash) return null;
  const want = Buffer.from(d.hash, 'hex');
  const got = Buffer.from(sha(m[2]), 'hex');
  return got.length === want.length && crypto.timingSafeEqual(got, want) ? d : null;
}

/** Is this token a live trusted device? Never says which part failed. */
function deviceStatus(token) {
  const d = _deviceFor(token);
  return d ? { trusted: true, deviceId: d.id, label: d.label } : { trusted: false };
}

/**
 * Spend a trusted device for one approval. Records an ACCEPTED challenge row
 * for this exact action, version and payload — so the database trigger that
 * refuses an approval without one still holds, and the row says which device.
 */
function consumeDevice({ deviceToken, actionId, version, payloadHash, now = Date.now() }) {
  _ensureTable();
  const nowMs = msOf(now);
  const d = _deviceFor(deviceToken);
  if (!d) return { ok: false, code: 403, error: 'this device is not trusted to send (or was revoked) — enter your approval code' };
  const challengeId = `ch_${crypto.randomBytes(16).toString('hex')}`;
  db.run(`INSERT INTO approval_challenges (challenge_id, action_id, version, payload_hash, issued_at, expires_at, issued_to, used_at, used_outcome)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'accepted')`,
  [challengeId, actionId, Number(version) || 1, payloadHash, iso(nowMs), iso(nowMs), `device:${d.id}`, iso(nowMs)]);
  const devices = _devices();
  if (devices[d.id]) { devices[d.id].lastUsedAt = iso(nowMs); _saveDevices(devices); }
  return { ok: true, proof: { mechanism: DEVICE_MECHANISM, challengeId, actionId, version: Number(version) || 1, payloadHash, at: iso(nowMs), deviceId: d.id } };
}

function listDevices() {
  return Object.values(_devices()).map(({ hash, ...rest }) => rest)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

function revokeDevice(id) {
  const devices = _devices();
  if (!devices[id]) return { ok: false, code: 404, error: 'no such trusted device' };
  delete devices[id];
  _saveDevices(devices);
  return { ok: true, revoked: id };
}

// ── a one-use intent grant (9 Oct 2026) ─────────────────────────────────────
//
// When Nick presses the final button on an action HE started, the grant he
// spent (services/intent-grants.js) is the proof. This records the ACCEPTED
// challenge row the Build 7 trigger requires, issued_to `intent:<grantId>`, so
// the database gate holds on this path too and the row names the grant. Called
// only after intent-grants.consume() has burned and checked the grant, inside
// the same transaction.
const INTENT_MECHANISM = 'intent-grant';
function recordIntentProof({ grantId, actionId, version, payloadHash, now = Date.now() }) {
  _ensureTable();
  if (!grantId || typeof grantId !== 'string') return { ok: false, code: 403, error: 'no intent grant' };
  const nowMs = msOf(now);
  const challengeId = `ch_${crypto.randomBytes(16).toString('hex')}`;
  db.run(`INSERT INTO approval_challenges (challenge_id, action_id, version, payload_hash, issued_at, expires_at, issued_to, used_at, used_outcome)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'accepted')`,
  [challengeId, actionId, Number(version) || 1, payloadHash, iso(nowMs), iso(nowMs), `intent:${grantId}`, iso(nowMs)]);
  return { ok: true, proof: { mechanism: INTENT_MECHANISM, challengeId, actionId, version: Number(version) || 1, payloadHash, at: iso(nowMs), grantId } };
}

function challenge(challengeId) {
  _ensureTable();
  return db.get('SELECT * FROM approval_challenges WHERE challenge_id = ?', [challengeId]) || null;
}

module.exports = {
  MECHANISM, DEVICE_MECHANISM, INTENT_MECHANISM, recordIntentProof, CHALLENGE_TTL_MS, MAX_FAILURES, LOCKOUT_MS, MIN_CODE_LENGTH,
  codeStatus, setCode, issue, consume, lockStatus, challenge, _ensureTable,
  trustDevice, deviceStatus, consumeDevice, listDevices, revokeDevice, setCodeFromScreen,
};
