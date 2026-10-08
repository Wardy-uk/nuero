import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../api';
import './MedicalPanel.css';

// ── Medical — test results, diagnoses and prescriptions from the NHS app ─────
//
// Two ways in: screenshots read here (PROPOSED, nothing saved until Nick ticks
// and saves), or records ChatGPT already parsed and posted over MCP
// (post_medical_records). Both land in the same store.
//
// ⚠ THE SERVER DECIDES. Validation, dates and folding are the backend's; this
// file renders what it says, including what it refused and why.
// ⚠ A screenshot never leaves this request: it is sent once for reading and
// is not kept here or on the server.

const KIND_LABEL = { test_result: 'Test results', diagnosis: 'Diagnoses', prescription: 'Prescriptions' };
const KINDS = Object.keys(KIND_LABEL);
// Anthropic's per-image ceiling is ~5MB; the server refuses above 4.5MB.
const MAX_BYTES = 4 * 1024 * 1024;

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error(`could not read ${file.name}`));
    r.readAsDataURL(file);
  });
}

// A screenshot under the cap goes as it is (text stays crisp). Over it, it is
// re-encoded as a high-quality JPEG at its own size — never shrunk, because a
// downscaled lab value is a misread waiting to happen.
async function toImage(file) {
  const dataUrl = await readAsDataUrl(file);
  if (file.size <= MAX_BYTES && /^image\/(png|jpeg|webp|gif)$/.test(file.type)) {
    return { mediaType: file.type, imageBase64: dataUrl.split(',')[1] };
  }
  const img = await new Promise((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = () => reject(new Error(`${file.name} is not a picture I can read`));
    i.src = dataUrl;
  });
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  canvas.getContext('2d').drawImage(img, 0, 0);
  const jpeg = canvas.toDataURL('image/jpeg', 0.9);
  return { mediaType: 'image/jpeg', imageBase64: jpeg.split(',')[1] };
}

function valueLine(r) {
  if (r.kind === 'test_result') return [r.value, r.unit].filter(Boolean).join(' ');
  if (r.kind === 'prescription') return [r.dose, r.directions].filter(Boolean).join(' · ');
  return r.status || '';
}

function enteredLine(r) {
  const who = r.enteredBy === 'nick' ? 'you' : r.enteredBy;
  const how = r.enteredVia === 'screenshot' ? 'from a screenshot' : 'as parsed records';
  return `Entered by ${who}, ${how}${r.revisions ? ` · revised ${r.revisions}×` : ''}`;
}

function FlagBadge({ flag }) {
  if (!flag) return null;
  return <span className={`med-flag med-flag--${flag}`}>{flag}</span>;
}

function Scanner({ onSaved }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [proposal, setProposal] = useState(null);
  const [keep, setKeep] = useState({});
  const [saved, setSaved] = useState(null);

  async function onFiles(e) {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (!files.length) return;
    setBusy(true); setError(null); setProposal(null); setSaved(null);
    try {
      const images = await Promise.all(files.map(toImage));
      const res = await apiFetch('/api/medical/scan', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ images }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.ok) throw new Error(body.error || `the screenshots could not be read (${res.status})`);
      setProposal(body);
      setKeep(Object.fromEntries(body.proposed.map((_, i) => [i, true])));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    const records = proposal.proposed.filter((_, i) => keep[i]);
    if (!records.length) return;
    setBusy(true); setError(null);
    try {
      const res = await apiFetch('/api/medical/records', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ records, via: 'screenshot' }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.ok) throw new Error(body.error || `not saved (${res.status})`);
      setSaved(body);
      setProposal(null);
      onSaved();
    } catch (err) {
      setError(`Not saved — ${err.message}`);
    } finally {
      setBusy(false);
    }
  }

  const chosen = proposal ? proposal.proposed.filter((_, i) => keep[i]).length : 0;

  return (
    <section className="med-card">
      <h2>Add from the NHS app</h2>
      <p className="med-hint">
        Screenshot a test result, your conditions or your prescriptions in the NHS App and add them here.
        Several screenshots of one scrolling page can go in together. Nothing is saved until you choose what to keep,
        and the screenshots themselves are not stored.
      </p>
      <label className={`med-upload${busy ? ' med-upload--busy' : ''}`}>
        <input type="file" accept="image/*" multiple disabled={busy} onChange={onFiles} />
        {busy ? 'Reading…' : 'Choose screenshots'}
      </label>
      {error && <p className="med-error">{error}</p>}
      {saved && (
        <p className="med-ok">
          Saved {saved.created} new{saved.revised ? `, updated ${saved.revised}` : ''}
          {saved.unchanged ? `, ${saved.unchanged} already recorded` : ''}
          {saved.refused ? `, ${saved.refused} refused` : ''}.
        </p>
      )}
      {proposal && (
        <div className="med-proposal">
          {proposal.screen && <p className="med-screen">Read as: {proposal.screen}</p>}
          {proposal.proposed.length === 0 && <p>I read the screenshots and found no test results, conditions or prescriptions on them.</p>}
          {proposal.proposed.length > 0 && (
            <ul className="med-rows">
              {proposal.proposed.map((r, i) => (
                <li key={i} className="med-row">
                  <label>
                    <input type="checkbox" checked={!!keep[i]} onChange={() => setKeep({ ...keep, [i]: !keep[i] })} />
                    <span className="med-kind">{KIND_LABEL[r.kind].replace(/s$/, '')}</span>
                    <strong>{r.name}</strong>
                    <span className="med-val">{valueLine(r)}</span>
                    {r.referenceRange && <span className="med-range">range {r.referenceRange}</span>}
                    <FlagBadge flag={r.flag} />
                    <span className="med-date">{r.date || 'no date'}</span>
                  </label>
                </li>
              ))}
            </ul>
          )}
          {(proposal.refused.length > 0 || proposal.unreadable.length > 0) && (
            <div className="med-refused">
              <p>Not proposed — check these against the screenshot and add them by hand if they matter:</p>
              <ul>
                {proposal.refused.map((x, i) => (
                  <li key={`r${i}`}>{(x.read && x.read.name) || 'A row'}: {x.why}</li>
                ))}
                {proposal.unreadable.map((u, i) => <li key={`u${i}`}>{u}</li>)}
              </ul>
            </div>
          )}
          <div className="med-actions">
            <button type="button" disabled={busy || !chosen} onClick={save}>Save {chosen} record{chosen === 1 ? '' : 's'}</button>
            <button type="button" className="med-secondary" disabled={busy} onClick={() => setProposal(null)}>Discard</button>
          </div>
          <p className="med-hint">Check values against the screenshot before saving — this is a transcription, not a reading of what they mean.</p>
        </div>
      )}
    </section>
  );
}

