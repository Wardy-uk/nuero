'use strict';

/**
 * Settings → AI & SAiM → Anthropic → "Do this", driven in a real browser
 * (Electron's Chromium) against the REAL routes, auth, guard and settings service
 * over a throwaway DB, at desktop (1440×900) and phone (390×844) width. Only the
 * Anthropic SDK client is scripted. Proves, on screen:
 *
 *  - the defaults (off, no key, $1.00, 10 runs), the notice and the cap statement;
 *  - pasting a key and pressing Save: the field empties, the page says only "A key
 *    is saved", and the key is nowhere in the page, the network responses or
 *    browser storage;
 *  - an invalid budget is refused with the field named and the explicit result;
 *  - the connection test asks first, then reports model, tokens, cost and ledger;
 *  - no horizontal scroll at either width.
 * Screenshots with TA_SHOTS=<dir>.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const esbuild = require('esbuild');

const ROOT = path.resolve(__dirname, '..', '..');
const MAIN_CHECKOUT = require('./electron-driver-support').mainCheckout(ROOT);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'task-agent-settings-ui-'));
const SHOTS = process.env.TA_SHOTS || path.join(tmp, 'shots');
process.env.NEURO_DB_PATH = path.join(tmp, 'agent.db');
process.env.OBSIDIAN_VAULT_PATH = path.join(tmp, 'vault');
process.env.NEURO_PIN = 'pin-1234';
process.env.NEURO_API_TOKEN = 'tok-5678';
delete process.env.ANTHROPIC_API_KEY;
delete process.env.AI_GATE_MODE;
process.env.AI_MODE = 'hybrid';
const nodePaths = [path.join(ROOT, 'node_modules'), ...String(process.env.NODE_PATH || '').split(path.delimiter).filter(Boolean)];
global.fetch = async () => { throw new Error('network blocked'); };

const KEY = 'sk-ant-api03-SCREEN-test-key-XYZW-1234abcd';

function electronBinary() {
  if (process.env.ELECTRON_PATH && fs.existsSync(process.env.ELECTRON_PATH)) return process.env.ELECTRON_PATH;
  for (const b of [path.join(ROOT, 'saim', 'desktop-electron'), ROOT, path.join(MAIN_CHECKOUT, 'saim', 'desktop-electron')]) {
    try { const p = require(require.resolve('electron', { paths: [b] })); if (typeof p === 'string' && fs.existsSync(p)) return p; } catch { /* not here */ }
  }
  return null;
}
function reactDir() {
  for (const b of [path.join(ROOT, 'frontend', 'node_modules'), path.join(ROOT, 'node_modules'), path.join(MAIN_CHECKOUT, 'node_modules')]) {
    if (fs.existsSync(path.join(b, 'react', 'package.json'))) return b;
  }
  return null;
}

