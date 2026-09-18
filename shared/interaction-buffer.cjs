'use strict';

/**
 * Counting control uses on a screen, without a request per click.
 *
 * ⚠ WHY A BUFFER AND NOT A POST PER CLICK. A busy TodoPanel session is dozens
 * of clicks a minute — a request and an `activity_log` row each would make the
 * measurement more expensive than the thing being measured, and would put the
 * heatmap's own traffic on the Pi it is measuring. So clicks are counted
 * locally and flushed as `{tab, surface, count}`, which is the `wins` ledger's
 * one-row-per-repo-per-day fold applied to a click stream.
 *
 * ⚠ WHAT COUNTS IS A CONTROL, not a click. Nick's call, 18 Sep 2026: using a
 * button, link, checkbox, input or select. Clicking a paragraph, selecting
 * text or scrolling is not an interaction — those are reading, and counting
 * them would make "interacted with" mean nothing more than "was on screen".
 *
 * ⚠⚠ AND A SCREEN WITH NO INTERACTIONS IS NOT A FAILING SCREEN. Measured on
 * this estate: `BriefingPanel` has 4 interactive elements and `TodoPanel` has
 * 99. Briefing, State of Play and Pi Health will always sit near zero here,
 * because they are things to READ. The panel says so; nothing in this file
 * scores anything, and nothing should ever start.
 *
 * PURE apart from the flush it is handed — `createInteractionBuffer` takes the
 * sender, so the three surfaces share the counting and each keeps its own
 * transport (the phone holds a PIN, the kiosk goes through a proxy, VANTAGE
 * talks to itself). The same split `useFieldDrive` makes with its fetcher.
 */

// A control. Anything else — a paragraph, a heading, the page background — is
// reading, and `closest()` walks up so a click on the text INSIDE a button
// still counts as the button.
const CONTROL_SELECTOR = [
  'button',
  'a[href]',
  'input',
  'select',
  'textarea',
  'summary',
  'label',
  '[role="button"]',
  '[role="tab"]',
  '[role="checkbox"]',
  '[role="switch"]',
  '[role="link"]',
  '[role="menuitem"]',
  '[role="option"]',
].join(',');

// How often a non-empty buffer is sent.
const FLUSH_MS = 20000;

// ⚠ The same ceiling the server clamps to. Stated in both places on purpose:
// the server must not trust a client, and the client should not knowingly send
// what will be clamped. If these ever disagree the server wins, and the route
// reports what it actually stored so the difference is visible.
const MAX_PER_FLUSH = 500;

/**
 * Is this event a control use?
 *
 * PURE given an element-like with `closest`. Exported so the rule pins without
 * a DOM, and so the three surfaces cannot come to disagree about it.
 */
function isControlUse(target) {
  if (!target || typeof target.closest !== 'function') return false;
  try {
    return Boolean(target.closest(CONTROL_SELECTOR));
  } catch {
    // A detached node, or a browser that dislikes the selector. Not knowing is
    // NOT a reason to count it — over-counting here would quietly turn this
    // into "clicks anywhere", which is the measure Nick did not ask for.
    return false;
  }
}

/**
 * A counter with a flush.
 *
 * `send({tab, surface, count})` is the caller's transport. It may reject; the
 * count is KEPT when it does, so a flush that fails is retried on the next one
 * rather than thrown away.
 */