function History({ name, onClose }) {
  const [data, setData] = useState(null);
  useEffect(() => {
    let live = true;
    apiFetch(`/api/medical/tests/${encodeURIComponent(name)}`)
      .then(r => r.json()).then(b => { if (live) setData(b); })
      .catch(() => { if (live) setData({ ok: false }); });
    return () => { live = false; };
  }, [name]);
  return (
    <div className="med-history">
      <div className="med-history-head">
        <strong>{name} over time</strong>
        <button type="button" className="med-secondary" onClick={onClose}>Close</button>
      </div>
      {!data && <p>Loading…</p>}
      {data && !data.ok && <p className="med-error">Couldn’t load the history.</p>}
      {data && data.ok && (
        <table className="med-table">
          <thead><tr><th>Date</th><th>Value</th><th>Range</th><th>Flag</th></tr></thead>
          <tbody>
            {data.readings.map(r => (
              <tr key={r.id}><td>{r.date}</td><td>{valueLine(r)}</td><td>{r.referenceRange || ''}</td><td><FlagBadge flag={r.flag} /></td></tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export default function MedicalPanel() {
  const [kind, setKind] = useState('test_result');
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [history, setHistory] = useState(null);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch(`/api/medical/records?kind=${kind}`);
      const body = await res.json();
      if (!res.ok || !body.ok) throw new Error(body.error || `status ${res.status}`);
      setData(body); setError(null);
    } catch (err) {
      setError(err.message);
    }
  }, [kind]);

  useEffect(() => { load(); }, [load]);

  async function remove(r) {
    if (!window.confirm(`Delete "${r.name}" (${r.date || 'no date'}) from your medical record?`)) return;
    const res = await apiFetch(`/api/medical/records/${r.id}`, { method: 'DELETE' });
    if (!res.ok) { setError('That record could not be deleted.'); return; }
    load();
  }

  return (
    <div className="med-panel">
      <div className="med-top">
        <h1>Medical</h1>
        <div className="med-tabs" role="tablist">
          {KINDS.map(k => (
            <button key={k} type="button" role="tab" aria-selected={kind === k}
              className={`med-tab${kind === k ? ' med-tab--on' : ''}`} onClick={() => { setKind(k); setHistory(null); }}>
              {KIND_LABEL[k]}{data && data.summary ? ` (${data.summary[k].count})` : ''}
            </button>
          ))}
        </div>
      </div>

      <Scanner onSaved={load} />

      <section className="med-card">
        <h2>{KIND_LABEL[kind]}</h2>
        {error && <p className="med-error">Couldn’t read your medical record: {error}</p>}
        {!error && !data && <p>Loading…</p>}
        {!error && data && data.records.length === 0 && (
          <p className="med-hint">Nothing recorded yet. Add screenshots above, or ask ChatGPT to parse them and save them to NEURO (post_medical_records).</p>
        )}
        {history && <History name={history} onClose={() => setHistory(null)} />}
        {!error && data && data.records.length > 0 && (
          <ul className="med-rows">
            {data.records.map(r => (
              <li key={r.id} className="med-row med-row--saved">
                <div className="med-row-main">
                  {kind === 'test_result'
                    ? <button type="button" className="med-link" onClick={() => setHistory(r.name)}>{r.name}</button>
                    : <strong>{r.name}</strong>}
                  <span className="med-val">{valueLine(r)}</span>
                  {r.referenceRange && <span className="med-range">range {r.referenceRange}</span>}
                  <FlagBadge flag={r.flag} />
                  {r.panel && <span className="med-range">{r.panel}</span>}
                  <span className="med-date">{r.date || 'no date'}</span>
                </div>
                <div className="med-row-meta">
                  <span>{enteredLine(r)}</span>
                  <button type="button" className="med-delete" onClick={() => remove(r)}>Delete</button>
                </div>
              </li>
            ))}
          </ul>
        )}
        {data && data.total > data.shown && <p className="med-hint">Showing the newest {data.shown} of {data.total}.</p>}
      </section>
    </div>
  );
}
