'use strict';
/**
 * The cinema wall's household-job actions (18 Oct 2026), over real HTTP against
 * a real database: every change is READ BACK from NEURO, never assumed.
 * Complete, reopen, reschedule, reassign and add — the four things /api/v
 * allows — plus the refusals: an empty job, a job this account cannot see, a
 * double tap.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-wall-actions-'));
process.env.NEURO_DB_PATH = path.join(root, 'w.db');
process.env.OBSIDIAN_VAULT_PATH = path.join(root, 'vault');
fs.mkdirSync(process.env.OBSIDIAN_VAULT_PATH, { recursive: true });
process.env.NEURO_API_TOKEN = process.env.NEURO_API_TOKEN || 'test-token-for-signing';
process.env.HA_TOKEN = '';
process.env.HA_URL = 'http://127.0.0.1:9';

const db = require('../db/database');
const capture = require('./capture-links');


const pad = (n) => String(n).padStart(2, '0');
const keyOffset = (n) => { const t = new Date(); t.setDate(t.getDate() + n); return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`; };

test('household jobs: complete, reopen, reschedule, reassign and add — each read back from NEURO', async () => {
  await db.init();
  capture.create({ label: 'Helen', username: 'helen', pin: '246813', scopes: ['tasks', 'shared-tasks'] });
  capture.create({ label: 'Other', username: 'other', pin: '246813', scopes: ['tasks'] });

  const express = require('express');
  const app = express(); app.use(express.json()); app.use('/api/v', require('../routes/vesta'));
  const server = app.listen(0); const port = server.address().port;
  const call = async (p, { token, body, method } = {}) => {
    const r = await fetch(`http://127.0.0.1:${port}/api/v${p}`, {
      method: method || (body ? 'POST' : 'GET'),
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, json: await r.json() };
  };
  const wallTasks = async (token) => (await call('/wall', { token })).json.tasks.tasks;
  try {
    const helen = (await call('/login', { body: { username: 'helen', pin: '246813' } })).json.token;
    const other = (await call('/login', { body: { username: 'other', pin: '246813' } })).json.token;
    assert.ok(helen && other);

    // Add — the wall payload carries who a job can be for.
    const wall = (await call('/wall', { token: helen })).json;
    assert.deepEqual(wall.people.map((p) => p.id).sort(), ['helen', 'nick', 'other'].sort());
    const added = await call('/tasks', { token: helen, body: { text: 'Clean the gutters', dueDate: keyOffset(3), assignees: ['nick', 'helen'] } });
    assert.equal(added.status, 200);
    const id = added.json.id;
    let t = (await wallTasks(helen)).find((x) => x.id === id);
    assert.ok(t, 'the new job is read back from NEURO');
    assert.equal(t.dueDate, keyOffset(3));
    assert.deepEqual(t.assignees.sort(), ['helen', 'nick']);

    // A double tap does not make a second job.
    const again = await call('/tasks', { token: helen, body: { text: 'Clean the gutters' } });
    assert.equal(again.json.created, false, 'the same wording folds into the existing job');
    assert.equal((await wallTasks(helen)).filter((x) => x.text === 'Clean the gutters').length, 1);

    // Reschedule and reassign.
    assert.equal((await call(`/tasks/${id}`, { token: helen, method: 'PATCH', body: { dueDate: keyOffset(1) } })).status, 200);
    assert.equal((await call(`/tasks/${id}`, { token: helen, method: 'PATCH', body: { assignees: ['helen'] } })).status, 200);
    t = (await wallTasks(helen)).find((x) => x.id === id);
    assert.equal(t.dueDate, keyOffset(1));
    assert.deepEqual(t.assignees, ['helen']);
    // Clearing the date is distinct from leaving it alone.
    await call(`/tasks/${id}`, { token: helen, method: 'PATCH', body: { dueDate: null } });
    assert.equal((await wallTasks(helen)).find((x) => x.id === id).dueDate, null);

    // Complete: it leaves the open list only once NEURO has it as done.
    assert.equal((await call(`/tasks/${id}`, { token: helen, method: 'PATCH', body: { done: true } })).status, 200);
    assert.ok(!(await wallTasks(helen)).some((x) => x.id === id), 'done: gone from the wall');
    assert.equal(db.getTaskRow(id).status, 'done', 'and recorded as done in the task store');
    // Reopen.
    assert.equal((await call(`/tasks/${id}`, { token: helen, method: 'PATCH', body: { done: false } })).status, 200);
    assert.ok((await wallTasks(helen)).some((x) => x.id === id), 'reopened: back on the wall');

    // The job's own wording is never touched by any of this.
    assert.equal(db.getTaskRow(id).text, 'Clean the gutters');

    // Refusals.
    assert.equal((await call('/tasks', { token: helen, body: { text: '   ' } })).status, 400, 'an empty job is refused');
    assert.equal((await call(`/tasks/${id}`, { token: other, method: 'PATCH', body: { done: true } })).status, 404, 'an account that cannot see the job cannot touch it');
    assert.equal(db.getTaskRow(id).status, 'open', '…and nothing changed');
    assert.equal((await call('/tasks/999999', { token: helen, method: 'PATCH', body: { done: true } })).status, 404);
    assert.equal((await call(`/tasks/${id}`, { token: helen, method: 'PATCH', body: {} })).status, 400, 'nothing to change');
    assert.equal((await call(`/tasks/${id}`, { method: 'PATCH', body: { done: true } })).status, 401, 'signed out: refused');
  } finally {
    server.close();
  }
});

test('the sheets render: a job with its full wording and a big tick, add, a person, weather, energy', async () => {
  const React = require('react');
  const { renderToString } = require('react-dom/server');
  const esbuild = require('esbuild');
  const out = await esbuild.build({
    entryPoints: [path.join(__dirname, '..', '..', 'vesta', 'src', 'views', 'WallSheets.jsx')],
    bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic',
    external: ['react', 'react-dom', 'nosleep.js/*'], loader: { '.css': 'empty' }, logLevel: 'silent',
  });
  const mod = { exports: {} };
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(mod, mod.exports, require);
  const { JobSheet, AddJobSheet, MemberSheet, WeatherSheet, EnergySheet, dueChoices, SheetBoundary } = mod.exports;
  const act = { task: async () => ({ ok: true }), addTask: async () => ({ ok: true }) };
  const people = [{ id: 'nick', label: 'Nick' }, { id: 'helen', label: 'Helen' }];
  const task = { id: 7, text: 'Book my car in for its MOT tomorrow (8 October 2026). Must do tomorrow.', short: 'Book Captur MOT', dueDate: '2026-10-12', overdue: true, dueToday: false, who: ['Nick'], assignees: ['nick'] };
  const job = renderToString(React.createElement(JobSheet, { task, people, today: '2026-10-18', act, onDone() {} }));
  assert.ok(job.includes(task.text), 'the full original wording, not the short label');
  assert.ok(job.includes('Mark this job done') && job.includes('Overdue') && job.includes('Pick a day') && job.includes('No date'));
  assert.ok(/aria-pressed="true"[^>]*>Nick</.test(job), 'who it is for is shown as chosen');
  const add = renderToString(React.createElement(AddJobSheet, { people, today: '2026-10-18', act, onSaved() {}, onCancel() {}, setDirty() {} }));
  assert.ok(add.includes('What needs doing?') && add.includes('Save') && add.includes('Cancel'));
  assert.ok(/disabled=""[^>]*>Save</.test(add), 'Save is off until there is something to save');
  const tasks = { total: 2, tasks: [task, { id: 8, text: 'Bins', who: ['Helen'], assignees: ['helen'] }] };
  const nick = renderToString(React.createElement(MemberSheet, { person: { name: 'Nick', state: 'out', role: 'person' }, tasks, today: '2026-10-18', onOpenJob() {}, onAddFor() {} }));
  assert.ok(nick.includes('Book my car in') && !nick.includes('>Bins<'), 'only jobs explicitly for him');
  assert.ok(nick.includes('Out') && nick.includes('aren’t listed per person'), 'events are not guessed per person');
  const ember = renderToString(React.createElement(MemberSheet, { person: { name: 'Ember', state: 'home', role: 'companion' }, tasks, today: '2026-10-18', onOpenJob() {}, onAddFor() {} }));
  assert.ok(ember.includes('Add a job for Ember'));
  const wx = renderToString(React.createElement(WeatherSheet, { station: { known: true, tempC: 11.4, humidityPct: 82, pressureHpa: 1009, tendency: 'falling slowly', conditionLabel: 'Partly cloudy', verdict: 'Pressure falling slowly.' }, dew: 8.44 }));
  assert.ok(wx.includes('Partly cloudy') && wx.includes('8.4°') && wx.includes('1009 hPa') && wx.includes('No forecast is held'));
  assert.ok(renderToString(React.createElement(WeatherSheet, { station: { known: false, why: 'the weather station could not be read' } })).includes('could not be read'));
  const none = renderToString(React.createElement(EnergySheet, { energy: { connected: true, fuels: { electricity: { days: [{ day: '2026-10-17', kwh: null }] } } } }));
  assert.ok(none.includes('No meter readings have arrived yet'), 'no data: an explanation, not an empty chart');
  const some = renderToString(React.createElement(EnergySheet, { energy: { connected: true, monthCostP: 7500, fuels: { electricity: { yesterday: { kwh: 9.4, costP: 260, complete: true }, month: { kwh: 150, costP: 4160 }, days: [{ day: '2026-10-16', kwh: 8, complete: true }, { day: '2026-10-17', kwh: 9.4, complete: true }] } } } }));
  assert.ok(some.includes('Yesterday 9.4 kWh') && some.includes('This month 150 kWh') && (some.match(/cine__ebar2"/g) || []).length === 2);
  assert.deepEqual(dueChoices('2026-10-18').map((c) => c.date), ['2026-10-18', '2026-10-19', '2026-10-24', '2026-10-25'], 'Sunday: Saturday is the next one');
  assert.equal(dueChoices('2026-10-24')[2].date, '2026-10-31', 'on a Saturday, "Saturday" is next week’s');
  // A malformed day key from the server must not crash the sheet (it once took the whole wall down).
  const odd = renderToString(React.createElement(EnergySheet, { energy: { connected: true, fuels: { gas: { yesterday: { kwh: 3, complete: true }, month: { kwh: 40 }, days: [{ day: 'd1', kwh: 3, complete: true }] } } } }));
  assert.ok(odd.includes('Yesterday 3.0 kWh'));
  // A sheet that throws renders nothing (and closes) instead of blanking the wall.
  let failed = false;
  const Boom = () => { throw new Error('boom'); };
  const orig = console.error; console.error = () => {};
  try {
    const { createRoot } = require('react-dom/client');
    assert.equal(typeof SheetBoundary, 'function');
    assert.equal(SheetBoundary.getDerivedStateFromError(new Error('x')).failed, true);
    const inst = new SheetBoundary({ onFail: () => { failed = true; } });
    inst.componentDidCatch(new Error('boom'));
    assert.equal(failed, true, 'the wall is told to close the sheet');
    void createRoot; void Boom;
  } finally { console.error = orig; }
});

test('the event sheet: editable family events get a form; phone events say where they live', async () => {
  const React = require('react');
  const { renderToString } = require('react-dom/server');
  const esbuild = require('esbuild');
  const out = await esbuild.build({
    entryPoints: [path.join(__dirname, '..', '..', 'vesta', 'src', 'views', 'WallSheets.jsx')],
    bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic',
    external: ['react', 'react-dom', 'nosleep.js/*'], loader: { '.css': 'empty' }, logLevel: 'silent',
  });
  const mod = { exports: {} };
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(mod, mod.exports, require);
  const { EventSheet, eventForm, eventPatch, newWallEventId } = mod.exports;
  const act = { event: { add: async () => ({ ok: true }), update: async () => ({ ok: true }), remove: async () => ({ ok: true }) } };
  const fam = { id: 'google:neu1', calendarId: 'neu1abc', editable: true, title: 'Dentist', start: '2026-10-20T10:00:00', end: '2026-10-20T10:30:00', allDay: false, location: 'Coalville' };
  const phone = { id: 'apple:x', title: 'Football', start: '2026-10-20T15:00:00', end: '2026-10-20T16:00:00', allDay: false };
  const edit = renderToString(React.createElement(EventSheet, { event: fam, today: '2026-10-18', act, canEdit: true }));
  assert.ok(edit.includes('value="Dentist"') && edit.includes('>Delete<') && edit.includes('value="10:00"') && edit.includes('value="Coalville"'));
  assert.ok(/disabled=""[^>]*>Save</.test(edit), 'nothing changed yet: Save is off');
  const ro = renderToString(React.createElement(EventSheet, { event: phone, today: '2026-10-18', act, canEdit: true }));
  assert.ok(ro.includes('Football') && ro.includes('phone calendar') && !ro.includes('>Delete<'), 'a phone event is view-only');
  const nope = renderToString(React.createElement(EventSheet, { event: fam, today: '2026-10-18', act, canEdit: false, why: 'The family calendar isn’t connected yet.' }));
  assert.ok(nope.includes('isn’t connected yet') && !nope.includes('>Delete<'));
  const add = renderToString(React.createElement(EventSheet, { date: '2026-10-21', today: '2026-10-18', act, canEdit: true }));
  assert.ok(add.includes('What’s happening?') && add.includes('value="2026-10-21"') && add.includes('shared family calendar') && !add.includes('>Delete<'));
  // Only what changed is sent; timing always as a whole.
  const before = eventForm(fam, null);
  assert.deepEqual(eventPatch(before, { ...before }), {});
  assert.deepEqual(eventPatch(before, { ...before, title: 'Dentist (Isaac)' }), { title: 'Dentist (Isaac)' });
  assert.deepEqual(eventPatch(before, { ...before, start: '11:00' }), { date: '2026-10-20', allDay: false, start: '11:00', end: '10:30' });
  const allDay = eventForm({ ...fam, allDay: true, start: '2026-10-20T00:00:00', end: '2026-10-23T00:00:00' }, null);
  assert.equal(allDay.endDate, '2026-10-22', 'Google’s exclusive end is shown as the last day');
  assert.match(newWallEventId(), /^[a-v0-9]{5,}$/, 'an id Google accepts');
});
