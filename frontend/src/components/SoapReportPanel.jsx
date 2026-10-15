import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../api';
import './SoapReportPanel.css';

// ── SOAP report — the Monday debrief for Ricky and Chris (15 Oct 2026) ─────
//
// ⚠ THE SERVER DECIDES the verdicts (services/soap-report.js). This screen
// renders them and collects the only things NEURO cannot know: what Nick will
// do about each red, and why a red he carried in is still red.
// ⚠ A source NEURO could not read is shown as a gap in amber, never as an
// empty section.

const STATUS_WORDS = {
  prepared: 'Queued — approve it in Actions',
  approved: 'Approved — waiting for Monday 08:00',
  executing: 'Sending',
  executed: 'Sent — checking Sent Items',
  verified: 'Sent and confirmed',
  execution_uncertain: 'Sent? — NEURO could not confirm it',
  cancelled: 'Held — not sent',
  expired: 'Expired — not sent',
  failed: 'Failed — not sent',
  superseded: 'Replaced by a newer version',
  rejected: 'Rejected',
};

const pct = (x) => (x && x.pct != null ? `${x.pct}%` : '—');
const when = (iso) => (iso ? new Date(iso).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');

function Gap({ text }) {
  return <p className="soap-gap">Not available — {text}</p>;
}

export function SoapReportView({ data, draft, setDraft, dirty, busy, onSave, onBuild, onQueue }) {
  const v = data.current;
  const off = data.offMonday;
  const send = data.send;
  if (!v) {
    return (
      <div className="soap-empty">
        <p>No SOAP report built yet. The final for last week is built every Monday at 07:00.</p>
        <div className="soap-actions">
          <button className="soap-btn" disabled={busy} onClick={() => onBuild('final')}>Build last week now</button>
          <button className="soap-btn" disabled={busy} onClick={() => onBuild('provisional')}>Build this week so far</button>
        </div>
      </div>
    );
  }
  const r = v.report;
  const vd = r.verdicts;
  const g = r.gapsBySection || {};
  const setRed = (key, action) => setDraft((d) => ({ ...d, reds: { ...d.reds, [key]: { action } } }));
  const setCarried = (key, field, val) => setDraft((d) => ({ ...d, carried: { ...d.carried, [key]: { ...(d.carried[key] || {}), [field]: val } } }));

  return (
    <div className="soap-body">
      {off && off.off && (
        <div className="soap-banner" role="note">
          You’re off on Monday {off.monday} ({off.detail || off.source}). Queue the provisional by Friday and approve it — it goes to Ricky and Chris at 08:00 Monday only if the full week’s verdicts match.
        </div>
      )}
      {off && !off.known && <p className="soap-meta">Couldn’t tell whether you’re off on Monday: {off.detail}.</p>}

      <div className="soap-head">
        <h2>Week of {r.from} — {r.kind === 'provisional' ? `provisional, data to ${r.upTo}` : 'final'}</h2>
        <span className="soap-meta">Built {when(r.generatedAt)}</span>
      </div>
      <div className="soap-actions">
        <button className="soap-btn" disabled={busy} onClick={() => onBuild(r.kind)}>Rebuild</button>
        {r.kind === 'final' && <button className="soap-btn" disabled={busy} onClick={() => onBuild('provisional')}>Build this week so far</button>}
        {r.kind === 'provisional' && <button className="soap-btn" disabled={busy} onClick={() => onBuild('final')}>Build last week</button>}
      </div>

      <section className="soap-section">
        <h3>✅ Success</h3>
        {vd.success.length ? <ul>{vd.success.map((s) => <li key={s.key}>{s.text}</li>)}</ul> : <p className="soap-meta">Nothing met its mark this week.</p>}
      </section>

      <section className="soap-section">
        <h3>⭐ Star of the week</h3>
        {vd.star ? <p><strong>{vd.star.name}</strong>{vd.star.team ? ` — ${vd.star.team}` : ''}{vd.star.solved != null ? ` · ${vd.star.solved} solved` : ''}{vd.star.slaCompliancePct != null ? ` · SLA ${vd.star.slaCompliancePct}%` : ''}{vd.star.qaOverall != null ? ` · QA ${vd.star.qaOverall}` : ''}</p>
          : g.leaderboard ? <Gap text={g.leaderboard} /> : <p className="soap-meta">No agent ranked.</p>}
      </section>

      <section className="soap-section soap-section--amber">
        <h3>🟠 Turning amber</h3>
        {vd.ambers.length ? <ul>{vd.ambers.map((a) => <li key={a.key}>{a.text}</li>)}</ul> : <p className="soap-meta">Nothing turning amber.</p>}
      </section>

      <section className="soap-section soap-section--red">
        <h3>🔴 Red — and what you will do</h3>
        {vd.reds.length ? vd.reds.map((x) => (
          <div key={x.key} className="soap-red">
            <p><strong>{x.text}</strong>{x.detail ? <span className="soap-meta"> — {x.detail}</span> : null}</p>
            <label>What I will do to make it green by next Monday
              <textarea rows={2} value={(draft.reds[x.key] && draft.reds[x.key].action) || ''} onChange={(e) => setRed(x.key, e.target.value)} />
            </label>
          </div>
        )) : <p className="soap-meta">Nothing red.</p>}
      </section>

      {(r.carried || []).length > 0 && (
        <section className="soap-section">
          <h3>Last week’s reds</h3>
          {r.carried.map((c) => (
            <div key={c.key} className="soap-red">
              <p>{c.green ? '🟢 Delivered green: ' : '🔴 Still red: '}<strong>{c.text}</strong></p>
              {!c.green && (
                <>
                  <label>Why it isn’t green
                    <textarea rows={2} value={(draft.carried[c.key] && draft.carried[c.key].why) || ''} onChange={(e) => setCarried(c.key, 'why', e.target.value)} />
                  </label>
                  <label>Consequences for the people around you
                    <textarea rows={2} value={(draft.carried[c.key] && draft.carried[c.key].consequences) || ''} onChange={(e) => setCarried(c.key, 'consequences', e.target.value)} />
                  </label>
                </>
              )}
            </div>
          ))}
        </section>
      )}

      <section className="soap-section">
        <h3>SLA adherence, day on day (CC + T2 + Production)</h3>
        {r.slaDaily && r.slaDaily.length ? (
          <table className="soap-table">
            <thead><tr><th>Day</th><th>FRT</th><th>Resolution</th></tr></thead>
            <tbody>{r.slaDaily.map((d) => <tr key={d.day}><td>{d.label}</td><td>{pct(d.frt)}</td><td>{pct(d.res)}</td></tr>)}</tbody>
          </table>
        ) : <Gap text={g.sla || 'no daily SLA figures'} />}
      </section>

      <section className="soap-section">
        <h3>Agents</h3>
        {r.leaderboard && r.leaderboard.top ? (
          <>
            <p>Top: <strong>{r.leaderboard.top.agentName}</strong></p>
            {r.leaderboard.weakest && (
              <>
                <p>Least performing: <strong>{r.leaderboard.weakest.agentName}</strong>
                  {r.leaderboard.weakest.solved != null ? ` · ${r.leaderboard.weakest.solved} solved` : ''}
                  {r.leaderboard.weakest.slaCompliancePct != null ? ` · SLA ${r.leaderboard.weakest.slaCompliancePct}%` : ''}
                  {` · QA ${r.leaderboard.weakest.qaOverall != null ? r.leaderboard.weakest.qaOverall : '—'}`}</p>
                <label>Your commentary
                  <textarea rows={2} value={draft.weakest || ''} onChange={(e) => setDraft((d) => ({ ...d, weakest: e.target.value }))} />
                </label>
              </>
            )}
          </>
        ) : <Gap text={g.leaderboard || 'no ranked agents'} />}
      </section>

      <section className="soap-section">
        <h3>Worst 5 customers</h3>
        {r.customers && r.customers.rows && r.customers.rows.length ? (
          <>
            <p className="soap-meta">As at {when(r.customers.generatedAt)}, in NOVA’s order{r.customers.stale ? ' — NOVA says this list is stale' : ''}.</p>
            <ol>{r.customers.rows.map((c) => <li key={c.bcAccountNumber || c.name}><strong>{c.name}</strong>{c.why ? ` — ${c.why}` : ''}</li>)}</ol>
          </>
        ) : r.customers && (r.customers.status === 'none_qualify' || r.customers.status === 'stale')
          ? <p className="soap-meta">No customer has a negative current sentiment{r.customers.stale ? ' (NOVA says this list is stale)' : ''}.</p>
          : <Gap text={g.customers || 'NOVA did not answer'} />}
      </section>

      <section className="soap-section">
        <h3>Improvement initiatives</h3>
        {r.plan && r.plan.known ? (
          <ul>
            <li>{r.plan.totals.done} of {r.plan.totals.mine} done · {r.plan.open.length} open{r.plan.overdue.length ? ` · ${r.plan.overdue.length} past due` : ''}</li>
            {r.plan.doneThisWeek.map((d) => <li key={`d${d.id}`}>Delivered this week: {d.id} — {d.action}</li>)}
            {r.plan.overdue.slice(0, 5).map((o) => <li key={`o${o.id}`}>Past due ({o.dueText}): {o.id} — {o.action}{o.percent != null ? ` (${o.percent}%)` : ''}</li>)}
          </ul>
        ) : <Gap text={g.plan || 'VANTAGE did not answer'} />}
      </section>

      <section className="soap-section">
        <h3>Notes</h3>
        <textarea rows={3} value={draft.notes || ''} onChange={(e) => setDraft((d) => ({ ...d, notes: e.target.value }))} />
      </section>

      {r.gaps && r.gaps.length > 0 && (
        <div className="soap-gaps" role="note">
          <strong>Couldn’t read:</strong>
          <ul>{r.gaps.map((x, i) => <li key={i}>{x.source}{x.why ? ` — ${x.why}` : ''}</li>)}</ul>
          {r.verdictComplete === false && <p>A verdict source is missing, so a Monday send would be held.</p>}
        </div>
      )}

      <div className="soap-foot">
        <button className="soap-btn soap-btn--primary" disabled={busy || !dirty} onClick={onSave}>{dirty ? 'Save your words' : 'Saved'}</button>
        {r.kind === 'provisional' && (
          <button className="soap-btn" disabled={busy || dirty || v.blockers.length > 0 || data.recipientProblems.length > 0} onClick={onQueue}>
            Queue send for Monday 08:00
          </button>
        )}
      </div>
      {r.kind === 'provisional' && v.blockers.length > 0 && (
        <ul className="soap-blockers">{v.blockers.map((b, i) => <li key={i}>{b}</li>)}</ul>
      )}
      {data.recipientProblems.length > 0 && (
        <ul className="soap-blockers">{data.recipientProblems.map((b, i) => <li key={i}>Recipient — {b}</li>)}</ul>
      )}
      {data.recipients.length > 0 && <p className="soap-meta">Goes to {data.recipients.map((x) => `${x.name} <${x.email}>`).join(' and ')}.</p>}
      {send && <p className="soap-meta">Send: <strong>{STATUS_WORDS[send.status] || send.status}</strong>{send.outcomeDetail ? ` — ${send.outcomeDetail}` : ''}</p>}
    </div>
  );
}

const asDraft = (m) => ({ reds: { ...(m?.reds || {}) }, carried: { ...(m?.carried || {}) }, weakest: m?.weakest || '', notes: m?.notes || '' });

export default function SoapReportPanel() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [draft, setDraft] = useState(asDraft(null));
  const [saved, setSaved] = useState(asDraft(null));
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);

  const load = useCallback(async () => {
    try {
      const j = await apiFetch('/api/soap').then((r) => r.json());
      if (!j.ok) throw new Error(j.error || 'could not load');
      setData(j);
      const d = asDraft(j.current && j.current.manual);
      setDraft(d); setSaved(d); setError(null);
    } catch (e) { setError(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const week = data && data.current && data.current.report.from;

  const save = async () => {
    setBusy(true); setNote(null);
    try {
      const j = await apiFetch(`/api/soap/${week}/manual`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(draft),
      }).then((r) => r.json());
      if (!j.ok) throw new Error(j.error || 'not saved');
      await load();
    } catch (e) { setNote(`Not saved — ${e.message}. Your words are still in the boxes.`); }
    setBusy(false);
  };
  const build = async (kind) => {
    setBusy(true); setNote(null);
    try {
      const j = await apiFetch('/api/soap/build', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind }),
      }).then((r) => r.json());
      if (!j.ok) throw new Error(j.error || 'build failed');
      await load();
    } catch (e) { setNote(`Build failed — ${e.message}`); }
    setBusy(false);
  };
  const queue = async () => {
    setBusy(true); setNote(null);
    try {
      const j = await apiFetch(`/api/soap/${week}/queue-send`, { method: 'POST' }).then((r) => r.json());
      if (!j.ok) throw new Error((j.blockers && j.blockers.join('; ')) || j.error || 'not queued');
      setNote(j.already ? 'Already queued — approve it in Actions.' : 'Queued. Approve it in Actions with your approval code; it goes at 08:00 Monday.');
      await load();
    } catch (e) { setNote(`Not queued — ${e.message}`); }
    setBusy(false);
  };

  return (
    <div className="soap-panel">
      <div className="soap-top">
        <h1>SOAP report</h1>
        <p className="soap-hint">Monday debrief for Ricky and Chris: success, star, amber, red.</p>
      </div>
      {error && <p className="soap-error">Couldn’t load the SOAP report — {error}</p>}
      {note && <p className="soap-note" role="status">{note}</p>}
      {data && <SoapReportView data={data} draft={draft} setDraft={setDraft} dirty={dirty} busy={busy} onSave={save} onBuild={build} onQueue={queue} />}
    </div>
  );
}
