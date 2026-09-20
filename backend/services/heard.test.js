'use strict';

/**
 * Saying a sentence she offered does what tapping it does.
 *
 * SAiM's principle is that everything she can do is achievable conversationally.
 * Until this the sentences could only be TAPPED — saying "not now" streamed a
 * chat answer ABOUT deferring rather than deferring anything, so the tap path
 * and the spoken path were two vocabularies and only one of them worked.
 *
 * ⚠ The rules being pinned are all refusals. A matcher that guesses spends a
 * deferral, a dismissal or a completion on a coin toss, out loud, on the card
 * in front of him — which is far worse than a question he has to repeat.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { normaliseSaid, matchSaid, STOP_PHRASES } = require('../../shared/heard.cjs');
const surface = require('./saim-surface');
const { phrasesFor } = surface._internals;

function card(actions, extra = {}) {
  return {
    context: { activity: 'steady' },
    primary: { kind: 'item', recordId: 'r1', title: 'Ship the thing', actions, tab: 'tasks', ...extra },
    secondary: [], poolAvailable: true, gaps: [],
  };
}

const offered = (payload) => surface.compose(payload).utterances;

// ── Dictation is lossy, and the normaliser is what absorbs that ─────────────

test('apostrophes, case and punctuation do not decide whether a command lands', () => {
  // ⚠ The composed sentences use CURLY apostrophes and iOS dictation emits
  //   straight ones — matching on the raw string would make "that's done" work
  //   on one device and not the other.
  const forms = ['That’s done', "That's done", 'thats done', 'Thats  done.', 'THATS DONE'];
  const seen = new Set(forms.map(normaliseSaid));
  assert.equal(seen.size, 1, [...seen].join(' | '));
});

test('nothing said is nothing matched', () => {
  assert.equal(matchSaid('', offered(card(['defer']))), null);
  assert.equal(matchSaid('   ', offered(card(['defer']))), null);
  assert.equal(matchSaid(null, offered(card(['defer']))), null);
});

// ── A sentence read off the screen works ────────────────────────────────────

test('reading a sentence off the shelf and saying it back does what tapping it does', () => {
  const list = offered(card(['defer', 'complete']));
  for (const u of list) {
    const hit = matchSaid(u.say, list);
    assert.ok(hit, `"${u.say}" is sayable`);
    assert.equal(hit.kind, 'utterance');
    assert.equal(hit.utterance.say, u.say, 'and it lands on its own sentence, not a neighbour');
  }
});

test('the natural shorthand lands on the right verb', () => {
  const list = offered(card(['defer', 'complete', 'acknowledge', 'dismiss']));
  const heard = (said) => {
    const m = matchSaid(said, list);
    return m && m.kind === 'utterance' ? m.utterance.intent : null;
  };
  assert.deepEqual(
    { action: heard('not now').action, reason: heard('not now').reason },
    { action: 'defer', reason: 'not-now' },
  );
  assert.equal(heard('too big').reason, 'too-big');
  assert.equal(heard('seen it').action, 'acknowledge');
  assert.equal(heard('open it').kind, 'navigate');
  assert.equal(heard('everything').kind, 'reveal');
});

// ── The refusals ────────────────────────────────────────────────────────────

test('⚠ a sentence NOT on offer cannot be reached by saying it', () => {
  // The list is bounded by what `attention-lifecycle` allows on that card — an
  // escalation is deliberately not dismissable — so a verb NEURO would refuse
  // must be no more reachable by voice than by tap.
  const list = offered(card(['defer'])); // no complete, no dismiss
  assert.equal(matchSaid('thats done', list), null);
  assert.equal(matchSaid('not mine', list), null);
  // ⚠ And the one that IS allowed still works, so this is not passing by the
  //   matcher being broken.
  assert.ok(matchSaid('not now', list));
});

test('⚠ AMBIGUITY IS REFUSED, never guessed', () => {
  // Two sentences claiming one phrase is the composer's bug to fix. Guessing
  // between them here would hide it while acting on the card in front of him.
  const list = [
    { say: 'A', intent: { kind: 'act', action: 'complete' }, phrases: ['done'] },
    { say: 'B', intent: { kind: 'session', action: 'finish' }, phrases: ['done'] },
  ];
  assert.equal(matchSaid('done', list), null);
});

test('⚠ an ordinary question is NOT a failed command — it falls through', () => {
  // null means "this was not a command", and the caller must then ask the brain.
  // Treating it as a failure would make every question report an error.
  const list = offered(card(['defer', 'complete']));
  assert.equal(matchSaid('what have I got on this afternoon', list), null);
  assert.equal(matchSaid('is it going to rain', list), null);
});

test('⚠ an `ask` sentence gets its own words and no shorthand', () => {
  // A question routed through the matcher would be answered from a cached
  // payload instead of being put to the brain.
  const u = { say: 'What have I got on?', intent: { kind: 'ask', text: 'What have I got on today?' } };
  assert.deepEqual(phrasesFor(u), ['What have I got on?']);
});

test('⚠⚠ "do it" is NOT a command, and that is deliberate', () => {
  // It should mean "perform the prepared action awaiting your word" — and on a
  // working surface the offered verbs are open / not-now / done / seen /
  // dismiss, none of which IS that action. The only genuinely prepared,
  // held-back write on the payload is a ROOM OFFER, which has no utterance at
  // all. Guessing would spend a real verb on a coin toss.
  for (const list of [offered(card(['defer', 'complete', 'acknowledge', 'dismiss'])), offered(card(['defer']))]) {
    assert.equal(matchSaid('do it', list), null);
    assert.equal(matchSaid('go ahead', list), null);
    assert.equal(matchSaid('yes', list), null);
  }
});

// ── Stop ────────────────────────────────────────────────────────────────────

test('"stop" is a CONTROL, not a sentence on the shelf', () => {
  // It is an interruption — a button for a state that lasts four seconds is
  // furniture. It cancels speech; it does not claim to recall a write already
  // sent, which is the "a request sent is not an action completed" rule
  // pointed backwards.
  const list = offered(card(['defer']));
  for (const said of STOP_PHRASES) {
    const m = matchSaid(said, list);
    assert.equal(m && m.control, 'stop', said);
  }
  assert.ok(!list.some((u) => u.phrases.includes('stop')), 'and it is on no shelf');
});

// ── The composer attaches them at all ───────────────────────────────────────

test('every offered sentence carries its own phrases', () => {
  // A payload field with no reader is this codebase's most common failure; a
  // field with no WRITER on some branch is the same bug earlier. Each dashboard
  // composes its own list, so this walks several.
  const payloads = [
    card(['defer', 'complete']),
    { context: { activity: 'in-meeting' }, quiet: true, meeting: { key: 'm1' }, primary: null, secondary: [], poolAvailable: true, gaps: [] },
    { context: { activity: 'unknown' }, primary: null, secondary: [], poolAvailable: false, gaps: [] },
    { context: { activity: 'off' }, primary: null, secondary: [], poolAvailable: true, gaps: [] },
  ];
  let total = 0;
  for (const p of payloads) {
    const list = surface.compose(p).utterances;
    assert.ok(list.length, 'a surface always offers something');
    for (const u of list) {
      assert.ok(Array.isArray(u.phrases) && u.phrases.length, `${u.say} has phrases`);
      assert.ok(u.phrases.includes(u.say), `${u.say} is sayable as written`);
      total += 1;
    }
  }
  assert.ok(total >= 8, `positive control: walked ${total} sentences`);
});

test('the escape hatch is sayable, on every surface', () => {
  // ⚠ NON-NEGOTIABLE. The one screen with no menu must always have a way round
  //   it, and that has to be true out loud as well as under a thumb.
  for (const p of [card(['defer']), { context: { activity: 'steady' }, primary: null, secondary: [], poolAvailable: true, gaps: [] }]) {
    const list = surface.compose(p).utterances;
    const m = matchSaid('show me everything', list);
    assert.equal(m && m.utterance.intent.kind, 'reveal');
  }
});
