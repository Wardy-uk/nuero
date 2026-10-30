import React, { useState, useRef, useEffect, useCallback } from 'react';
import { apiUrl } from '../api';
import './CapturePanel.css';

const MAX_SIZE = 10 * 1024 * 1024;
const QUEUE_KEY = 'neuro_offline_queue';

function getQueue() {
  try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]'); }
  catch { return []; }
}

function addToQueue(item) {
  const q = getQueue();
  q.push({ ...item, queuedAt: Date.now() });
  localStorage.setItem(QUEUE_KEY, JSON.stringify(q));
}

async function drainQueue(onDrained) {
  const q = getQueue();
  if (q.length === 0) return;
  const remaining = [];
  for (const item of q) {
    try {
      const res = await fetch(item.url, {
        method: 'POST',
        headers: item.headers || { 'Content-Type': 'application/json' },
        body: item.body
      });
      if (!res.ok) remaining.push(item);
    } catch {
      remaining.push(item);
    }
  }
  localStorage.setItem(QUEUE_KEY, JSON.stringify(remaining));
  if (remaining.length < q.length && onDrained) onDrained(q.length - remaining.length);
}

// #114 — the capture section of the feature tracker, read back.
// Capture wrote into the tracker from three surfaces and nothing ever read it,
// so the only way to see whether an idea had landed was to open the file. This
// is the cheapest honest version: a count and the last few rows, shown where the
// confirmation already appears.
function useCapturedFeatures(active) {
  const [state, setState] = useState({ status: 'idle', items: [], total: 0 });

  const load = useCallback(async () => {
    setState(s => (s.status === 'idle' ? { ...s, status: 'loading' } : s));
    try {
      const res = await fetch(apiUrl('/api/features/captured?limit=3'));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setState({ status: 'ok', items: data.items || [], total: data.total || 0 });
    } catch {
      // "Couldn't ask" is not "there are none" (#28). The panel says so.
      setState(s => ({ ...s, status: 'error' }));
    }
  }, []);

  useEffect(() => { if (active) load(); }, [active, load]);
  return { ...state, reload: load };
}

// ── The single way in (30 Oct 2026) ─────────────────────────────────────────
// Nick: "rebuild the capture box to be able to capture everything that NEURO
// captures everywhere — single way in". One box, a row of chips saying where it
// goes. NEURO GUESSES the chip (rules first, the model only when unsure) and
// Nick confirms: nothing is filed on a guess he has not seen. The chips and the
// fields each needs come from the server (GET /api/capture-hub/kinds) so the
// box and the routes cannot disagree about what exists.