const anthropic = require('./providers/anthropic-provider');
anthropic._internals.setClient({ messages: { create: async () => ({ model: 'claude-sonnet-4-6', content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn', usage: { input_tokens: 31, output_tokens: 2 } }) } });

let server; let skipWhy = null; const results = {}; const responses = [];

const MEASURE = `(() => {
  const vw = document.documentElement.clientWidth;
  const root = document.querySelector('[data-testid="task-agent-settings"]');
  let store = ''; try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); store += k + '=' + localStorage.getItem(k) + ';'; } for (let i = 0; i < sessionStorage.length; i++) { const k = sessionStorage.key(i); store += k + '=' + sessionStorage.getItem(k) + ';'; } } catch {}
  return {
    vw, sw: document.documentElement.scrollWidth,
    text: root ? root.textContent : '', html: document.documentElement.outerHTML,
    keyValue: (document.getElementById('tas-key') || {}).value,
    keyType: (document.getElementById('tas-key') || {}).type,
    enabledDisabled: (document.getElementById('tas-enabled') || {}).disabled,
    store,
    over: [...document.querySelectorAll('.tas *')].filter((e) => { const b = e.getBoundingClientRect(); return b.width && b.right > vw + 1; }).slice(0, 5).map((e) => String(e.className || e.tagName)),
  };
})()`;

const setVal = (sel, v) => `(() => { const el = document.querySelector(${JSON.stringify(sel)}); const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set; set.call(el, ${JSON.stringify(v)}); el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`;
const click = (t) => `(() => { const b = [...document.querySelectorAll('.tas button')].find((x) => x.textContent.trim() === ${JSON.stringify(t)}); if (!b || b.disabled) return false; b.click(); return true; })()`;
const textIs = (t) => `(document.querySelector('[data-testid="task-agent-settings"]') || {}).textContent?.includes(${JSON.stringify(t)})`;

test.before(async () => {
  const db = require('../db/database');
  await db.init();
  const bin = electronBinary(); const nm = reactDir();
  if (!bin || !nm) { skipWhy = !bin ? 'no Electron binary here (set ELECTRON_PATH) — the screen was NOT measured' : 'no react installed'; return; }

  const www = path.join(tmp, 'www'); fs.mkdirSync(www, { recursive: true });
  const slash = (p) => p.replace(/\\/g, '/');
  const entry = path.join(tmp, 'entry.jsx');
  fs.writeFileSync(entry, `
import React from 'react';
import { createRoot } from 'react-dom/client';
import ${JSON.stringify(slash(path.join(ROOT, 'frontend/src/index.css')))};
import ${JSON.stringify(slash(path.join(ROOT, 'frontend/src/components/AdminPanel.css')))};
import TaskAgentSettings from ${JSON.stringify(slash(path.join(ROOT, 'frontend/src/components/TaskAgentSettings.jsx')))};
createRoot(document.getElementById('root')).render(React.createElement('main', { className: 'main-panel', style: { padding: 16 } }, React.createElement('div', { className: 'ai-setting-group' }, React.createElement('div', { className: 'ai-setting-group-title' }, 'Anthropic'), React.createElement(TaskAgentSettings))));
`);
  await esbuild.build({
    entryPoints: { app: entry }, bundle: true, outdir: www, format: 'esm', platform: 'browser', jsx: 'automatic', logLevel: 'silent',
    loader: { '.png': 'dataurl', '.svg': 'dataurl', '.woff2': 'dataurl', '.woff': 'dataurl' },
    define: { 'import.meta.env': JSON.stringify({ VITE_API_URL: '', DEV: false, PROD: true, MODE: 'production' }) },
    alias: { react: path.join(nm, 'react'), 'react-dom': path.join(nm, 'react-dom'), 'react/jsx-runtime': path.join(nm, 'react', 'jsx-runtime.js') },
    nodePaths: [nm, ...nodePaths],
  });
  fs.writeFileSync(path.join(www, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"><style>*{animation:none!important;transition:none!important}</style></head><body><div id="root"></div><script>localStorage.setItem("neuro_pin","pin-1234")</script><script type="module" src="/app.js"></script></body></html>');

  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api', (req, res, next) => { const send = res.send.bind(res); res.send = (b) => { responses.push(String(b)); return send(b); }; next(); });
  app.use('/api', require('./api-auth'));
  app.use('/api', require('./authority-guard').guard);
  app.use('/api/task-agent', require('../routes/task-agent'));
  app.use(express.static(www));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/`;

  fs.mkdirSync(SHOTS, { recursive: true });
  const drv = path.join(tmp, 'driver'); fs.mkdirSync(drv);
  fs.writeFileSync(path.join(drv, 'package.json'), '{"name":"tas-driver","main":"main.js","private":true}');
  fs.writeFileSync(path.join(drv, 'main.js'), DRIVER);
  for (const [w, h] of [[1440, 900], [390, 844]]) {
    db.setState('task_agent_settings', ''); db.setState('task_agent_anthropic_key', ''); // each width starts from the defaults
    const steps = [
      { name: 'initial', run: 'true', until: textIs('No key saved.') },
      { name: 'bad-budget', run: `${setVal('#tas-usd', '0')} && ${click('Save settings')}`, until: textIs('Not saved — see the highlighted field.') },
      { name: 'key-saved', run: `${setVal('#tas-key', KEY)} && ${click('Save key')}`, until: textIs('A key is saved.') },
      { name: 'test-confirm', run: click('Test connection…'), until: textIs('Send the test request') },
      { name: 'test-result', run: click('Send the test request'), until: textIs('Connected') },
    ];
    const env = { ...process.env, NW_URL: base, NW_JOB: path.join(tmp, 'job.json'), NW_OUT: path.join(tmp, 'out.json') };
    delete env.ELECTRON_RUN_AS_NODE;
    fs.writeFileSync(env.NW_JOB, JSON.stringify({ w, h, steps, shots: SHOTS, measure: MEASURE }));
    try { fs.rmSync(env.NW_OUT); } catch { /* none */ }
    await new Promise((resolve) => {
      const c = require('child_process').spawn(bin, [drv], { env, stdio: ['ignore', 'ignore', 'pipe'] });
      let err = ''; c.stderr.on('data', (d) => { err += d; });
      const t = setTimeout(() => c.kill(), 120000);
      c.on('exit', () => { clearTimeout(t); try { results[`${w}x${h}`] = JSON.parse(fs.readFileSync(env.NW_OUT, 'utf8')); } catch { results[`${w}x${h}`] = { error: `no result: ${err.slice(0, 400)}` }; } resolve(); });
    });
  }
});
test.after(() => { try { server && server.close(); } catch { /* */ } if (!process.env.TA_SHOTS) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp */ } } });

const { LOAD_WITH_RETRY } = require('./electron-driver-support');
const DRIVER = String.raw`
const { app, BrowserWindow } = require('electron'); const fs = require('fs'); const path = require('path');
${LOAD_WITH_RETRY}
const job = JSON.parse(fs.readFileSync(process.env.NW_JOB, 'utf8'));
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const fail = (e) => { fs.writeFileSync(process.env.NW_OUT, JSON.stringify({ error: String(e && e.stack || e) })); app.exit(1); };
process.on('unhandledRejection', fail); process.on('uncaughtException', fail);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
app.whenReady().then(async () => {
  const { w, h } = job; const out = { steps: [] };
  const win = new BrowserWindow({ width: w, height: h, useContentSize: true, show: false, webPreferences: { offscreen: true } });
  win.setContentSize(w, h);
  await loadWithRetry(win, process.env.NW_URL);
  const js = (c) => win.webContents.executeJavaScript(c);
  const until = async (cond) => { const t0 = Date.now(); while (Date.now() - t0 < 20000 && !(await js(cond))) await sleep(150); return js(cond); };
  for (const s of job.steps) {
    await until('!!document.querySelector(\'[data-testid="task-agent-settings"]\')');
    const ran = await js(s.run);
    const ok = await until(s.until);
    await sleep(300);
    const m = await js(job.measure);
    const H = await js('document.documentElement.scrollHeight'); win.setContentSize(w, Math.min(H, 4000)); await sleep(300);
    fs.writeFileSync(path.join(job.shots, 'settings-' + s.name + '-' + w + 'x' + h + '.png'), (await win.webContents.capturePage()).toPNG());
    win.setContentSize(w, h); await sleep(150);
    out.steps.push({ name: s.name, ran, ok, ...m });
  }
  win.destroy();
  fs.writeFileSync(process.env.NW_OUT, JSON.stringify(out));
  app.quit();
});`;

for (const size of ['1440x900', '390x844']) {
  test(`Settings screen at ${size}: defaults, invalid budget, key saved and never shown, connection test`, (t) => {
    if (skipWhy) return t.skip(skipWhy);
    const r = results[size];
    assert.ok(r && !r.error, r && r.error);
    const by = Object.fromEntries(r.steps.map((s) => [s.name, s]));
    for (const s of r.steps) {
      assert.ok(s.ok, `${size} ${s.name}: reached`);
      assert.equal(s.sw, s.vw, `${size} ${s.name}: no horizontal scroll`);
      assert.deepEqual(s.over, [], `${size} ${s.name}: nothing past the right edge`);
    }
    const i = by.initial;
    assert.match(i.text, /No key saved\./);
    assert.equal(i.enabledDisabled, true, 'Enabled cannot be switched on without a key');
    assert.match(i.text, /\$0\.00 spent of \$1\.00/);
    assert.match(i.text, /0 of 10 runs/);
    assert.match(i.text, /This key is stored on this NEURO server\. Encrypted secret storage is the next security upgrade\./);
    assert.match(i.text, /independent of the wider AI gate, which is still in shadow mode/);
    assert.equal(i.keyType, 'password');

    assert.match(by['bad-budget'].text, /Enter an amount above \$0 and up to \$50\./);

    const k = by['key-saved'];
    assert.match(k.text, /A key is saved\./);
    assert.match(k.text, /Key saved\. It will not be shown again\./);
    assert.equal(k.keyValue, '', 'the field is emptied');
    for (const s of r.steps.slice(2)) {
      assert.ok(!s.html.includes(KEY) && !s.html.includes(KEY.slice(-4)), `${s.name}: the key (or its last four) is not in the page`);
      assert.ok(!s.store.includes(KEY) && !s.store.includes(KEY.slice(-4)), `${s.name}: not in browser storage`);
    }
    assert.match(by['test-confirm'].text, /one tiny request/);
    const tr = by['test-result'];
    assert.match(tr.text, /Connected/);
    assert.match(tr.text, /claude-sonnet-4-6/);
    assert.match(tr.text, /31 in \/ 2 out/);
    assert.match(tr.text, /Recorded on the shared AI ledger/);
  });
}

test('no API response to the browser carried the key, its last four or its length', (t) => {
  if (skipWhy) return t.skip(skipWhy);
  assert.ok(responses.length >= 8, 'responses were captured');
  for (const b of responses) {
    assert.ok(!b.includes(KEY) && !b.includes(KEY.slice(-4)), 'no key material');
    assert.ok(!new RegExp(`"(len|length|keyLength)"\\s*:\\s*${KEY.length}\\b`).test(b));
  }
});
