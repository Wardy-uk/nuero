'use strict';

/**
 * Build 12.3 — situation synthesis, the P0 digest and the notification policy.
 * PURE: fixtures in, contract out. The real HTTP/DB path is
 * routes/build123-needs-you-routing.test.js.
 *
 * Numbers in test names follow the Build 12.3 test list in the build record.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { composePresentation } = require('./presentation-intent');
const { synthesise, THEME_TYPES } = require('./situation-synthesis');
const policy = require('./notification-policy');
const setup = require('./setup-check');
const { FIXTURES } = require('../../shared/presentation-fixtures.cjs');

// 4 Oct 2026, 18:00 BST — a Sunday evening, as the live screen was read.
const NOW = Date.parse('2026-10-04T17:00:00Z');

function sunday(extra = {}) {
  return {
    poolAvailable: true,
    surface: 'off-duty',
    context: { activity: 'off', duty: { onDuty: false, reason: 'weekend' }, confidence: { level: 'high' } },
    life: {
      doing: 'watching-tv', label: 'Watching TV', confidence: 'medium',
      place: { kind: 'home', label: 'living room' },
      household: { othersHome: true, who: ['Helen', 'Isaac'] },
    },
    agenda: { known: true, events: [{ id: 'ev-hike', subject: 'Hiking', start: '2026-10-10T00:00:00', end: '2026-10-10T23:59:00', allDay: true }] },
    rooms: { known: true, considered: [{ area: 'Living Room', temperature: { known: true, reading: { currentC: 20 } } }] },
    weather: { known: true, tempC: 17 },
    lastNight: { known: true, asleepHours: 10.53, usualLine: 'usually 8h29 on a Sunday', notable: false },
    readiness: { known: true, status: 'ok', score: 66, label: 'Elevated', hrv: 10.7, baselineMs: 20, deviation: -0.9, baselineDays: 14, caveats: [], notable: true },
    gaps: [],
    ...extra,
  };
}

const compose = (p) => composePresentation(p, { now: NOW });
const allText = (syn) => syn.themes.flatMap((t) => [t.label, t.headline, t.summary, ...(t.lines || [])]).filter(Boolean).join(' \n ');

// ── 12.3A/B — grouping ──────────────────────────────────────────────────────

test('1. a quiet Sunday synthesises into schedule, recovery and home themes, in that order', () => {
  const out = compose(sunday());
  assert.equal(out.mode, 'off-duty');
  const syn = out.synthesis;
  assert.equal(syn.contract, 'synthesis-v1');
  assert.deepEqual(syn.themes.map((t) => t.type), ['schedule', 'recovery', 'presence']);
  const [sched, rec, home] = syn.themes;
  assert.equal(sched.label, 'Saturday');
  assert.equal(sched.headline, 'Hiking');
  assert.equal(home.headline, 'You’re home.');
  assert.deepEqual(home.lines, ['Helen and Isaac are home too.']);
  assert.equal(rec.headline, 'Lower than usual');
  assert.equal(rec.summary, 'HRV 10.7ms vs 20 baseline');
  // The situation is the presentation's, copied — never re-derived.
  assert.equal(syn.situation.headline, out.situation.headline);
  assert.equal(syn.situation.summary, out.situation.summary);
});

test('1b. every theme carries evidence refs and an evidence list the renderer can open', () => {
  const syn = compose(sunday()).synthesis;
  for (const t of syn.themes) {
    assert.ok(t.evidenceRefs.length > 0, t.type);
    assert.equal(t.evidence.length, t.evidenceRefs.length, t.type);
    assert.ok(['high', 'medium', 'low'].includes(t.confidence), t.type);
    assert.ok(THEME_TYPES.includes(t.type), t.type);
  }
});

test('1c. ordinary telemetry is HIDDEN with its ref, never drawn and never thrown away', () => {
  const syn = compose(sunday()).synthesis;
  const refs = syn.hidden.map((h) => h.ref);
  assert.ok(refs.includes('context:room'), 'an ordinary room temperature is hidden');
  assert.ok(refs.includes('context:weather'), 'the outside temperature is hidden');
  assert.ok(!/20°|17°/.test(allText(syn)), 'no raw temperature reaches a theme');
});

test('1d. `covered` names what a DRAWN theme says — the rest stays drawable (10 Oct 2026)', () => {
  const out = compose(sunday());
  const syn = out.synthesis;
  const covered = new Set(syn.covered);
  // The schedule theme says the hike, recovery says the night, presence says who is home.
  assert.ok(covered.has('sleep'));
  assert.ok(covered.has('household'));
  assert.ok(covered.has('place'));
  assert.ok(syn.themes.some((t) => t.itemRef && covered.has(t.itemRef)));
  // The room and the weather are NOT in any theme, so a renderer must still draw them.
  assert.ok(!covered.has('room'));
  assert.ok(!covered.has('weather'));
  const drawable = out.context.filter((c) => !covered.has(c.id)).map((c) => c.id);
  assert.ok(drawable.includes('room') && drawable.includes('weather'), drawable.join(','));
});

test('1e. a theme CUT by the budget covers nothing — its facts are not lost with it', () => {
  // A P0 shrinks the themes to one; presence is cut, so who is home must stay drawable.
  const out = compose(sunday({
    approvals: { known: true, needsApproval: 1, needsReview: 0, say: 'The weekly report is ready for your approval.', where: 'Actions, in NEURO on the desktop', newestAt: '2026-10-04T16:00:00Z' },
  }));
  const syn = out.synthesis;
  assert.equal(syn.themes.length, 1);
  assert.ok(!syn.themes.some((t) => t.type === 'presence'), 'precondition: presence was cut');
  assert.ok(!syn.covered.includes('household'), 'a cut presence theme must not swallow the household line');
  assert.ok(syn.hidden.some((h) => h.ref === 'context:household'));
});

// ── 12.3C — health ──────────────────────────────────────────────────────────

test('2. health telemetry is hidden when the brain did not call it notable', () => {
  const p = sunday({ readiness: { ...sunday().readiness, label: 'Balanced', notable: false } });
  const syn = compose(p).synthesis;
  assert.ok(!syn.themes.some((t) => t.type === 'recovery'), 'no recovery theme on a Balanced day');
  const hid = syn.hidden.find((h) => h.ref === 'readiness');
  assert.ok(hid, 'the reading is kept behind "why"');
  assert.equal(hid.why, 'on his usual baseline');
  // Positive control: the same payload with notable:true does produce it.
  assert.ok(compose(sunday()).synthesis.themes.some((t) => t.type === 'recovery'));
});

test('3. a promoted health read becomes a recovery theme, with the night folded under it', () => {
  const rec = compose(sunday()).synthesis.themes.find((t) => t.type === 'recovery');
  assert.deepEqual(rec.lines, ['Slept 10h32 — usually 8h29 on a Sunday']);
  assert.ok(rec.evidenceRefs.includes('readiness') && rec.evidenceRefs.includes('sleep'));
  assert.equal(rec.confidence, 'medium', 'a wrist read against a baseline is never high');
});

test('3b. HRV ABOVE baseline says higher, not lower — the sign is the service’s, not a guess', () => {
  const p = sunday({ readiness: { ...sunday().readiness, label: 'Low', deviation: 1.2, hrv: 31 } });
  assert.equal(compose(p).synthesis.themes.find((t) => t.type === 'recovery').headline, 'Higher than usual');
});

test('3c. a notable NIGHT alone (readiness ordinary) is a "Last night" theme', () => {
  const p = sunday({
    readiness: { ...sunday().readiness, label: 'Balanced', notable: false },
    lastNight: { known: true, asleepHours: 4.2, usualLine: 'usually 8h29 on a Sunday', notable: true },
  });
  const rec = compose(p).synthesis.themes.find((t) => t.type === 'recovery');
  assert.equal(rec.label, 'Last night');
  assert.equal(rec.headline, 'Slept 4h12');
});

test('3d. stress-score caveats travel with the theme verbatim', () => {
  const caveat = 'Heart rate is well above resting — if you have just been active, this reads high.';
  const p = sunday({ readiness: { ...sunday().readiness, caveats: [caveat] } });
  assert.ok(compose(p).synthesis.themes.find((t) => t.type === 'recovery').lines.includes(caveat));
});

test('4. no theme across any fixture diagnoses, advises or claims a cause', () => {
  const forbidden = /\b(ill|sick|illness|rest up|take it easy|you should|should|because|due to|recover by|train|workout|caused)\b/i;
  const payloads = [sunday(), ...Object.values(FIXTURES).map((f) => f.payload || f)];
  for (const p of payloads) {
    const syn = compose(p).synthesis;
    assert.ok(!forbidden.test(allText(syn)), allText(syn));
  }
});

// ── 12.3A — P0 outranks themes ──────────────────────────────────────────────

test('5. when something needs him, the themes shrink to one', () => {
  const p = sunday({
    approvals: { known: true, needsApproval: 1, needsReview: 0, say: 'The weekly report is ready for your approval.', where: 'Actions, in NEURO on the desktop', newestAt: '2026-10-04T16:00:00Z' },
  });
  const out = compose(p);
  assert.equal(out.mode, 'needs-attention');
  assert.equal(out.synthesis.themes.length, 1);
  // Positive control: without the approval there are three.
  assert.equal(compose(sunday()).synthesis.themes.length, 3);
});

test('6. theme order is semantic: a promoted (P2) home theme rises above nothing it should not, a P3 one sits last', () => {
  // Without readiness the home theme is P3 and must come after the P2 schedule.
  const base = sunday({ readiness: { known: false, notable: false } });
  assert.deepEqual(compose(base).synthesis.themes.map((t) => t.type), ['schedule', 'presence']);
  // A promoted room makes home P2; it still follows schedule by the fixed type order.
  const cold = sunday({ readiness: { known: false, notable: false },
    rooms: { known: true, considered: [{ area: 'Living Room', temperature: { known: true, reading: { currentC: 11 } } }] } });
  const themes = compose(cold).synthesis.themes;
  assert.deepEqual(themes.map((t) => [t.type, t.priority]), [['schedule', 'P2'], ['presence', 'P2']]);
  assert.ok(themes[1].lines.some((l) => /Living Room is 11°/.test(l)));
});

test('6b. the item the situation is ABOUT is not themed again (said once)', () => {
  const bed = Object.values(FIXTURES).map((x) => x.payload || x).find((p) => p.life && p.life.doing === 'winding-down');
  const out = compose(bed);
  assert.ok(out.situation.about, 'fixture has an about');
  assert.ok(out.next.some((n) => n.id === out.situation.about), 'positive control: the about item is in Next');
  assert.ok(!out.synthesis.themes.some((t) => t.itemRef === out.situation.about));
});

test('11. a degraded read gets ONE theme, the degraded one — never an all-clear', () => {
  const out = compose(sunday({ poolAvailable: false }));
  assert.equal(out.mode, 'degraded');
  assert.deepEqual(out.synthesis.themes.map((t) => t.type), ['degraded']);
  assert.equal(out.p0.known, false, 'a blind digest is not a known zero');
  assert.ok(!/all clear|nothing needs you/i.test(allText(out.synthesis)));
});

// ── 12.3F–H — the P0 digest and the policy ──────────────────────────────────

test('8. the digest counts P0 only — P1/P2 never enter it', () => {
  const p = sunday({
    primary: { kind: 'item', id: 'email-urgent', type: 'email', title: 'Reply to Simon', urgency: 'high', recordId: 'r-email' },
    secondary: [{ kind: 'item', id: 'todo-x', type: 'todo', title: 'Overdue thing', urgency: 'medium' }],
  });
  const out = compose(p);
  assert.equal(out.primary.priority, 'P1');
  assert.equal(out.p0.count, 0);
  assert.deepEqual(out.p0.items, []);
});

test('8a. the digest itself refuses a non-P0 entry (its own guard, not only the composer’s)', () => {
  const d = policy.p0Digest([
    { item: { id: 'a', priority: 'P1', title: 'not urgent' }, card: { type: 'escalation', urgency: 'high' } },
    { item: { id: 'b', priority: 'P0', title: 'urgent', kind: 'approval', count: 1 }, card: null },
    { item: { id: 'b', priority: 'P0', title: 'urgent', kind: 'approval', count: 1 }, card: null },
  ]);
  assert.deepEqual(d.items.map((i) => i.id), ['b'], 'P1 excluded, duplicate folded');
  assert.equal(d.count, 1);
});

test('8b. a critical escalation is P0, counted once, eligible, keyed on its ticket set', () => {
  const card = { kind: 'item', id: 'escalations-unseen', type: 'escalation', title: 'NT-1 — Broken thing', urgency: 'critical',
    recordId: 'rec-esc', firstSeenAt: '2026-10-04T15:00:00Z', meta: { escalations: [{ key: 'NT-2' }, { key: 'NT-1' }] } };
  const out = compose(sunday({ primary: card }));
  assert.equal(out.p0.count, 1);
  const it = out.p0.items[0];
  assert.equal(it.kind, 'escalation');
  assert.equal(it.since, '2026-10-04T15:00:00Z');
  assert.equal(it.notification.eligible, true);
  assert.deepEqual(it.notification.channels, ['native-local']);
  assert.equal(it.notification.dedupeKey, 'escalation:NT-1,NT-2', 'sorted, so ticket order cannot mint a new key');
  assert.equal(it.notification.existingSender, 'web-push escalation_alert (PWA)');
});

test('8c. an imminent meeting and the pre-11 standup ARE P0 (they need him) but are NOT notified — their own channels already do', () => {
  for (const type of ['meeting', 'nudge']) {
    const out = compose(sunday({ primary: { kind: 'item', id: `x-${type}`, type, title: 't', urgency: 'critical', recordId: `r-${type}` } }));
    assert.equal(out.p0.count, 1, type);
    assert.equal(out.p0.items[0].notification.eligible, false, type);
    assert.ok(out.p0.items[0].notification.existingSender, type);
  }
});

test('8d. approvals: the digest counts the drafts, keyed on the newest so a new draft is news and a poll is not', () => {
  const ap = { known: true, needsApproval: 2, needsReview: 0, say: '2 drafts', where: 'Actions', newestAt: '2026-10-04T16:00:00Z' };
  const a = compose(sunday({ approvals: ap })).p0;
  assert.equal(a.count, 2);
  assert.equal(a.items[0].notification.dedupeKey, 'approvals:2026-10-04T16:00:00Z');
  const b = compose(sunday({ approvals: { ...ap, newestAt: '2026-10-04T16:30:00Z' } })).p0;
  assert.notEqual(b.items[0].notification.dedupeKey, a.items[0].notification.dedupeKey);
});

test('19. urgent email is NOT eligible on any subject wording — no keyword shortcut exists', () => {
  for (const title of ['URGENT: invoice', 'urgent urgent urgent', 'ASAP please']) {
    // As P0 (firefighting lifts a high card to P0) — the policy still refuses.
    const p = sunday({ context: { ...sunday().context, activity: 'firefighting' },
      primary: { kind: 'item', id: 'email-urgent', type: 'email', title, urgency: 'high', recordId: 'r1' } });
    const it = compose(p).p0.items[0];
    assert.equal(it.notification.eligible, false, title);
  }
  // The DECIDING functions never read a title or subject (p0Digest copies the
  // title for display, which decides nothing).
  const deciding = [policy.policyFor, policy.kindOf, policy.dedupeKeyFor].map((f) => f.toString()).join('\n');
  assert.ok(/urgency/.test(deciding), 'positive control: the scan sees the real source');
  assert.ok(!/\.title|subject|urgent\//i.test(deciding.replace(/^\s*(\/\/|\*).*$/gm, '')));
});

test('19b. a CRITICAL email card (only the synthetic fixture produces one) is eligible', () => {
  const card = { kind: 'item', id: 'synthetic-email-1', type: 'email', title: 'Test — synthetic urgent email', urgency: 'critical',
    recordId: 'r-s', meta: { synthetic: true, syntheticId: 'abc' } };
  const it = compose(sunday({ primary: card })).p0.items[0];
  assert.equal(it.notification.eligible, true);
  assert.equal(it.notification.synthetic, true);
  assert.equal(it.notification.dedupeKey, 'synthetic:abc:email:r-s');
  assert.equal(it.notification.ttl, 900);
});

test('policy: nothing below P0 is ever eligible, and an unknown kind is counted but never buzzed', () => {
  assert.equal(policy.policyFor({ id: 'x', priority: 'P1' }, { type: 'escalation', urgency: 'critical' }).eligible, false);
  const u = policy.policyFor({ id: 'x', priority: 'P0' }, { type: 'plan', urgency: 'critical', recordId: 'r' });
  assert.equal(u.eligible, false);
  assert.match(u.reason, /never buzzed/);
});

// ── 12.3U — setup only proves what was observed ─────────────────────────────

function setupSnap(extra = {}) {
  return { microsoft: { configured: true, authenticated: true }, vault: true, ai: true, vapid: true, apns: false,
    approvalCode: true, sendingEnabled: false, sources: [], desktopHosts: [], reports: [], clients: {},
    containers: 0, unclassified: 0, goals: 0, companions: 0, ...extra };
}
const item = (out, id) => out.items.find((i) => i.id === id);

test('20/21. with no APNs key the watch alert item SAYS alerts are local and slow — and is not done without proof', () => {
  const out = setup.assess(setupSnap(), { now: NOW });
  const it = item(out, 'watch.alerts-proven');
  assert.equal(it.status, 'todo');
  assert.match(it.why, /Remote push is unavailable/);
  assert.match(it.why, /minutes to hours, not seconds/);
  assert.equal(item(out, 'watch.complication').status, 'unknown', 'only the watch can see its faces');
});

test('25. an ACCEPTED synthetic alert is not proof; only an OPENED one is', () => {
  const accepted = { dedupeKey: 'synthetic:a:escalation:TEST-a', deviceId: 'iphone', outcome: 'accepted', acceptedAt: '2026-10-04T16:50:00Z', synthetic: true };
  const a = item(setup.assess(setupSnap({ watchLastSynthetic: accepted }), { now: NOW }), 'watch.alerts-proven');
  assert.equal(a.status, 'attention');
  assert.match(a.evidence, /never opened — not proven/);
  const opened = { ...accepted, openedAt: '2026-10-04T16:55:00Z' };
  const b = item(setup.assess(setupSnap({ watchProof: opened, watchLastSynthetic: opened }), { now: NOW }), 'watch.alerts-proven');
  assert.equal(b.status, 'done');
});

test('25b. the watch report decides the complication item; a stale report decides nothing', () => {
  const report = { platform: 'watchos', app: 'saim', host: 'Nick’s Watch', at: '2026-10-04T16:00:00Z',
    checks: [{ id: 'signed-in', ok: true }, { id: 'complication-on-face', ok: true, detail: 'Modular' }, { id: 'presentation-read', ok: true }] };
  const fresh = setup.assess(setupSnap({ reports: [report] }), { now: NOW });
  assert.equal(item(fresh, 'watch.complication').status, 'done');
  assert.equal(item(fresh, 'watch.app').status, 'done');
  const old = setup.assess(setupSnap({ reports: [{ ...report, at: '2026-09-01T00:00:00Z' }] }), { now: NOW });
  assert.equal(item(old, 'watch.complication').status, 'unknown');
});
