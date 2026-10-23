import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../api';
import './ReportFixes.css';

// ── The fixes log (23 Oct 2026) ─────────────────────────────────────────────
//
// Its own page (REPORTS → Fixes log). The VAULT is the master: one note per fix
// in Projects/Fixes Log/, which the SOAP and Weekly Risk reports read
// (services/report-fixes.js). A Claude Code session PROPOSES a fix at deploy;
// nothing reaches a report until Nick includes it. A fix Nick types here is his
// own statement, so it is included at once. Figures a fix affected are FLAGGED
// in the report, never restated.

const SYSTEMS = [['nova', 'NOVA'], ['vantage', 'VANTAGE'], ['neuro', 'NEURO'], ['n8n', 'n8n'], ['other', 'Other']];
const IMPACTS = [['figures', 'Changed a reported figure'], ['team', 'Affected the team'], ['customers', 'Affected customers']];
const pad = (n) => String(n).padStart(2, '0');
const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const short = (d) => (d ? `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]}` : '—');
const span = (a) => (a.from === a.to ? short(a.from) : `${short(a.from)}–${short(a.to)}`);

const blank = () => ({ system: 'nova', title: '', problem: '', impact: [], affects: [], fixedIn: '', deployedOn: today() });
const fromFix = (f) => ({ system: f.system, title: f.title, problem: f.problem, impact: [...f.impact], affects: f.affects.map((a) => ({ ...a })), fixedIn: f.fixedIn || '', deployedOn: f.deployedOn });

