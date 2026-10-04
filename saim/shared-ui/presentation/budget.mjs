// Surface budgets (Build 12C/D/O) — how MUCH of one presentation a surface shows.
//
// NEURO composes ONE presentation intent (`backend/services/presentation-intent.js`):
// what matters, in what order, at what priority. This module is the other half:
// given that intent and what kind of surface is drawing it, which blocks appear
// and how many items each may hold.
//
// ⚠ IT NEVER RANKS. Every list is taken in the order the server sent it and is
//   only ever CUT — `slice`, never `sort`. A budget that re-orders is a second
//   opinion about importance, which is the one thing a renderer may not have.
//   Pinned by a test that feeds reversed lists and expects reversed output.
//
// ⚠ THE PROFILE IS DECLARED BY THE SHELL, never sniffed here. The kiosk shell
//   knows it is a kiosk, Electron knows it is a desktop, the phone app knows it
//   is a phone. Only the viewport CLASS is measured, because a phone PWA opened
//   in a laptop browser is genuinely a wider surface.
//
// PURE: no DOM, no React, no clock. Imported by the shared renderer, by the
// render tests and (mirrored) by the native iOS budget in NeuroKit.

export const PROFILES = {
  // Personal, conversational, scrollable; touch and voice first.
  phone: { id: 'phone', interaction: 'touch', distance: 'near', density: 'standard', inputs: ['touch', 'microphone'] },
  // Glanceable from 1–3 metres. No expectation of touch, minimal reading time.
  kiosk: { id: 'kiosk', interaction: 'ambient', distance: 'room', density: 'ambient', inputs: ['none'] },
  // Richer context and investigation; mouse and keyboard.
  desktop: { id: 'desktop', interaction: 'mouse', distance: 'desk', density: 'standard', inputs: ['keyboard', 'mouse'] },
  // One thing only.
  watch: { id: 'watch', interaction: 'watch', distance: 'near', density: 'compact', inputs: ['touch'] },
};

// Counts per block. 0 = not rendered. 'count' = a one-line count, no items.
// ⚠ Phone context is 5, not 4 (Build 12.1): the activity annotation is drawn as
//   the correction row, not a context line, yet it still takes a slot here — at
//   4 the live Sunday read lost "18° outside" the moment SAiM inferred TV.
export const BUDGETS = {
  phone: { needsYou: 3, primary: 'card', focal: true, next: 2, offers: 2, observations: 2, context: 5, tracked: 'count', details: 'collapsed', correction: 'inline', ask: 'visible', actions: true },
  kiosk: { needsYou: 1, primary: 'line', next: 1, offers: 0, observations: 1, context: 3, tracked: 0, details: 0, correction: 0, ask: 'ambient', actions: false },
  desktop: { needsYou: 5, primary: 'card', next: 5, offers: 3, observations: 4, context: 6, tracked: 'list', details: 'open', correction: 'inline', ask: 'rich', actions: true },
  watch: { needsYou: 1, primary: 'line', next: 0, offers: 0, observations: 0, context: 0, tracked: 0, details: 0, correction: 0, ask: 0, actions: false },
};

/**
 * Which profile a SHELL is. The shell passes what it already knows; only the
 * viewport class is measured. PURE.
 *   platform: 'kiosk' | 'electron' | 'phone-app' | 'browser' | 'watch'
 */
export function profileFor({ platform = 'browser', width = 400 } = {}) {
  if (platform === 'kiosk') return 'kiosk';
  if (platform === 'watch') return 'watch';
  if (platform === 'electron') return 'desktop';
  // A PWA is a phone until it is genuinely wide. 900px, not 700: an iPad in
  // portrait is a big phone, not a desk.
  return width >= 900 ? 'desktop' : 'phone';
}

const take = (list, n) => (Array.isArray(list) ? list.slice(0, Math.max(0, n | 0)) : []);

/**
 * Compose the blocks a surface draws from a presentation. PURE.
 * Returns { profile, mode, blocks: [{ type, items?, overflow?, variant? }] }.
 */
