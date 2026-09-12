'use strict';

/**
 * Where should this go?
 *
 * `resolve()` is pure, so what is under test is the product: which endpoint
 * wins, and — the half that matters — what it refuses to do rather than
 * finding somewhere to put the message.
 *
 * ⚠ The rule worth breaking the suite over is the AUDIENCE gate. The obvious
 * model is "send it to the nearest device", and it is wrong in the one
 * direction that cannot be undone: the kiosk and the living-room TV are in a
 * family room, so "nearest" routes a colleague's name and a customer's ticket
 * to whoever is on the sofa. Private content never lands on a shared endpoint,
 * and when no private one is reachable it REFUSES rather than downgrading.
 *
 * The endpoints below are the real ones as measured on 12 Sep 2026:
 * media_player.living_room (Apple TV, shared), the Pi 4 kiosk + satellite
 * (shared), notify.mobile_app_nicks_iphone (private), the desktop browser
 * (private). There is no HomePod in Home Assistant and the laptop agent is
 * outbound-only, so neither can be reached.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const ep = require('./endpoints');

const KIOSK = { id: 'kiosk', label: 'Living room screen', capabilities: ['speak', 'show', 'listen', 'notify'], room: 'living-room', audience: 'shared', reachable: true };
const TV = { id: 'tv', label: 'Living room TV', capabilities: ['play', 'speak'], room: 'living-room', audience: 'shared', reachable: true };
const PHONE = { id: 'phone', label: 'iPhone', capabilities: ['notify', 'show', 'play'], room: null, audience: 'private', reachable: true };
const DESKTOP = { id: 'desktop', label: 'Laptop browser', capabilities: ['show', 'notify'], room: 'office', audience: 'private', reachable: true };
const ALL = [KIOSK, TV, PHONE, DESKTOP];

const inLivingRoom = { room: 'living-room', known: true, quiet: false, onDuty: true, inMeeting: false, atDesk: false };
const atDesk = { room: 'office', known: true, quiet: false, onDuty: true, inMeeting: false, atDesk: true };

// ── The audience gate ────────────────────────────────────────────────────────

test('⚠ private content NEVER goes to a shared endpoint, even the nearest one', () => {
  // He is standing in the living room. The kiosk is right there and can speak.
  const r = ep.resolve({ capability: 'speak', privacy: 'private', endpoints: ALL, context: inLivingRoom });
  assert.equal(r.endpoint, null, 'the only speakers here are shared');
  assert.match(r.why, /shared with the household/);
  assert.ok(r.refused.some(x => x.id === 'kiosk'));
});

test('⚠ it REFUSES rather than downgrading to a shared endpoint', () => {
  const r = ep.resolve({ capability: 'speak', privacy: 'private', endpoints: [KIOSK, TV], context: inLivingRoom });
  assert.equal(r.endpoint, null);
  // Saying it where everyone can hear is worse than not saying it.
  assert.equal(r.alternatives.length, 0);
});

test('ambient content is happy on a shared endpoint in the room he is in', () => {
  const r = ep.resolve({ capability: 'speak', privacy: 'ambient', endpoints: ALL, context: inLivingRoom });
  assert.equal(r.endpoint.id, 'kiosk');
  assert.match(r.why, /you are in the living-room/);
});

test('⚠ an UNSTATED privacy defaults to private, never to broadcast', () => {
  const r = ep.resolve({ capability: 'speak', endpoints: ALL, context: inLivingRoom });
  assert.equal(r.endpoint, null, 'forgetting to say is not permission to say it aloud');
});

test('private NOTIFICATIONS still work in a shared room — the phone is his', () => {
  const r = ep.resolve({ capability: 'notify', privacy: 'private', endpoints: ALL, context: inLivingRoom });
  assert.equal(r.endpoint.audience, 'private');
  assert.equal(r.endpoint.id, 'phone');
});

// ── Where he actually is ─────────────────────────────────────────────────────

test('the desk wins for a screen when he is at it', () => {
  const r = ep.resolve({ capability: 'show', privacy: 'private', endpoints: ALL, context: atDesk });
  assert.equal(r.endpoint.id, 'desktop');
  assert.match(r.why, /at the laptop/);
});

test('⚠ the phone is the FALLBACK, never the winner over a device he is at', () => {
  // A buzz in his pocket while he is looking at a screen is the worse choice.
  const r = ep.resolve({ capability: 'show', privacy: 'private', endpoints: ALL, context: atDesk });
  assert.notEqual(r.endpoint.id, 'phone');
  assert.ok(r.alternatives.some(a => a.id === 'phone'), 'but it is offered as the alternative');
});

test('the phone wins when he is nowhere identifiable', () => {
  const r = ep.resolve({ capability: 'notify', privacy: 'private', endpoints: ALL, context: { known: false } });
  assert.equal(r.endpoint.id, 'phone');
  assert.match(r.why, /follows you/);
});

test('⚠ not knowing where he is is a GAP, not an error', () => {
  const r = ep.resolve({ capability: 'notify', privacy: 'private', endpoints: ALL, context: { known: false } });
  assert.ok(r.endpoint, 'it still answers');
  assert.ok(r.gaps.some(g => /do not know which room/.test(g)), 'and says the answer is weaker');
});

// ── The situation ────────────────────────────────────────────────────────────

test('⚠ being in a meeting silences speech entirely, urgent or not', () => {
  const ctx = { ...inLivingRoom, inMeeting: true };
  for (const urgent of [false, true]) {
    const r = ep.resolve({ capability: 'speak', privacy: 'ambient', endpoints: ALL, context: ctx, urgent });
    assert.equal(r.endpoint, null, 'urgent=' + urgent);
    assert.match(r.why, /in a meeting/);
  }
});

test('a meeting does not stop a NOTIFICATION — it is quiet', () => {
  const r = ep.resolve({ capability: 'notify', privacy: 'private', endpoints: ALL, context: { ...inLivingRoom, inMeeting: true } });
  assert.ok(r.endpoint);
});

test('quiet hours silence speech, and urgent overrides that one', () => {
  const ctx = { ...inLivingRoom, quiet: true };
  assert.equal(ep.resolve({ capability: 'speak', privacy: 'ambient', endpoints: ALL, context: ctx }).endpoint, null);
  assert.ok(ep.resolve({ capability: 'speak', privacy: 'ambient', endpoints: ALL, context: ctx, urgent: true }).endpoint);
});

// ── Reachability ─────────────────────────────────────────────────────────────

test('⚠ an unreachable endpoint is NAMED, never silently swapped', () => {
  const deadTv = { ...TV, reachable: false, why: 'the Apple TV is asleep' };
  const r = ep.resolve({ capability: 'play', privacy: 'ambient', endpoints: [deadTv, PHONE], context: inLivingRoom });
  assert.equal(r.endpoint.id, 'phone', 'it still finds somewhere');
  assert.ok(r.refused.some(x => x.id === 'tv' && /asleep/.test(x.why)), 'and says what it could not use');
});

test('nothing reachable at all says so', () => {
  const r = ep.resolve({ capability: 'play', privacy: 'ambient', endpoints: [{ ...TV, reachable: false }], context: inLivingRoom });
  assert.equal(r.endpoint, null);
  assert.match(r.why, /reachable/);
});

test('⚠ a capability nothing has is its own answer, not a crash', () => {
  // There is no HomePod and the laptop agent cannot be told to launch anything,
  // so "play, privately" has nowhere to go today. That must read as a stated
  // fact rather than as a broken feature.
  const r = ep.resolve({ capability: 'play', privacy: 'private', endpoints: [KIOSK, TV, DESKTOP], context: inLivingRoom });
  assert.equal(r.endpoint, null);
  assert.ok(r.why.length > 0);
});

test('an unknown capability is refused by name', () => {
  const r = ep.resolve({ capability: 'teleport', endpoints: ALL, context: inLivingRoom });
  assert.equal(r.endpoint, null);
  assert.match(r.why, /unknown capability/);
});

test('no endpoints configured is a gap, not an exception', () => {
  const r = ep.resolve({ capability: 'notify', endpoints: [], context: inLivingRoom });
  assert.equal(r.endpoint, null);
  assert.ok(r.gaps.length > 0);
});

// ── Fanning out ──────────────────────────────────────────────────────────────

test('⚠ resolveAll is STILL audience-gated — urgency is not a licence to broadcast', () => {
  const r = ep.resolveAll({ capability: 'speak', privacy: 'private', endpoints: ALL, context: inLivingRoom, urgent: true });
  assert.deepEqual(r.endpoints, [], 'critical work detail still does not go to the family room');
});

test('room matching survives case and punctuation', () => {
  assert.equal(ep.sameRoom('Living Room', 'living-room'), true);
  assert.equal(ep.sameRoom('office', 'Office'), true);
  assert.equal(ep.sameRoom('', ''), false, 'two unknowns are not the same room');
});

// ── Classifying a push subscription ──────────────────────────────────────────
//
// ⚠ A subscription IS a device, and some devices are shared. The living-room
// kiosk is a browser like any other and can hold one; a notification reading a
// colleague's name lands on a screen the household can read. Measured 12 Sep
// 2026: exactly one subscription exists and it is an Apple endpoint, so nothing
// is leaking — this exists so that subscribing from the kiosk cannot quietly
// start leaking.

test('an explicitly labelled kiosk is SHARED, and the label beats the host', () => {
  // An Apple push endpoint on a shared iPad is still a shared device.
  const r = ep.classifyPushEndpoint('https://web.push.apple.com/x', 'kiosk');
  assert.equal(r.audience, 'shared');
  assert.equal(r.confidence, 'stated');
});

test('a labelled phone or desktop is private', () => {
  assert.equal(ep.classifyPushEndpoint('https://any', 'phone').audience, 'private');
  assert.equal(ep.classifyPushEndpoint('https://any', 'desktop').audience, 'private');
});

test('⚠ an Apple endpoint is INFERRED private, never asserted', () => {
  // It names the push SERVICE, not the device — an iPad on a worktop is shared.
  const r = ep.classifyPushEndpoint('https://web.push.apple.com/QPY_mmv93xk');
  assert.equal(r.audience, 'private');
  assert.equal(r.confidence, 'inferred', 'the uncertainty travels with the answer');
});

test('⚠ an unlabelled subscription is treated as private AND flagged unknown', () => {
  // Treated as private so it still works — refusing would silence the only
  // subscription that exists. Flagged so the gap stays visible.
  const r = ep.classifyPushEndpoint('https://fcm.googleapis.com/fcm/send/abc');
  assert.equal(r.audience, 'private');
  assert.equal(r.confidence, 'unknown');
  assert.match(r.why, /counted/);
});

test('an unreadable endpoint does not throw', () => {
  for (const bad of [null, undefined, '', 'not a url', 42]) {
    assert.equal(ep.classifyPushEndpoint(bad).audience, 'private');
  }
});

test('⚠ an unknown label falls back to inference rather than being trusted', () => {
  const r = ep.classifyPushEndpoint('https://web.push.apple.com/x', 'toaster');
  assert.equal(r.confidence, 'inferred', 'a label nobody recognises is not a statement');
});
