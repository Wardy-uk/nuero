import React, { useState } from 'react';
import { useCanonical, postCanonical, HowItWorks } from './canonicalUi';

/**
 * Build 26 — Life → Finance, the OPERATIONAL view. Not a bank statement, not a
 * budget and not Tally's analytics: whether the money sources are healthy, the
 * state of things in Tally's own words, the one or two changes that matter,
 * what is coming, what needs Nick, and where money touches the rest of his life.
 * Every figure is Tally's (finance-intelligence-v1); NEURO calculates none, and
 * the detail lives one click away in Tally → Outlook.
 */

const money = (p) => (p == null ? '—' : `${p < 0 ? '−' : ''}£${(Math.abs(p) / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const HEALTH_WORDS = { healthy: 'live', partial: 'partly live', stale: 'stale', reconnect_required: 'reconnect needed', unknown: 'unknown' };
const PRESSURE_WORDS = { comfortable: 'Comfortable', tighter_than_usual: 'Tighter than usual', stretched: 'Stretched', insufficient_data: 'Not enough data' };
const OB_KINDS = [['renewal', 'Renewal'], ['bill', 'Bill'], ['annual_fee', 'Annual fee'], ['subscription_renewal', 'Subscription renewal'], ['household_charge', 'Household charge'], ['other', 'Other']];
const OB_STATE = { overdue: 'Overdue', needs_you: 'Needs you', preparation_open: 'In hand', upcoming: 'Upcoming', later: 'Later', unknown: 'No date', complete: 'Done' };

export default function FinanceCard() {
  const { data, error, reload } = useCanonical('/api/finance');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);
  const act = async (fn) => {
    setBusy(true); setNote(null);
    try { await fn(); await reload(); } catch (e) { setNote(`Not saved — ${e.message}`); }
    setBusy(false);
  };
  if (error && !data) return <section className="cn-section"><h3>Finance</h3><div className="cn-error">Couldn’t read finance — {error}</div></section>;
  if (!data) return <section className="cn-section"><h3>Finance</h3><div className="cn-muted">Reading…</div></section>;
  return <FinanceView data={data} busy={busy} act={act} note={note} />;
}

/** The whole card for one payload. Exported so it can be rendered for real in a test. */
export function FinanceView({ data, busy, act, note = null }) {
  const op = data.operational;
  const tally = data.source && data.source.tallyUrl;
  return (
    <section className="cn-section">
      <h3>Finance</h3>
      {note && <div className="cn-error">{note}</div>}
      <Source data={data} />
      {!op ? <div className="cn-muted">Tally’s finance intelligence has not been read yet.</div> : (
        <>
          <State op={op} />
          {op.needsAction.length > 0 && (
            <div className="cn-row" style={{ padding: '10px 12px' }}>
              <div className="cn-rowtitle">Needs you</div>
              <ul className="cn-list cn-small">{op.needsAction.map((n, i) => <li key={i}>{n.line}</li>)}</ul>
            </div>
          )}
          {op.synthesis.length > 0 && (
            <div className="cn-row" style={{ padding: '10px 12px' }}>
              <div className="cn-rowtitle">Where money meets the rest of life</div>
              <ul className="cn-list cn-small">{op.synthesis.map((s) => (
                <li key={s.id}>{s.line}<div className="cn-muted">Because: {s.facts.map((f) => `${f.system === 'tally' ? 'Tally' : 'NEURO'} — ${f.statement}`).join('; ')}</div></li>
              ))}</ul>
            </div>
          )}
          {op.changes.length > 0 && (
            <div className="cn-row" style={{ padding: '10px 12px' }}>
              <div className="cn-rowtitle">What changed</div>
              <ul className="cn-list cn-small">{op.changes.map((c, i) => <li key={i}>{c.line}{c.timing ? <div className="cn-muted">{c.timing}</div> : null}</li>)}</ul>
            </div>
          )}
          <Upcoming items={op.upcoming} />
          <div className="cn-muted cn-small">
            {op.toLook.unusual ? `${op.toLook.unusual} unusual item${op.toLook.unusual === 1 ? '' : 's'} and ` : ''}{op.toLook.priceChanges} price change{op.toLook.priceChanges === 1 ? '' : 's'} to look at — {tally ? <a href={tally} target="_blank" rel="noreferrer">Tally → Outlook</a> : 'in Tally → Outlook'}.
            {!op.categories.available && op.categories.why ? ` Category trends: not available (${op.categories.why}).` : ''}
          </div>
        </>
      )}
      <Obligations obligations={data.obligations || []} linkable={data.linkable || []} busy={busy} act={act} personalAdmin={data.personalAdmin} />
      <HowItWorks>{data.rule}</HowItWorks>
    </section>
  );
}

function Source({ data }) {
  const h = data.health || {};
  const sh = data.sourceHealth;
  const age = data.source && data.source.ageMinutes;
  return (
    <div className="cn-row" style={{ padding: '10px 12px' }}>
      <div className="cn-rowtitle">Bank feeds: {HEALTH_WORDS[h.household] || h.household} — {h.label}</div>
      <ul className="cn-list cn-small">
        {(h.accounts || []).filter((a) => a.state !== 'healthy').map((a) => <li key={a.accountRef}>{a.owner === 'private' ? `${a.name}’s account` : a.name}: {HEALTH_WORDS[a.state]} — {a.why}</li>)}
      </ul>
      {data.lastRead && data.lastRead.ok === false && <div className="cn-error">Last read of Tally failed — {data.lastRead.error}{age != null ? ` (showing what Tally said ${age} min ago)` : ''}</div>}
      {sh && (
        <details className="cn-details"><summary>Source health</summary>
          <ul className="cn-list cn-small">
            {sh.balances.map((b) => <li key={`b${b.accountId}`}>{b.owner === 'private' ? `${b.name}’s` : b.name} balance: {b.why}</li>)}
            {sh.transactions.map((t) => <li key={`t${t.accountId}`}>{t.owner === 'private' ? `${t.name}’s` : t.name}: {t.why}</li>)}
            <li>Categories: {sh.categories.state} — {sh.categories.why}</li>
            <li>Recurring payments: {sh.recurrence.state} — {sh.recurrence.why}</li>
            <li>Forecast: {sh.forecast.state}</li>
          </ul>
        </details>
      )}
    </div>
  );
}

function State({ op }) {
  const f = op.forecast;
  return (
    <div className="cn-row" style={{ padding: '10px 12px' }}>
      <div className="cn-rowtitle">{PRESSURE_WORDS[op.pressure.state] || op.pressure.state}{op.position.usablePence != null ? ` · ${money(op.position.usablePence)} across the household now` : ''}</div>
      <ul className="cn-list cn-small">
        {op.pressure.why.slice(0, 3).map((w, i) => <li key={i}>{w}</li>)}
        {f.d30 ? <li>Next 30 days ({f.confidence} confidence): known payments alone leave {money(f.d30.projectedPence)} on {f.d30.through}; lowest {money(f.d30.lowestPoint.pence)} on {f.d30.lowestPoint.date}. Day-to-day spending is not included.</li>
          : <li>No forward view: {(f.why || [])[0] || 'not enough current data'}.</li>}
        {f.nextIncome && <li>Next income: {f.nextIncome.label} on {f.nextIncome.date}.</li>}
      </ul>
      <div className="cn-muted cn-small">{op.position.statement}</div>
    </div>
  );
}

function Upcoming({ items }) {
  if (!items.length) return null;
  return (
    <details className="cn-details">
      <summary>Coming up — {items.length} dated item{items.length === 1 ? '' : 's'} (not every direct debit)</summary>
      <ul className="cn-list cn-small">{items.map((u, i) => (
        <li key={i}>{u.date || 'no date'} — {u.label}{u.pence ? ` ${money(u.pence)}` : ''} <span className="cn-chip">{u.source === 'tally' ? (u.kind === 'annual' ? 'annual (Tally)' : 'planned (Tally)') : (OB_STATE[u.state] || u.state)}</span></li>
      ))}</ul>
    </details>
  );
}

function Obligations({ obligations, linkable, busy, act, personalAdmin }) {
  const [f, setF] = useState({ kind: 'renewal', title: '', dueDate: '', amount: '', requiresDecision: false, seriesKey: '' });
  const open = obligations.filter((o) => o.status === 'open');
  const submit = (e) => {
    e.preventDefault();
    const body = { kind: f.kind, title: f.title, dueDate: f.dueDate || null, requiresDecision: f.requiresDecision, seriesKey: f.seriesKey || null };
    if (f.amount) body.expectedAmountPence = Math.round(Number(f.amount) * 100);
    act(() => postCanonical('/api/finance/obligations', body)).then(() => setF({ ...f, title: '', dueDate: '', amount: '' }));
  };
  return (
    <details className="cn-details" open={open.some((o) => o.state === 'needs_you' || o.state === 'overdue')}>
      <summary>Finance dates you recorded — {open.length} open</summary>
      <div className="cn-muted cn-small">Renewals and fees that need an action or a decision. A routine Direct Debit does not need one. Ticking a linked task is the action, not proof of payment.
        {personalAdmin && personalAdmin.note ? ` ${personalAdmin.note}` : ''}</div>
      <ul className="cn-list">
        {open.map((o) => (
          <li key={o.id} className="cn-row" style={{ padding: '8px 12px' }}>
            <div className="cn-rowtitle">{o.title} — {o.dueDate || 'no date'} {o.expectedAmountPence ? money(o.expectedAmountPence) : ''} <span className="cn-chip">{OB_STATE[o.state] || o.state}</span></div>
            <div className="cn-muted cn-small">{o.stateWhy}{o.payment ? ` · ${o.payment}` : ''}{o.task ? ` · task: ${o.task.title} (${o.task.status})` : o.linkedTaskRef ? ` · linked ${o.linkedTaskRef}` : ''}</div>
            <Resolve o={o} busy={busy} act={act} />
          </li>
        ))}
      </ul>
      <form className="cn-goalform" onSubmit={submit}>
        <select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })} aria-label="Kind">{OB_KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
        <input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="e.g. Home insurance renewal" aria-label="Title" />
        <input type="date" value={f.dueDate} onChange={(e) => setF({ ...f, dueDate: e.target.value })} aria-label="Due date" />
        <input value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} placeholder="£ expected" aria-label="Expected amount" inputMode="decimal" />
        <select value={f.seriesKey} onChange={(e) => setF({ ...f, seriesKey: e.target.value })} aria-label="Recurring payment">
          <option value="">no recurring payment</option>
          {linkable.map((s) => <option key={s.key} value={s.key}>{s.label} ({money(s.typicalPence)})</option>)}
        </select>
        <label className="cn-small"><input type="checkbox" checked={f.requiresDecision} onChange={(e) => setF({ ...f, requiresDecision: e.target.checked })} /> needs my decision</label>
        <button className="cn-btn" disabled={busy || f.title.trim().length < 2}>Record</button>
      </form>
    </details>
  );
}

function Resolve({ o, busy, act }) {
  const [ev, setEv] = useState('');
  const [txt, setTxt] = useState('');
  return (
    <div className="cn-small">
      <select value={ev} onChange={(e) => setEv(e.target.value)} aria-label="Evidence">
        <option value="">resolve with…</option>
        <option value="payment-seen">payment seen in Tally</option><option value="renewed">renewed</option><option value="statement">statement / letter</option><option value="cancelled">cancelled</option>
      </select>
      {ev && ev !== 'payment-seen' && <input value={txt} onChange={(e) => setTxt(e.target.value)} placeholder="what is the evidence?" aria-label="Evidence note" />}
      {ev && <button type="button" className="cn-btn cn-btn--tiny" disabled={busy} onClick={() => act(() => postCanonical(`/api/finance/obligations/${o.id}/resolve`, { evidence: ev, note: txt || null }))}>Resolve</button>}
    </div>
  );
}