export function composeForSurface(presentation, profileId = 'phone') {
  const pr = presentation || null;
  const profile = BUDGETS[profileId] ? profileId : 'phone';
  const b = { ...BUDGETS[profile] };
  if (!pr) return { profile, mode: null, blocks: [] };
  const mode = pr.mode;

  // ── State adapts the budget (12D). Only ever DOWN: a mode may quieten a
  //    surface; it never shows more than the profile allows. ──
  if (mode === 'needs-attention' && profile === 'kiosk') { b.next = 0; b.observations = 0; b.context = 2; }
  if (mode === 'needs-attention' && profile === 'phone') { b.next = 1; b.observations = 1; b.context = 3; }
  if (mode === 'degraded') { b.next = Math.min(b.next, 1); b.observations = 0; b.correction = 0; if (b.details) b.details = 'open'; }
  if (mode === 'in-meeting') { b.observations = 0; b.correction = 0; b.offers = 0; b.context = Math.min(b.context, 2); }
  if (mode === 'bedtime' && profile === 'kiosk') { b.context = 1; }
  if (mode === 'upcoming' && profile === 'kiosk') { b.context = 2; }

  const about = pr.situation && pr.situation.about;
  const blocks = [];
  blocks.push({
    type: 'situation',
    // The summary is the compact form of whatever item it is about. A surface
    // that ALSO draws that item as an object drops the sentence, not the item.
    variant: profile === 'kiosk' || profile === 'watch' ? 'ambient' : 'editorial',
  });

  // An ambient surface says the one thing that needs him in the situation line
  // itself, so the same item is not repeated as a block beneath it.
  const ambient = profile === 'kiosk' || profile === 'watch';
  const needs = take((pr.needsYou || []).filter((n) => !(ambient && about && n.id === about)), b.needsYou);
  if (needs.length) blocks.push({ type: 'needsYou', items: needs, overflow: Math.max(0, (pr.needsYou || []).length - needs.length) });

  const hasPrimary = Boolean(pr.primary && b.primary === 'card');
  if (hasPrimary) blocks.push({ type: 'primary', items: [pr.primary] });

  // ── The focal object (Build 12.1) ──
  // After the headline there must be ONE thing the eye lands on. Where nothing
  // needs him and nothing is current, that is the next meaningful thing — the
  // one the situation is ABOUT if the server named one, else the first of Next
  // in the server's own order. Chosen, never ranked: `find` and `[0]`, no sort.
  // The summary sentence about it is then dropped (the drawn-as-object rule),
  // so the item is said once — as the object.
  // Phone only: the wall draws Next as one big line already, and the desktop's
  // primary slot is its own AttentionCard.
  let focal = null;
  if (b.focal && !needs.length && !hasPrimary) {
    focal = (about && (pr.next || []).find((n) => n.id === about)) || (pr.next || []).find((n) => !(about && n.id === about)) || null;
  }

  const offers = take(pr.offers, b.offers);
  if (focal) blocks.push({ type: 'focal', items: [focal] });
  if (offers.length) blocks.push({ type: 'offers', items: offers });

  // The situation line already says the item it is about; listing it again
  // underneath is the "same thing three times" bug (8 Sep 2026).
  const nextSrc = (pr.next || []).filter((n) => !(about && n.id === about) && !(focal && n.id === focal.id));
  const next = take(nextSrc, b.next);
  if (next.length) blocks.push({ type: 'next', items: next, overflow: Math.max(0, nextSrc.length - next.length) });

  // Observations: only PROMOTED ones on an ambient surface — an ordinary
  // ambient nudge is a thing to read up close, not across a room.
  const obsSrc = profile === 'kiosk' ? (pr.observations || []).filter((o) => o.promoted) : (pr.observations || []);
  const obs = take(obsSrc, b.observations);
  if (obs.length) blocks.push({ type: 'observations', items: obs });

  const ctx = take(pr.context, b.context);
  if (ctx.length || (b.correction && pr.correction)) {
    blocks.push({ type: 'context', items: ctx, correction: b.correction ? pr.correction || null : null, honesty: pr.situation && pr.situation.honesty });
  }

  if (b.tracked === 'count' && (pr.tracked || []).length) blocks.push({ type: 'tracked', variant: 'count', count: pr.tracked.length, items: [] });
  if (b.tracked === 'list' && (pr.tracked || []).length) blocks.push({ type: 'tracked', variant: 'list', count: pr.tracked.length, items: pr.tracked });

  if (b.details && (pr.details || []).length) blocks.push({ type: 'details', variant: b.details, items: pr.details });

  if (b.ask) blocks.push({ type: 'ask', variant: b.ask, prompt: pr.voicePrompt || null });

  return { profile, mode, actions: !!b.actions, blocks };
}

/**
 * Group the context annotations for display (Build 12.1). PURE.
 *
 * The server sends P3 annotations as a flat list; read as one dot-separated
 * line they look like telemetry. This only ARRANGES them, by the `kind` the
 * server already set — it adds no words, drops nothing it was given and never
 * re-orders within a line:
 *   place     → the group's eyebrow ("Home")
 *   room, weather → one line: where he is and what it is like outside
 *   household → its own line (people are not a reading)
 *   sleep     → its own line
 *   activity  → NOT here: it is the correction row's subject
 *   anything else → its own line, in the order it arrived
 */
export function groupContext(items) {
  const list = Array.isArray(items) ? items : [];
  const placeItem = list.find((c) => c.kind === 'place') || null;
  const activity = list.find((c) => c.kind === 'activity') || null;
  const lines = [];
  const surroundings = list.filter((c) => c.kind === 'room' || c.kind === 'weather');
  if (surroundings.length) lines.push({ id: 'surroundings', items: surroundings });
  for (const c of list) {
    if (['place', 'activity', 'room', 'weather'].includes(c.kind)) continue;
    lines.push({ id: c.id, items: [c] });
  }
  return { place: placeItem ? placeItem.label : null, lines, activity };
}

/** Block types a profile may NEVER draw, whatever the mode. Pinned by tests. */
export const FORBIDDEN = {
  kiosk: ['details', 'tracked', 'primary', 'focal'],
  watch: ['details', 'tracked', 'primary', 'focal', 'next', 'context', 'ask'],
};
