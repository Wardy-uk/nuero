import React, { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../api';
import './TaskAgentSettings.css';

// Settings → AI & SAiM → Anthropic → "Do this" (23 Oct 2026, Stage 1).
//
// The Anthropic key Do this uses, its on/off, model and its two HARD daily limits.
// ⚠ The key is write-only from here: it is sent once in a POST body, the field is
// cleared at once, and nothing about it (not even its last four) ever comes back —
// the server reports configured: true/false and nothing else. It is never put in
// browser storage. The temporary-storage notice is the server's own sentence.

async function call(path, method = 'GET', body) {
  const res = await apiFetch(path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, body: json };
}

const usd = (n, dp = 2) => (n == null ? '—' : `$${Number(n).toFixed(dp)}`);
const fieldError = (errors, f) => ((errors || []).find((e) => e.field === f) || {}).error || null;

/** PURE view (render-tested). `s` is GET /api/task-agent/settings. */
export function TaskAgentSettingsView({ s, draft, setDraft, keyText, setKeyText, busy, result, errors, onSave, onSaveKey, onClearKey, test, onTestAsk, onTestConfirm, onTestCancel }) {
  if (!s) return <p className="tas__muted">Loading Do this settings…</p>;
  const t = s.today || {};
  return (
    <div className="tas" data-testid="task-agent-settings">
      <div className="tas__title">Do this (task agent)</div>
      <p className="tas__muted">Do this uses its own Anthropic key, below. It is separate from the Anthropic setting above.</p>

      <div className="tas__notice" role="note" data-tas-notice>{s.notice}</div>

      <div className="tas__row">
        <label className="tas__label" htmlFor="tas-key">API key</label>
        <div className="tas__control">
          <div className="tas__keystate" data-tas-configured={s.configured ? 'yes' : 'no'}>{s.configured ? 'A key is saved.' : 'No key saved.'}</div>
          <div className="tas__inline">
            <input id="tas-key" className="tas__input tas__input--key" type="password" autoComplete="new-password" spellCheck={false}
              placeholder={s.configured ? 'Paste a new key to replace it' : 'Paste the Anthropic API key'} value={keyText}
              onChange={(e) => setKeyText(e.target.value)} disabled={busy} aria-describedby="tas-key-err" />
            <button type="button" className="btn" onClick={onSaveKey} disabled={busy || !keyText.trim()}>{s.configured ? 'Replace key' : 'Save key'}</button>
            {s.configured && <button type="button" className="btn" onClick={onClearKey} disabled={busy}>Clear key</button>}
          </div>
          {fieldError(errors, 'apiKey') && <p id="tas-key-err" className="tas__err">{fieldError(errors, 'apiKey')}</p>}
        </div>
      </div>

      <div className="tas__row">
        <label className="tas__label" htmlFor="tas-enabled">Enabled</label>
        <div className="tas__control">
          <label className="tas__check">
            <input id="tas-enabled" type="checkbox" checked={draft.enabled} disabled={busy || (!s.configured && !draft.enabled)} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} />
            {draft.enabled ? 'On — Do this can run' : 'Off'}
          </label>
          {!s.configured && <p className="tas__muted">Save a key first. Running the connection test before turning it on is recommended.</p>}
          {fieldError(errors, 'enabled') && <p className="tas__err">{fieldError(errors, 'enabled')}</p>}
        </div>
      </div>

      <div className="tas__row">
        <label className="tas__label" htmlFor="tas-model">Model</label>
        <div className="tas__control">
          <select id="tas-model" className="tas__input" value={draft.model} disabled={busy} onChange={(e) => setDraft({ ...draft, model: e.target.value })}>
            {(s.models || []).map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
          {fieldError(errors, 'model') && <p className="tas__err">{fieldError(errors, 'model')}</p>}
        </div>
      </div>

      <div className="tas__row">
        <label className="tas__label" htmlFor="tas-usd">Do this daily budget</label>
        <div className="tas__control">
          <div className="tas__inline"><span>$</span><input id="tas-usd" className="tas__input tas__input--num" type="number" min="0.01" max="50" step="0.01" value={draft.dailyUsd} disabled={busy} onChange={(e) => setDraft({ ...draft, dailyUsd: e.target.value })} /></div>
          {fieldError(errors, 'dailyUsd') && <p className="tas__err">{fieldError(errors, 'dailyUsd')}</p>}
        </div>
      </div>

      <div className="tas__row">
        <label className="tas__label" htmlFor="tas-runs">Do this daily run limit</label>
        <div className="tas__control">
          <input id="tas-runs" className="tas__input tas__input--num" type="number" min="1" max="200" step="1" value={draft.dailyRuns} disabled={busy} onChange={(e) => setDraft({ ...draft, dailyRuns: e.target.value })} />
          {fieldError(errors, 'dailyRuns') && <p className="tas__err">{fieldError(errors, 'dailyRuns')}</p>}
        </div>
      </div>

      <div className="tas__actions">
        <button type="button" className="btn btn-primary" onClick={onSave} disabled={busy}>Save settings</button>
        {result && <span className={`tas__result tas__result--${result.ok ? 'ok' : 'bad'}`} role="status" data-tas-result>{result.say}</span>}
      </div>

      <div className="tas__today" data-tas-today>
        <div className="tas__h">Today</div>
        {t.known === false ? <p className="tas__err">NEURO cannot read today’s Do this spend, so Do this will not run until it can.</p> : (
          <ul className="tas__stats">
            <li><b>{usd(t.usd)}</b> spent of {usd(s.dailyUsd)} · <b>{usd(t.remainingUsd)}</b> left</li>
            <li><b>{t.runs ?? '—'}</b> of {s.dailyRuns} runs · <b>{t.remainingRuns ?? '—'}</b> left</li>
            <li>{t.requests ?? '—'} model request{t.requests === 1 ? '' : 's'}</li>
            <li>Resets at midnight (UK time)</li>
          </ul>
        )}
        <p className="tas__cap" data-tas-cap>{s.capSay}</p>
        {s.stepUsd != null && <p className="tas__muted">A run, or its next step, starts only if the most one step could cost ({usd(s.stepUsd)} with this model) still fits in what is left today.</p>}
      </div>

      <div className="tas__test">
        <div className="tas__h">Test Anthropic connection</div>
        {!s.configured ? <p className="tas__muted">Save a key to test it.</p> : test.stage === 'confirm' ? (
          <div className="tas__confirm">
            <p>This sends one tiny request to Anthropic using fixed test text (about {usd(test.estimateUsd, 4)}). No task, draft or note is touched.</p>
            <button type="button" className="btn btn-primary" onClick={onTestConfirm} disabled={busy}>Send the test request</button>
            <button type="button" className="btn" onClick={onTestCancel} disabled={busy}>Cancel</button>
          </div>
        ) : (
          <button type="button" className="btn" onClick={onTestAsk} disabled={busy}>Test connection…</button>
        )}
        {test.result && (
          <div className={`tas__testresult tas__testresult--${test.result.ok ? 'ok' : 'bad'}`} data-tas-test-result role="status">
            <div>{test.result.ok ? test.result.say : `Failed: ${test.result.error}`}</div>
            {test.result.model && <div className="tas__muted">Model {test.result.model}{test.result.ok ? ` · ${test.result.promptTokens} in / ${test.result.completionTokens} out · ${test.result.costUsd == null ? 'cost unknown' : usd(test.result.costUsd, 5)}` : ''}</div>}
            {test.result.ledger && <div className="tas__muted">{test.result.ledger.say}</div>}
          </div>
        )}
      </div>
    </div>
  );
}

const draftOf = (s) => ({ enabled: Boolean(s && s.enabled), model: (s && s.model) || 'claude-sonnet-4-6', dailyUsd: s ? String(s.dailyUsd) : '1.00', dailyRuns: s ? String(s.dailyRuns) : '10' });

export default function TaskAgentSettings() {
  const [s, setS] = useState(null);
  const [draft, setDraft] = useState(draftOf(null));
  const [keyText, setKeyText] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [errors, setErrors] = useState([]);
  const [test, setTest] = useState({ stage: null, estimateUsd: null, result: null });

  const load = useCallback(async () => {
    const r = await call('/api/task-agent/settings');
    if (r.status === 200 && r.body) { setS(r.body); setDraft(draftOf(r.body)); } else setResult({ ok: false, say: (r.body && r.body.error) || `Could not load (${r.status}).` });
  }, []);
  useEffect(() => { load(); }, [load]);

  const post = async (body, okSay) => {
    setBusy(true); setResult(null); setErrors([]);
    try {
      const r = await call('/api/task-agent/settings', 'POST', body);
      if (r.status === 200 && r.body && r.body.ok) {
        setS(r.body.settings); setDraft(draftOf(r.body.settings));
        setResult({ ok: true, say: r.body.changed && r.body.changed.length ? okSay : 'Nothing changed.' });
        return true;
      }
      setErrors((r.body && r.body.errors) || []);
      setResult({ ok: false, say: 'Not saved — see the highlighted field.' });
      return false;
    } catch { setResult({ ok: false, say: 'Not saved — NEURO did not answer.' }); return false; } finally { setBusy(false); }
  };

  const onSave = () => post({ enabled: draft.enabled, model: draft.model, dailyUsd: Number(draft.dailyUsd), dailyRuns: Number(draft.dailyRuns) }, 'Saved.');
  const onSaveKey = async () => {
    const k = keyText;
    setKeyText(''); // never keep it in the page longer than the request
    await post({ apiKey: k }, 'Key saved. It will not be shown again.');
  };
  const onClearKey = () => post({ clearKey: true }, 'Key cleared. Do this is off.');
  const onTestAsk = async () => {
    setBusy(true);
    try {
      const r = await call('/api/task-agent/settings/test', 'POST', {});
      if (r.body && r.body.needsConfirm) setTest({ stage: 'confirm', estimateUsd: r.body.estimateUsd, result: null });
      else setTest({ stage: null, estimateUsd: null, result: r.body || { ok: false, error: `HTTP ${r.status}` } });
    } finally { setBusy(false); }
  };
  const onTestConfirm = async () => {
    setBusy(true);
    try {
      const r = await call('/api/task-agent/settings/test', 'POST', { confirm: true });
      setTest({ stage: null, estimateUsd: null, result: r.body || { ok: false, error: `HTTP ${r.status}` } });
      await load();
    } catch { setTest({ stage: null, estimateUsd: null, result: { ok: false, error: 'NEURO did not answer.' } }); } finally { setBusy(false); }
  };
  const onTestCancel = () => setTest({ stage: null, estimateUsd: null, result: null });

  return <TaskAgentSettingsView s={s} draft={draft} setDraft={setDraft} keyText={keyText} setKeyText={setKeyText} busy={busy} result={result} errors={errors}
    onSave={onSave} onSaveKey={onSaveKey} onClearKey={onClearKey} test={test} onTestAsk={onTestAsk} onTestConfirm={onTestConfirm} onTestCancel={onTestCancel} />;
}
