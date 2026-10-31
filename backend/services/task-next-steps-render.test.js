'use strict';

/**
 * Next steps on Claude's returned work, rendered for real (esbuild + renderToString)
 * from the SAME shared component the desktop task card, SAiM Tasks and the Keep my
 * word card mount (31 Oct 2026): numbered steps under the newest From Claude
 * result, each with its why line, its one button and its state; the email draft
 * preview with Send now / Open in Actions; the switch-off notice; the fallback
 * label; and the kiosk (readOnly) showing the steps with no buttons.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const React = require('react');
const { renderToString } = require('react-dom/server');
const esbuild = require('esbuild');

const ROOT = path.resolve(__dirname, '..', '..');

async function load(file) {
  const out = await esbuild.build({
    entryPoints: [path.join(ROOT, file)], bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic',
    external: ['react', 'react-dom'], logLevel: 'silent',
    nodePaths: [path.join(ROOT, 'node_modules'), ...String(process.env.NODE_PATH || '').split(path.delimiter).filter(Boolean)],
    plugins: [{ name: 'css', setup(b) { b.onResolve({ filter: /\.css$/ }, (a) => ({ path: a.path, namespace: 'css' })); b.onLoad({ filter: /.*/, namespace: 'css' }, () => ({ contents: '', loader: 'js' })); } }],
  });
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}

let TA;
test.before(async () => { TA = await load('saim/shared-ui/TaskAgent.jsx'); });
const noop = () => {};

const PLAN = {
  forResultId: 'c1', source: 'model', label: null, steps: [
    { id: 's1', kind: 'send', title: 'Send it to Alex', why: 'Alex asked for the cover plan.', state: null,
      send: { to: { name: 'Alex Reed', email: 'alex.reed@nurtur.tech' }, subject: 'Write the Q4 rota cover plan', body: 'Hi Alex,\n\nAttached…\n\nNick', attachmentName: 'Q4 Rota Cover Plan.docx', action: null, sendingEnabled: true } },
    { id: 's2', kind: 'follow-up-task', title: 'Book the rota review', why: 'The plan says to book a review.', state: { status: 'done', say: 'Task #412 created.' }, followUp: { text: 'Book the review', due: null, already: null } },
    { id: 's3', kind: 'manual', title: 'Ring the agency', why: 'Week 44 may need agency cover.', state: null },
    { id: 'drop-time', kind: 'drop-time', title: 'Drop the suggested time (Wed 4 Nov 10:30)', why: 'Not needed now.', state: null, dropTime: { recordId: 'pm_x', version: 1, say: 'Wed 4 Nov 10:30' } },
    { id: 's4', kind: 'complete', title: 'Mark the task done', why: null, state: null },
  ],
};
const render = (props) => renderToString(React.createElement(TA.NextSteps, { onAct: noop, onSendNow: noop, onRethink: noop, onOpenActions: noop, ...props }));

test('numbered steps, why lines, one button each, a done step ticked with what happened', () => {
  const h = render({ nextSteps: PLAN });
  assert.match(h, /Next steps/);
  for (const t of ['Send it to Alex', 'Book the rota review', 'Ring the agency', 'Drop the suggested time \\(Wed 4 Nov 10:30\\)', 'Mark the task done']) assert.match(h, new RegExp(t));
  assert.match(h, /Alex asked for the cover plan\./);
  assert.match(h, />Send to Alex</);
  assert.match(h, /📎 (<!-- -->)?Q4 Rota Cover Plan\.docx/);
  assert.match(h, /✓/);
  assert.match(h, /Task #412 created\./);
  assert.doesNotMatch(h, />Add it to your tasks</, 'a done step has no button');
  assert.match(h, />Drop it</);
  assert.match(h, />Rethink</);
});

test('a prepared email shows To / Subject / body / attachment with Send now and Open in Actions; switch off says so', () => {
  const action = { actionId: 'pa_1', version: 1, payloadHash: 'h', status: 'prepared', actionType: 'compose_email', to: [{ name: 'Alex Reed', email: 'alex.reed@nurtur.tech' }], subject: 'Write the Q4 rota cover plan', body: 'Hi Alex,\n\nAttached…\n\nNick', attachments: [{ name: 'Q4 Rota Cover Plan.docx', size: 2000 }] };
  const on = render({ nextSteps: { ...PLAN, steps: [{ ...PLAN.steps[0], send: { ...PLAN.steps[0].send, action } }] } });
  assert.match(on, /Alex Reed &lt;alex\.reed@nurtur\.tech&gt;/);
  assert.match(on, />Send now</);
  assert.match(on, />Open in Actions</);
  const off = render({ nextSteps: { ...PLAN, steps: [{ ...PLAN.steps[0], send: { ...PLAN.steps[0].send, action, sendingEnabled: false } }] } });
  assert.doesNotMatch(off, />Send now</);
  assert.match(off, /Send approved emails/);
  const sent = render({ nextSteps: { ...PLAN, steps: [{ ...PLAN.steps[0], send: { ...PLAN.steps[0].send, action: { ...action, status: 'verified' } } }] } });
  assert.match(sent, /verified in Sent Items/);
  assert.doesNotMatch(sent, />Send now</);
});

test('no single address: why, and an address box', () => {
  const h = render({ nextSteps: { ...PLAN, steps: [{ ...PLAN.steps[0], send: { ...PLAN.steps[0].send, to: null, why: 'no single address for Pat Gray in your People notes — type it' } }] } });
  assert.match(h, /no single address for Pat Gray/);
  assert.match(h, /type="email"/);
  assert.match(h, />Prepare the email</);
});

test('fallback label, and the thinking state', () => {
  assert.match(render({ nextSteps: { ...PLAN, source: 'fallback', label: 'Suggested steps (NEURO couldn’t think this through just now)' } }), /couldn’t think this through just now/);
  assert.match(render({ nextSteps: { forResultId: 'c1', thinking: true, steps: [] } }), /Working out the next steps/);
});

test('kiosk (readOnly): the steps are shown, with no buttons, boxes or Rethink', () => {
  const h = render({ nextSteps: { ...PLAN, steps: [...PLAN.steps.slice(0, 1).map((s) => ({ ...s, send: { ...s.send, to: null, why: 'type it' } })), ...PLAN.steps.slice(1)] }, readOnly: true });
  assert.match(h, /Send it to Alex/);
  assert.match(h, /Mark the task done/);
  assert.doesNotMatch(h, /<button/);
  assert.doesNotMatch(h, /<input/);
});

test('the steps sit under the newest From Claude result', () => {
  const h = renderToString(React.createElement(TA.ClaudeReturn, { results: [{ id: 'c2', at: '2026-10-31T10:00:00Z', markdown: 'newest', notePath: 'a.md' }, { id: 'c1', at: '2026-10-30T10:00:00Z', markdown: 'older', notePath: 'a.md' }], after: React.createElement('div', { 'data-steps-here': 'yes' }) }));
  const i = h.indexOf('newest'); const j = h.indexOf('data-steps-here'); const k = h.indexOf('older');
  assert.ok(i > -1 && j > i && k > j, 'after the newest, before the older one');
});
