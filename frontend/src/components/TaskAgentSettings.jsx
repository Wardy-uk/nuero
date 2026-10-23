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
  const st = s.status || { state: s.enabled ? 'enabled' : 'disabled', label: s.enabled ? 'Task Agent: Enabled' : 'Task Agent: Disabled', say: '' };
  const rules = s.limitRules || {};
  const unsaved = unsavedFields(s, draft);
  return (
    <div className="tas" data-testid="task-agent-settings">
      <div className={`tas__status tas__status--${st.state}`} role="status" data-tas-status={st.state}>
        <div className="tas__status-label">{st.label}</div>
        {st.say && <div className="tas__status-say">{st.say}</div>}
      </div>
      <div className="tas__title">Do this (task agent)</div>
      <p className="tas__muted">Do this uses its own Anthropic key, below. It is separate from the Anthropic setting above.</p>

      <div className="tas__notice" role="note" data-tas-notice>{s.notice}</div>

      <div className="tas__row">
        <label className="tas__label" htmlFor="tas-key">API key</label>
        <div className="tas__control">
          <div className="tas__keystate" data-tas-configured={s.configured ? 'yes' : 'no'}>{s.configured ? (s.credentialSay || 'Anthropic key saved. This is configuration only: it does not turn Do this on.') : 'No key saved.'}</div>
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
        <label className="tas__label" htmlFor="tas-enabled">Do this</label>
        <div className="tas__control">
          <select id="tas-enabled" className="tas__input" value={draft.enabled ? 'enabled' : 'disabled'} disabled={busy}
            onChange={(e) => setDraft({ ...draft, enabled: e.target.value === 'enabled' })}>
            <option value="disabled">Disabled</option>
            <option value="enabled" disabled={!s.configured}>Enabled</option>
          </select>
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
          <div className="tas__inline"><span>$</span><input id="tas-usd" className="tas__input tas__input--num" type="text" inputMode="decimal" autoComplete="off" value={draft.dailyUsd} disabled={busy} onChange={(e) => setDraft({ ...draft, dailyUsd: e.target.value })} aria-describedby="tas-usd-rule" /></div>
          <p id="tas-usd-rule" className="tas__muted" data-tas-rule="dailyUsd">{rules.dailyUsd}</p>
          {fieldError(errors, 'dailyUsd') && <p className="tas__err">{fieldError(errors, 'dailyUsd')}</p>}
        </div>
      </div>

      <div className="tas__row">
        <label className="tas__label" htmlFor="tas-runs">Do this daily run limit</label>
        <div className="tas__control">
          <input id="tas-runs" className="tas__input tas__input--num" type="text" inputMode="numeric" autoComplete="off" value={draft.dailyRuns} disabled={busy} onChange={(e) => setDraft({ ...draft, dailyRuns: e.target.value })} aria-describedby="tas-runs-rule" />
          <p id="tas-runs-rule" className="tas__muted" data-tas-rule="dailyRuns">{rules.dailyRuns}</p>
          {fieldError(errors, 'dailyRuns') && <p className="tas__err">{fieldError(errors, 'dailyRuns')}</p>}
        </div>
      </div>

      {s.attempt && s.attemptRules && (
        <details className="tas__fold" data-tas-attempt>
          <summary>Do this attempt limits (advanced)</summary>
          <p className="tas__muted">{s.attemptSay}</p>
          <div className="tas__grid">
            {Object.entries(s.attemptRules).map(([k, rule]) => (
              <div className="tas__field" key={k}>
                <label htmlFor={`tas-att-${k}`}>{rule.label}</label>
                <input id={`tas-att-${k}`} className="tas__input tas__input--num" type="text" inputMode="decimal" autoComplete="off"
                  value={(draft.attempt || {})[k] ?? ''} disabled={busy}
                  onChange={(e) => setDraft({ ...draft, attempt: { ...(draft.attempt || {}), [k]: e.target.value } })} aria-describedby={`tas-att-${k}-rule`} />
                <p id={`tas-att-${k}-rule`} className="tas__muted" data-tas-rule={`attempt.${k}`}>{rule.say}{s.attemptDefaults && s.attemptDefaults[k] != null ? ` Default ${s.attemptDefaults[k]}.` : ''}</p>
                {fieldError(errors, `attempt.${k}`) && <p className="tas__err">{fieldError(errors, `attempt.${k}`)}</p>}
              </div>
            ))}
          </div>
        </details>
      )}

      <div className="tas__actions">
        <button type="button" className="btn btn-primary" onClick={onSave} disabled={busy}>Save settings</button>
        {result && <span className={`tas__result tas__result--${result.ok ? 'ok' : 'bad'}`} role="status" data-tas-result>{result.say}</span>}
      </div>
      {unsaved.length > 0 && (
        <p className="tas__unsaved" data-tas-unsaved>Not saved yet: {unsaved.join(', ')}. Saved values: {s.enabled ? 'Enabled' : 'Disabled'}, {usd(s.dailyUsd)} a day, {s.dailyRuns} runs a day.</p>
      )}

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
            {!test.result.ok && test.result.anthropic && (
              <div className="tas__muted" data-tas-test-anthropic>Anthropic said: {[test.result.anthropic.type, test.result.anthropic.message].filter(Boolean).join(' — ')}</div>
            )}
            {test.result.model && <div className="tas__muted">Model {test.result.model}{test.result.ok ? ` · ${test.result.promptTokens} in / ${test.result.completionTokens} out · ${test.result.costUsd == null ? 'cost unknown' : usd(test.result.costUsd, 5)}` : ''}</div>}
            {test.result.ledger && <div className="tas__muted">{test.result.ledger.say}</div>}
          </div>
        )}
      </div>
    </div>
  );
}