/** The form for a new fix or an edit. Validation is the server's; its refusal is shown verbatim. */
export function FixForm({ initial, submitLabel, busy, error, onSubmit, onCancel }) {
  const [f, setF] = useState(initial || blank());
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const toggleImpact = (k) => setF((x) => {
    const impact = x.impact.includes(k) ? x.impact.filter((i) => i !== k) : [...x.impact, k];
    const affects = impact.includes('figures') && !x.affects.length ? [{ measure: '', from: '', to: '' }] : impact.includes('figures') ? x.affects : [];
    return { ...x, impact, affects };
  });
  const setAffect = (i, k, v) => setF((x) => ({ ...x, affects: x.affects.map((a, j) => (j === i ? { ...a, [k]: v } : a)) }));
  return (
    <form className="rf-form" onSubmit={(e) => { e.preventDefault(); onSubmit(f); }}>
      <div className="rf-row">
        <label>System
          <select value={f.system} onChange={(e) => set('system', e.target.value)}>
            {SYSTEMS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </label>
        <label>Fixed in (version or commit)
          <input value={f.fixedIn} onChange={(e) => set('fixedIn', e.target.value)} placeholder="v1.1.740" />
        </label>
        <label>Deployed on
          <input type="date" value={f.deployedOn} max={today()} onChange={(e) => set('deployedOn', e.target.value)} />
        </label>
      </div>
      <label>What was fixed (one line)
        <input value={f.title} onChange={(e) => set('title', e.target.value)} placeholder="Tier 2 FRT compliance counted resolved tickets twice" />
      </label>
      <label>What was wrong, and who or what it affected
        <textarea rows={2} value={f.problem} onChange={(e) => set('problem', e.target.value)} />
      </label>
      <fieldset className="rf-impact">
        <legend>Impact</legend>
        {IMPACTS.map(([k, l]) => (
          <label key={k}><input type="checkbox" checked={f.impact.includes(k)} onChange={() => toggleImpact(k)} /> {l}</label>
        ))}
      </fieldset>
      {f.impact.includes('figures') && (
        <div className="rf-affects">
          <p className="rf-meta">Which figures, named as the report names them, and the dates they were wrong. They stay as reported; the report marks them.</p>
          {f.affects.map((a, i) => (
            <div key={i} className="rf-row">
              <input aria-label="Figure" value={a.measure} onChange={(e) => setAffect(i, 'measure', e.target.value)} placeholder="Tier 2 — FRT compliance" />
              <input aria-label="From" type="date" value={a.from} onChange={(e) => setAffect(i, 'from', e.target.value)} />
              <input aria-label="To" type="date" value={a.to} onChange={(e) => setAffect(i, 'to', e.target.value)} />
              <button type="button" className="rf-link" onClick={() => setF((x) => ({ ...x, affects: x.affects.filter((_, j) => j !== i) }))}>Remove</button>
            </div>
          ))}
          <button type="button" className="rf-link" onClick={() => setF((x) => ({ ...x, affects: [...x.affects, { measure: '', from: '', to: '' }] }))}>+ Another figure</button>
        </div>
      )}
      {error && <p className="rf-error" role="alert">{error}</p>}
      <div className="rf-actions">
        <button type="submit" className="rf-btn rf-btn--primary" disabled={busy}>{busy ? 'Saving…' : submitLabel}</button>
        {onCancel && <button type="button" className="rf-btn" onClick={onCancel}>Cancel</button>}
      </div>
    </form>
  );
}

/** One fix as it will read. PURE. */
export function FixSummary({ fix }) {
  return (
    <>
      <p><strong>{fix.title}</strong> <span className="rf-meta">— {fix.systemLabel}{fix.fixedIn ? ` ${fix.fixedIn}` : ''}, deployed {short(fix.deployedOn)}</span></p>
      <p className="rf-problem">{fix.problem}</p>
      {fix.affects.length > 0 && (
        <ul className="rf-figs">{fix.affects.map((a, i) => <li key={i}>Figure flagged: {a.measure} ({span(a)})</li>)}</ul>
      )}
      <p className="rf-meta">{fix.source === 'manual' ? 'Entered by you' : `Posted by ${String(fix.postedBy || '').replace(/^machine:/, '')} at deploy`}</p>
    </>
  );
}

export default function ReportFixes({ onChanged }) {
  const [fixes, setFixes] = useState(null);
  const [log, setLog] = useState({ folder: 'Projects/Fixes Log', unreadable: [] });
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(null);
  const [formErr, setFormErr] = useState(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(null);
  const [showDone, setShowDone] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch('/api/report-fixes');
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || `HTTP ${res.status}`);
      if (j.known === false) throw new Error(j.why || 'the vault could not be read');
      setFixes(j.fixes); setLog({ folder: j.folder, unreadable: j.unreadable || [] }); setErr(null);
    } catch (e) { setErr(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const call = async (key, path, body) => {
    setBusy(key); setFormErr(null);
    try {
      const res = await apiFetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) { setFormErr(j.error || `HTTP ${res.status}`); return false; }
      await load();
      if (onChanged) onChanged();
      return true;
    } finally { setBusy(null); }
  };

  if (err) return <section className="rf-panel"><p className="rf-error">Could not read the fixes log: {err}. This is not "no fixes" — the reports will say the log could not be read.</p></section>;
  if (!fixes) return <section className="rf-panel"><p className="rf-meta">Loading…</p></section>;

  const proposed = fixes.filter((f) => f.status === 'proposed');
  const included = fixes.filter((f) => f.status === 'included');
  const dismissed = fixes.filter((f) => f.status === 'dismissed');

  return (
    <section className="rf-panel">
      <div className="rf-head">
        <h3>{proposed.length ? `${proposed.length} waiting on you` : 'Fixes'}</h3>
        {!adding && <button className="rf-btn" onClick={() => { setAdding(true); setFormErr(null); }}>Add a fix</button>}
      </div>
      <p className="rf-meta">Kept in your vault, one note per fix, in <code>{log.folder}</code>. You can edit a note in Obsidian: changing <code>status: proposed</code> to <code>status: included</code> is the same as pressing Include. A fix appears in the SOAP and Weekly Risk reports for the week it was deployed; where it changed figures, both reports flag them without changing them.</p>
      {log.unreadable.length > 0 && (
        <div className="rf-unreadable" role="alert">
          <p className="rf-error">{log.unreadable.length} note{log.unreadable.length === 1 ? '' : 's'} in the log could not be read, so the reports leave {log.unreadable.length === 1 ? 'it' : 'them'} out:</p>
          <ul className="rf-figs">{log.unreadable.map((u) => <li key={u.path}><code>{u.path}</code> — {u.why}</li>)}</ul>
        </div>
      )}

      {adding && (
        <FixForm submitLabel="Add to the reports" busy={busy === 'add'} error={formErr}
          onCancel={() => setAdding(false)}
          onSubmit={async (f) => { if (await call('add', '/api/report-fixes/manual', f)) setAdding(false); }} />
      )}

      {proposed.length > 0 && <h4>Waiting on you</h4>}
      {proposed.map((f) => (
        <div key={f.id} className="rf-item rf-item--proposed">
          {editing === f.id ? (
            <FixForm initial={fromFix(f)} submitLabel="Save" busy={busy === `edit-${f.id}`} error={formErr}
              onCancel={() => setEditing(null)}
              onSubmit={async (x) => { if (await call(`edit-${f.id}`, `/api/report-fixes/${f.id}/edit`, x)) setEditing(null); }} />
          ) : (
            <>
              <FixSummary fix={f} />
              <div className="rf-actions">
                <button className="rf-btn rf-btn--primary" disabled={!!busy} onClick={() => call(`inc-${f.id}`, `/api/report-fixes/${f.id}/decide`, { decision: 'include' })}>Include</button>
                <button className="rf-btn" disabled={!!busy} onClick={() => { setEditing(f.id); setFormErr(null); }}>Edit</button>
                <button className="rf-btn" disabled={!!busy} onClick={() => call(`dis-${f.id}`, `/api/report-fixes/${f.id}/decide`, { decision: 'dismiss' })}>Not for the report</button>
              </div>
            </>
          )}
        </div>
      ))}

      {(included.length > 0 || dismissed.length > 0) && (
        <button className="rf-link" onClick={() => setShowDone((s) => !s)}>
          {showDone ? 'Hide' : 'Show'} {included.length} included{dismissed.length ? `, ${dismissed.length} left out` : ''}
        </button>
      )}
      {showDone && [...included, ...dismissed].map((f) => (
        <div key={f.id} className={`rf-item rf-item--${f.status}`}>
          {editing === f.id ? (
            <FixForm initial={fromFix(f)} submitLabel="Save" busy={busy === `edit-${f.id}`} error={formErr}
              onCancel={() => setEditing(null)}
              onSubmit={async (x) => { if (await call(`edit-${f.id}`, `/api/report-fixes/${f.id}/edit`, x)) setEditing(null); }} />
          ) : (
            <>
              <FixSummary fix={f} />
              <div className="rf-actions">
                <span className="rf-meta">{f.status === 'included' ? 'In the reports' : 'Left out'}</span>
                <button className="rf-btn" disabled={!!busy} onClick={() => { setEditing(f.id); setFormErr(null); }}>Edit</button>
                {f.status === 'included'
                  ? <button className="rf-btn" disabled={!!busy} onClick={() => call(`dis-${f.id}`, `/api/report-fixes/${f.id}/decide`, { decision: 'dismiss' })}>Take out</button>
                  : <button className="rf-btn" disabled={!!busy} onClick={() => call(`inc-${f.id}`, `/api/report-fixes/${f.id}/decide`, { decision: 'include' })}>Include</button>}
              </div>
            </>
          )}
        </div>
      ))}
      {!fixes.length && !adding && <p className="rf-meta">No fixes recorded yet.</p>}
    </section>
  );
}
