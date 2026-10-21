'use strict';

/**
 * Which desk apps are worth offering RIGHT NOW (21 Oct 2026). PURE.
 *
 * `work.deskOffer.apps` is what the laptop CAN open — the whole installed
 * catalogue (seventeen chips on Nick's first use: noise). This picks the few
 * that are MATERIALLY relevant to the live situation, from explicit links only:
 *
 *   1. an app SAiM's hand-off names for what leads now (its primary first,
 *      then its alternatives, in the resolver's own order) — the hand-off only
 *      ever names an app from evidence: the meeting's own app, or a device-
 *      reported app state (saim/policy/handoff.cjs);
 *   2. the app actually in front on the laptop (saim-device: a fresh sample).
 *
 * Every pick must also be in `deskOffer.apps` (the laptop can open it). Mere
 * installation is never relevance. No link, an unreadable input, or a laptop
 * NEURO cannot see → [] — the surface then shows no "On the desktop" block at
 * all. Capped (MAX), deterministic. Presentation only: opening still goes
 * through the existing desk-intent route and its own checks.
 */

const MAX = 3;

/** → [{ id, label, why }] */
function relevantApps({ offer = null, handoff = null, device = null, max = MAX } = {}) {
  if (!offer || offer.known !== true || !Array.isArray(offer.apps) || !offer.apps.length) return [];
  const canOpen = new Map(offer.apps.filter((a) => a && a.id).map((a) => [a.id, a]));
  const out = [];
  const add = (id, why) => {
    if (out.length >= max || !id || !canOpen.has(id) || out.some((x) => x.id === id)) return;
    const a = canOpen.get(id);
    out.push({ id, label: a.label, why });
  };
  const h = handoff && handoff.handoff;
  if (h && h.primary) {
    const dests = [h.primary, ...(Array.isArray(h.alternatives) ? h.alternatives : [])];
    dests.forEach((d, i) => {
      const id = d && d.target && d.target.app;
      if (id) add(id, i === 0 ? 'what leads now happens here' : 'another way to do what leads now');
    });
  }
  if (device && device.known === true && Array.isArray(device.apps)) {
    const front = device.apps.find((a) => a && a.foreground === true);
    if (front) add(front.id, 'in front on the laptop now');
  }
  return out;
}

module.exports = { MAX, relevantApps };
