'use strict';

/**
 * What SAiM is doing about it — the operational half of the attention feed.
 *
 * The feed says what she READ, what she thinks MATTERS and how CONFIDENT the
 * read is. It never said whether anything was under way. So a request Nick had
 * made ten seconds earlier and a completely idle afternoon produced the same
 * screen, and the only place "in flight" existed at all was a `useState` inside
 * `Surface.jsx` — invisible to the kiosk, to iOS, to the widget, and to the
 * next poll of the phone itself.
 *
 * ── The loop ────────────────────────────────────────────────────────────────
 *   observe → assess → recommend → obtain approval → execute → verify → report
 *
 * ⚠⚠ A REQUEST SENT IS NOT AN ACTION COMPLETED. `executing` says the ask is out,
 *   `verifying` says something took it and has not reported back, and NEITHER
 *   is success. That distinction is the entire product here: it is the
 *   difference between a chief of staff and an optimistic button.
 *
 * ── What this is NOT ────────────────────────────────────────────────────────
 * It is not a second decision engine, and it is not a second opinion about
 * anything. It adds no candidates, re-ranks nothing, hides nothing and writes
 * nothing. Every fact it reports was already resolved by the module that owns
 * it — the pool by `decision-engine`, the quiet by `context-state`, the offers
 * by `rooms`, the requests by `desk-intents`, the deferrals by
 * `attention-lifecycle`. All this does is name which of them is the operative
 * one and compose one sentence about it.
 *
 * PURE. No clock, no storage, no network — the `pi-health.assess()` /
 * `state-of-play.assess()` split, so the ranking pins without a Pi, a database
 * or a house.
 *
 * CommonJS only — NEURO backend convention.
 */

const { labelFor, isActivePhase } = require('../../shared/operation-phase.cjs');

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function firstOf(list) {
  return Array.isArray(list) && list.length ? list[0] : null;
}

/**
 * PURE. The operative phase and one honest sentence about it.
 *
 * @param {object} draft   the payload being assembled — read only
 * @returns {{phase,label,detail,subject,changedAt,confidence,active}}
 */
