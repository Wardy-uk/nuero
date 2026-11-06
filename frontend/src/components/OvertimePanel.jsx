import React, { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../api';
import { executeDirect, directOutcome } from '../directAction';
import './OvertimePanel.css';

// PEOPLE & MEETINGS → Overtime (29 Oct 2026). Agents claim in NOVA; Nick approves and reports
// here. Every read and write goes over the NOVA bridge (services/overtime-claims.js). The
// activity and Working Time read shown on a card is live; NOVA re-runs it when Nick decides
// and freezes that copy onto the claim as the evidence. The payroll email is a governed send.

async function getJson(path) {
  const r = await apiFetch(path);
  let j = null;
  try { j = await r.json(); } catch { j = null; }
  if (!r.ok || !j || !j.ok) throw new Error((j && j.error) || `HTTP ${r.status}`);
  return j;
}

async function postJson(path, body) {
  const r = await apiFetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  let j = null;
  try { j = await r.json(); } catch { j = null; }
  return j || { ok: false, error: `HTTP ${r.status}` };
}

const hours = (m) => { const h = Math.floor(m / 60); const r = m % 60; return h ? (r ? `${h}h ${r}m` : `${h}h`) : `${r}m`; };
// Sliced, never parsed into a Date: a YYYY-MM-DD key is already a wall-clock fact.
const dayLabel = (d) => { const [y, m, dd] = d.split('-').map(Number); return new Date(Date.UTC(y, m - 1, dd, 12)).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }); };
const ukTime = (iso) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' });
const ukToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
const thisMonth = () => ukToday().slice(0, 7);

const FLAG = {
  ok: { label: 'Activity matches the window', tone: 'ok' },
  low: { label: 'Little activity in this window', tone: 'warn' },
  none: { label: 'No activity found in this window', tone: 'warn' },
  unknown: { label: 'Activity could not be fully checked', tone: 'muted' },
};

/** The five overtime checks, each answered from what NOVA checked. */
function fiveSteps(check) {
  const a = check.activity;
  const w = check.wtr;
  const over48 = w.weeklyAverageHours > 48;
  // WTR briefing §5: daily rest, weekly rest and the 20-minute in-work break (and §6 night work).
  const restWarn = w.warnings.filter((x) => ['rest-11', 'rest-weekly', 'break-20', 'night'].includes(x.code));
  return [
    { label: 'Verified against Jira/NOVA activity', state: a ? (a.assessment.flag === 'ok' ? 'ok' : 'warn') : 'warn',
      text: a ? FLAG[a.assessment.flag].label : (check.activityError || 'Not checked') },
    { label: '48-hour average over 17 weeks', state: over48 && !w.optedOut ? 'bad' : 'ok', text: `${w.weeklyAverageHours}h a week with this claim` },
    { label: 'Signed opt-out where the average is over 48h', state: over48 ? (w.optedOut ? 'ok' : 'bad') : 'ok',
      text: over48 ? (w.optedOut ? 'Opt-out on file' : 'Needed, none recorded') : 'Not needed' },
    { label: 'Rest: daily, weekly, 20-minute break', state: restWarn.length ? 'bad' : 'ok',
      text: restWarn.length ? restWarn.map((x) => x.message).join(' ') : `${w.restBeforeHours ?? '—'}h before · ${w.restAfterHours ?? '—'}h after` },
    { label: 'Check recorded', state: 'ok', text: 'Frozen onto the claim when you decide' },
  ];
}

function ClaimHead({ c }) {
  return (
    <div className="ot__head">
      <div>
        <div className="ot__who">{c.agentName}</div>
        <div className="ot__when">{dayLabel(c.date)}, {c.start}–{c.end} · {hours(c.minutes)}</div>
      </div>
      <span className={`ot__chip ot__chip--${c.status}`}>{c.status}</span>
    </div>
  );
}

function Activity({ activity }) {
  if (!activity) return null;
  const f = FLAG[activity.assessment.flag];
  return (
    <div className="ot__activity">
      <div className={`ot__flag ot__flag--${f.tone}`}>{f.label}</div>
      <div className="ot__muted">
        {activity.assessment.actions} actions on {activity.assessment.tickets} tickets
        {activity.assessment.perHour != null ? ` · ${activity.assessment.perHour} an hour` : ''}
        {activity.assessment.longestQuietMinutes != null ? ` · longest quiet stretch ${hours(activity.assessment.longestQuietMinutes)}` : ''}
      </div>
      {activity.assessment.reasons.map((r, k) => <div key={k} className="ot__reason">{r}</div>)}
      {activity.tickets.length > 0 && (
        <table className="ot__tickets"><tbody>
          {activity.tickets.map((t) => (
            <tr key={t.key}>
              <td className="ot__key">{t.key}</td>
              <td>{t.summary || ''}</td>
              <td className="ot__muted">{activity.actions.filter((x) => x.ticketKey === t.key).map((x) => `${ukTime(x.at)} ${x.kind}${x.detail ? ` (${x.detail})` : ''}`).join(', ')}</td>
            </tr>
          ))}
        </tbody></table>
      )}
      <div className="ot__sources">
        {Object.entries(activity.sources).map(([k, s]) => `${k} ${s.ok ? `✓ ${s.count}` : `✗ ${s.error || ''}`}`).join(' · ')}
        {activity.capped ? ' · ticket search capped' : ''}
      </div>
    </div>
  );
}

