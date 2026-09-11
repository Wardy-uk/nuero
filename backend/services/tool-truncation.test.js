'use strict';

/**
 * A tool call that was CUT OFF is not a tool call.
 *
 * ⚠ The bug this pins, measured on Nick's standup of 11 Sep 2026. The tool path
 * ran with `max_tokens: 400`. The closing turn emitted five resolve_commitment
 * calls, ran out of room inside the fifth, and OpenRouter returned the block
 * anyway with `finish_reason: "length"`. The fragment's arguments had been
 * truncated to `{}` — VALID JSON — so it parsed clean, reached the handler and
 * came back as an ordinary "key is required", indistinguishable from the model
 * forgetting a field. And the call it had NOT reached yet, `set_weekly_target`,
 * carrying the number Nick had given it one message earlier, was never emitted
 * at all.
 *
 * So the number was dropped in silence and SARA asked for it again — twice —
 * relaying the tool's own complaint to him in the tool's vocabulary. Nothing
 * logged, and the session transcript stores assistant TEXT only, so afterwards
 * there was no record that any call had been refused.
 *
 * Three rules, and the middle one is the one that is easy to get wrong:
 *
 *  1. A truncated turn is NAMED, never passed off as a complete one.
 *  2. Calls emitted BEFORE the cut are real and still run — they are decisions
 *     Nick actually made, and throwing them away to be safe loses his work.
 *     Only the last block can be the fragment.
 *  3. The fragment is REFUSED and asked for again, never executed.
 */

const test = require('node:test');
const assert = require('node:assert');

const or = require('./providers/openrouter-provider');
const anth = require('./providers/anthropic-provider');

// ── OpenRouter ───────────────────────────────────────────────────────────────

function orResponse(finish_reason, tool_calls, content = null) {
  return {
    ok: true,
    json: async () => ({
      model: 'anthropic/claude-haiku-4.5',
      usage: { prompt_tokens: 10, completion_tokens: 20, cost: 0 },
      choices: [{ finish_reason, message: { role: 'assistant', content, tool_calls } }],
    }),
  };
}

function call(id, name, args) {
  return { id, type: 'function', function: { name, arguments: args } };
}

/** Drives chatWithTools over a scripted list of responses. */
async function runOr(responses) {
  const realFetch = global.fetch;
  const realKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'test-key';
  let i = 0;
  global.fetch = async () => responses[Math.min(i++, responses.length - 1)];
  const ran = [];
  try {
    const out = await or.chatWithTools(
      'sys', [{ role: 'user', content: 'go' }],
      [{ name: 'resolve_commitment', description: '', input_schema: { type: 'object' } }],
      async (name, input) => { ran.push({ name, input }); return { ok: true }; },
      { maxRounds: 3 }
    );
    return { out, ran };
  } finally {
    global.fetch = realFetch;
    if (realKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = realKey;
  }
}

test('openrouter: a call cut off at max_tokens is NOT run', async () => {
  const { ran } = await runOr([
    orResponse('length', [
      call('a', 'resolve_commitment', '{"key":"one","decision":"done"}'),
      // The live shape: arguments truncated all the way to an empty object.
      call('b', 'resolve_commitment', '{}'),
    ]),
    orResponse('stop', null, 'done'),
  ]);
  assert.strictEqual(ran.length, 1, 'only the complete call should have run');
  assert.strictEqual(ran[0].input.key, 'one');
});

test('openrouter: calls emitted before the cut still run', async () => {
  // Losing these to be safe would throw away decisions Nick actually made.
  const { ran } = await runOr([
    orResponse('length', [
      call('a', 'resolve_commitment', '{"key":"one","decision":"done"}'),
      call('b', 'resolve_commitment', '{"key":"two","decision":"today"}'),
      call('c', 'resolve_commitment', '{}'),
    ]),
    orResponse('stop', null, 'done'),
  ]);
  assert.deepStrictEqual(ran.map(r => r.input.key), ['one', 'two']);
});

test('openrouter: the model is TOLD the call was cut off, and the loop continues', async () => {
  // It must get the chance to make the call again — returning here would drop
  // it, which is the silent failure being fixed.
  const { ran, out } = await runOr([
    orResponse('length', [call('a', 'resolve_commitment', '{}')]),
    orResponse('tool_calls', [call('b', 'resolve_commitment', '{"key":"one"}')]),
    orResponse('stop', null, 'finished'),
  ]);
  assert.strictEqual(ran.length, 1, 'the repeated call should have run');
  assert.strictEqual(ran[0].input.key, 'one');
  assert.match(out.text, /finished/);
});

test('openrouter: a COMPLETE turn is not flagged as truncated', async () => {
  // A rule that fires on healthy turns is one nobody believes by week two.
  const { ran, out } = await runOr([
    orResponse('tool_calls', [
      call('a', 'resolve_commitment', '{"key":"one"}'),
      call('b', 'resolve_commitment', '{"key":"two"}'),
    ]),
    orResponse('stop', null, 'done'),
  ]);
  assert.deepStrictEqual(ran.map(r => r.input.key), ['one', 'two']);
  assert.ok(!out.truncated, 'truncated must not be set on a clean turn');
});

test('openrouter: truncated prose with no tool calls is reported, not silent', async () => {
  const { out } = await runOr([orResponse('length', null, 'half a sent')]);
  assert.strictEqual(out.truncated, true);
  assert.match(out.text, /half a sent/);
});

// ── Anthropic (the fallback tool provider — same class, opposite failure) ─────

test('anthropic: a max_tokens turn still runs its complete calls', async () => {
  // ⚠ Before this, `stop_reason !== 'tool_use'` returned early and dropped
  // EVERY call including the ones emitted whole.
  const responses = [
    {
      stop_reason: 'max_tokens',
      usage: { input_tokens: 10, output_tokens: 20 },
      content: [
        { type: 'tool_use', id: 'a', name: 'resolve_commitment', input: { key: 'one' } },
        { type: 'tool_use', id: 'b', name: 'resolve_commitment', input: {} },
      ],
    },
    { stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'text', text: 'done' }] },
  ];
  let i = 0;
  const ran = [];
  const realKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'test-key';
  anth._internals.setClient({
    messages: { create: async () => responses[Math.min(i++, responses.length - 1)] },
  });
  let out;
  try {
    out = await anth.chatWithTools(
      'sys', [{ role: 'user', content: 'go' }],
      [{ name: 'resolve_commitment', description: '', input_schema: { type: 'object' } }],
      async (name, input) => { ran.push({ name, input }); return { ok: true }; },
      { maxRounds: 3 }
    );
  } finally {
    anth._internals.setClient(null);
    if (realKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = realKey;
  }
  assert.strictEqual(ran.length, 1, 'only the complete call should have run');
  assert.strictEqual(ran[0].input.key, 'one');
  assert.match(out.text, /done/);
});
