'use strict';

/**
 * The suggestion chips (saim/shared-ui/ProposalChips.jsx) and the triage run's
 * pre-fill (TaskTriage.prefillAnswers) — a REAL render via esbuild.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const React = require('react');
const { renderToString } = require('react-dom/server');
const esbuild = require('esbuild');

async function load(file) {
  const out = await esbuild.build({
    entryPoints: [file],
    bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic',
    external: ['react', 'react-dom'],
    logLevel: 'silent',
    plugins: [{
      name: 'stub',
      setup(build) {
        build.onResolve({ filter: /\.css$/ }, (a) => ({ path: a.path, namespace: 'css' }));
        build.onLoad({ filter: /.*/, namespace: 'css' }, () => ({ contents: '', loader: 'js' }));
        build.onResolve({ filter: /(^|\/)api$/ }, () => ({ path: 'api', namespace: 'stub' }));
        build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
          contents: 'export const apiUrl = p => p;\nexport const authHeaders = () => ({});\nexport const apiFetch = async () => ({});\nexport default { apiUrl };', loader: 'js',
        }));
      },
    }],
  });
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}

const ROOT = path.resolve(__dirname, '..', '..');
let Chips;
let proposalChips;
let TaskTriage;
let prefillAnswers;

test.before(async () => {
  const c = await load(path.join(ROOT, 'saim', 'shared-ui', 'ProposalChips.jsx'));
  Chips = c.default; proposalChips = c.proposalChips;
  const t = await load(path.join(ROOT, 'frontend', 'src', 'components', 'TaskTriage.jsx'));
  TaskTriage = t.default; prefillAnswers = t.prefillAnswers;
  assert.ok(Chips && proposalChips && TaskTriage && prefillAnswers, 'positive control: exports exist');
});

const PROPOSALS = {
  moscow: { value: 'should', basis: 'wording', why: 'from the wording' },
  estimate: { minutes: 60, basis: 'measured-similar', why: '2 finished focus sessions on a similar task' },
  due: { date: '2026-11-14', basis: 'stated', why: 'the task says “by 14 November”' },
};

test('chips: each suggestion renders with a trailing "?" and its own Confirm, writing the real field', () => {
  const chips = proposalChips(PROPOSALS);
  assert.deepEqual(chips.map((c) => c.label), ['Should?', '~1h?', 'Due 14 Nov?']);
  assert.deepEqual(chips.map((c) => c.body), [{ moscow: 'should' }, { estimateMinutes: 60 }, { due_date: '2026-11-14' }]);
  const html = renderToString(React.createElement(Chips, { proposals: PROPOSALS, onConfirm: async () => {} })).replace(/<!-- -->/g, '');
  assert.match(html, /Should\?/);
  assert.equal((html.match(/>Confirm</g) || []).length, 3);
});

test('chips: nothing to suggest renders nothing; read-only renders no Confirm', () => {
  assert.equal(renderToString(React.createElement(Chips, { proposals: {} })), '');
  const ro = renderToString(React.createElement(Chips, { proposals: PROPOSALS, onConfirm: async () => {}, readOnly: true }));
  assert.doesNotMatch(ro, />Confirm</);
});

test('triage: proposals pre-fill ONLY the missing fields, so Enter confirms them', () => {
  const todo = { task_id: 7, text: 'x', triage: { missing: ['moscow', 'due', 'priority'] }, proposals: PROPOSALS };
  assert.deepEqual(prefillAnswers(todo), { moscow: 'should', due: '2026-11-14' }, 'estimate not missing → not pre-filled');
  assert.deepEqual(prefillAnswers({ task_id: 8, triage: { missing: ['moscow'] }, proposals: PROPOSALS }), { moscow: 'should' }, 'a set date is never pre-filled over');
  assert.deepEqual(prefillAnswers({ ms_id: 'a', triage: { missing: ['moscow'] }, proposals: PROPOSALS }), {}, 'never on a non-NEURO row');
});

test('triage: the first card opens with the suggestion selected and says so', () => {
  const todos = [{ task_id: 7, text: 'Send the rota by 14 November', triage: { missing: ['moscow', 'due'] }, proposals: PROPOSALS }];
  const html = renderToString(React.createElement(TaskTriage, { todos, onClose: () => {} })).replace(/<!-- -->/g, '');
  assert.match(html, /NEURO suggests Should/);
  assert.match(html, /triage-choice active[^>]*>Should/);
  assert.match(html, /triage-choice active[^>]*>2026-11-14\?/);
  assert.match(html, /All answered\./);
});