function createInteractionBuffer({ send, surface, flushMs = FLUSH_MS, now = () => Date.now() }) {
  // tab -> count. Keyed by screen, because a flush can span a navigation and
  // attributing the clicks made on Tasks to whatever is on screen when the
  // timer fires would be worse than not measuring at all.
  const pending = new Map();
  let timer = null;
  let inFlight = false;

  function count(tab, n = 1) {
    if (!tab) return;
    pending.set(tab, Math.min((pending.get(tab) || 0) + n, MAX_PER_FLUSH));
    schedule();
  }

  function schedule() {
    if (timer || !pending.size) return;
    timer = setTimeout(() => { timer = null; flush(); }, flushMs);
    // Never hold a process open for a usage counter. No-op in a browser.
    if (typeof timer?.unref === 'function') timer.unref();
  }

  /**
   * Send what is buffered.
   *
   * ⚠ The buffer is CLEARED BEFORE the send and restored on failure, so clicks
   * made during the request are not lost to the clear — the read-modify-write
   * trap that would otherwise drop exactly the clicks made while the network
   * was slow.
   */
  async function flush({ keepalive = false } = {}) {
    if (inFlight || !pending.size) return { sent: 0 };
    const batch = [...pending.entries()];
    pending.clear();
    inFlight = true;
    let sent = 0;
    try {
      for (const [tab, n] of batch) {
        await send({ tab, surface, count: n, keepalive });
        sent += n;
      }
      return { sent };
    } catch (e) {
      // Put it back. A usage grid is not worth losing, but it is also not
      // worth retrying forever — the next flush carries it, and if the Pi is
      // down for the session it is lost, which is documented rather than
      // papered over with a queue. A capture gets a durable outbox; a click
      // count does not, and conflating the two is how a store grows.
      for (const [tab, n] of batch) {
        pending.set(tab, Math.min((pending.get(tab) || 0) + n, MAX_PER_FLUSH));
      }
      return { sent, failed: true, reason: e && e.message };
    } finally {
      inFlight = false;
      schedule();
    }
  }

  function pendingTotal() {
    let t = 0;
    for (const n of pending.values()) t += n;
    return t;
  }

  function stop() {
    if (timer) { clearTimeout(timer); timer = null; }
  }

  return { count, flush, pendingTotal, stop, _now: now };
}

/**
 * Wire a content area up to a buffer. Returns a detach function.
 *
 * ⚠ SCOPED TO THE CONTENT AREA, NEVER THE DOCUMENT, and it is an ALLOWLIST
 * (`closest(scope)`) rather than a list of chrome to ignore. Two reasons, and
 * the second is the one that matters: a denylist rots the first time a new bit
 * of chrome appears, and — more importantly — CLICKING THE NAV IS LEAVING A
 * SCREEN, NOT WORKING ON ONE. Counting it would give every screen a free
 * interaction on the way out, so the busiest rows on the grid would be the
 * ones he navigated away from most.
 *
 * ⚠ It listens for `click` AND `change`. Click alone misses a select being
 * used with the keyboard and a date picked from a native picker; `change`
 * alone misses every button. ⚠ It does NOT listen for `input` — that fires per
 * KEYSTROKE, so typing a task title would register as forty interactions and
 * whichever screen has a text box would win the grid outright.
 *
 * ⚠ Both listeners are CAPTURING, so a handler that calls `stopPropagation`
 * (which this codebase does deliberately in several places — the expanded task
 * card stops clicks reaching the row beneath) cannot make the click invisible.
 *
 * ⚠ The tab is read AT EVENT TIME via `getTab()`, never closed over: a stale
 * capture would attribute every click to whichever screen was mounted when the
 * listener was attached.
 */
function attachInteractionListener({ scope, getTab, buffer, root }) {
  const doc = root || (typeof document !== 'undefined' ? document : null);
  if (!doc || !buffer) return () => {};

  const onEvent = (e) => {
    const target = e && e.target;
    if (!isControlUse(target)) return;
    // Outside the content area — chrome, nav, a modal launcher. Not work on
    // this screen.
    if (scope && typeof target.closest === 'function' && !target.closest(scope)) return;
    const tab = typeof getTab === 'function' ? getTab() : null;
    if (tab) buffer.count(tab, 1);
  };

  doc.addEventListener('click', onEvent, true);
  doc.addEventListener('change', onEvent, true);

  // ⚠ Flush on the way out. `visibilitychange` is the reliable one on iOS,
  // where `beforeunload`/`pagehide` are unreliable and a backgrounded PWA may
  // never come back. `keepalive` lets the request outlive the page — and it is
  // used rather than `sendBeacon`, which cannot set the PIN header the phone
  // needs and would force the credential into a URL.
  const onHide = () => {
    if (doc.visibilityState === 'hidden') buffer.flush({ keepalive: true });
  };
  doc.addEventListener('visibilitychange', onHide);

  return () => {
    doc.removeEventListener('click', onEvent, true);
    doc.removeEventListener('change', onEvent, true);
    doc.removeEventListener('visibilitychange', onHide);
    buffer.stop();
  };
}

module.exports = {
  attachInteractionListener,
  createInteractionBuffer,
  isControlUse,
  CONTROL_SELECTOR,
  FLUSH_MS,
  MAX_PER_FLUSH,
};
