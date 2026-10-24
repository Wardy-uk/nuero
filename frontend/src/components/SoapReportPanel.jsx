import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../api';
import { executeDirect, directOutcome } from '../directAction';
import './SoapReportPanel.css';

// ── SOAP report — the Monday debrief for Chris, Ricky and Liam (15 Oct 2026) ─
//
// ⚠ THE SERVER DECIDES the verdicts (services/soap-report.js). This screen
// renders them and collects the only things NEURO cannot know: what Nick will
// do about each red, and why a red he carried in is still red.
// ⚠ A source NEURO could not read is shown as a gap in amber, never as an
// empty section.

const STATUS_WORDS = {
  prepared: 'Prepared — not sent yet',
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

const LIGHT = { green: '🟢', amber: '🟠', red: '🔴' };
const pct = (x) => (x && x.pct != null ? `${x.pct}%` : '—');
const when = (iso) => (iso ? new Date(iso).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');

// A section of the report with an "Exclude" box: ticked, it is left out of
// the email and the vault note (the server drops it; this only says so).
function Sec({ k, title, className, draft, setDraft, locked, children }) {
  const off = (draft.excluded || []).includes(k);
  const toggle = (e) => setDraft((d) => {
    const cur = new Set(d.excluded || []);
    if (e.target.checked) cur.add(k); else cur.delete(k);
    return { ...d, excluded: [...cur] };
  });
  return (
    <section className={`soap-section${className ? ` ${className}` : ''}${off ? ' soap-section--excluded' : ''}`}>
      <div className="soap-sec-head">
        <h3>{title}</h3>
        <label className="soap-exclude"><input type="checkbox" checked={off} disabled={locked} onChange={toggle} /> Exclude</label>
      </div>
      {off ? <p className="soap-meta">Left out of the report.</p> : children}
    </section>
  );
}

function Gap({ text }) {
  return <p className="soap-gap">Not available — {text}</p>;
}

export function SoapReportView({ data, draft, setDraft, dirty, busy, onSave, onBuild, onQueue, onPublish, onTest, onMarkSent, onReopen, preview, onPreview, note }) {
  const v = data.current;
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
  const locked = !!v.locked;
  const names = data.recipients.map((x) => x.name.split(' ')[0]).join(', ') || 'them';
  const g = r.gapsBySection || {};
  const setRed = (key, action) => setDraft((d) => ({ ...d, reds: { ...d.reds, [key]: { action } } }));
  const secProps = { draft, setDraft, locked };
  const setCarried = (key, field, val) => setDraft((d) => ({ ...d, carried: { ...d.carried, [key]: { ...(d.carried[key] || {}), [field]: val } } }));

  return (
    <div className="soap-body">

      <div className="soap-head">
        <h2>Week {r.from} to {r.to} — {r.kind === 'provisional' ? `provisional, data to ${r.upTo}` : 'final (the full week)'}</h2>
        <span className="soap-meta">Built {when(r.generatedAt)}</span>
      </div>
      {locked && (
        <div className="soap-banner" role="note">
          Sent {v.sent ? new Date(v.sent.sentAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''}{v.sent && v.sent.reportedByNick ? ' (recorded by you)' : ''}. This week is finished: what you see is what was sent, frozen, not a rebuild. Reopen it if something needs changing.
        </div>
      )}
      {!locked && v.sent && v.sent.reopenedAt && (
        <div className="soap-banner" role="note">Reopened after it was sent — the figures may no longer match what {names} received.</div>
      )}
      <div className="soap-actions">
        <button className="soap-btn" disabled={busy || locked} onClick={() => onBuild(r.kind)}>Rebuild</button>
        {r.kind === 'final' && <button className="soap-btn" disabled={busy} onClick={() => onBuild('provisional')}>Build this week so far</button>}
        {r.kind === 'provisional' && <button className="soap-btn" disabled={busy} onClick={() => onBuild('final')}>Build last week</button>}
      </div>

      <section className="soap-section">
        <h3>Intro</h3>
        <p className="soap-meta">Opens the email, above everything else — e.g. “As I’m on annual leave today, please see below the Service Desk SOAP.” Leave blank for none.</p>
        <textarea rows={2} disabled={locked} value={draft.intro || ''} onChange={(e) => setDraft((d) => ({ ...d, intro: e.target.value }))} />
      </section>

      <Sec k="success" title="✅ Success" {...secProps}>
        {vd.success.length || (v.fixes && v.fixes.fixed.length)
          ? <ul>{vd.success.map((s) => <li key={s.key}>{s.text}</li>)}{((v.fixes && v.fixes.fixed) || []).map((f) => <li key={`fix-${f.id}`}>Fixed: {f.title} — {f.problem} ({f.systemLabel}{f.fixedIn ? ` ${f.fixedIn}` : ''})</li>)}</ul>
          : <p className="soap-meta">Nothing met its mark this week.</p>}
      </Sec>

      <Sec k="star" title="⭐ Star of the week" {...secProps}>
        {vd.star ? <p><strong>{vd.star.name}</strong>{vd.star.team ? ` — ${vd.star.team}` : ''}{vd.star.solved != null ? ` · ${vd.star.solved} solved` : ''}{vd.star.slaCompliancePct != null ? ` · SLA ${vd.star.slaCompliancePct}%` : ''}{vd.star.qaOverall != null ? ` · QA ${vd.star.qaOverall}` : ''}</p>
          : g.leaderboard ? <Gap text={g.leaderboard} /> : <p className="soap-meta">No agent ranked.</p>}
      </Sec>

      <Sec k="amber" title="🟠 Turning amber" className="soap-section--amber" {...secProps}>
        {vd.ambers.length ? <ul>{vd.ambers.map((a) => <li key={a.key}>{a.text}</li>)}</ul> : <p className="soap-meta">Nothing turning amber.</p>}
      </Sec>

      <Sec k="red" title="🔴 Red — and what you will do" className="soap-section--red" {...secProps}>
        {vd.reds.length ? vd.reds.map((x) => (
          <div key={x.key} className="soap-red">
            <p><strong>{x.text}</strong>{x.detail ? <span className="soap-meta"> — {x.detail}</span> : null}</p>
            <label>What I will do to make it green by next Monday
              <textarea rows={2} value={(draft.reds[x.key] && draft.reds[x.key].action) || ''} onChange={(e) => setRed(x.key, e.target.value)} />
            </label>
          </div>
        )) : <p className="soap-meta">Nothing red.</p>}
      </Sec>

      {(r.carried || []).length > 0 && (
        <Sec k="carried" title="Last week’s reds" {...secProps}>
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
        </Sec>
      )}

      <Sec k="perQueue" title="SLA compliance by queue" {...secProps}>
        {r.perQueue && r.perQueue.length ? (
          <>
            <table className="soap-table">
              <thead><tr><th>Queue</th><th>This week</th><th>Last week</th><th>Target</th></tr></thead>
              <tbody>{r.perQueue.map((q) => (
                <tr key={q.key}>
                  <td>{q.label}</td>
                  <td>{LIGHT[q.rag] || ''} {q.value == null ? 'no data' : `${q.value}%`}</td>
                  <td>{q.was == null ? 'no data' : `${q.was}%`}</td>
                  <td>{q.target != null ? `${q.target}%` : '—'}</td>
                </tr>
              ))}</tbody>
            </table>
            <p className="soap-meta">“no data” means the queue solved nothing that week.</p>
          </>
        ) : <Gap text={g.perQueue || 'NOVA did not answer'} />}
      </Sec>

      <Sec k="slaDaily" title="SLA adherence, day on day (CC + T2 + Production)" {...secProps}>
        {r.slaDaily && r.slaDaily.length ? (
          <table className="soap-table">
            <thead><tr><th>Day</th><th>FRT</th><th>Resolution</th></tr></thead>
            <tbody>{r.slaDaily.map((d) => <tr key={d.day}><td>{d.label}</td><td>{pct(d.frt)}</td><td>{pct(d.res)}</td></tr>)}</tbody>
          </table>
        ) : <Gap text={g.sla || 'no daily SLA figures'} />}
      </Sec>

      <Sec k="ageing" title="Ageing vs target (oldest actionable ticket per queue)" {...secProps}>
        {r.ageing && r.ageing.length ? (
          <>
            <table className="soap-table">
              <thead><tr><th>Queue</th><th>Days</th><th>Target</th><th>Over by</th></tr></thead>
              <tbody>{r.ageing.map((a) => (
                <tr key={a.kpi}><td>{String(a.kpi).replace(/^Oldest actionable \(days\):\s*/i, '')}</td><td>{a.value}</td><td>{a.target}</td><td>{a.ratio}×</td></tr>
              ))}</tbody>
            </table>
            <p className="soap-meta">NOVA advises confirming extreme figures are genuine backlog, not a due-date configuration artefact.</p>
          </>
        ) : r.ageing ? <p className="soap-meta">No queue is carrying tickets past its target age.</p> : <Gap text={g.kpi || 'NOVA did not answer'} />}
      </Sec>

      <Sec k="volumes" title="Volumes and backlog" {...secProps}>
        {r.volumes && r.volumes.length ? (
          <table className="soap-table">
            <thead><tr><th></th><th>This week</th><th>Last week</th></tr></thead>
            <tbody>{r.volumes.map((v2) => (
              <tr key={v2.name}><td>{v2.label}</td><td>{v2.now == null ? 'no data' : v2.now}</td><td>{v2.was == null ? 'no data' : v2.was}</td></tr>
            ))}</tbody>
          </table>
        ) : <Gap text={g.sla || 'NOVA did not answer'} />}
      </Sec>

      <Sec k="csat" title="CSAT and sentiment" {...secProps}>
        {r.csat && r.csat.length ? <ul>{r.csat.map((c) => <li key={c.key || c.label}>{c.label}: {c.now} (last week {c.was}) {c.delta}</li>)}</ul> : <Gap text={g.kpi || 'NOVA did not answer'} />}
        {r.sentiment ? (
          <ul>
            {r.sentiment.survey && <li>Customer survey (7 days): {r.sentiment.survey.responded} replies from {r.sentiment.survey.sent} sent ({r.sentiment.survey.ratePct}%){r.sentiment.survey.thin ? ' — too few to quote a score' : ''}</li>}
            {r.sentiment.tickets && <li>Sentiment on problem tickets: {r.sentiment.tickets.scored} scored, {r.sentiment.tickets.negative} negative{r.sentiment.tickets.average != null ? `, average ${r.sentiment.tickets.average}` : ''}</li>}
            {r.sentiment.team && <li>Team: {r.sentiment.team.title} — average {r.sentiment.team.avg} from {r.sentiment.team.responses} responses</li>}
            {r.sentiment.unavailable.length > 0 && <li className="soap-gap">Not read: {r.sentiment.unavailable.join(', ')}</li>}
          </ul>
        ) : <Gap text={g.sentiment || 'NOVA did not answer'} />}
      </Sec>

      <Sec k="agents" title="Agents" {...secProps}>
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
      </Sec>

      <Sec k="customers" title="Worst 5 customers" {...secProps}>
        {r.customers && r.customers.rows && r.customers.rows.length ? (
          <>
            <p className="soap-meta">As at {when(r.customers.generatedAt)}, in NOVA’s order{r.customers.stale ? ' — NOVA says this list is stale' : ''}.</p>
            <ol>{r.customers.rows.map((c) => <li key={c.bcAccountNumber || c.name}><strong>{c.name}</strong>{c.why ? ` — ${c.why}` : ''}</li>)}</ol>
          </>
        ) : r.customers && (r.customers.status === 'none_qualify' || r.customers.status === 'stale')
          ? <p className="soap-meta">No customer has 2 or more unhappy current tickets (Frustrated or worse){r.customers.stale ? ' (NOVA says this list is stale)' : ''}.</p>
          : <Gap text={g.customers || 'NOVA did not answer'} />}
      </Sec>

      <Sec k="winning" title="Customers winning after support" {...secProps}>
        {r.winning && r.winning.rows && r.winning.rows.length
          ? <ol>{r.winning.rows.map((c) => <li key={c.bcAccountNumber || c.name}><strong>{c.name}</strong> — {c.why}</li>)}</ol>
          : r.winning && r.winning.status === 'none_qualify'
            ? <p className="soap-meta">No customer had 2 or more tickets resolved this week ending better than they started.</p>
            : <Gap text={g.winning || 'NOVA did not answer'} />}
      </Sec>

      <Sec k="plan" title="Improvement initiatives" {...secProps}>
        {r.plan && r.plan.known ? (
          <ul>
            {r.plan.rag && <li><strong>Plan status: {LIGHT[r.plan.rag.rag]} {String(r.plan.rag.rag).toUpperCase()}</strong> — {r.plan.overdue.length} of {r.plan.open.length} open actions past due</li>}
            <li><strong>Completed this week: {r.plan.completedThisWeek != null ? r.plan.completedThisWeek : r.plan.doneThisWeek.length}</strong> · {r.plan.totals.done} of {r.plan.totals.mine} done overall</li>
            {r.plan.doneThisWeek.map((d) => <li key={`d${d.id}`}>Delivered this week: {d.id} — {d.action}</li>)}
            {r.plan.overdue.slice(0, 5).map((o) => <li key={`o${o.id}`}>Past due ({o.dueText}): {o.id} — {o.action}{o.percent != null ? ` (${o.percent}%)` : ''}</li>)}
          </ul>
        ) : <Gap text={g.plan || 'VANTAGE did not answer'} />}
      </Sec>

      <Sec k="findings" title="Open findings" {...secProps}>
        {r.findings && r.findings.length ? (
          <ul>
            {r.findings.map((f) => <li key={f.id}>{f.severity ? <strong>{f.severity} — </strong> : null}{f.title}{f.foundOn ? <span className="soap-meta"> (since {f.foundOn})</span> : null}</li>)}
            {r.findingsOpen > r.findings.length && <li className="soap-meta">…and {r.findingsOpen - r.findings.length} more open in VANTAGE</li>}
          </ul>
        ) : r.findings ? <p className="soap-meta">No open findings.</p> : <Gap text={g.findings || 'VANTAGE did not answer'} />}
      </Sec>

      <Sec k="leading" title="Leading indicators" {...secProps}>
        {r.leading && r.leading.available ? (
          r.leading.fired.length
            ? <ul>{r.leading.fired.map((i, k) => <li key={k}><strong>{i.title}</strong>{i.change ? ` — ${i.change}` : ''}{i.horizonDays ? <span className="soap-meta"> (useful for ~{i.horizonDays} days, confidence {i.confidence})</span> : null}</li>)}</ul>
            : <p className="soap-meta">No early warning this week ({r.leading.quiet} checks running, all quiet).</p>
        ) : <Gap text={g.leading || 'VANTAGE did not answer'} />}
      </Sec>

      <Sec k="slm" title={`Friday Support Leadership Meeting${r.slm && (r.slm.date || (/^\d{4}-\d{2}-\d{2}/.exec(r.slm.note || '') || [])[0]) ? ` — ${r.slm.date || r.slm.note.slice(0, 10)}` : ''}`} {...secProps}>
        {r.slm ? [['Highlights', r.slm.highlights], ['Lowlights', r.slm.lowlights], ['Blockers', r.slm.blockers]].map(([h, list]) => (
          <div key={h}><p><strong>{h}</strong></p>{list && list.length ? <ul>{list.map((x, k) => <li key={k}>{x}</li>)}</ul> : <p className="soap-meta">None.</p>}</div>
        )) : <Gap text={g.slm || 'no meeting note found'} />}
      </Sec>

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
        <button className="soap-btn soap-btn--primary" disabled={busy || !dirty || locked} onClick={onSave}>{dirty ? 'Save' : 'Saved'}</button>
        <button className={`soap-btn${v.published ? ' soap-btn--done' : ''}`} disabled={busy} onClick={onPublish}>{v.published ? '✓ Published to vault' : 'Publish to vault'}</button>
        {locked
          ? <span className="soap-btn soap-btn--sent">✓ Sent to {names}</span>
          : <button className="soap-btn" disabled={busy || dirty || v.blockers.length > 0 || data.recipientProblems.length > 0} onClick={onQueue}>
              {r.kind === 'provisional' ? 'Send Monday 08:00' : 'Send now'}
            </button>}
        <button className="soap-btn" disabled={busy} onClick={onTest}>Test send to me</button>
        <button className="soap-btn" disabled={busy} onClick={onPreview}>{preview !== null ? 'Hide preview' : 'Preview note'}</button>
        {!locked && <button className="soap-btn" disabled={busy || dirty} onClick={onMarkSent}>I sent it myself</button>}
        {locked && <button className="soap-btn soap-btn--right" disabled={busy} onClick={onReopen}>Reopen this week</button>}
      </div>
      {note && <p className="soap-note" role="status">{note}</p>}
      {v.published && <p className="soap-meta">Published {new Date(v.published.publishedAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} to {v.published.path}.</p>}
      {preview !== null && <pre className="soap-preview">{preview}</pre>}
      {!locked && v.blockers.length > 0 && (
        <ul className="soap-blockers">{v.blockers.map((b, i) => <li key={i}>{b}</li>)}</ul>
      )}
      {data.recipientProblems.length > 0 && (
        <ul className="soap-blockers">{data.recipientProblems.map((b, i) => <li key={i}>Recipient — {b}</li>)}</ul>
      )}
      {data.recipients.length > 0 && <p className="soap-meta">Goes to {data.recipients.map((x) => `${x.name} <${x.email}>`).join(' and ')}.</p>}
      {send && <p className="soap-meta">Send ({send.target && send.target.kind === 'final' ? 'full week' : 'provisional'}): <strong>{STATUS_WORDS[send.status] || send.status}</strong>{send.outcomeDetail ? ` — ${send.outcomeDetail}` : ''}</p>}
    </div>
  );
}

// The distribution list: People-note names. The address shown is the one the
// note holds — what the send will use. A name with no note is shown, not hidden.
function Distribution({ onChanged }) {
  const [info, setInfo] = useState(null);
  const [names, setNames] = useState([]);
  const [adding, setAdding] = useState('');
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const j = await apiFetch('/api/soap/recipients').then((r) => r.json()).catch(() => null);
    if (j && j.ok) { setInfo(j); setNames(j.names); }
  }, []);
  useEffect(() => { load(); }, [load]);
  if (!info) return null;
  const dirty = JSON.stringify(names) !== JSON.stringify(info.names);
  const addressOf = (n) => (info.recipients.find((r) => r.name.toLowerCase() === n.toLowerCase()) || {}).email;
  const problemOf = (n) => info.problems.find((p) => p.toLowerCase().startsWith(`${n.toLowerCase()}:`));
  const save = async () => {
    setBusy(true); setMsg(null);
    try {
      const j = await apiFetch('/api/soap/recipients', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ names }),
      }).then((r) => r.json());
      if (!j.ok) throw new Error(j.error || 'not saved');
      setInfo({ ...info, ...j }); setNames(j.names);
      setMsg(j.problems.length ? `Saved — ${j.problems.length} name(s) do not resolve yet, so Queue send will refuse until they do.` : 'Saved.');
      if (onChanged) onChanged();
    } catch (e) { setMsg(`Not saved — ${e.message}`); }
    setBusy(false);
  };
  const add = () => {
    const n = adding.replace(/\s+/g, ' ').trim();
    if (!n || names.some((x) => x.toLowerCase() === n.toLowerCase())) return;
    setNames([...names, n]); setAdding('');
  };
  return (
    <section className="soap-section soap-dist">
      <h3>Distribution list</h3>
      <ul className="soap-dist-list">
        {names.map((n) => (
          <li key={n}>
            <span><strong>{n}</strong> {info.names.includes(n) ? (addressOf(n) ? <span className="soap-meta">&lt;{addressOf(n)}&gt;</span> : <span className="soap-gap">{(problemOf(n) || '').replace(/^[^:]*:\s*/, '') || 'no address'}</span>) : <span className="soap-meta">(not saved yet)</span>}</span>
            <button className="soap-btn soap-btn--small" disabled={busy || names.length <= 1} onClick={() => setNames(names.filter((x) => x !== n))}>Remove</button>
          </li>
        ))}
      </ul>
      <div className="soap-dist-add">
        <input value={adding} placeholder="People-note name, e.g. Liam Sims" onChange={(e) => setAdding(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') add(); }} />
        <button className="soap-btn soap-btn--small" disabled={busy || !adding.trim() || names.length >= info.max} onClick={add}>Add</button>
        <button className="soap-btn soap-btn--primary soap-btn--small" disabled={busy || !dirty} onClick={save}>{dirty ? 'Save list' : 'Saved'}</button>
      </div>
      <p className="soap-meta">Names must match a People note with an <code>email:</code> line — the address comes from the note. Up to {info.max}. A queued send keeps the list it was queued with; queue again after changing it.</p>
      {msg && <p className="soap-meta">{msg}</p>}
    </section>
  );
}

const asDraft = (m) => ({ reds: { ...(m?.reds || {}) }, carried: { ...(m?.carried || {}) }, weakest: m?.weakest || '', notes: m?.notes || '', intro: m?.intro || '', excluded: [...(m?.excluded || [])] });

export default function SoapReportPanel() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [draft, setDraft] = useState(asDraft(null));
  const [saved, setSaved] = useState(asDraft(null));
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);
  const [preview, setPreview] = useState(null);

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
  const kind = data && data.current && data.current.report.kind;

  const act = async (path, body, okNote) => {
    setBusy(true); setNote(null);
    try {
      const j = await apiFetch(`/api/soap/${week}/${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
      }).then((r) => r.json());
      if (!j.ok) throw new Error((j.blockers && j.blockers.join('; ')) || j.error || 'refused');
      setNote(typeof okNote === 'function' ? okNote(j) : okNote);
      await load();
    } catch (e) { setNote(`Not done — ${e.message}`); }
    setBusy(false);
  };
  const publish = () => act('publish', { kind }, (j) => `Published to ${j.path}.`);
  const testSend = () => act('test-send', { kind }, (j) => `Test copy sent to ${j.to}${j.unfinished ? ` — ${j.unfinished} thing(s) still to write, the mail says so` : ''}.`);
  const markSent = () => act('mark-sent', { kind }, 'Recorded as sent by you. The week is now frozen.');
  const reopen = () => act('reopen', {}, 'Reopened — you can rebuild and send again.');
  const togglePreview = () => setPreview(preview !== null ? null : (data.current && data.current.markdown) || '');

  const save = async () => {
    setBusy(true); setNote(null);
    try {
      const j = await apiFetch(`/api/soap/${week}/manual`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(draft),
      }).then((r) => r.json());
      if (!j.ok) throw new Error(j.error || 'not saved');
      await load();
      setNote(`Saved at ${new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}.`);
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
      const j = await apiFetch(`/api/soap/${week}/queue-send`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind }),
      }).then((r) => r.json());
      if (!j.ok) throw new Error((j.blockers && j.blockers.join('; ')) || j.error || 'not queued');
      // 24 Oct 2026 (Nick): the press is the decision — no trip to Actions, no
      // code. A provisional is approved now and goes at 08:00 Monday.
      if (j.action && j.action.status && j.action.status !== 'prepared') {
        setNote(STATUS_WORDS[j.action.status] || `It is already ${j.action.status}.`);
        await load(); setBusy(false); return;
      }
      const x = await executeDirect(j.action);
      if (x.ok && x.status === 'approved') {
        setNote(kind === 'provisional' ? 'Approved — it goes at 08:00 Monday if the verdicts hold.' : 'Approved — sending now.');
      } else {
        setNote(directOutcome(x).text);
      }
      await load();
    } catch (e) { setNote(`Not queued — ${e.message}`); }
    setBusy(false);
  };

  return (
    <div className="soap-panel">
      <div className="soap-top">
        <h1>SOAP report</h1>
        <p className="soap-hint">Monday debrief for Chris, Ricky and Liam: success, star, amber, red. Frozen Friday 17:00, sent Monday 08:00 once you approve.</p>
      </div>
      {error && <p className="soap-error">Couldn’t load the SOAP report — {error}</p>}
      {note && <p className="soap-note" role="status">{note}</p>}
      <Distribution onChanged={load} />
      {data && <SoapReportView data={data} draft={draft} setDraft={setDraft} dirty={dirty} busy={busy} onSave={save} onBuild={build} onQueue={queue}
        onPublish={publish} onTest={testSend} onMarkSent={markSent} onReopen={reopen} preview={preview} onPreview={togglePreview} note={note} />}
    </div>
  );
}