const todayKey = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const json = (body) => ({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

/** PURE. Kind + text + fields → the request that files it, or an error message. */
export function buildRequest(kind, text, f = {}) {
  const t = text.trim();
  const first = t.split('\n')[0].trim();
  const rest = t.split('\n').slice(1).join('\n').trim();
  const need = (cond, msg) => (cond ? null : msg);
  const num = (v) => (v === '' || v === undefined || v === null ? undefined : Number(v));
  switch (kind) {
    case 'task': return { url: '/api/capture/todo', ...json({ text: t, priority: 'normal' }) };
    case 'done': return { url: '/api/tasks/quick-log', ...json({ text: t }) };
    case 'note': return { url: '/api/capture/note', ...json({ title: null, content: t }) };
    case 'chris': return { url: '/api/weekly-risk/chris-agenda', ...json({ text: t }) };
    case 'feature': return { url: '/api/capture/feature', ...json({ title: first, notes: rest || undefined, system: f.system || 'NEURO', source: 'NEURO Capture' }) };
    case 'journal': return { url: '/api/journal/save', ...json({ entries: [{ prompt: 'Captured', response: t }] }) };
    case 'catalogue': {
      const err = need(f.slug, 'Pick a catalogue') || need(f.section, 'Pick a section');
      return err ? { error: err } : { url: `/api/catalogues/${encodeURIComponent(f.slug)}/add`, ...json({ section: f.section, name: t }) };
    }
    case 'mgmt-log': return { url: '/api/weekly-risk/log', ...json({ summary: t, type: f.type || 'action', person: f.person || null, dueDate: f.dueDate || null, owner: 'Nick' }) };
    case 'report-fix': {
      const impact = f.impact || [];
      const err = need(f.system, 'Pick the system') || need((f.problem || '').trim(), 'Say what was wrong') || need(impact.length, 'Pick at least one impact') || need(f.deployedOn, 'When was it deployed?')
        || (impact.includes('figures') ? need(f.measure && f.from && f.to, 'Name the figure affected and the dates') : null);
      if (err) return { error: err };
      const affects = impact.includes('figures') ? [{ measure: f.measure, from: f.from, to: f.to }] : [];
      return { url: '/api/report-fixes/manual', ...json({ system: f.system, title: first, problem: f.problem, impact, affects, deployedOn: f.deployedOn }) };
    }
    case 'blocker': return f.projectId ? { url: `/api/projects/${encodeURIComponent(f.projectId)}/blockers`, ...json({ what: t, unblock: f.unblock || null }) } : { error: 'Pick the project' };
    case 'date': {
      const err = need(f.entity, 'Whose date is it?') || need(f.date, 'Pick the date');
      return err ? { error: err } : { url: '/api/loops/personal-dates/declared', ...json({ entity: f.entity, kind: f.kind || 'birthday', date: f.date }) };
    }
    case 'care': {
      const err = need(f.companionId, 'Who is it for?') || need(f.kind, 'Pick the kind of care');
      return err ? { error: err } : { url: `/api/canonical/companions/${encodeURIComponent(f.companionId)}/care`, ...json({ kind: f.kind, title: t, dueDate: f.dueDate || null }) };
    }
    case 'finance': {
      const err = need(f.kind, 'Pick the kind') || need(f.dueDate, 'When is it due?');
      const pence = num(f.amount) !== undefined ? Math.round(num(f.amount) * 100) : undefined;
      return err ? { error: err } : { url: '/api/finance/obligations', ...json({ kind: f.kind, title: t, dueDate: f.dueDate, expectedAmountPence: pence }) };
    }
    case 'mileage': {
      const err = need(f.vehicleId, 'Pick the vehicle') || need(num(f.value), 'Enter the miles');
      return err ? { error: err } : { url: `/api/vehicle/${encodeURIComponent(f.vehicleId)}/mileage`, ...json({ value: num(f.value), observedOn: f.observedOn || todayKey(), note: t || undefined }) };
    }
    case 'fuel': {
      const err = need(f.vehicleId, 'Pick the vehicle') || need(num(f.litres), 'Enter the litres') || need(num(f.odometer), 'Enter the odometer');
      return err ? { error: err } : { url: `/api/vehicle/${encodeURIComponent(f.vehicleId)}/fuel`, ...json({ filledOn: f.filledOn || todayKey(), litres: num(f.litres), odometer: num(f.odometer), fullTank: f.fullTank !== false, note: t || undefined }) };
    }
    case 'leisure': return f.kind ? { url: '/api/leisure/items', ...json({ kind: f.kind, title: t, creator: f.creator || undefined, state: f.state || 'saved' }) } : { error: 'Pick the kind' };
    case 'goal': return { url: '/api/canonical/goals', ...json({ title: t, reviewDate: f.reviewDate || undefined }) };
    default: return { url: '/api/capture-hub/file', ...json({ kind, text: t, fields: f }) };
  }
}

/** PURE. Which kinds need no words of their own (the fields carry it). */
const TEXTLESS = new Set(['date', 'mileage', 'fuel']);

function defaultsFor(kind, kinds) {
  const k = kinds.find((x) => x.id === kind);
  const out = {};
  for (const fd of k?.fields || []) {
    if (fd.default === 'today') out[fd.name] = todayKey();
    else if (fd.default !== undefined) out[fd.name] = fd.default;
  }
  return out;
}

function useCaptureHub() {
  const [kinds, setKinds] = useState(null);
  const [options, setOptions] = useState(null);
  useEffect(() => {
    fetch(apiUrl('/api/capture-hub/kinds')).then((r) => r.json()).then((d) => setKinds(d.kinds || [])).catch(() => setKinds([]));
  }, []);
  const loadOptions = useCallback(() => {
    if (options) return;
    fetch(apiUrl('/api/capture-hub/options')).then((r) => r.json()).then(setOptions).catch(() => setOptions({ failed: true }));
  }, [options]);
  return { kinds, options, loadOptions };
}

function FieldInput({ field, value, onChange, options, kindFields }) {
  const id = `cap-${field.name}`;
  let list = field.options ? field.options.map((o) => ({ value: o, label: o.replace(/_/g, ' ') })) : null;
  if (field.optionsFrom) {
    if (field.optionsFrom === 'catalogueSections') {
      const cat = (options?.catalogues || []).find((c) => c.value === kindFields.slug);
      list = (cat?.sections || []).map((s) => ({ value: s, label: s }));
    } else {
      const src = options?.[field.optionsFrom];
      list = src === undefined ? [] : src === null ? null : src.map((o) => (typeof o === 'string' ? { value: o, label: o } : o));
    }
  }
  const label = <label htmlFor={id} className="capture-field-label">{field.label}{field.required ? ' *' : ''}</label>;
  if (field.type === 'checkbox') {
    return (
      <div className="capture-field capture-field--check">
        <label className="capture-field-label"><input id={id} type="checkbox" checked={value !== false} onChange={(e) => onChange(e.target.checked)} /> {field.label}</label>
      </div>
    );
  }
  if (field.type === 'multi') {
    const vals = value || [];
    return (
      <div className="capture-field">
        <span className="capture-field-label">{field.label}{field.required ? ' *' : ''}</span>
        <div className="capture-field-multi">
          {field.options.map((o) => (
            <label key={o}><input type="checkbox" checked={vals.includes(o)} onChange={(e) => onChange(e.target.checked ? [...vals, o] : vals.filter((v) => v !== o))} /> {o}</label>
          ))}
        </div>
      </div>
    );
  }
  if (field.type === 'textarea') {
    return <div className="capture-field capture-field--wide">{label}<textarea id={id} className="capture-input" rows={2} value={value || ''} onChange={(e) => onChange(e.target.value)} /></div>;
  }
  if (field.type === 'select' || (list && !field.free)) {
    return (
      <div className="capture-field">
        {label}
        {list === null
          ? <span className="capture-field-gap">Couldn't load the list</span>
          : (
            <select id={id} className="capture-input" value={value || ''} onChange={(e) => onChange(e.target.value)}>
              <option value="">—</option>
              {list.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          )}
      </div>
    );
  }
  return (
    <div className="capture-field">
      {label}
      <input id={id} className="capture-input" type={field.type === 'date' ? 'date' : field.type === 'number' ? 'number' : 'text'}
        list={list ? `${id}-list` : undefined} value={value ?? ''} onChange={(e) => onChange(e.target.value)} />
      {list && <datalist id={`${id}-list`}>{list.map((o) => <option key={o.value} value={o.value} />)}</datalist>}
    </div>
  );
}

export default function CapturePanel() {
  const [content, setContent] = useState('');
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState(null);
  const [recent, setRecent] = useState([]);
  const [queueCount, setQueueCount] = useState(getQueue().length);
  const [showAttach, setShowAttach] = useState(false);
  const [guess, setGuess] = useState(null);       // what NEURO thinks
  const [picked, setPicked] = useState(null);     // what Nick chose — wins over the guess
  const [fields, setFields] = useState({});
  const fileRef = useRef(null);
  const textRef = useRef(null);
  const asked = useRef('');
  const { kinds, options, loadOptions } = useCaptureHub();

  const kind = picked || guess?.kind || null;
  const kindDef = (kinds || []).find((k) => k.id === kind) || null;

  const captured = useCapturedFeatures(kind === 'feature' || result?.kind === 'feature');

  // The guess. Debounced, asked once per wording, and only while Nick has not
  // chosen a chip himself — his choice is never overwritten by a later guess.
  useEffect(() => {
    if (picked || file) return undefined;
    const text = content.trim();
    if (!text) { setGuess(null); return undefined; }
    const timer = setTimeout(async () => {
      if (asked.current === text) return;
      asked.current = text;
      try {
        const res = await fetch(apiUrl('/api/capture-hub/classify'), { method: 'POST', ...json({ text }) });
        const d = await res.json();
        if (asked.current !== text || !d.ok) return;
        setGuess({ kind: d.kind, by: d.by, confidence: d.confidence, prefill: d.prefill || {}, prefixed: d.by === 'prefix', clean: d.text });
      } catch {
        if (asked.current === text) setGuess({ kind: 'note', by: 'offline', confidence: 'default', prefill: {} });
      }
    }, 700);
    return () => clearTimeout(timer);
  }, [content, picked, file]);

  // Defaults + what the guess lifted out of the words, without overwriting
  // anything Nick has already typed into a field.
  useEffect(() => {
    if (!kind || !kinds) return;
    const base = { ...defaultsFor(kind, kinds), ...(picked ? {} : guess?.prefill || {}) };
    setFields((cur) => ({ ...base, ...Object.fromEntries(Object.entries(cur).filter(([k, v]) => v !== '' && v !== undefined && (kindDef?.fields || []).some((f) => f.name === k))) }));
    if (kindDef?.fields?.some((f) => f.optionsFrom)) loadOptions();
  }, [kind, kinds]); // eslint-disable-line react-hooks/exhaustive-deps

  const resetForm = () => {
    setContent(''); setFile(null); setPreview(null); setResult(null); setShowAttach(false);
    setGuess(null); setPicked(null); setFields({}); asked.current = '';
    if (fileRef.current) fileRef.current.value = '';
  };

  const fetchRecent = useCallback(async () => {
    try {
      const res = await fetch(apiUrl('/api/capture/recent'));
      const data = await res.json();
      setRecent(data.items || []);
    } catch {}
  }, []);

  useEffect(() => { fetchRecent(); }, [fetchRecent]);

  useEffect(() => {
    const drain = () => drainQueue((count) => {
      setQueueCount(getQueue().length);
      if (count > 0) fetchRecent();
    });
    drain();
    const onVisible = () => { if (!document.hidden) drain(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [fetchRecent]);

  const handleFileSelect = (e) => {
    const f = e.target.files[0];
    if (!f) return;
    if (f.size > MAX_SIZE) { setResult({ error: 'File too large — 10MB maximum' }); return; }
    setFile(f);
    setResult(null);
    if (f.type.startsWith('image/')) {
      const reader = new FileReader();
      reader.onload = (ev) => setPreview(ev.target.result);
      reader.readAsDataURL(f);
    } else setPreview(null);
  };

  // A prefix ("chris: …") is an instruction, not part of the thing — file the
  // words after it. Typed prose with no prefix is filed exactly as typed.
  const textToFile = () => (!picked && guess?.prefixed && guess.clean ? guess.clean : content.trim());

  const submit = async () => {
    setSubmitting(true);
    setResult(null);
    try {
      if (file) {
        const formData = new FormData();
        formData.append('file', file);
        const endpoint = file.type.startsWith('image/') ? '/api/capture/photo' : '/api/capture/file';
        const res = await fetch(apiUrl(endpoint), { method: 'POST', body: formData });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) setResult({ error: data.error || `Capture failed (${res.status})` });
        else { setResult({ success: true, kind: 'file', where: 'Saved to the vault.' }); fetchRecent(); setTimeout(resetForm, 3000); }
        return;
      }
      const req = buildRequest(kind, textToFile(), fields);
      if (req.error) { setResult({ error: req.error }); return; }
      let res;
      try {
        res = await fetch(apiUrl(req.url), { method: 'POST', headers: req.headers, body: req.body });
      } catch {
        // Offline: queued on this device and said so. It has not reached NEURO.
        addToQueue({ url: apiUrl(req.url), headers: req.headers, body: req.body });
        setQueueCount(getQueue().length);
        setResult({ queued: true });
        setTimeout(resetForm, 2500);
        return;
      }
      const data = await res.json().catch(() => ({}));
      if (res.status === 207) {
        // The words are on disk; the task row is not. Never "failed".
        setResult({ partial: true, kind, vault: data.vault, error: data.error });
      } else if (!res.ok || data.ok === false) {
        setResult({ error: res.status === 401 ? 'Not logged in — open Settings and re-enter your PIN' : (data.error || data.message || `Capture failed (${res.status})`) });
        try { navigator.vibrate?.([200, 100, 200]); } catch {}
      } else {
        setResult({ success: true, kind, where: savedLine(kind, kindDef, data) });
        try { navigator.vibrate?.(100); } catch {}
        fetchRecent();
        if (kind === 'feature') captured.reload();
        setTimeout(resetForm, 3000);
      }
    } finally {
      setSubmitting(false);
    }
  };

  const needsText = !TEXTLESS.has(kind);
  const canSubmit = !!file || (!!kind && (!needsText || content.trim().length > 0));
  const quick = (kinds || []).filter((k) => k.group === 'quick');
  const forms = (kinds || []).filter((k) => k.group === 'form');

  const chip = (k) => (
    <button key={k.id} type="button"
      className={`capture-chip${kind === k.id ? ' capture-chip--on' : ''}${!picked && guess?.kind === k.id ? ' capture-chip--guess' : ''}`}
      onClick={() => { setPicked(picked === k.id ? null : k.id); setResult(null); }}
      title={k.hint}
      disabled={!!file}>
      {k.label}
    </button>
  );

  return (
    <div className="capture-panel">
      <div className="capture-saim">
        <span className="capture-saim-label">SAiM</span>
        <span className="capture-saim-line">Get it out of your head. Everything comes in here — I'll suggest where it goes.</span>
      </div>

      {result && !result.partial && (
        <div className={`capture-result-banner ${result.error ? 'capture-result-error' : result.queued ? 'capture-result-queued' : 'capture-result-ok'}`}>
          <span className="capture-result-icon">{result.error ? '✗' : result.queued ? '⏳' : '✓'}</span>
          <span className="capture-result-text">
            {result.error || (result.queued ? 'Queued on this device. It has NOT reached NEURO yet — it will send when you are back online.' : result.where)}
          </span>
        </div>
      )}
      {result?.partial && (
        <div className="capture-result-banner capture-result-partial">
          <span className="capture-result-icon">!</span>
          <span className="capture-result-text">
            Saved to the vault at {result.vault?.path || 'the capture log'}, but the task row failed
            {result.error ? ` — ${result.error}` : ''}. The words are safe; it just is not on your task list yet.
          </span>
        </div>
      )}

      <div className="capture-form">
        <textarea
          ref={textRef}
          className="capture-textarea"
          placeholder="Type it. Plain text is fine — or start with a word like chris:, done:, wait:, buy:"
          value={content}
          onChange={(e) => { setContent(e.target.value); setResult(null); }}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && canSubmit && !submitting) submit(); }}
          rows={4}
          autoFocus
          disabled={!!file}
        />

        {kinds === null ? <div className="capture-type-hint">Loading where things can go…</div> : (
          <>
            <div className="capture-chips" role="group" aria-label="Where it goes">{quick.map(chip)}</div>
            <div className="capture-chips capture-chips--forms" role="group" aria-label="Records">
              <span className="capture-chips-label">Record</span>{forms.map(chip)}
            </div>
          </>
        )}

        {content.trim() && !file && (
          <div className="capture-type-hint">
            {kindDef
              ? <>{picked ? 'Going to' : guess?.by === 'ai' ? 'NEURO thinks this is' : guess?.by === 'default' || guess?.by === 'offline' ? 'Not sure — defaulting to' : 'Looks like'} <strong>{kindDef.label}</strong> — {kindDef.hint}.{!picked && ' Pick another chip to change it.'}</>
              : 'Working out where it goes…'}
          </div>
        )}

        {kindDef?.fields?.length > 0 && !file && (
          <div className="capture-fields">
            {kindDef.fields.map((fd) => (
              <FieldInput key={fd.name} field={fd} value={fields[fd.name]} options={options} kindFields={fields}
                onChange={(v) => setFields((cur) => ({ ...cur, [fd.name]: v, ...(fd.name === 'slug' ? { section: '' } : {}) }))} />
            ))}
          </div>
        )}

        {kind === 'feature' && (
          <div className="capture-captured">
            <div className="capture-captured-head">
              {captured.status === 'error' ? 'Recently captured — couldn’t reach the tracker'
                : captured.status === 'loading' ? 'Recently captured…'
                : captured.total === 0 ? 'Nothing captured yet — this would be the first'
                : `Recently captured (${captured.total})`}
            </div>
            {captured.items.map((item) => (
              <div key={`${item.number}-${item.title}`} className="capture-captured-row">
                <span className="capture-captured-num">#{item.number}</span>
                <span className="capture-captured-title">{item.title}</span>
                <span className="capture-captured-sys">{item.system}</span>
              </div>
            ))}
          </div>
        )}

        {showAttach && (
          <div className="capture-attach-area">
            <input ref={fileRef} type="file" onChange={handleFileSelect} className="capture-file-input" />
            {preview && <img src={preview} alt="Preview" className="capture-preview-img" />}
            {file && !preview && (
              <div className="capture-file-info">
                <span>{file.name}</span>
                <span className="capture-file-size">{(file.size / 1024).toFixed(1)} KB</span>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="capture-actions">
        <button className="capture-attach-btn" onClick={() => setShowAttach((o) => !o)} title="Attach file or photo">
          {showAttach ? 'Cancel' : 'Attach'}
        </button>
        <button className="capture-submit" onClick={submit} disabled={!canSubmit || submitting}>
          {submitting ? 'Saving…' : kindDef && !file ? `Capture → ${kindDef.label}` : 'Capture'}
        </button>
      </div>

      {queueCount > 0 && (
        <div className="capture-queue-notice">
          {queueCount} item{queueCount !== 1 ? 's' : ''} queued — will sync when online
        </div>
      )}

      {recent.length > 0 && (
        <div className="capture-recent">
          <div className="capture-recent-header">Recent notes ({recent.length})</div>
          <div className="capture-recent-list">
            {recent.slice(0, 8).map((item, i) => (
              <div key={i} className="capture-recent-item">
                <span className="capture-recent-name">
                  {item.title || item.filename.replace(/^\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}-/, '').replace('.md', '')}
                </span>
                {item.preview && <span className="capture-recent-preview">{item.preview}</span>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** What the confirmation says — the server's own words where it gave any. */
function savedLine(kind, def, data) {
  if (kind === 'task') {
    if (data.vault && data.vault.written === false) return `Task created, but NOT written to the vault — ${data.vault.why || 'reason unknown'}.`;
    return `Saved to the vault${data.created === false ? ' · folded into a task already on your list' : ' · task created'}.`;
  }
  if (kind === 'feature') return `Added to the feature tracker${data.number ? ` as #${data.number}` : ''}.`;
  if (kind === 'chris' && data.already) return 'Already on the list for Chris.';
  if (data.saved) return `Saved — ${data.saved}.`;
  if (kind === 'note') return 'Saved to the vault. Indexing and entity extraction run after this and are not confirmed here.';
  return `Saved — ${def?.label || 'done'}.`;
}