function ApprovalCard({ claim, onDone }) {
  const [check, setCheck] = useState(null);
  const [checkErr, setCheckErr] = useState(null);
  const [checking, setChecking] = useState(false);
  const [note, setNote] = useState('');
  const [override, setOverride] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const runCheck = useCallback(async () => {
    setChecking(true); setCheckErr(null);
    try { setCheck((await getJson(`/api/overtime-claims/${claim.id}/check`)).check); } catch (e) { setCheckErr(e.message); }
    setChecking(false);
  }, [claim.id]);
  useEffect(() => { runCheck(); }, [runCheck]);

  const decide = async (decision) => {
    setBusy(true); setErr(null);
    const r = await postJson(`/api/overtime-claims/${claim.id}/decide`, { decision, note: note || null, overrideReason: override || null });
    setBusy(false);
    if (!r.ok) { setErr(r.error || 'Not saved'); return; }
    onDone(`${decision === 'approve' ? 'Approved' : 'Rejected'}: ${claim.agentName}, ${dayLabel(claim.date)} ${claim.start}–${claim.end} (${hours(claim.minutes)}).`);
  };

  const warned = !!check && check.wtr.warnings.length > 0;
  // §8.3: over 48 hours with no signed opt-out is never approved — NOVA refuses it; HR decides.
  const blocked = !!check && check.wtr.warnings.some((x) => x.code === 'avg-48');
  return (
    <div className="ot__card">
      <ClaimHead c={claim} />
      <div className="ot__reason-text">{claim.reason}</div>
      {claim.items.length > 0 && (
        <ul className="ot__items">{claim.items.map((i, k) => <li key={k}>{i.description}{i.minutes ? ` (${hours(i.minutes)})` : ''}</li>)}</ul>
      )}
      {checkErr && <div className="ot__bad">Could not check: {checkErr}</div>}
      {!check && !checkErr && <div className="ot__muted">Asking NOVA what happened in this window…</div>}
      {check && (
        <div className="ot__grid">
          <div className="ot__box">
            <div className="ot__label">Activity in the window</div>
            {check.activity ? <Activity activity={check.activity} /> : <div className="ot__warn">{check.activityError}</div>}
          </div>
          <div className="ot__box">
            <div className="ot__label">Five-step check</div>
            <ol className="ot__steps">
              {fiveSteps(check).map((s, k) => (
                <li key={k} className={`ot__step ot__step--${s.state}`}><span>{s.label}</span><span>{s.text}</span></li>
              ))}
            </ol>
            {check.wtr.gaps.map((g, k) => <div key={k} className="ot__warn">Missing input: {g}</div>)}
            {check.wtr.info.map((i, k) => <div key={k} className="ot__muted">{i}</div>)}
          </div>
        </div>
      )}
      <div className="ot__decide">
        <label>Note to the agent (needed to reject)
          <input value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} /></label>
        {blocked && <div className="ot__bad">Over the 48-hour average with no signed opt-out on file — this can't be approved. Escalate it to HR, or record the opt-out first if one was signed before the work.</div>}
        {warned && !blocked && (
          <label className="ot__override">Why approve past the Working Time warning (recorded)
            <input value={override} maxLength={1000} onChange={(e) => setOverride(e.target.value)} /></label>
        )}
        <button className="ot__primary" disabled={busy || !check || blocked || (warned && !override.trim())} onClick={() => decide('approve')}>
          {busy ? 'Saving — NOVA is re-checking…' : warned ? 'Approve with warnings' : 'Approve'}
        </button>
        <button className="ot__quiet" disabled={busy || !note.trim()} onClick={() => decide('reject')}>Reject</button>
        <button className="ot__quiet" disabled={checking} onClick={runCheck}>{checking ? 'Checking…' : 'Re-check'}</button>
      </div>
      {err && <div className="ot__bad">{err}</div>}
    </div>
  );
}

