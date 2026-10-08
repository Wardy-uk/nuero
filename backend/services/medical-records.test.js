'use strict';

/**
 * The medical-record rules, pure: dates at the precision the record states,
 * values transcribed not interpreted, flags never derived, refusals named, and
 * an unreadable model answer never mistaken for an empty screen.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const m = require('./medical-records');

const TODAY = new Date(2026, 9, 8, 12); // 8 Oct 2026, local

test('dates: the forms the NHS app prints, at their own precision', () => {
  assert.deepEqual(m.parseDate('2026-03-12', TODAY), { ok: true, date: '2026-03-12', precision: 'day' });
  assert.deepEqual(m.parseDate('12 March 2026', TODAY), { ok: true, date: '2026-03-12', precision: 'day' });
  assert.deepEqual(m.parseDate('12/03/2026', TODAY), { ok: true, date: '2026-03-12', precision: 'day' }, 'day first, UK');
  assert.deepEqual(m.parseDate('March 2014', TODAY), { ok: true, date: '2014-03', precision: 'month' });
  assert.deepEqual(m.parseDate('2014', TODAY), { ok: true, date: '2014', precision: 'year' });
  assert.deepEqual(m.parseDate(null, TODAY), { ok: true, date: null, precision: null });
});

test('dates: an impossible or future date is refused, never rolled over', () => {
  assert.equal(m.parseDate('2026-02-31', TODAY).ok, false);
  assert.equal(m.parseDate('31/02/2026', TODAY).ok, false);
  assert.equal(m.parseDate('2026-10-09', TODAY).ok, false, 'tomorrow is a misread');
  assert.equal(m.parseDate('2026-11', TODAY).ok, false);
  assert.equal(m.parseDate('2026-10-08', TODAY).ok, true, 'today is fine');
  assert.equal(m.parseDate('2026-10', TODAY).ok, true, 'this month is fine');
  assert.equal(m.parseDate('last Tuesday', TODAY).ok, false);
});

test('values: a number only when the text IS a plain number', () => {
  assert.deepEqual(m.parseValue('4.2'), { text: '4.2', num: 4.2 });
  assert.deepEqual(m.parseValue('1,250'), { text: '1,250', num: 1250 });
  assert.deepEqual(m.parseValue('<0.5'), { text: '<0.5', num: null }, '"<0.5" is not 0.5');
  assert.deepEqual(m.parseValue('>90'), { text: '>90', num: null });
  assert.deepEqual(m.parseValue('Negative'), { text: 'Negative', num: null });
  assert.deepEqual(m.parseValue(''), { text: null, num: null });
});

test('a flag is what the record says — never derived from the range', () => {
  const n = m.normaliseRecord({ kind: 'test_result', name: 'Haemoglobin', date: '2026-03-12', value: '120', unit: 'g/L', referenceRange: '130 - 180' }, { today: TODAY });
  assert.equal(n.ok, true);
  assert.equal(n.record.flag, null, 'below the printed range, but the record did not say low');
  const stated = m.normaliseRecord({ kind: 'test_result', name: 'Haemoglobin', date: '2026-03-12', value: '120', flag: 'Low' }, { today: TODAY });
  assert.equal(stated.record.flag, 'low');
});

test('an unrecognised flag or status is REFUSED, not dropped to null', () => {
  const f = m.normaliseRecord({ kind: 'test_result', name: 'ALT', date: '2026-03-12', value: '60', flag: 'Hihg' }, { today: TODAY });
  assert.equal(f.ok, false);
  assert.match(f.why, /flag/);
  const s = m.normaliseRecord({ kind: 'prescription', name: 'Sertraline', date: '2026-09-01', status: 'ongoing' }, { today: TODAY });
  assert.equal(s.ok, false);
  assert.match(s.why, /status/);
});

test('refusals name what is missing', () => {
  const cases = [
    [{ kind: 'xray', name: 'Chest' }, /kind/],
    [{ kind: 'test_result', date: '2026-03-12', value: '1' }, /name/],
    [{ kind: 'test_result', name: 'ALT', value: '60' }, /date/],
    [{ kind: 'test_result', name: 'ALT', date: '2026-03-12' }, /value/],
    [{ kind: 'prescription', name: 'Sertraline' }, /date/],
    [{ kind: 'test_result', name: '---', date: '2026-03-12', value: '1' }, /letters or numbers/],
  ];
  for (const [input, why] of cases) {
    const r = m.normaliseRecord(input, { today: TODAY });
    assert.equal(r.ok, false, JSON.stringify(input));
    assert.match(r.why, why);
  }
  // A diagnosis may carry no date at all — "Asthma" with no onset is a real record.
  assert.equal(m.normaliseRecord({ kind: 'diagnosis', name: 'Asthma' }, { today: TODAY }).ok, true);
});

test('kind spellings fold, and the key is kind + name + date', () => {
  const a = m.normaliseRecord({ kind: 'Test result', name: 'HbA1c', date: '2026-03-12', value: '41' }, { today: TODAY }).record;
  const b = m.normaliseRecord({ kind: 'test-result', name: 'hba1c ', date: '12/03/2026', value: '42' }, { today: TODAY }).record;
  assert.equal(a.kind, 'test_result');
  assert.equal(m.dedupeKey(a), m.dedupeKey(b), 'same test, same day — a resend, whatever the spelling');
  const c = m.normaliseRecord({ kind: 'test_result', name: 'HbA1c', date: '2026-06-12', value: '40' }, { today: TODAY }).record;
  assert.notEqual(m.dedupeKey(a), m.dedupeKey(c), 'a later test is a new reading');
});

test('model answer: fenced JSON parses, bad rows are kept as refusals, overlap folds', () => {
  const text = '```json\n' + JSON.stringify({
    screen: 'Test results: Full blood count',
    records: [
      { kind: 'test_result', name: 'Haemoglobin', date: '2026-03-12', value: '145', unit: 'g/L' },
      { kind: 'test_result', name: 'Haemoglobin', date: '2026-03-12', value: '145', unit: 'g/L' },
      { kind: 'test_result', name: 'Platelets', date: '2026-03-12' },
    ],
    unreadable: ['white cell count value cut off'],
  }) + '\n```';
  const p = m.parseProposal(text, { today: TODAY });
  assert.equal(p.ok, true);
  assert.equal(p.proposed.length, 1, 'the overlapping repeat folds');
  assert.equal(p.refused.length, 1);
  assert.match(p.refused[0].why, /value/);
  assert.equal(p.refused[0].read.name, 'Platelets', 'what the model read is shown, not dropped');
  assert.deepEqual(p.unreadable, ['white cell count value cut off']);
  assert.equal(p.screen, 'Test results: Full blood count');
});

test('model answer: unreadable REFUSES; an empty screen is a real empty answer', () => {
  assert.equal(m.parseProposal('', { today: TODAY }).ok, false);
  assert.equal(m.parseProposal('Sorry, I cannot help with that.', { today: TODAY }).ok, false);
  assert.equal(m.parseProposal('{"records": [{"kind": "test_res', { today: TODAY }).ok, false, 'a truncated answer is not an empty one');
  assert.equal(m.parseProposal('{"screen": "x"}', { today: TODAY }).ok, false, 'no list is not an empty list');
  const empty = m.parseProposal('{"screen": "GP practice details", "records": []}', { today: TODAY });
  assert.equal(empty.ok, true);
  assert.deepEqual(empty.proposed, []);
});

test('the prompt tells the model to transcribe, not to judge', () => {
  const p = m.buildPrompt(3);
  assert.match(p, /3 screenshots/);
  assert.match(p, /Never work it out from the range/);
  assert.match(p, /instead of guessing/);
});

// ── The vision call, with the provider stubbed at its own seam ────────────

const ROUTING = { isCloudAllowed: () => true, recordUsage: () => {} };
const PNG = Buffer.from('fake-png-bytes').toString('base64');

test('scan: every screenshot goes to ONE call, and nothing of the image comes back', async () => {
  let seen;
  const provider = {
    isConfigured: () => true,
    vision: async (system, input, opts) => {
      seen = { system, input, opts };
      return { text: JSON.stringify({ records: [{ kind: 'diagnosis', name: 'Asthma', date: '2014', status: 'active' }] }), model: 'claude-opus-5', usage: {} };
    },
  };
  const r = await m.proposeFromScreenshots({
    images: [{ imageBase64: PNG, mediaType: 'image/png' }, { imageBase64: `data:image/png;base64,${PNG}`, mediaType: 'image/png' }],
  }, { aiRouting: ROUTING, provider, today: TODAY });
  assert.equal(r.ok, true);
  assert.equal(seen.input.images.length, 2);
  assert.equal(seen.input.images[1].imageBase64, PNG, 'a data: URL prefix is stripped');
  assert.match(seen.system, /never interpret/);
  assert.equal(r.proposed[0].name, 'Asthma');
  assert.ok(!JSON.stringify(r).includes(PNG), 'the screenshot is never echoed back');
});

test('scan: refused before spending when cloud is off, the input is wrong, or it is too many', async () => {
  const provider = { isConfigured: () => true, vision: async () => { throw new Error('should not be called'); } };
  const img = { imageBase64: PNG, mediaType: 'image/png' };
  assert.match((await m.proposeFromScreenshots({ images: [img] }, { aiRouting: { ...ROUTING, isCloudAllowed: () => false }, provider })).why, /not allowed/);
  assert.match((await m.proposeFromScreenshots({ images: [] }, { aiRouting: ROUTING, provider })).why, /no screenshots/);
  assert.match((await m.proposeFromScreenshots({ images: [{ ...img, mediaType: 'application/pdf' }] }, { aiRouting: ROUTING, provider })).why, /picture/);
  assert.match((await m.proposeFromScreenshots({ images: Array(m.MAX_IMAGES + 1).fill(img) }, { aiRouting: ROUTING, provider })).why, /at most/);
});

test('scan: a provider error is generalised, never passed through', async () => {
  const provider = { isConfigured: () => true, vision: async () => { throw new Error('401 invalid x-api-key sk-ant-secret'); } };
  const warn = console.warn; console.warn = () => {};
  try {
    const r = await m.proposeFromScreenshots({ images: [{ imageBase64: PNG, mediaType: 'image/png' }] }, { aiRouting: ROUTING, provider });
    assert.equal(r.ok, false);
    assert.ok(!/sk-ant|401/.test(r.why));
  } finally { console.warn = warn; }
});