function composeOperation(draft = {}) {
  const d = isObject(draft) ? draft : {};
  const context = isObject(d.context) ? d.context : {};
  const confidence = (isObject(context.confidence) && context.confidence.level) || null;

  const settle = (phase, { detail = null, subject = null, changedAt = null } = {}) => ({
    phase,
    // ⚠ Composed here and rendered VERBATIM everywhere. A client that builds
    //   its own wording from `phase` is the fourth opinion this whole layer
    //   exists to prevent.
    label: labelFor(phase),
    detail,
    subject,
    changedAt,
    confidence,
    // Carried rather than re-derived, because the rule lives in the shared
    // vocabulary and a renderer inferring it from the phase name is how the
    // two come apart.
    active: isActivePhase(phase),
  });

  // ── 1. Can she see his work at all? ───────────────────────────────────────
  //
  // ⚠ OUTRANKS EVERYTHING, including a request in flight. This is not a status,
  //   it is a warning about how much of the rest of the screen can be believed,
  //   and the codebase ranks that way everywhere else: `state-of-play` puts a
  //   stale cache above big-but-true numbers, and SAiM's own provenance lets a
  //   stale connection outrank the domain roll-up. A request in flight still
  //   says so on its own card; a surface that has gone blind must never look
  //   calm.
  //
  // ⚠ ONLY THE POOL EARNS IT — never the `gaps` array. Gaps are routine (the
  //   house was unreachable, the diary hiccuped) and are ALREADY rendered as
  //   named gaps in their own words. Promoting any of them to a crown-level
  //   UNAVAILABLE would leave that word permanently lit, and a warning that is
  //   always on is one nobody reads — which then costs the reading of the one
  //   that matters. Seven weeks of "partly live" over a healthy kiosk is this
  //   exact mistake, already paid for once.
  if (d.poolAvailable === false) {
    return settle('unavailable', {
      detail: "I can't see what needs your attention, so nothing here is an all-clear.",
    });
  }

  // ── 2. Is something out and unanswered? ───────────────────────────────────
  //
  // ⚠ REQUESTED and TAKEN are different facts and are never merged. "The ask is
  //   out and nobody has picked it up" and "the machine has it and has not said
  //   what happened" send Nick to different places if it goes wrong.
  //
  // ⚠ An UNREADABLE queue reports nothing rather than an empty one — the read
  //   itself says which, and absence of evidence is not evidence of absence.
  const desk = isObject(d.desk) ? d.desk : null;
  if (desk && desk.known === true) {
    const requested = firstOf(desk.requested);
    if (requested) {
      return settle('executing', {
        // ⚠ "asked" and never "opened". The laptop has not answered; claiming
        //   it had is the failure mode named at the top of this file.
        detail: `Asked your laptop to open ${requested.label || requested.app}. It hasn't picked it up yet.`,
        subject: { type: 'desk-intent', id: requested.id, title: requested.label || requested.app },
        changedAt: requested.at || null,
      });
    }
    const taken = firstOf(desk.taken);
    if (taken) {
      return settle('verifying', {
        detail: `Your laptop has taken ${taken.label || taken.app}. Waiting for it to say what happened.`,
        subject: { type: 'desk-intent', id: taken.id, title: taken.label || taken.app },
        changedAt: taken.at || null,
      });
    }
  }

  // ── 3. Is a prepared action waiting on his word? ──────────────────────────
  //
  // A room offer is a WRITE with a physical effect in the house, held back
  // until he says so — `rooms.act()` has exactly one caller and it is an
  // attended press. That is precisely "proposed, awaiting authorisation", and
  // it is the one such thing already on this payload.
  //
  // ⚠ THE WORDS ARE THE OFFER'S OWN. `rooms` composed them; rephrasing here
  //   would put two sentences about one light switch on one screen.
  //
  // ⚠ It outranks `quiet`, deliberately. The offer card is ON SCREEN in a
  //   meeting too, and a crown reading QUIET above a control asking for one
  //   word would be the two halves of the screen disagreeing.
  const rooms = isObject(d.rooms) ? d.rooms : null;
  const offer = rooms && rooms.known === true ? firstOf(rooms.offers) : null;
  if (offer) {
    return settle('awaiting_authorisation', {
      detail: offer.say || null,
      subject: { type: 'room-offer', id: offer.key || null, title: offer.area || null },
    });
  }

  // ── 4. Is this a moment to stay out of the way? ───────────────────────────
  //
  // ⚠ NO DETAIL. The crown already carries the context label an inch away —
  //   "in a meeting · QUIET" — and repeating why would be the same fact twice.
  //   `covered` is the composer's call, and this is the same rule one field up.
  if (d.quiet === true) return settle('quiet');

  // ── 5. Is something being held for later? ─────────────────────────────────
  //
  // A deferral is a watched trigger with a next check: he said not now, gave a
  // reason, and NEURO will bring it back. Reporting STANDING BY over that would
  // be false — there is something pending, it simply is not pending now.
  //
  // ⚠ The sentence is `shared/deferral-line.cjs`'s, already composed when the
  //   card was held back. A second phrasing of one deferral is how the crown
  //   and the held line come to name different times for it.
  const held = (Array.isArray(d.deferrals) ? d.deferrals : []).filter(isObject);
  if (held.length) {
    const one = held.length === 1 ? held[0] : null;
    return settle('monitoring', {
      detail: one && one.why
        ? one.why
        : `${held.length} things held back until their time comes.`,
      subject: one ? { type: one.type || 'deferred', id: one.id || null, title: one.title || null } : null,
    });
  }

  // ── 6. Nothing pressing, and she could see. ───────────────────────────────
  //
  // ⚠ STANDING BY IS A REAL ANSWER, not a fallback. Most of a calm day is this,
  //   and the one thing it must never do is invent a job to look busy —
  //   `primary: null` has always been a valid result and this must not become
  //   the pressure that changes that.
  //
  // ⚠ No detail, for the reason `quiet` has none: a line that is present for
  //   most of every day is a line nobody reads.
  return settle('standing_by');
}

module.exports = { composeOperation };