function Approvals() {
  const [claims, setClaims] = useState(null);
  const [me, setMe] = useState(null);
  const [err, setErr] = useState(null);
  const [done, setDone] = useState([]);
  const load = useCallback(async () => {
    try {
      const [c, s] = await Promise.all([getJson('/api/overtime-claims?status=submitted'), getJson('/api/overtime-claims/signoff').catch(() => null)]);
      setClaims(c.claims); setMe(s && s.me ? String(s.me).toLowerCase() : null); setErr(null);
    } catch (e) { setErr(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);
  if (err) return <div className="ot__bad">Could not read claims from NOVA: {err}</div>;
  if (!claims) return <div className="ot__muted">Loading…</div>;
  // Nick's own claims are Chris's to approve (NOVA refuses a self-decision): they go in his sign-off email.
  const own = me ? claims.filter((c) => String(c.agentEmail || '').toLowerCase() === me) : [];
  const team = claims.filter((c) => !own.includes(c));
  return (
    <div>
      {done.map((d, k) => <div key={k} className="ot__ok">{d}</div>)}
      {!team.length && <div className="ot__muted">No overtime claims waiting for a decision.</div>}
      {team.map((c) => <ApprovalCard key={c.id} claim={c} onDone={(msg) => { if (msg) setDone((d) => [...d, msg]); load(); }} />)}
      {own.length > 0 && (
        <div className="ot__card">
          <div className="ot__label">Your own overtime — Chris approves these</div>
          {own.map((c) => <div key={c.id} className="ot__muted">{dayLabel(c.date)} {c.start}–{c.end} · {hours(c.minutes)} · {c.reason}</div>)}
          <div className="ot__muted">They go in Monday's sign-off email to Chris (see Chris sign-off).</div>
        </div>
      )}
    </div>
  );
}

/**
 * A missed line: work nobody claimed. NOVA creates it as a claim already approved by Nick,
 * runs and freezes the same activity + Working Time check, and it goes in the next payroll
 * file flagged "worked in an earlier month" and "added by".
 */
function ManualLine({ onAdded }) {
  const [open, setOpen] = useState(false);
  const [agents, setAgents] = useState(null);
  const [agentsErr, setAgentsErr] = useState(null);
  const [f, setF] = useState({ agentEmail: '', date: '', start: '17:30', end: '', reason: '', overrideReason: '' });
  const [needOverride, setNeedOverride] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  useEffect(() => {
    if (!open || agents) return;
    getJson('/api/overtime-claims/agents').then((j) => setAgents(j.agents)).catch((e) => setAgentsErr(e.message));
  }, [open, agents]);

  const add = async () => {
    setBusy(true); setMsg(null);
    const r = await postJson('/api/overtime-claims/manual', { ...f, overrideReason: f.overrideReason || null });
    setBusy(false);
    if (!r.ok) {
      if (/Working Time warnings/.test(r.error || '')) setNeedOverride(true);
      setMsg({ tone: 'bad', text: r.error || 'Not saved' });
      return;
    }
    const c = r.claim;
    setMsg({ tone: 'ok', text: `Added and approved: ${c.agentName}, ${dayLabel(c.date)} ${c.start}–${c.end} (${hours(c.minutes)}). It goes in the next payroll file.` });
    setF({ ...f, date: '', end: '', reason: '', overrideReason: '' });
    setNeedOverride(false);
    onAdded();
  };

  if (!open) return <button className="ot__quiet" onClick={() => setOpen(true)}>+ Add a missed overtime line</button>;
  const ready = f.agentEmail && f.date && f.start && f.end && f.reason.trim() && (!needOverride || f.overrideReason.trim());
  return (
    <div className="ot__card">
      <div className="ot__label">Add a missed overtime line</div>
      <p className="ot__muted">For work nobody claimed, such as overtime missed from last month. It's saved in NOVA as a claim approved by you, with the activity and Working Time check recorded, and it goes in the next payroll file marked "added by you".</p>
      {agentsErr && <div className="ot__bad">Could not read the agent list from NOVA: {agentsErr}</div>}
      <div className="ot__form">
        <select value={f.agentEmail} onChange={(e) => setF({ ...f, agentEmail: e.target.value })} disabled={!agents}>
          <option value="">{agents ? 'Choose the agent' : 'Loading agents…'}</option>
          {(agents || []).map((a) => <option key={a.email} value={a.email}>{a.name}</option>)}
        </select>
        <input type="date" value={f.date} max={ukToday()} onChange={(e) => setF({ ...f, date: e.target.value })} />
        <input type="time" value={f.start} onChange={(e) => setF({ ...f, start: e.target.value })} aria-label="From" />
        <input type="time" value={f.end} onChange={(e) => setF({ ...f, end: e.target.value })} aria-label="To" />
        <input className="ot__grow" placeholder="Reason (payroll sees this)" maxLength={1000} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} />
      </div>
      {needOverride && (
        <div className="ot__form">
          <input className="ot__grow" placeholder="Why approve past the Working Time warning (recorded)" maxLength={1000}
            value={f.overrideReason} onChange={(e) => setF({ ...f, overrideReason: e.target.value })} />
        </div>
      )}
      <div className="ot__actions">
        <button className="ot__primary" disabled={busy || !ready} onClick={add}>{busy ? 'Checking and adding…' : 'Add and approve'}</button>
        <button className="ot__quiet" disabled={busy} onClick={() => { setOpen(false); setMsg(null); }}>Close</button>
      </div>
      {msg && <div className={`ot__note ot__note--${msg.tone}`}>{msg.text}</div>}
    </div>
  );
}

// One claim in a person's list. A line Nick added (and payroll has not had — everything in this
// list is unsent) can be corrected or deleted; an agent's own claim cannot.
function ManualRow({ r, onChanged }) {
  const [mode, setMode] = useState(null); // null | 'edit' | 'delete'
  const [f, setF] = useState(null);
  const [needOverride, setNeedOverride] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const mineToChange = !!r.enteredBy;

  const startEdit = () => {
    setF({ agentEmail: r.agentEmail, date: r.date, start: r.start, end: r.end, reason: r.reason || '', overrideReason: '' });
    setNeedOverride(false); setMsg(null); setMode('edit');
  };
  const save = async () => {
    setBusy(true); setMsg(null);
    const res = await postJson(`/api/overtime-claims/${r.claimId}/manual-edit`, { ...f, overrideReason: f.overrideReason || null });
    setBusy(false);
    if (!res.ok) {
      if (/Working Time warnings/.test(res.error || '')) setNeedOverride(true);
      setMsg(res.error || 'Not saved'); return;
    }
    setMode(null); onChanged();
  };
  const del = async () => {
    setBusy(true); setMsg(null);
    const res = await postJson(`/api/overtime-claims/${r.claimId}/manual-delete`, {});
    setBusy(false);
    if (!res.ok) { setMsg(res.error || 'Not deleted'); return; }
    setMode(null); onChanged();
  };

  return (
    <>
      <tr>
        <td>{dayLabel(r.date)}</td><td>{r.start}–{r.end}</td><td>{r.hours}h</td>
        <td>{r.reason}{r.lateFromEarlierMonth ? ' (earlier month)' : ''}{r.enteredBy ? ` (added by ${r.enteredBy})` : ''}</td>
        <td className="ot__rowacts">
          {mineToChange && mode === null && (
            <>
              <button type="button" className="ot__quiet ot__small" onClick={startEdit}>Edit</button>
              <button type="button" className="ot__quiet ot__small" onClick={() => { setMsg(null); setMode('delete'); }}>Delete</button>
            </>
          )}
          {mode === 'delete' && (
            <>
              <span className="ot__muted">Delete this line? </span>
              <button type="button" className="ot__danger ot__small" disabled={busy} onClick={del}>{busy ? 'Deleting…' : 'Delete'}</button>
              <button type="button" className="ot__quiet ot__small" disabled={busy} onClick={() => setMode(null)}>Keep</button>
            </>
          )}
        </td>
      </tr>
      {mode === 'edit' && f && (
        <tr><td colSpan={5}>
          <div className="ot__form">
            <input type="date" value={f.date} max={ukToday()} onChange={(e) => setF({ ...f, date: e.target.value })} />
            <input type="time" value={f.start} onChange={(e) => setF({ ...f, start: e.target.value })} aria-label="From" />
            <input type="time" value={f.end} onChange={(e) => setF({ ...f, end: e.target.value })} aria-label="To" />
            <input className="ot__grow" maxLength={1000} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} placeholder="Reason (payroll sees this)" />
          </div>
          {needOverride && (
            <div className="ot__form">
              <input className="ot__grow" placeholder="Why approve past the Working Time warning (recorded)" maxLength={1000}
                value={f.overrideReason} onChange={(e) => setF({ ...f, overrideReason: e.target.value })} />
            </div>
          )}
          <div className="ot__actions">
            <button type="button" className="ot__primary ot__small" disabled={busy || !f.date || !f.start || !f.end || !f.reason.trim() || (needOverride && !f.overrideReason.trim())} onClick={save}>{busy ? 'Checking and saving…' : 'Save'}</button>
            <button type="button" className="ot__quiet ot__small" disabled={busy} onClick={() => setMode(null)}>Cancel</button>
          </div>
        </td></tr>
      )}
      {msg && <tr><td colSpan={5}><div className="ot__note ot__note--bad">{msg}</div></td></tr>}
    </>
  );
}

function Month() {
  const [month, setMonth] = useState(thisMonth());
  // The payroll month runs to the cut-off (usually the 16th): open on the period we are in.
  useEffect(() => {
    getJson('/api/overtime-claims/signoff').then((s) => { if (s.current && s.current.month) setMonth(s.current.month); }).catch(() => {});
  }, []);
  const [data, setData] = useState(null);
  const [decided, setDecided] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);
  const [openAgent, setOpenAgent] = useState(null);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const [p, d] = await Promise.all([
        getJson(`/api/overtime-claims/payroll?month=${month}`),
        getJson(`/api/overtime-claims?month=${month}`),
      ]);
      setData(p); setDecided(d.claims);
    } catch (e) { setErr(e.message); setData(null); setDecided(null); }
  }, [month]);
  useEffect(() => { setData(null); load(); }, [load]);

  const download = async () => {
    const r = await apiFetch(`/api/overtime-claims/payroll/file?month=${month}`);
    if (!r.ok) { setNote({ tone: 'bad', text: 'Could not download the file.' }); return; }
    const url = URL.createObjectURL(await r.blob());
    const a = document.createElement('a');
    a.href = url; a.download = `Overtime ${month}.xlsx`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };

  const [confirmOverride, setConfirmOverride] = useState(false);
  const send = async (override = false) => {
    setBusy(true); setNote(null); setConfirmOverride(false);
    try {
      const prep = await postJson('/api/overtime-claims/payroll/prepare', override ? { month, override: true } : { month });
      if (!prep.ok) { setNote({ tone: 'bad', text: prep.error || 'Could not prepare the email.' }); return; }
      setNote(directOutcome(await executeDirect(prep.action)));
    } finally { setBusy(false); await load(); }
  };

  const testSend = async () => {
    setBusy(true); setNote(null);
    try {
      const r = await postJson('/api/overtime-claims/payroll/test-send', { month });
      setNote(r.ok
        ? { tone: 'ok', text: `Test copy sent to ${r.to} with the file. Payroll got nothing and no claim was marked sent.` }
        : { tone: 'bad', text: r.error || 'The test email was not sent.' });
    } finally { setBusy(false); }
  };

  const exp = data && data.export;
  const rejected = (decided || []).filter((c) => c.status === 'rejected');
  const waiting = (decided || []).filter((c) => c.status === 'submitted');
  return (
    <div>
      <div className="ot__toolbar">
        <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
        {data && data.period && <span className="ot__muted">Period {dayLabel(data.period.from)} to {dayLabel(data.period.to)} (cut-off){data.period.overridden ? ' — set by hand' : ''}</span>}
        {exp && <span className="ot__muted">{exp.rows.length} approved claims to send · {exp.totalHours} hours{exp.alreadySent ? ` · ${exp.alreadySent} already sent` : ''}</span>}
      </div>
      <ManualLine onAdded={load} />
      {err && <div className="ot__bad">Could not read the month from NOVA: {err}</div>}
      {!data && !err && <div className="ot__muted">Loading…</div>}
      {data && (
        <>
          {waiting.length > 0 && <div className="ot__warn">{waiting.length} claim{waiting.length === 1 ? '' : 's'} for this month still {waiting.length === 1 ? 'needs' : 'need'} a decision — decide {waiting.length === 1 ? 'it' : 'them'} first or {waiting.length === 1 ? 'it goes' : 'they go'} in a later file.</div>}
          {exp.totals.length > 0 ? (
            <table className="ot__table">
              <thead><tr><th>Name</th><th>Claims</th><th>Paid hours</th></tr></thead>
              <tbody>
                {exp.totals.map((t) => {
                  const open = openAgent === t.agentEmail;
                  const mine = open ? exp.rows.filter((r) => r.agentEmail === t.agentEmail) : [];
                  return (
                    <React.Fragment key={t.agentEmail}>
                      <tr>
                        <td>
                          <button type="button" className="ot__name" aria-expanded={open}
                            onClick={() => setOpenAgent(open ? null : t.agentEmail)}>
                            {open ? '▾' : '▸'} {t.agentName}
                          </button>
                        </td>
                        <td>{t.claims}</td><td>{t.hours}</td>
                      </tr>
                      {open && (
                        <tr className="ot__agentrows">
                          <td colSpan={3}>
                            <table className="ot__table ot__table--inner">
                              <thead><tr><th>Date</th><th>Time</th><th>Hours</th><th>Reason</th><th></th></tr></thead>
                              <tbody>
                                {mine.map((r) => <ManualRow key={r.claimId} r={r} onChanged={load} />)}
                              </tbody>
                            </table>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
                <tr className="ot__total"><td>Total</td><td>{exp.rows.length}</td><td>{exp.totalHours}</td></tr>
              </tbody>
            </table>
          ) : <div className="ot__muted">Nothing approved and unsent for this month.</div>}
          {exp.rows.length > 0 && (
            <details className="ot__details">
              <summary>Every claim in the file</summary>
              <table className="ot__table"><tbody>
                {exp.rows.map((r) => (
                  <tr key={r.claimId}><td>{r.agentName}</td><td>{dayLabel(r.date)}</td><td>{r.start}–{r.end}</td><td>{r.hours}h</td><td>{r.reason}{r.lateFromEarlierMonth ? ' (earlier month)' : ''}{r.enteredBy ? ` (added by ${r.enteredBy})` : ''}</td></tr>
                ))}
              </tbody></table>
            </details>
          )}
          {data.signoff && !data.signoff.complete && exp.rows.length > 0 && (
            <div className="ot__warn">
              Chris has not signed off {data.signoff.unsigned.length} claim{data.signoff.unsigned.length === 1 ? '' : 's'} in this file — payroll waits until he has:
              {' '}{data.signoff.unsigned.slice(0, 8).map((u) => `${u.agentName} ${dayLabel(u.date)}`).join(', ')}{data.signoff.unsigned.length > 8 ? '…' : ''}
              {data.signoff.canOverride && !data.inFlight && (
                <div className="ot__actions">
                  {confirmOverride ? (
                    <>
                      <span>Send to {data.to} with Chris copied in, asking him to approve the {data.signoff.unsigned.length} unsigned claim{data.signoff.unsigned.length === 1 ? '' : 's'} by reply? His reply is recorded on Chris sign-off.</span>
                      <button className="ot__primary" disabled={busy} onClick={() => send(true)}>{busy ? 'Sending…' : 'Yes, send it'}</button>
                      <button className="ot__quiet" disabled={busy} onClick={() => setConfirmOverride(false)}>Cancel</button>
                    </>
                  ) : (
                    <button className="ot__quiet" disabled={busy} onClick={() => setConfirmOverride(true)}>Cut-off: send anyway and copy Chris in to approve</button>
                  )}
                </div>
              )}
            </div>
          )}
          <div className="ot__actions">
            {data.inFlight
              ? <span className="ot__warn">The {month} email is {data.inFlight.status}; NOVA marks the claims sent once it is confirmed in Sent Items.</span>
              : <button className="ot__primary" disabled={busy || !exp.rows.length || (data.signoff && !data.signoff.complete)} onClick={() => send(false)}>{busy ? 'Sending…' : `Send to ${data.to}`}</button>}
            <button className="ot__quiet" disabled={busy || !exp.rows.length} onClick={testSend}>Send a test to me</button>
            <button className="ot__quiet" disabled={!data.hasFile || !exp.rows.length} onClick={download}>Download the file</button>
          </div>
          {note && <div className={`ot__note ot__note--${note.tone}`}>{note.text}</div>}
          {data.sends.length > 0 && (
            <div className="ot__sends">
              {data.sends.map((s) => (
                <div key={s.id} className="ot__muted">
                  Prepared {new Date(s.preparedAt).toLocaleString('en-GB')} · {s.claims} claims · {s.totalHours}h · {s.status || 'unknown'}
                  {s.markedAt ? ' · marked sent in NOVA' : ''}{s.markError ? ` · NOVA not updated yet: ${s.markError}` : ''}
                </div>
              ))}
            </div>
          )}
          {rejected.length > 0 && (
            <details className="ot__details">
              <summary>Rejected this month ({rejected.length})</summary>
              {rejected.map((c) => <div key={c.id} className="ot__muted">{c.agentName} · {dayLabel(c.date)} {c.start}–{c.end} · {c.decisionNote}</div>)}
            </details>
          )}
        </>
      )}
    </div>
  );
}

const KIND = { weekly: 'Weekly', reminder: 'Final reminder', cutoff: 'Cut-off', override: 'Sent to payroll, Chris copied to approve' };
const STATUS = {
  nothing: 'Nothing to sign off — not sent',
  preparing: 'Preparing',
  prepared: 'Ready — waiting to send',
  sent: 'Sent — waiting for Chris',
  'needs-you': 'Chris replied — confirm what he signed off',
  signed: 'Signed off',
  partial: 'Partly signed off',
  held: 'Held',
  'not-sent': 'Not sent',
  failed: 'Failed',
};

/** Chris's weekly sign-off (5 Nov 2026): the cut-off, the emails, and his replies to confirm. */
function SignOff() {
  const [v, setV] = useState(null);
  const [err, setErr] = useState(null);
  const [day, setDay] = useState('');
  const [ovMonth, setOvMonth] = useState('');
  const [ovDate, setOvDate] = useState('');
  const [note, setNote] = useState(null);
  const load = useCallback(async () => {
    try { const r = await getJson('/api/overtime-claims/signoff'); setV(r); setDay(String(r.cutoff.day)); setErr(null); } catch (e) { setErr(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);
  const saveCutoff = async (body) => {
    setNote(null);
    const r = await postJson('/api/overtime-claims/signoff/cutoff', body);
    setNote(r.ok ? { tone: 'ok', text: 'Cut-off saved.' } : { tone: 'bad', text: r.error || 'Not saved' });
    load();
  };
  if (err) return <div className="ot__bad">Could not read the sign-off: {err}</div>;
  if (!v) return <div className="ot__muted">Loading…</div>;
  const overrides = Object.entries(v.cutoff.overrides || {}).sort();
  return (
    <div>
      <p className="ot__muted">
        Every Monday at 09:00 Chris gets last week's approved team overtime, and any of your own claims, to sign off with the file attached.
        The working day before the cut-off he gets a reminder if anything is still unsigned, and on the cut-off morning (08:00) the part-week since Monday.
        A plain "signed off" reply is recorded automatically; anything else comes here for you to confirm. Payroll can't be sent until every claim in the file is signed off.
      </p>
      <div className="ot__card">
        <div className="ot__label">Cut-off</div>
        <div className="ot__muted">
          This period: {dayLabel(v.current.from)} to {dayLabel(v.current.to)} ({v.current.month}). Next: {dayLabel(v.next.from)} to {dayLabel(v.next.to)}.
          {' '}{v.chris.error ? <span className="ot__bad">Chris: {v.chris.error}</span> : `Emails go to ${v.chris.name} (${v.chris.email}).`}
          {' '}{v.autoSend ? 'Sent automatically on working days.' : 'Auto-send is off — each email waits on Actions for your press.'}
        </div>
        <div className="ot__form">
          <label>Cut-off day of the month <input type="number" min={1} max={28} value={day} onChange={(e) => setDay(e.target.value)} style={{ width: 70 }} /></label>
          <button className="ot__quiet" onClick={() => saveCutoff({ day: Number(day) })}>Save day</button>
          <span className="ot__muted">A weekend or bank holiday moves it to the working day before.</span>
        </div>
        <div className="ot__form">
          <label>Override one month <input type="month" value={ovMonth} onChange={(e) => setOvMonth(e.target.value)} /></label>
          <input type="date" value={ovDate} onChange={(e) => setOvDate(e.target.value)} />
          <button className="ot__quiet" disabled={!ovMonth || !ovDate} onClick={() => saveCutoff({ overrides: { [ovMonth]: ovDate } })}>Set</button>
        </div>
        {overrides.map(([m, d]) => (
          <div key={m} className="ot__muted">{m}: cut-off {dayLabel(d)} <button className="ot__quiet" onClick={() => saveCutoff({ overrides: { [m]: null } })}>Remove</button></div>
        ))}
        {note && <div className={`ot__note ot__note--${note.tone}`}>{note.text}</div>}
      </div>
      {!v.requests.length && <div className="ot__muted">No sign-off emails yet. The first goes on Monday if there is anything to sign off.</div>}
      {v.requests.map((r) => <SignOffRequest key={r.id} r={r} onChanged={load} />)}
    </div>
  );
}

const CONFIRMABLE = new Set(['needs-you', 'partial', 'sent', 'held']);

function SignOffRequest({ r, onChanged }) {
  const [sign, setSign] = useState(() => new Set(r.team.filter((c) => !c.signed).map((c) => c.id)));
  const [own, setOwn] = useState(() => Object.fromEntries(r.own.filter((c) => !c.signed).map((c) => [c.id, 'approve'])));
  const [rejectNote, setRejectNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const confirmable = CONFIRMABLE.has(r.status) && (r.team.length > 0 || r.own.length > 0);
  const toggle = (id) => setSign((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const submit = async (hold) => {
    setBusy(true); setMsg(null);
    const approveOwn = Object.entries(own).filter(([, d]) => d === 'approve').map(([id]) => Number(id));
    const rejectOwn = Object.entries(own).filter(([, d]) => d === 'reject').map(([id]) => Number(id));
    const body = hold ? { hold: true, note: 'Chris queried it — held' } : { sign: [...sign], approveOwn, rejectOwn, rejectNote };
    const res = await postJson(`/api/overtime-claims/signoff/${r.id}/confirm`, body);
    setBusy(false);
    if (!res.ok) { setMsg({ tone: 'bad', text: res.error || 'Not recorded' }); return; }
    const failed = res.failed && res.failed.length ? res.failed.map((f) => f.error).join('; ') : null;
    setMsg(failed ? { tone: 'bad', text: `Recorded, but: ${failed}` } : { tone: 'ok', text: 'Recorded.' });
    onChanged();
  };
  return (
    <div className={`ot__card${r.status === 'needs-you' ? ' ot__card--alert' : ''}`}>
      <div className="ot__label">{KIND[r.kind] || r.kind} · {dayLabel(r.runDate)} · ref OT-{r.id} · {STATUS[r.status] || r.status}</div>
      {r.error && <div className="ot__warn">{r.error}</div>}
      {r.reply && (
        <div className="ot__box">
          <div className="ot__label">Chris replied{r.reply.at ? ` ${new Date(r.reply.at).toLocaleString('en-GB', { timeZone: 'Europe/London' })}` : ''}</div>
          <div className="ot__reason-text" style={{ whiteSpace: 'pre-wrap' }}>{r.reply.text || '(no text)'}</div>
        </div>
      )}
      {r.team.length > 0 && (
        <table className="ot__table ot__table--inner"><tbody>
          {r.team.map((c) => (
            <tr key={c.id}>
              <td>{c.signed ? '✓' : confirmable ? <input type="checkbox" checked={sign.has(c.id)} onChange={() => toggle(c.id)} /> : ''}</td>
              <td>{c.agentName}</td><td>{dayLabel(c.date)}</td><td>{c.start}–{c.end}</td><td>{hours(c.minutes)}</td><td>{c.reason}</td>
            </tr>
          ))}
        </tbody></table>
      )}
      {r.own.length > 0 && (
        <div>
          <div className="ot__label">Your own</div>
          {r.own.map((c) => (
            <div key={c.id} className="ot__muted">
              {dayLabel(c.date)} {c.start}–{c.end} · {hours(c.minutes)} · {c.reason}
              {c.signed ? ' · approved' : confirmable ? (
                <select value={own[c.id] || 'leave'} onChange={(e) => setOwn({ ...own, [c.id]: e.target.value })}>
                  <option value="approve">Chris approved</option><option value="reject">Chris rejected</option><option value="leave">Not decided yet</option>
                </select>
              ) : null}
            </div>
          ))}
          {Object.values(own).includes('reject') && <input placeholder="Why Chris rejected it (recorded in NOVA)" value={rejectNote} onChange={(e) => setRejectNote(e.target.value)} />}
        </div>
      )}
      {confirmable && (
        <div className="ot__actions">
          <button className="ot__primary" disabled={busy} onClick={() => submit(false)}>Record what Chris signed off</button>
          <button className="ot__quiet" disabled={busy} onClick={() => submit(true)}>Chris queried it — hold</button>
        </div>
      )}
      {msg && <div className={`ot__note ot__note--${msg.tone}`}>{msg.text}</div>}
    </div>
  );
}

function OptOuts() {
  const [rows, setRows] = useState(null);
  const [f, setF] = useState({ agentName: '', agentEmail: '', optedOutOn: ukToday(), documentRef: '' });
  const [err, setErr] = useState(null);
  const load = useCallback(async () => {
    try { setRows((await getJson('/api/overtime-claims/optouts')).optOuts); setErr(null); } catch (e) { setErr(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);
  const add = async () => {
    setErr(null);
    const r = await postJson('/api/overtime-claims/optouts', f);
    if (!r.ok) { setErr(r.error || 'Not saved'); return; }
    setF({ ...f, agentName: '', agentEmail: '', documentRef: '' });
    load();
  };
  const withdraw = async (id) => { await postJson(`/api/overtime-claims/optouts/${id}/withdraw`, { withdrawnOn: ukToday() }); load(); };
  return (
    <div>
      <p className="ot__muted">A recorded opt-out removes the 48-hour average warning only. Rest-break warnings always remain.</p>
      <div className="ot__form">
        <input placeholder="Agent name" value={f.agentName} onChange={(e) => setF({ ...f, agentName: e.target.value })} />
        <input placeholder="Agent email" value={f.agentEmail} onChange={(e) => setF({ ...f, agentEmail: e.target.value })} />
        <input type="date" value={f.optedOutOn} onChange={(e) => setF({ ...f, optedOutOn: e.target.value })} />
        <input className="ot__grow" placeholder="Where the signed opt-out is kept" value={f.documentRef} onChange={(e) => setF({ ...f, documentRef: e.target.value })} />
        <button className="ot__primary" onClick={add}>Record opt-out</button>
      </div>
      {err && <div className="ot__bad">{err}</div>}
      {rows && rows.length === 0 && <div className="ot__muted">No opt-outs recorded.</div>}
      {(rows || []).map((o) => (
        <div key={o.id} className="ot__optout">
          <span>{o.agentName} ({o.agentEmail}) — from {o.optedOutOn}{o.withdrawnOn ? `, withdrawn ${o.withdrawnOn}` : ''} · {o.documentRef}</span>
          {!o.withdrawnOn && <button className="ot__quiet" onClick={() => withdraw(o.id)}>Withdrawn today</button>}
        </div>
      ))}
    </div>
  );
}

const TABS = [['approvals', 'Waiting for you'], ['signoff', 'Chris sign-off'], ['month', 'Month & payroll'], ['optouts', '48-hour opt-outs']];

export default function OvertimePanel() {
  const [tab, setTab] = useState('approvals');
  return (
    <div className="ot">
      <div className="ot__top">
        <h1>Overtime</h1>
        <p className="ot__muted">Agents claim in NOVA. You approve here; NOVA's activity and Working Time check is recorded with each decision, and the month goes to payroll from here.</p>
      </div>
      <div className="ot__tabs">
        {TABS.map(([k, label]) => <button key={k} className={`ot__tab${tab === k ? ' ot__tab--on' : ''}`} onClick={() => setTab(k)}>{label}</button>)}
      </div>
      {tab === 'approvals' && <Approvals />}
      {tab === 'signoff' && <SignOff />}
      {tab === 'month' && <Month />}
      {tab === 'optouts' && <OptOuts />}
    </div>
  );
}
