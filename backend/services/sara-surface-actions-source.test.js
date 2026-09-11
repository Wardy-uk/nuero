'use strict';

/**
 * Two SARA parity gaps that would regress silently.
 *
 * (1) "That's done" as a BUTTON on a card. It must go through the attention
 *     record (`POST /api/attention/records/:id/act` with `action: 'complete'`) —
 *     the only path that resolves and the only one that may close a task — and it
 *     must be offered only where the shell can act AND the record allows it. The
 *     Pi kiosk mounts the same shared component, so a button rendered without an
 *     `onAct` would be one that silently does nothing.
 *
 * (2) Chat passing `onTool` to the stream. Without it every tool NEURO ran during
 *     a reply is dropped on the floor, and nothing throws — the reply just looks
 *     like a plain answer.
 *
 * Source scans, each with a positive control, because the absence of a callback
 * has no runtime assertion that can see it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SARA = path.join(__dirname, '..', '..', 'sara');
const surfaceSrc = fs.readFileSync(path.join(SARA, 'shared-ui', 'AttentionSurface.jsx'), 'utf8');
const phoneSrc = fs.readFileSync(path.join(SARA, 'app', 'src', 'views', 'Surface.jsx'), 'utf8');
const chatSrc = fs.readFileSync(path.join(SARA, 'app', 'src', 'views', 'Chat.jsx'), 'utf8');
const apiSrc = fs.readFileSync(path.join(SARA, 'app', 'src', 'api.js'), 'utf8');

test('positive control: these are the files being scanned', () => {
  assert.match(surfaceSrc, /export default function AttentionSurface/);
  assert.match(phoneSrc, /export default function Surface/);
  assert.match(chatSrc, /export default function Chat/);
  // The existing buttons this change sits beside are still there.
  assert.match(surfaceSrc, /act\(primary, 'acknowledge'\)/);
  assert.match(surfaceSrc, /includes\('dismiss'\)/);
});

test('"that\'s done" posts complete through the record route', () => {
  assert.match(surfaceSrc, /act\(primary, 'complete'\)/, 'the card must offer complete');
  assert.match(
    phoneSrc,
    /\/api\/attention\/records\/\$\{card\.recordId\}\/act/,
    'actions go to the attention record, not a suppression timer',
  );
  assert.match(phoneSrc, /JSON\.stringify\(\{ action, \.\.\.opts \}\)/, 'the action name travels verbatim');
});

test('complete is gated on onAct, a record, and the record allowing it', () => {
  const gate = surfaceSrc.match(/const canComplete = \(card\) => Boolean\(([\s\S]*?)\);/);
  assert.ok(gate, 'the gate must be a named, single predicate');
  assert.match(gate[1], /onAct/, 'no button without a shell that can act');
  assert.match(gate[1], /card\.recordId/, 'no button without a record to resolve');
  assert.match(gate[1], /includes\('complete'\)/, 'no button the record does not allow');
  assert.match(surfaceSrc, /canComplete\(primary\) &&/, 'the button must be rendered behind the gate');
});

test('complete never falls back to the legacy dismissal', () => {
  // A dismissal is not a completion; substituting one for the other is the bug
  // the attention contract removed.
  assert.match(phoneSrc, /action === 'complete' && !card\.recordId/);
});

test('the result is described from the response, never implied', () => {
  assert.match(surfaceSrc, /res\.taskCompleted === true/, 'task closed is read off the response');
  assert.match(surfaceSrc, /res\.taskWhy/, 'the server\'s own reason is shown');
  assert.match(surfaceSrc, /no task was closed/, 'a cleared card is not reported as finished work');
});

test('Chat passes onTool to the stream and reads the sync fallback\'s tools', () => {
  assert.match(apiSrc, /evt\.type === 'tool'\) onTool\?\.\(evt\.name\)/, 'positive control: the helper emits tool names');
  assert.match(chatSrc, /chatStream\(body, \{[\s\S]*?onTool:/, 'Chat must pass onTool');
  assert.match(chatSrc, /res\?\.tools/, 'the sync fallback carries tools: [names]');
});

test('Chat never renders tool arguments', () => {
  assert.doesNotMatch(chatSrc, /\.input\b/, 'a tool\'s input can hold private content');
  assert.doesNotMatch(chatSrc, /\.args\b|\.arguments\b/, 'nor its arguments by another name');
});
