'use strict';

/**
 * The P0 notification ledger (Build 12.3N) — one semantic urgent item, one
 * notification, per device.
 *
 * The phone posts P0 notifications locally (there is no APNs key, so NEURO
 * cannot push to it). Its own on-device memory of what it already said resets
 * on reinstall and is invisible to everything else, so the AUTHORITY on "has
 * this already been said on this device" lives here, keyed on the policy's
 * `dedupeKey`:
 *
 *   claim   — the device asks before posting. First claim wins; every later
 *             one (a second poll, a reconnect, a restart, a replayed source)
 *             is refused with what already happened.
 *   accepted / failed — what iOS said when the post was added. A FAILED post
 *             releases the claim so the next wake can try again: a key is spent
 *             only on something that could have arrived (the burned-key rule
 *             from Notifications.swift).
 *   opened  — he tapped it. The only event that proves a human saw it.
 *   dismissed — iOS reported a dismissal (only when the category asks for it).
 *
 * ⚠ "ACCEPTED" IS NOT "DELIVERED TO HIS WRIST". `UNUserNotificationCenter.add`
 *   succeeding means iOS took it; whether iOS mirrored it to the watch is not
 *   observable from either app. Nothing here, and nothing reading this, may
 *   call an accepted row delivered.
 */

const EVENTS = ['accepted', 'failed', 'opened', 'dismissed'];
const CHANNELS = ['native-local'];
const MAX_KEY = 200;

function _db() { return require('../db/database'); }

function _clean(s, n) { return typeof s === 'string' && s.trim() ? s.trim().slice(0, n) : null; }

function _row(key, device, channel) {
  return _db().get('SELECT * FROM attention_notifications WHERE dedupe_key = ? AND device_id = ? AND channel = ?', [key, device, channel]);
}

function _shape(r) {
  if (!r) return null;
  return {
    dedupeKey: r.dedupe_key, deviceId: r.device_id, channel: r.channel, itemId: r.item_id,
    synthetic: r.synthetic === 1, outcome: r.outcome,
    claimedAt: r.claimed_at, acceptedAt: r.accepted_at, failedAt: r.failed_at,
    openedAt: r.opened_at, dismissedAt: r.dismissed_at, detail: r.detail || null,
  };
}

function _validate({ dedupeKey, deviceId, channel = 'native-local' }) {
  const key = _clean(dedupeKey, MAX_KEY);
  const device = _clean(deviceId, 80);
  if (!key) throw Object.assign(new Error('dedupeKey is required'), { status: 400 });
  if (!device) throw Object.assign(new Error('deviceId is required'), { status: 400 });
  if (!CHANNELS.includes(channel)) throw Object.assign(new Error(`channel must be one of ${CHANNELS.join(', ')}`), { status: 400 });
  return { key, device, channel };
}

/**
 * Claim the right to post. Synchronous from read to write — better-sqlite3 in
 * one process, so two polls cannot both win (plaud-admin-blocks' rule).
 */
function claim(body, { now = Date.now() } = {}) {
  const { key, device, channel } = _validate(body || {});
  const at = new Date(now).toISOString();
  const existing = _row(key, device, channel);
  if (existing && existing.outcome !== 'failed') return { claim: false, already: _shape(existing) };
  if (existing) {
    _db().run(`UPDATE attention_notifications SET outcome = 'claimed', claimed_at = ?, failed_at = NULL, detail = NULL
               WHERE dedupe_key = ? AND device_id = ? AND channel = ?`, [at, key, device, channel]);
  } else {
    _db().run(`INSERT INTO attention_notifications (dedupe_key, device_id, channel, item_id, synthetic, outcome, claimed_at)
               VALUES (?, ?, ?, ?, ?, 'claimed', ?)`,
    [key, device, channel, _clean(body.itemId, 120), body.synthetic === true ? 1 : 0, at]);
  }
  return { claim: true, row: _shape(_row(key, device, channel)) };
}

function record(body, { now = Date.now() } = {}) {
  const { key, device, channel } = _validate(body || {});
  const event = body.event;
  if (!EVENTS.includes(event)) throw Object.assign(new Error(`event must be one of ${EVENTS.join(', ')}`), { status: 400 });
  const existing = _row(key, device, channel);
  if (!existing) throw Object.assign(new Error('no claim for that key on that device'), { status: 404 });
  const at = new Date(now).toISOString();
  const detail = _clean(body.detail, 200);
  const col = { accepted: 'accepted_at', failed: 'failed_at', opened: 'opened_at', dismissed: 'dismissed_at' }[event];
  // `opened`/`dismissed` never downgrade an outcome; `failed` releases the claim.
  const outcome = event === 'accepted' ? 'accepted' : event === 'failed' ? 'failed'
    : existing.outcome === 'claimed' ? 'accepted' : existing.outcome;
  _db().run(`UPDATE attention_notifications SET ${col} = COALESCE(${col}, ?), outcome = ?, detail = COALESCE(?, detail)
             WHERE dedupe_key = ? AND device_id = ? AND channel = ?`, [at, outcome, detail, key, device, channel]);
  return _shape(_row(key, device, channel));
}

function recent({ limit = 20 } = {}) {
  try {
    return _db().all('SELECT * FROM attention_notifications ORDER BY claimed_at DESC LIMIT ?', [Math.max(1, Math.min(100, limit))]).map(_shape);
  } catch { return []; }
}

/** The newest synthetic notification that was OPENED — the only end-to-end proof. */
function lastProvenSynthetic() {
  try {
    return _shape(_db().get(`SELECT * FROM attention_notifications WHERE synthetic = 1 AND opened_at IS NOT NULL
                             ORDER BY opened_at DESC LIMIT 1`));
  } catch { return null; }
}

module.exports = { EVENTS, CHANNELS, claim, record, recent, lastProvenSynthetic };
