'use strict';

/**
 * The AI gate is the ONLY way out (22 Oct 2026).
 *
 *  1. SOURCE SCAN: no file outside backend/services/providers/ imports a model SDK
 *     or names a model provider's host — so nothing can reach a provider without
 *     going through a provider module.
 *  2. Every provider module that makes a network request opens a gate ticket.
 *  3. Every task type ai-routing knows, and every class a caller names, is in
 *     the registry (an unregistered one would only show up as unknown-class).
 *  4. A real provider call (fetch stubbed at the network boundary) lands in the
 *     shared ledger with its class, model and vendor cost; a failed one settles
 *     as failed; a tool loop takes one ticket per round.
 *
 * The scans carry positive controls so a scan that reads nothing cannot pass.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
process.env.AI_GATE_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ai-gate-enf-')), 'ledger.db');

function walk(dir, out = []) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return out;
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) continue;
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) walk(rel, out);
    else if (/\.(js|cjs|mjs)$/.test(e.name) && !/\.test\.js$/.test(e.name)) out.push(rel);
  }
  return out;
}

// What counts as reaching a model provider directly.
const PROVIDER_PATTERNS = [
  /require\(\s*['"]@anthropic-ai\/sdk['"]\s*\)/,
  /from\s+['"]@anthropic-ai\/sdk['"]/,
  /require\(\s*['"]openai['"]\s*\)/,
  /openrouter\.ai\/api/,
  /api\.openai\.com/,
  /api\.anthropic\.com/,
  /api\.voyageai\.com/,
  /api\.elevenlabs\.io/,
  /localhost:11434/,
  /\$\{OLLAMA_URL\}/,
];
const PROVIDER_DIR = 'backend/services/providers/';

// Outside NEURO's backend process, named with WHY each is not the gate's business.
const EXEMPT = {
  // The retired Pi 4 worker (PI4_WORKER_ENABLED=false since 15 Aug 2026) is its own
  // process on another box; NEURO's side of it (pi4-worker-client.js) IS gated.
  'worker/server.js': 'separate retired process; its NEURO client is gated',
};

test('no file outside providers/ reaches a model provider directly', () => {
  const files = ['backend', 'mcp-server', 'saim/backend', 'shared', 'worker'].flatMap((d) => walk(d));
  assert.ok(files.length > 300, `positive control: the scan read the sources (${files.length})`);
  const offenders = [];
  for (const f of files) {
    if (f.startsWith(PROVIDER_DIR) || EXEMPT[f]) continue;
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    if (PROVIDER_PATTERNS.some((p) => p.test(src))) offenders.push(f);
  }
  assert.deepEqual(offenders, [], `reach a provider only through backend/services/providers/: ${offenders.join(', ')}`);
  // Positive control: the patterns DO match the provider modules themselves.
  const or = fs.readFileSync(path.join(ROOT, PROVIDER_DIR, 'openrouter-provider.js'), 'utf8');
  assert.ok(PROVIDER_PATTERNS.some((p) => p.test(or)));
});

test('every provider module that makes a network request opens a gate ticket', () => {
  const dir = path.join(ROOT, PROVIDER_DIR);
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js') && !f.endsWith('.test.js') && f !== 'gate-call.js');
  assert.ok(files.length >= 6, 'positive control');
  for (const f of files) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    const networks = /\bfetch\(|messages\.(create|stream)\(/.test(src);
    if (!networks) continue;
    assert.match(src, /gateCall\.open\(/, `${f} makes requests without the gate`);
    assert.match(src, /gateCall\.close\(/, `${f} never settles its tickets`);
  }
  // The non-provider network edges that reach local model servers are gated too.
  for (const f of ['backend/services/pi4-worker-client.js', 'backend/services/voice-capture.js']) {
    assert.match(fs.readFileSync(path.join(ROOT, f), 'utf8'), /gateCall\.open\(/, f);
  }
});

test('every class a caller can name is registered', () => {
  const { CLASS_NAMES, REGISTRY } = require('./ai-gate-classes');
  const routing = require('./ai-routing');
  const known = new Set(CLASS_NAMES);
  const sets = ['LATENCY_SENSITIVE_TASKS', 'CAPABILITY_TASKS', 'CLOUD_PREFERRED_TASKS', 'BACKGROUND_TASKS', 'CLOUD_ON_WORKER_FALLBACK'];
  let seen = 0;
  for (const name of sets) for (const t of routing[name] || []) { seen += 1; assert.ok(known.has(t), `ai-routing ${name} has ${t} with no gate class`); }
  for (const t of Object.keys(routing.TASK_MODELS || {})) { seen += 1; assert.ok(known.has(t), `TASK_MODELS ${t}`); }
  assert.ok(seen > 10, 'positive control: read ai-routing’s task sets');
  // Literal classes named in source (runTask('x'…), callClass: 'x', taskType: 'x').
  const files = walk('backend/services').concat(walk('backend/routes'));
  const re = /(?:runTask\(\s*|callClass:\s*|taskType:\s*)'([a-z_]+)'/g;
  const named = new Set();
  for (const f of files) for (const m of fs.readFileSync(path.join(ROOT, f), 'utf8').matchAll(re)) named.add(m[1]);
  assert.ok(named.size > 15, 'positive control: found named classes');
  const missing = [...named].filter((c) => !known.has(c));
  assert.deepEqual(missing, [], `unregistered classes: ${missing.join(', ')}`);
  assert.ok(REGISTRY.$providers.ollama.maxConcurrent >= 1, 'local concurrency is bounded');
  for (const c of CLASS_NAMES) assert.equal(REGISTRY[c].maxPerDay, undefined, `${c}: no daily volume cap until Nick chooses one`);
});

test('a real OpenRouter call lands in the shared ledger; a failure settles as failed; a tool loop takes a ticket per round', async () => {
  const gate = require('./ai-gate');
  gate._reset();
  const realFetch = global.fetch;
  process.env.OPENROUTER_API_KEY = 'test-key';
  process.env.OPENROUTER_FALLBACK_MODELS = '';
  try {
    let calls = 0;
    global.fetch = async (url, init) => {
      calls += 1;
      assert.match(String(url), /openrouter\.ai/);
      const body = JSON.parse(init.body);
      if (body.messages.some((m) => m.content === 'fail')) return new Response('nope', { status: 500 });
      const toolTurn = Array.isArray(body.tools) && calls === 3;
      return new Response(JSON.stringify({
        model: 'anthropic/claude-haiku-4.5',
        choices: [{ message: toolTurn
          ? { content: '', tool_calls: [{ id: 't1', type: 'function', function: { name: 'x', arguments: '{}' } }] }
          : { content: 'hello' }, finish_reason: toolTurn ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 20, cost: 0.0007 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const or = require('./providers/openrouter-provider');
    const r = await or.chat('sys', [{ role: 'user', content: 'hi' }], { callClass: 'chat_sync', maxTokens: 200 });
    assert.equal(r.text, 'hello');
    await assert.rejects(or.chat('sys', [{ role: 'user', content: 'fail' }], { callClass: 'email_summary', maxTokens: 200 }));
    await or.chatWithTools('sys', [{ role: 'user', content: 'go' }], [{ name: 'x', description: 'x', input_schema: { type: 'object' } }], async () => 'done', { callClass: 'chat_tools', maxTokens: 300 });
    const p = gate.profile();
    const cls = Object.fromEntries(p.byClass.map((c) => [c.callClass, c]));
    assert.equal(cls.chat_sync.calls, 1);
    assert.equal(cls.chat_sync.usd, 0.0007, 'vendor cost');
    assert.equal(cls.email_summary.calls, 1, 'a failed request still took (and settled) a ticket');
    assert.equal(cls.chat_tools.calls, 2, 'one ticket per tool-loop round');
    assert.equal(p.wouldRefuse, 0);
    assert.equal(p.mode, 'shadow');
  } finally {
    global.fetch = realFetch;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_FALLBACK_MODELS;
  }
});

test('TTS — once wholly unrecorded — takes a ticket, settles on the stream’s own cost, and shows its honest gaps', async () => {
  const gate = require('./ai-gate');
  gate._reset();
  const realFetch = global.fetch;
  process.env.OPENROUTER_API_KEY = 'test-key';
  try {
    const pcm = Buffer.alloc(480).toString('base64');
    global.fetch = async (url) => {
      assert.match(String(url), /openrouter\.ai/);
      const sse = [
        `data: ${JSON.stringify({ choices: [{ delta: { audio: { data: pcm, transcript: 'Gate test line.' } } }] })}`,
        `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 60, completion_tokens: 90, cost: 0.0009 } })}`,
        'data: [DONE]', '',
      ].join('\n');
      return new Response(sse, { status: 200 });
    };
    const tts = require('./tts');
    const out = await tts.speak('Gate test line.', { voice: 'coral' });
    assert.equal(out.cached, false);
    const p = gate.profile();
    const row = p.byClass.find((c) => c.callClass === 'tts_speak');
    assert.ok(row, 'tts_speak went through the gate');
    assert.equal(row.usd, 0.0009, 'the vendor-reported cost');
    const reasons = p.refusals.map((r) => r.reason);
    assert.ok(reasons.includes('unbounded-output'), 'no max_tokens is sent — recorded, not invented');
    assert.ok(reasons.includes('unknown-price'), 'the audio model has no known price');
  } finally {
    global.fetch = realFetch;
    delete process.env.OPENROUTER_API_KEY;
  }
});

test('the gate is parity-pinned with VANTAGE’s copy when that checkout is present', (t) => {
  // The sibling VANTAGE checkout, seen from this repo's root or from a worktree under .claude/worktrees/.
  const parents = [path.resolve(ROOT, '..'), path.resolve(ROOT, '..', '..', '..', '..')];
  const candidates = parents.flatMap((p) => [
    path.join(p, 'Service Desk Continual Improvement', 'backend', 'services', 'ai-gate.js'),
    path.join(p, 'Service Desk Continual Improvement', '.claude', 'worktrees', 'ai-gate', 'backend', 'services', 'ai-gate.js'),
  ]);
  const theirs = candidates.find((p) => fs.existsSync(p));
  if (!theirs) return t.skip('no VANTAGE checkout beside this one (the Pi); VANTAGE’s own test pins the other direction');
  const body = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
  assert.equal(body(theirs), body(path.join(__dirname, 'ai-gate.js')), 'ai-gate.js must be byte-identical in NEURO and VANTAGE');
});