// The draft shows the SAVED values exactly (1.5 stays "1.50", never "15").
const draftOf = (s) => ({ enabled: Boolean(s && s.enabled), model: (s && s.model) || 'claude-sonnet-4-6', dailyUsd: s ? Number(s.dailyUsd).toFixed(2) : '1.00', dailyRuns: s ? String(s.dailyRuns) : '10',
  attempt: s && s.attempt ? Object.fromEntries(Object.entries(s.attempt).map(([k, v]) => [k, k === 'maxAttemptUsd' ? Number(v).toFixed(2) : String(v)])) : {} });
/** PURE. The attempt limits that differ from what is saved (sent as typed; the server refuses, never clamps). */
export function changedAttempt(s, draft) {
  const out = {};
  for (const [k, v] of Object.entries((draft && draft.attempt) || {})) {
    const saved = s && s.attempt ? s.attempt[k] : undefined;
    const t = String(v).trim();
    if (!(t !== '' && Number(t) === Number(saved) && /^\d+(\.\d{1,2})?$/.test(t))) out[k] = t;
  }
  return out;
}

/** PURE. Which fields on screen differ from what NEURO has saved. */
export function unsavedFields(s, draft) {
  if (!s || !draft) return [];
  const out = [];
  if (Boolean(draft.enabled) !== Boolean(s.enabled)) out.push('Do this on/off');
  if (draft.model !== s.model) out.push('model');
  const u = String(draft.dailyUsd).trim();
  if (!(/^\d+(\.\d{1,2})?$/.test(u) && Number(u) === Number(s.dailyUsd))) out.push('daily budget');
  const r = String(draft.dailyRuns).trim();
  if (!(/^\d+(\.0+)?$/.test(r) && Number(r) === Number(s.dailyRuns))) out.push('daily run limit');
  if (Object.keys(changedAttempt(s, draft)).length) out.push('attempt limits');
  return out;
}

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

  // The typed text goes as-is; the server parses it and refuses anything it would
  // otherwise have to round or reinterpret.
  const onSave = () => {
    const att = changedAttempt(s, draft);
    return post({ enabled: draft.enabled, model: draft.model, dailyUsd: String(draft.dailyUsd).trim(), dailyRuns: String(draft.dailyRuns).trim(), ...(Object.keys(att).length ? { attempt: att } : {}) }, 'Saved.');
  };
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
