import React, { useState } from 'react';
import { useCanonical, postCanonical, HowItWorks } from './canonicalUi';

/**
 * Build 23 — Life → Finance. Not a bank statement and not a budget: what is
 * happening, what is changing, what is coming up, and whether anything needs
 * Nick. Every figure says what period and source it comes from. Tally is the
 * source of truth and nothing here moves money or edits a transaction.
 * Helen's own account appears only as totals.
 */

const money = (p) => (p == null ? '—' : `£${(Math.abs(p) / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const HEALTH_WORDS = { healthy: 'live', partial: 'partly live', stale: 'stale', reconnect_required: 'reconnect needed', unknown: 'unknown' };
const STATE_WORDS = { explicit_recurring: 'recurring (you said)', strong_pattern: 'recurring', weak_pattern: 'maybe recurring', not_recurring: 'not recurring' };
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
  const latest = (data.summaries || []).filter((s) => s.complete).slice(-1)[0] || null;
  const current = (data.summaries || []).slice(-1)[0] || null;
  return (
    <section className="cn-section">
      <h3>Finance</h3>
      {note && <div className="cn-error">{note}</div>}
      <Source data={data} busy={busy} act={act} />
      {latest && <Month s={latest} title={`${latest.month} (complete month)`} />}
      {current && !current.complete && current.month !== (latest && latest.month) && (
        <div className="cn-muted cn-small">{current.month} is partial ({current.coverageReasons[0]}) — not compared with complete months.</div>
      )}
      {data.monthOnMonth && <div className="cn-muted">{data.monthOnMonth.line || `Month on month: ${data.monthOnMonth.state} — ${data.monthOnMonth.why}`}</div>}
      <LiveComparison c={data.comparison} householdLatest={latest} />
      <Trend summaries={data.summaries || []} rolling={data.rolling} />
      <Upcoming upcoming={data.upcoming} obligations={data.obligations || []} />
      <Obligations obligations={data.obligations || []} series={data.series || []} busy={busy} act={act} personalAdmin={data.personalAdmin} />
      <Recurring series={data.series || []} priceChanges={data.priceChanges || []} busy={busy} act={act} />
      <Review review={data.review} busy={busy} act={act} />
      <Quality quality={data.quality} review={data.review} categories={data.tallyCategories || []} writes={data.tallyWrites !== false} rules={data.rules || []} busy={busy} act={act} />
      <HowItWorks>{data.rule}</HowItWorks>
    </section>
  );
}

function Source({ data, busy, act }) {
  const h = data.health || {};
  return (
    <div className="cn-row" style={{ padding: '10px 12px' }}>
      <div className="cn-rowtitle">Bank feeds: {HEALTH_WORDS[h.household] || h.household} — {h.label}</div>
      {/* 8 Oct 2026 — only an account that needs something stays on the page; the rest is one click down. */}
      <ul className="cn-list cn-small">
        {(h.accounts || []).filter((a) => a.state !== 'healthy').map((a) => <li key={a.accountRef}>{a.owner === 'helen' ? 'Helen’s account' : a.name}: {HEALTH_WORDS[a.state]} — {a.why}</li>)}
      </ul>
      {data.lastRead && data.lastRead.ok === false && <div className="cn-error">Last read failed — {data.lastRead.error}</div>}
      <details className="cn-details"><summary>Details</summary>
      <ul className="cn-list cn-small">
        {(h.accounts || []).filter((a) => a.state === 'healthy').map((a) => <li key={a.accountRef}>{a.owner === 'helen' ? 'Helen’s account' : a.name}: {HEALTH_WORDS[a.state]} — {a.why}</li>)}
      </ul>
      {h.helen && <div className="cn-muted cn-small">{h.helen.why}</div>}
      {data.source && <div className="cn-muted cn-small">Tally data {data.source.dataFrom} – {data.source.dataThrough} ({data.source.transactionsRead} transactions, read-only).{data.lastRead && data.lastRead.at ? ` Last read ${data.lastRead.at.slice(0, 16).replace('T', ' ')}.` : ''}</div>}
      {data.counts && data.counts.transfersInferred && data.counts.transfersInferred.count > 0 && (
        <div className="cn-muted cn-small">{data.counts.transfersInferred.count} unpaired transfers ({money(data.counts.transfersInferred.outPence)} out, {money(data.counts.transfersInferred.inPence)} in) treated as transfers — {data.counts.transfersInferred.why}</div>
      )}
      {data.reconnect && data.reconnect.anyRelinked && (
        <div className="cn-small">After reconnect: {data.reconnect.accounts.filter((a) => a.relinked).map((a) => `${a.owner === 'helen' ? 'Helen’s account' : a.name} backfilled from ${a.oldestBackfilled || '—'}${a.gapDays ? `, ${a.gapDays} days missing` : ''}${a.doubleImported ? `, ${a.doubleImported} double imports` : ''}`).join('; ')}.
          {data.reconnect.identityOk ? ' Account identity unchanged.' : ' ⚠ Account identity changed — check Tally.'}</div>
      )}
      </details>
      <button type="button" className="cn-btn cn-btn--tiny" disabled={busy} onClick={() => act(() => postCanonical('/api/finance/sync', {}))}>Read Tally now</button>
    </div>
  );
}

function Month({ s, title }) {
  const doms = Object.entries(s.byDomain || {}).sort((a, b) => b[1] - a[1]);
  return (
    <div className="cn-row" style={{ padding: '10px 12px' }}>
      <div className="cn-rowtitle">{title}: spending {money(s.spendPence)} · money out {money(s.moneyOutPence)} · income {money(s.incomePence)}{s.net && s.net.meaningful ? ` · net ${s.net.pence < 0 ? '−' : ''}${money(s.net.pence)}` : ''}</div>
      <div className="cn-chips">{doms.map(([d, p]) => <span key={d} className={`cn-chip${d === 'unknown' ? ' cn-chip--unknown' : ''}`}>{d.replace(/_/g, ' ')} {money(p)}</span>)}</div>
      <details className="cn-details"><summary>Breakdown</summary><div className="cn-muted cn-small">
        Nick’s account {money(s.owners.nickPence)} · Joint & Bills {money(s.owners.sharedPence)} · Helen’s own account {money(s.owners.helenOwnAccountPence)} (total only).
        {' '}Recurring {money(s.recurringPence)}. Biggest: {(s.biggestMerchants || []).map((m) => `${m.merchantKey} ${money(m.pence)}`).join(', ') || '—'}.
        {s.financingPence ? ` Loan & finance repayments ${money(s.financingPence)}.` : ''}{s.cardRepaymentsPence ? ` Card repayments ${money(s.cardRepaymentsPence)} — ${s.cardSpendNote}` : ''}
        {s.unresolvedDuplicates && s.unresolvedDuplicates.count ? ` ${s.unresolvedDuplicates.count} possible pending copies (${money(s.unresolvedDuplicates.pence)}) ${s.unresolvedDuplicates.note}.` : ''}
      </div></details>
    </div>
  );
}

/** While one account is not refreshing, the months the LIVE accounts cover, labelled as such. */
function LiveComparison({ c, householdLatest }) {
  if (!c || c.basis !== 'live-accounts') return null;
  const done = (c.summaries || []).filter((s) => s.complete);
  const last = done[done.length - 1];
  if (!last || (householdLatest && last.month <= householdLatest.month)) return <div className="cn-muted cn-small">{c.note}</div>;
  const doms = Object.entries(last.byDomain || {}).sort((a, b) => b[1] - a[1]).slice(0, 6);
  return (
    <div className="cn-row" style={{ padding: '10px 12px' }}>
      <div className="cn-rowtitle">{last.month}, live accounts only: spending {money(last.spendPence)} · money out {money(last.moneyOutPence)} · income {money(last.incomePence)}</div>
      <div className="cn-chips">{doms.map(([d, p]) => <span key={d} className={`cn-chip${d === 'unknown' ? ' cn-chip--unknown' : ''}`}>{d.replace(/_/g, ' ')} {money(p)}</span>)}</div>
      <div className="cn-muted cn-small">{c.note}{c.monthOnMonth ? ` ${c.monthOnMonth.line || `Month on month: ${c.monthOnMonth.state} — ${c.monthOnMonth.why}`}.` : ''}</div>
    </div>
  );
}

function Trend({ summaries, rolling }) {
  if (!summaries.length) return null;
  return (
    <details className="cn-details">
      <summary>Monthly trend — {rolling ? rolling.label : ''}</summary>
      <table className="cn-small" style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead><tr><th align="left">Month</th><th align="right">Spending</th><th align="right">Money out</th><th align="right">Income</th><th align="left">Coverage</th></tr></thead>
        <tbody>{summaries.map((s) => <tr key={s.month}><td>{s.month}</td><td align="right">{money(s.spendPence)}</td><td align="right">{money(s.moneyOutPence)}</td><td align="right">{money(s.incomePence)}</td><td>{s.complete ? 'complete' : `partial — ${s.coverageReasons[0]}`}</td></tr>)}</tbody>
      </table>
    </details>
  );
}

function Upcoming({ upcoming }) {
  if (!upcoming) return null;
  const d30 = upcoming.d30;
  return (
    <details className="cn-details">
      <summary>Upcoming money out — 7 days {money(upcoming.d7.knownPence)} · 14 days {money(upcoming.d14.knownPence)} · 30 days {money(d30.knownPence)} ({d30.label})</summary>
      <div className="cn-muted cn-small">{d30.reasons.join('; ')}.</div>
      <ul className="cn-list cn-small">{d30.items.map((i, n) => <li key={n}>{i.date} — {i.label} {i.amountPence ? money(i.amountPence) : '(no amount)'} · {i.basis}{i.caveat ? ` · ${i.caveat}` : ''}</li>)}</ul>
    </details>
  );
}

function Obligations({ obligations, series, busy, act, personalAdmin }) {
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
      <div className="cn-muted cn-small">Renewals, annual fees and known bills. A routine Direct Debit does not need one. Ticking a linked task is the action, not proof of payment.
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
          {series.filter((s) => !s.shownAsTotalOnly && s.direction === 'out').map((s) => <option key={s.seriesKey} value={s.seriesKey}>{s.label} ({money(s.typicalPence)})</option>)}
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

function Recurring({ series, priceChanges, busy, act }) {
  const operational = series.filter((s) => s.state === 'explicit_recurring' || s.state === 'strong_pattern');
  const weak = series.filter((s) => s.state === 'weak_pattern' && !s.shownAsTotalOnly);
  const total = operational.filter((s) => s.direction === 'out').reduce((a, s) => a + s.typicalPence, 0);
  return (
    <details className="cn-details">
      <summary>Recurring payments — {operational.filter((s) => s.direction === 'out').length} established, about {money(total)} a cycle{priceChanges.length ? ` · ${priceChanges.length} price change${priceChanges.length === 1 ? '' : 's'}` : ''}</summary>
      {priceChanges.map((p) => <div key={p.seriesKey} className="cn-small">{p.label}: {p.line} (from {p.firstAt})</div>)}
      <ul className="cn-list cn-small">
        {operational.map((s) => (
          <li key={s.seriesKey}>{s.label} — {s.direction === 'in' ? 'in' : 'out'} {money(s.typicalPence)} {s.cadence}, {STATE_WORDS[s.state]}{s.shownAsTotalOnly ? '' : `, ${s.accountName}`}{s.nextExpected ? `, next about ${s.nextExpected}${s.projectedThroughGap ? ' (projected)' : ''}` : ''}
            {!s.shownAsTotalOnly && s.state === 'strong_pattern' && <button type="button" className="cn-btn cn-btn--tiny" disabled={busy} onClick={() => act(() => postCanonical(`/api/finance/recurring/${s.seriesKey}/decide`, { decision: 'not-recurring' }))}>Not recurring</button>}</li>
        ))}
      </ul>
      {weak.length > 0 && <div className="cn-muted cn-small">Maybe recurring (not used for the forward view):</div>}
      <ul className="cn-list cn-small">
        {weak.slice(0, 10).map((s) => (
          <li key={s.seriesKey}>{s.label} {money(s.typicalPence)} — {s.why.slice(1).join('; ')}
            <button type="button" className="cn-btn cn-btn--tiny" disabled={busy} onClick={() => act(() => postCanonical(`/api/finance/recurring/${s.seriesKey}/decide`, { decision: 'recurring' }))}>It is recurring</button></li>
        ))}
      </ul>
    </details>
  );
}

function Review({ review, busy, act }) {
  if (!review) return null;
  const unusual = review.unusual.filter((u) => !u.explainedBy && !u.decision);
  const dups = review.duplicates.filter((d) => !d.decision);
  const hidden = review.hidden.helenUnusual + review.hidden.helenDuplicates;
  return (
    <details className="cn-details" open={unusual.length + dups.length > 0}>
      <summary>Worth a look — {unusual.length} unusual, {dups.length} possible duplicate{dups.length === 1 ? '' : 's'}</summary>
      <ul className="cn-list cn-small">
        {unusual.map((u) => <li key={u.itemKey}>{u.txn.date} · {u.line}
          <button type="button" className="cn-btn cn-btn--tiny" disabled={busy} onClick={() => act(() => postCanonical(`/api/finance/review/${u.itemKey}/decide`, { decision: 'expected' }))}>Expected</button></li>)}
        {dups.map((d) => <li key={d.itemKey}>{d.line}
          <button type="button" className="cn-btn cn-btn--tiny" disabled={busy} onClick={() => act(() => postCanonical(`/api/finance/review/${d.itemKey}/decide`, { decision: 'not-duplicate' }))}>Not a duplicate</button>
          <button type="button" className="cn-btn cn-btn--tiny" disabled={busy} onClick={() => act(() => postCanonical(`/api/finance/review/${d.itemKey}/decide`, { decision: 'look-into-it' }))}>I’ll look into it</button></li>)}
      </ul>
      {hidden > 0 && <div className="cn-muted cn-small">{hidden} more on Helen’s own account, not shown.</div>}
      <div className="cn-muted cn-small">Compared with your recorded history only. Nothing is disputed or reported.</div>
    </details>
  );
}

/**
 * 9 Oct 2026 — Tally is the one store. The picker lists TALLY'S categories and a
 * choice is written into Tally ("Always" = Tally's merchant rule). When Tally asks
 * before making a rule (an ambiguous merchant, or past choices that disagree),
 * its question is shown here with one button to make the rule anyway.
 */
function Quality({ quality, review, categories, writes, rules, busy, act }) {
  const [choice, setChoice] = useState({});
  const [ask, setAsk] = useState({});
  const [done, setDone] = useState(null);
  if (!quality) return null;
  const pick = (t, v) => setChoice({ ...choice, [t.sourceTransactionId]: v });
  const chosenFor = (t) => Number(choice[t.sourceTransactionId] || t.suggestedCategoryId || 0) || null;
  const decide = (t, remember, confirmRule = false) => act(async () => {
    const r = await postCanonical(`/api/finance/transactions/${t.sourceTransactionId}/decide`, { decision: 'confirm', categoryId: chosenFor(t), remember, confirmRule });
    setAsk({ ...ask, [t.sourceTransactionId]: r.needsConfirmation ? r.needsConfirmation.message : null });
    setDone(`${t.merchantKey} → ${r.category} in Tally${r.appliedToSimilar ? `, and ${r.appliedToSimilar} more from that merchant` : ''}${r.ruleCreated || r.ruleUpdated ? ' (Tally rule saved)' : ''}.`);
  });
  const spending = categories.filter((c) => c.kind === 'expense');
  return (
    <details className="cn-details">
      <summary>Category quality — {quality.score.classifiedPct}% of spending has a domain · {(review.classification || []).length} to review · {rules.filter((r) => r.active).length} rules</summary>
      <ul className="cn-list cn-small">{quality.readout.map((l, i) => <li key={i}>{l}</li>)}</ul>
      {quality.opportunities.length > 0 && (
        <div className="cn-small"><div className="cn-muted">Quickest wins</div>
          <ul className="cn-list cn-small">{quality.opportunities.slice(0, 4).map((o, i) => <li key={i}>{o.line}</li>)}</ul>
        </div>
      )}
      <div className="cn-small cn-muted">Choices are saved in Tally — change them there or here, it is the same record.{!writes && ' Tally writes are not configured on this NEURO, so the buttons are off.'}</div>
      {done && <div className="cn-small">{done}</div>}
      <div className="cn-txns">
        {(review.classification || []).slice(0, 15).map((t) => {
          const chosen = chosenFor(t) || '';
          const why = t.conflict ? t.conflict.why : t.category ? `Tally: ${t.category}` : 'no category';
          return (
            <React.Fragment key={t.sourceTransactionId}>
              <div className="cn-txn-main">
                <div className="cn-txn-head"><span className="cn-txn-merchant">{t.merchantKey}</span><span className="cn-txn-amt">{money(t.amountPence)}</span></div>
                <div className="cn-txn-why">{t.date} · {why}{t.hint ? ` · looks like ${t.hint.domain.replace(/_/g, ' ')}` : ''}</div>
                {ask[t.sourceTransactionId] && (
                  <div className="cn-txn-why">Tally asks: {ask[t.sourceTransactionId]}{' '}
                    <button type="button" className="cn-btn cn-btn--tiny" disabled={busy} onClick={() => decide(t, true, true)}>Make the rule</button>
                  </div>
                )}
              </div>
              <div className="cn-txn-act">
                <select className="cn-select" value={chosen} onChange={(e) => pick(t, e.target.value)} aria-label="Tally category">
                  <option value="">choose…</option>{spending.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
                <span className="cn-seg">
                  <button type="button" className="cn-btn" disabled={busy || !chosen || !writes} onClick={() => decide(t, false)} title="Just this transaction, in Tally">This one</button>
                  <button type="button" className="cn-btn" disabled={busy || !chosen || !writes} onClick={() => decide(t, true)} title={`Always file ${t.merchantKey} this way — saved as Tally's own rule`}>Always</button>
                  <button type="button" className="cn-btn" disabled={busy} onClick={() => act(() => postCanonical(`/api/finance/transactions/${t.sourceTransactionId}/decide`, { decision: 'unknown' }))} title="Leave it unclassified">Leave</button>
                </span>
              </div>
            </React.Fragment>
          );
        })}
      </div>
    </details>
  );
}
