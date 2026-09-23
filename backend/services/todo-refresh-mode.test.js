'use strict';

/**
 * Every mutation refreshes the list that is ON SCREEN.
 *
 * TodoPanel has two data sources and only ever one of them is live:
 *
 *   focused mode -> useCachedFetch('/api/todos/focus?filter=...')  -> refreshFocus
 *   full mode    -> useCachedFetch('/api/todos')                   -> fetchTodos
 *
 * The inactive one is subscribed to `null`, so its refresh is a NO-OP. Five
 * handlers already guarded on `mode` and six did not — including both
 * suggestion handlers. So approving a spotted todo in the Due Today view hid
 * the card (resolvedSuggestions answers the click immediately) and then
 * refreshed nothing: the task Nick had just given today's date did not appear,
 * and the only visible outcome was the card disappearing. It looked like the
 * task had vanished rather than arrived.
 *
 * ⚠ The backend was innocent — `/api/todos/focus?filter=today` returned all 8
 * correctly while the screen showed none. That is why this is pinned as a SCAN
 * over the call sites rather than as behaviour: the bug is a handler forgetting
 * a guard, and a new handler can forget it just as easily.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const PANEL = path.resolve(__dirname, '..', '..', 'frontend', 'src', 'components', 'TodoPanel.jsx');
const source = fs.readFileSync(PANEL, 'utf-8');
const lines = source.split('\n');

test('positive control — the panel really does have both refreshes', () => {
  assert.match(source, /refresh: refreshFocus/, 'focused-mode refresh must exist');
  assert.match(source, /refresh: fetchTodos/, 'full-mode refresh must exist');
  assert.match(source, /mode === 'focused' \? focusPath : null/,
    'and the focused path must still be the one that goes null in full mode');
});

test('no handler calls fetchTodos() without checking the mode', () => {
  const offenders = [];
  lines.forEach((line, i) => {
    if (!/\bfetchTodos\(\)/.test(line)) return;
    // The guard may sit on this line or the one above it (`else await ...`).
    const context = `${lines[i - 1] || ''}\n${line}`;
    if (/mode === 'focused'/.test(context)) return;
    offenders.push(`${i + 1}: ${line.trim()}`);
  });
  assert.deepEqual(offenders, [],
    'these refresh the full-mode list, which is null in focused mode:\n' + offenders.join('\n'));
});

test('a callback that refreshes by mode lists mode in its deps', () => {
  // A `useCallback` closing over `mode` without declaring it keeps the value
  // from the render it was created in — so it would silently refresh the list
  // Nick was looking at LAST, which is the same bug wearing a stale closure.
  const offenders = [];
  const re = /useCallback\(async[\s\S]*?\}, \[([^\]]*)\]\)/g;
  let m;
  while ((m = re.exec(source))) {
    const body = m[0];
    if (!/mode === 'focused'/.test(body)) continue;
    const deps = m[1];
    if (!/\bmode\b/.test(deps)) offenders.push(deps.trim() || '(empty)');
  }
  assert.deepEqual(offenders, [], `useCallback deps missing "mode": ${offenders.join(' | ')}`);
});
