'use strict';

/**
 * NEURO's /api authentication, moved out of server.js verbatim (Build 14C) so a
 * test can drive the REAL middleware with the authority guard behind it rather
 * than a replica of it. Mounted by server.js on `/api`; behaviour unchanged
 * apart from the kiosk token added in the same build.
 */

function apiAuth(req, res, next) {
  const expectedPin = process.env.NEURO_PIN;
  const expectedApiToken = process.env.NEURO_API_TOKEN;
  if (!expectedPin && !expectedApiToken) return next(); // no auth configured = open access

  // Allow auth check endpoint without PIN
  if (req.path === '/auth/check' || req.path === '/auth/login') return next();

  // Allow push subscription endpoint (service worker can't send custom headers)
  if (req.path.startsWith('/push/')) return next();

  // Allow SSE streams (nudges/stream) — they use EventSource which can't set headers
  if (req.path === '/nudges/stream') return next();


  // The capture door. ⚠ Tailscale Funnel is ON, so this exemption publishes the
  // route to the PUBLIC INTERNET, not merely to the tailnet — which is the
  // intent: Nick's wife has no PIN and no tailnet, and giving her the PIN would
  // hand over the whole brain. The link token in the path is the entire
  // credential, so routes/capture-link.js is write-only and returns nothing
  // about Nick's day; a leaked link can add a personal task and nothing else.
  //
  // ⚠ ONLY /api/c is exempt. Creating and revoking links lives on
  // /api/capture-links, which stays behind the PIN — one letter apart on
  // purpose, and `startsWith('/c/')` rather than `startsWith('/c')` so the
  // admin mount cannot be reached through this branch by prefix.
  if (req.path.startsWith('/c/')) return next();

  // VESTA — the shared home surface (vesta.nickward.co.uk). Same reasoning as
  // /api/c above and the same credential system (capture-links accounts, PINs,
  // throttle, sessions), but it READS as well as writes, which is a real step up
  // in blast radius: his partner sees shared tasks, the kitchen, and his diary.
  //
  // ⚠ So every read is gated on a per-account SCOPE that DEFAULTS CLOSED, and
  // the calendar is redacted in services/vesta.js before it reaches the route —
  // a work subject never enters routes/vesta.js at all.
  //
  // ⚠ `/v/` not `/v`, so the prefix cannot reach anything else — and note it
  // sits one letter from `/v1/` (the FreeReps health wire, exempted below for
  // an entirely different reason). Same care as /c/ versus /capture-links.
  if (req.path.startsWith('/v/')) return next();

  // Allow the FreeReps iOS app's wire API (#40). Same reason as the exemptions
  // above — the client cannot send a header. This one is not a limitation of the
  // browser but of the app: its config model has no credential field at all, so
  // there is nothing to send. The routes enforce their own guard (tailnet source
  // only) and can write to exactly one table. See routes/apple-health.js.
  if (req.path.startsWith('/v1/')) return next();

  const providedPin = req.headers['x-neuro-pin'] || req.query.pin;
  const providedApiToken = req.headers['x-neuro-api-token'] || req.query.api_token;

  // Build 14C: the living-room kiosk's own credential. It forwards what a
  // PERSON at that screen pressed, so it is an attended surface — NOT a machine
  // client — and the authority guard below treats it as one. Distinct from the
  // API token so an agent holding that token cannot borrow the room's authority.
  const expectedKioskToken = process.env.NEURO_KIOSK_TOKEN;
  const providedKioskToken = req.headers['x-neuro-kiosk-token'];
  if (expectedKioskToken && providedKioskToken && expectedKioskToken !== expectedApiToken
      && providedKioskToken === expectedKioskToken) {
    req.attendedSurface = 'kiosk';
    return next();
  }

  if (expectedApiToken && providedApiToken && providedApiToken === expectedApiToken) {
    // Machine client authenticated — tag the request so routes can enforce
    // API-only mode or audit which caller wrote.
    req.apiClient = 'n8n';
    return next();
  }

  if (expectedPin && providedPin && providedPin === expectedPin) {
    return next();
  }

  return res.status(401).json({ error: 'Authentication required' });
}

module.exports = apiAuth;
