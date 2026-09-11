const express = require('express');
const router = express.Router();

const neuroChat = require('../integrations/neuroChat');
const neuroConfig = require('../integrations/neuroConfig');

async function postJson(path, body) {
  const availability = neuroChat.getAvailability();
  if (!availability.available) {
    return { ok: false, status: 503, error: availability.detail || 'NEURO bridge not configured' };
  }

  const res = await fetch(neuroChat.buildUrl(availability.config.baseUrl, path), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...neuroConfig.authHeaders(),
    },
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(5000),
  });

  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      error: payload.error || payload.detail || `HTTP ${res.status}`,
    };
  }

  return { ok: true, status: res.status, payload };
}

// ⚠ `GET /` (the pending-action list), `POST /:id/approve` and `POST /:id/reject`
// USED TO LIVE HERE, and they were the hole in this backend's whole safety model
// (found 11 Sep 2026). `neuroProxy.js` is an allowlist that refuses `/api/actions`
// precisely because approving a queued action SENDS EMAIL AS NICK, books meetings
// with real attendees and chases direct reports — and this router was mounted
// AHEAD of it, forwarding approve/reject to NEURO with SARA's own credential. On a
// server bound to 0.0.0.0 with no auth of its own, that put "send this email" in
// reach of anything on the tailnet. The GET listed every pending action,
// drafted email bodies included. No screen called any of the three; they are gone
// rather than guarded, because an unused door with a credential behind it is how
// this happened. Approving stays on NEURO's desktop Actions panel, behind the PIN.

// The LEGACY suppression path, kept for one job only: a card the kiosk cannot
// resolve to a canonical attention record. `saraState` tries the record first
// and says out loud when it has fallen back here, because the engine's
// suppression is a TIMER and cannot express "seen it" or "this is finished".
router.post('/focus/dismiss', async (req, res) => {
  const itemId = String(req.body?.itemId || '').trim();
  if (!itemId) return res.status(400).json({ ok: false, error: 'itemId is required' });

  try {
    const result = await postJson('/api/focus/dismiss', {
      itemId,
      itemType: req.body?.itemType || null,
    });
    if (!result.ok) return res.status(result.status).json({ ok: false, error: result.error });
    return res.json({ ok: true });
  } catch (error) {
    return res.status(502).json({ ok: false, error: error.message });
  }
});

// ⚠ `POST /focus/done` USED TO LIVE HERE and proxied `/api/focus/action-done`.
//
// That route calls `nextActionEngine.logOutcome()` AND `engine.dismiss()`, so
// the kiosk's "Done" button recorded work as a completed outcome and hid the
// card — and it never closed the underlying task, so the work stayed open with
// its only reminder suppressed. It is the same bug the desktop carried, one
// surface along, and it is gone rather than fixed in place: completion belongs
// to the attention lifecycle, which knows what a card is about and can say
// whether a task was actually closed.
//
// The replacement is `POST /api/attention/records/:id/act` with
// `action: 'complete'` — see `src/routes/attention.js`.


module.exports = router;
