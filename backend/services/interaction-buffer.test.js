'use strict';

/**
 * `shared/interaction-buffer.cjs` — what counts as an interaction, and how it
 * gets off the client.
 *
 * This is the half of the heatmap that can be wrong without anything failing:
 * a selector that is too broad turns "interacted with" into "was on screen",
 * and a flush that loses its buffer under-reports in silence. Both are pinned
 * here rather than discovered on the grid months later.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const ib = require('../../shared/interaction-buffer.cjs');

/** A node-like with the `closest` the real code uses. `matches` is the chain. */
function node(chain) {
  return {
    closest(sel) {
      const wanted = sel.split(',').map(s => s.trim());
      for (const entry of chain) {
        if (wanted.includes(entry)) return { tag: entry };
      }
      return null;
    },
  };
}

// ── What counts ─────────────────────────────────────────────────────────────

test('a control is an interaction', () => {
  for (const control of ['button', 'a[href]', 'input', 'select', 'textarea', 'label', 'summary']) {
    assert.ok(ib.isControlUse(node([control])), `${control} should count`);
  }
  for (const role of ['[role="button"]', '[role="tab"]', '[role="checkbox"]', '[role="switch"]']) {
    assert.ok(ib.isControlUse(node([role])), `${role} should count`);
  }
});

test('⚠ clicking prose is NOT an interaction — that is reading', () => {
  assert.equal(ib.isControlUse(node(['p'])), false);
  assert.equal(ib.isControlUse(node(['div', 'section'])), false);
  assert.equal(ib.isControlUse(node([])), false);
});

test('⚠ a click on the text INSIDE a button counts as the button', () => {
  // `closest` walks up, which is why a <span> label inside a control is not
  // lost — the common case in this codebase's cards.
  assert.ok(ib.isControlUse(node(['span', 'button', 'div'])));
});

test('⚠ a target it cannot read is NOT counted — not knowing is not a reason to count', () => {
  assert.equal(ib.isControlUse(null), false);
  assert.equal(ib.isControlUse({}), false);
  assert.equal(ib.isControlUse({ closest() { throw new Error('detached'); } }), false);
});

test('⚠ the selector does not include a bare link or a generic clickable', () => {
  // `a` without href is an anchor, not a control; `[onclick]` would drag in
  // every card in this codebase that is clickable to expand, which is reading.
  assert.equal(ib.isControlUse(node(['a'])), false);
  assert.equal(ib.isControlUse(node(['[onclick]'])), false);
});

// ── The buffer ──────────────────────────────────────────────────────────────

function collector() {
  const sent = [];
  return { sent, send: async (p) => { sent.push(p); } };
}

test('clicks coalesce per screen and flush as a count', async () => {
  const c = collector();
  const b = ib.createInteractionBuffer({ send: c.send, surface: 'neuro', flushMs: 10_000 });
  b.count('todos'); b.count('todos'); b.count('todos');
  b.count('briefing');
  await b.flush();
  b.stop();

  assert.equal(c.sent.length, 2, 'one request per screen, not one per click');
  const todos = c.sent.find(p => p.tab === 'todos');
  assert.equal(todos.count, 3);
  assert.equal(todos.surface, 'neuro');
  assert.equal(c.sent.find(p => p.tab === 'briefing').count, 1);
});

test('⚠ the buffer is keyed by SCREEN, so a flush spanning a navigation attributes correctly', () => {
  // Attributing clicks made on Tasks to whatever is on screen when the timer
  // fires would be worse than not measuring at all.
  const c = collector();
  const b = ib.createInteractionBuffer({ send: c.send, surface: 'saim', flushMs: 10_000 });
  b.count('tasks', 4);
  b.count('chat', 2);
  b.stop();
  assert.equal(b.pendingTotal(), 6);
});

test('⚠ a FAILED flush keeps the count — the next one carries it', async () => {
  let fail = true;
  const sent = [];
  const b = ib.createInteractionBuffer({
    surface: 'neuro', flushMs: 10_000,
    send: async (p) => { if (fail) throw new Error('offline'); sent.push(p); },
  });
  b.count('todos', 5);

  const first = await b.flush();
  assert.equal(first.failed, true);
  assert.match(first.reason, /offline/);
  assert.equal(b.pendingTotal(), 5, 'the clicks were NOT thrown away');

  fail = false;
  const second = await b.flush();
  b.stop();
  assert.equal(second.sent, 5);
  assert.equal(sent[0].count, 5);
  assert.equal(b.pendingTotal(), 0);
});

test('⚠ a click made DURING a flush is not lost to the clear', async () => {
  // The buffer is cleared BEFORE the send and restored on failure; without
  // that ordering a click landing mid-request would be wiped by the clear
  // afterwards — the read-modify-write trap, on exactly the slow network where
  // it matters most.
  const b = ib.createInteractionBuffer({
    surface: 'neuro', flushMs: 10_000,
    send: async () => { b.count('todos', 1); },
  });
  b.count('todos', 2);
  await b.flush();
  b.stop();
  assert.equal(b.pendingTotal(), 1, 'the click made during the send survived');
});

test('an empty buffer sends nothing at all', async () => {
  const c = collector();
  const b = ib.createInteractionBuffer({ send: c.send, surface: 'neuro', flushMs: 10_000 });
  const out = await b.flush();
  b.stop();
  assert.equal(out.sent, 0);
  assert.equal(c.sent.length, 0);
});

