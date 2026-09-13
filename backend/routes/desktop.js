'use strict';

/**
 * /api/desktop — where the Windows reporter posts what the laptop is doing.
 *
 * ⚠ The reporter sends the FOREGROUND PROCESS NAME and nothing else. Never a
 * window title, never a path, never a URL. See the header of
 * services/desktop-activity.js for why that line matters on this machine
 * specifically — and note the service sanitises again on the way in, so a
 * careless future reporter is truncated here rather than trusted.
 *
 * Machine client: authenticated by the app-level NEURO_API_TOKEN header like
 * n8n and the other scheduled callers, not by the PIN.
 */

const express = require('express');
const router = express.Router();
const desktop = require('../services/desktop-activity');

// POST /api/desktop/activity — one sample, or a batch after the laptop wakes.
router.post('/activity', (req, res) => {
  try {
    const body = req.body || {};
    const batch = Array.isArray(body.samples) ? body.samples : [body];
    if (!batch.length) return res.status(400).json({ error: 'no samples' });
    // A reporter catching up after a sleep can post a backlog, but not an
    // unbounded one — a runaway client must not be able to fill agent_state.
    if (batch.length > 60) return res.status(400).json({ error: 'at most 60 samples per call' });

    const stored = batch.map(s => desktop.record(s));

    // ⚠ THE PULL. The agent is outbound-only and stays that way: anything it
    // should do comes back on the RESPONSE to a connection it opened itself.
    // Nothing listens on the laptop and nothing on the network can reach it.
    // What travels is an id from a fixed vocabulary — never a path, never an
    // argument — and the agent refuses an unknown one locally before anything
    // runs. A failure here must never cost the sample that was just stored.
    let intents = [];
    try {
      const last = batch[batch.length - 1] || {};
      const host = last.host || null;
      // What this agent says it can act on. Absent = an older agent = nothing
      // is handed over, and the intent waits rather than being eaten.
      const canOpen = Array.isArray(last.canOpen) ? last.canOpen : null;
      intents = require('../services/desk-intents').claim({ host, canOpen }).intents;
    } catch (e) {
      console.warn('[Desktop] could not read desk intents:', e.message);
    }

    res.json({ ok: true, stored: stored.length, sample: stored[stored.length - 1], intents });
  } catch (e) {
    console.error('[Desktop] record failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/desktop/activity — the current read. Read-only, nothing notifies.
router.get('/activity', (req, res) => {
  try {
    const now = new Date();
    res.json({
      run: desktop.run(now),
      present: desktop.present(now),
      // Which machines are reporting, and when each last spoke. Names only — a
      // hostname is not what the privacy line is about, and without this a
      // second machine that quietly stopped reporting is invisible.
      hosts: desktop.hosts(),
      // Deliberately NOT the samples themselves. They are a rolling record of
      // which app was in front of him minute by minute, and there is no reason
      // for a browser to hold that — the derived answer is the useful part.
      sampleCount: desktop.samples().length,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/desktop/daily?days=30 — the kept history, newest first, one row per
// machine per day. Read-only.
//
// ⚠ Rows are NOT summed across machines here or anywhere else: two hosts used in
// the same hour each counted that hour, and the samples needed to take a union
// are long gone. A caller that wants one number per day has to say which machine
// it means.
router.get('/daily', (req, res) => {
  try {
    const daily = require('../services/desktop-daily');
    const days = Math.min(365, Math.max(1, parseInt(req.query.days, 10) || 30));
    const completeOnly = req.query.completeOnly === 'true';
    const host = req.query.host || null;
    const rows = daily.recentDays(days, { completeOnly, host });
    res.json({
      days: rows,
      // What the rollup could see, so an empty list is never mistaken for an
      // empty diary: no rows plus a live agent means the rollup has not run yet.
      hosts: require('../services/desktop-activity').hosts(),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/desktop/daily/sync — roll the live buffer now. The hourly job does
// this; the route exists so a deploy does not have to wait up to an hour to see
// whether the change worked.
router.post('/daily/sync', (req, res) => {
  try {
    res.json(require('../services/desktop-daily').sync());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


// ── Opening something on the laptop ───────────────────────────────────
//
// ⚠ QUEUEING IS A HUMAN ACT AND MUST STAY ONE. This route is reachable from a
//   button and from nothing else — no rule, no scheduler, no model tool calls
//   it. An assistant that could decide on its own to run programs on his work
//   machine is a different product with a different risk.

// POST /api/desktop/intents/claim { host?, canOpen[] } — the agent asking
// whether anything is waiting for it.
//
// ⚠⚠ THIS EXISTS BECAUSE A BUTTON MUST FEEL LIKE A BUTTON. Claiming used to
//   happen ONLY on the back of a full activity sample, and that sample is
//   deliberately infrequent (120s — it answers "what is he doing", which does
//   not need to be asked often). Measured live on 13 Sep 2026, a press took
//   **111 seconds** to open Chrome, and the next one EXPIRED without firing.
//   Tying an interactive request to a background sampler's cadence is the
//   mistake; they are two different questions and now have two cadences.
//
// ⚠ IT RECORDS NOTHING. No sample is stored, so this cannot be used to inject
//   desk activity — which is exactly why the whole `desktop` segment is not a
//   kiosk proxy door, and why this narrow route can be one.
//
// ⚠ `canOpen` IS STILL REQUIRED, unchanged: an agent that does not say what it
//   understands is handed nothing, and the intent waits for one that does
//   rather than being silently eaten.
//
// ⚠ Registered ABOVE `/intents/:id`-shaped routes. They differ by method and
//   by segment count today, so nothing currently shadows it — but a literal
//   path sitting under a parameterised sibling is a bug this repo has shipped
//   before, and the order costs nothing.
router.post('/intents/claim', (req, res) => {
  try {
    const body = req.body || {};
    const canOpen = Array.isArray(body.canOpen) ? body.canOpen : null;
    const out = require('../services/desk-intents').claim({
      host: body.host || null,
      canOpen,
    });
    res.json({ ok: true, intents: out.intents });
  } catch (e) {
    console.error('[Desktop] claim failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/desktop/intents { app, host? } — ask for something to be opened.
router.post('/intents', (req, res) => {
  try {
    const { app, host, why } = req.body || {};

    // ⚠ DEVICE AWARENESS, AS A REFUSAL. If the target machine has SAID what it
    //   can open and this is not on the list, say so NOW. `claim` already
    //   declines to hand it over, which is correct and silent - the request
    //   would simply sit there and expire five minutes later, which from the
    //   button's side is indistinguishable from a laptop that is asleep.
    //
    // ⚠ SILENCE IS NOT A REFUSAL. A machine that has never declared its
    //   capabilities is not one that lacks the program - it is one that has not
    //   been asked yet (an older agent, or a first sample still to arrive), and
    //   refusing on that would break the feature for a machine that works.
    try {
      const target = host || null;
      const caps = require('../services/desktop-activity').capabilities();
      const declared = target ? caps[target] : null;
      if (Array.isArray(declared) && app && !declared.includes(String(app).toLowerCase())) {
        return res.json({
          ok: false,
          reason: `${target} can’t open that`,
        });
      }
    } catch (e) {
      // Never allowed to cost the press. Not knowing falls through to the
      // existing guards, which are the ones that actually keep it safe.
      console.warn('[Desktop] capability check skipped:', e.message);
    }

    res.json(require('../services/desk-intents').queue(app, { host: host || null, why: why || null }));
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/desktop/intents/:id — what happened to it. `waiting` / `claimed` /
// `opened` / `failed` / `expired` are five different facts and stay apart.
router.get('/intents/:id', (req, res) => {
  try {
    res.json(require('../services/desk-intents').status(req.params.id));
  } catch (e) {
    res.status(500).json({ known: false, error: e.message });
  }
});

// POST /api/desktop/intents/:id/done { ok, detail } — the agent reporting back,
// so a surface can say "opened" rather than "sent, hopefully".
router.post('/intents/:id/done', (req, res) => {
  try {
    const { ok, detail } = req.body || {};
    res.json(require('../services/desk-intents').record(req.params.id, ok, detail || null));
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