test('⚠ a runaway count is clamped, so one row cannot flatten the whole grid', () => {
  const b = ib.createInteractionBuffer({ send: async () => {}, surface: 'neuro', flushMs: 10_000 });
  for (let i = 0; i < ib.MAX_PER_FLUSH + 250; i++) b.count('todos');
  b.stop();
  assert.equal(b.pendingTotal(), ib.MAX_PER_FLUSH);
});

test('a screenless count is ignored rather than stored under undefined', () => {
  const b = ib.createInteractionBuffer({ send: async () => {}, surface: 'neuro', flushMs: 10_000 });
  b.count(null);
  b.count('');
  b.stop();
  assert.equal(b.pendingTotal(), 0);
});

// ── The listener ────────────────────────────────────────────────────────────

function fakeDoc() {
  const handlers = {};
  return {
    visibilityState: 'visible',
    addEventListener: (t, fn) => { (handlers[t] ||= []).push(fn); },
    removeEventListener: (t, fn) => { handlers[t] = (handlers[t] || []).filter(h => h !== fn); },
    fire: (t, e) => (handlers[t] || []).forEach(h => h(e)),
    count: (t) => (handlers[t] || []).length,
  };
}

test('⚠ a click OUTSIDE the content area is not counted — leaving is not working', () => {
  // Counting nav clicks would give every screen a free interaction on the way
  // out, so the busiest rows would be the ones he navigated away from most.
  const b = ib.createInteractionBuffer({ send: async () => {}, surface: 'neuro', flushMs: 10_000 });
  const doc = fakeDoc();
  const detach = ib.attachInteractionListener({
    scope: '.main-panel', getTab: () => 'todos', buffer: b, root: doc,
  });

  doc.fire('click', { target: node(['button', '.sidebar']) });
  assert.equal(b.pendingTotal(), 0, 'a sidebar button is navigation');

  doc.fire('click', { target: node(['button', '.main-panel']) });
  assert.equal(b.pendingTotal(), 1, 'positive control — a button in the content area counts');

  detach();
  b.stop();
});

test('⚠ it listens for click AND change, but NEVER input', () => {
  // `input` fires per keystroke, so a text box would win the grid outright.
  const doc = fakeDoc();
  const b = ib.createInteractionBuffer({ send: async () => {}, surface: 'neuro', flushMs: 10_000 });
  const detach = ib.attachInteractionListener({ scope: null, getTab: () => 'x', buffer: b, root: doc });

  assert.equal(doc.count('click'), 1);
  assert.equal(doc.count('change'), 1);
  assert.equal(doc.count('input'), 0, 'per-keystroke events must not be counted');

  detach();
  b.stop();
});

test('⚠ the tab is read at EVENT time, never closed over', () => {
  // A stale capture would attribute every click to whichever screen was
  // mounted when the listener was attached.
  const doc = fakeDoc();
  const b = ib.createInteractionBuffer({ send: async () => {}, surface: 'neuro', flushMs: 10_000 });
  let tab = 'todos';
  const detach = ib.attachInteractionListener({ scope: null, getTab: () => tab, buffer: b, root: doc });

  doc.fire('click', { target: node(['button']) });
  tab = 'briefing';
  doc.fire('click', { target: node(['button']) });

  assert.equal(b.pendingTotal(), 2);
  detach();
  b.stop();
});

test('detaching removes every listener it added', () => {
  const doc = fakeDoc();
  const b = ib.createInteractionBuffer({ send: async () => {}, surface: 'neuro', flushMs: 10_000 });
  const detach = ib.attachInteractionListener({ scope: null, getTab: () => 'x', buffer: b, root: doc });
  detach();
  assert.equal(doc.count('click'), 0);
  assert.equal(doc.count('change'), 0);
  assert.equal(doc.count('visibilitychange'), 0);
});

test('going hidden flushes with keepalive, so a backgrounded app does not lose its buffer', async () => {
  const c = collector();
  const doc = fakeDoc();
  const b = ib.createInteractionBuffer({ send: c.send, surface: 'saim', flushMs: 10_000 });
  const detach = ib.attachInteractionListener({ scope: null, getTab: () => 'chat', buffer: b, root: doc });

  doc.fire('click', { target: node(['button']) });
  doc.visibilityState = 'hidden';
  doc.fire('visibilitychange', {});
  await new Promise(r => setImmediate(r));

  assert.equal(c.sent.length, 1);
  assert.equal(c.sent[0].keepalive, true);
  detach();
  b.stop();
});

test('becoming visible again does NOT flush — only hiding does', async () => {
  const c = collector();
  const doc = fakeDoc();
  const b = ib.createInteractionBuffer({ send: c.send, surface: 'saim', flushMs: 10_000 });
  const detach = ib.attachInteractionListener({ scope: null, getTab: () => 'chat', buffer: b, root: doc });

  doc.fire('click', { target: node(['button']) });
  doc.visibilityState = 'visible';
  doc.fire('visibilitychange', {});
  await new Promise(r => setImmediate(r));

  assert.equal(c.sent.length, 0);
  detach();
  b.stop();
});

test('no document and no buffer are both survivable', () => {
  assert.doesNotThrow(() => ib.attachInteractionListener({ scope: null, getTab: () => 'x', buffer: null, root: null })());
});
