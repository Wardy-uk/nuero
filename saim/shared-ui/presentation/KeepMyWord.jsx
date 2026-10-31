import { useState } from 'react';
import { promiseMoveResult } from './promiseMove.mjs';
import './KeepMyWord.css';

// Keep my word — the locked SAiM home scene (timefield.html, 21 Oct 2026).
//
// Draws `presentation.keepMyWord` (keep-my-word-v1). Mounted by Situation (the
// phone, the desktop and the kiosk) and by Alt's ManifestView, so all four draw
// ONE decision in one vocabulary:
//   - the READOUT: a compact left-hand column — the week's promises kept on
//     time, the Monday report, the next protected time, what needs judgement;
//   - the MAIN surface: a verified RECEIPT (what changed, how it was checked,
//     where it lives) or the promise SAiM is holding as a THREAD.
//
// ⚠ IT DECIDES NOTHING. State, order, wording and the lead rule are the
//   server's. Its controls are hand-offs the SHELL supplies: `onOpen` (the
//   task) and, for a promise that is a message, `onPrepareDelivery` — which
//   only PREPARES the governed draft (POST /api/promises/:key/prepare) and
//   shows what came back; and `onPromiseMove`, which takes a held promise
//   forward as a prepared move — asking, in place, the one thing SAiM needs
//   (who it is owed to) and storing a PROPOSAL. Never a confirm, an approval
//   or a send: a held thread NAMES what is missing and offers no way round it. No URL lives here, so a
//   shell without a credential path (the kiosk) simply passes no handler.

/**
 * NEURO's Now page (22 Oct 2026, restored the same day): the readout as THREE
 * compact cards, each an answer with its route — never placeholders and never
 * folded into one paragraph (the earlier fold hid the Monday report and turned
 * the judgement count into a line with nowhere to go).
 *
 *   Keeping my word      the figure, or the honest "not measured yet" WITH its reason
 *   Monday report        status, the read-back receipt, or the actual next action
 *   Needs your judgement the real count and each promise, opening its task
 *
 * A card with no data says so in one line. `onOpen` is the shell's: { kind:'view', view }
 * or { kind:'task', taskId } — absent (a kiosk), the cards render without buttons.
 * The SAiM scenes keep the locked readout below.
 */
function WorkspaceReadout({ readout, onOpen = null }) {
  const j = readout.judgement;
  const m = readout.monday;
  const go = (target) => (onOpen && target ? () => onOpen(target) : null);
  const keptGo = go(readout.kept && readout.kept.action ? { kind: 'view', view: readout.kept.action.view } : null);
  const mondayGo = go(m && m.action ? { kind: 'view', view: m.action.view } : null);
  return (
    <aside className="kmw__week kmw__week--workspace" aria-label="Holding the week">
      <p className="kmw__label">{readout.label}</p>
      <div className="kmw__cards">
        <section className="kmw__card kmw__card--kept" aria-label="Keeping my word">
          <h3 className="kmw__card-title">Keeping my word</h3>
          {readout.figure
            ? <p className="kmw__figure">{readout.figure}</p>
            : <p className="kmw__figure kmw__figure--note">{readout.figureNote || 'Not measured yet'}</p>}
          {readout.line && <p className="kmw__line">{readout.line}</p>}
          {readout.trend && <p className="kmw__line kmw__trend">{readout.trend}</p>}
          {readout.reDated && <p className="kmw__line kmw__line--quiet">{readout.reDated}</p>}
          {readout.next && <p className="kmw__line"><span className="kmw__inline-label">{readout.next.label}</span> <strong>{readout.next.strong}</strong> {readout.next.line}</p>}
          {keptGo && <button type="button" className="kmw__card-go" onClick={keptGo}>{readout.kept.action.label} →</button>}
        </section>

        <section className={`kmw__card kmw__card--monday${m ? ` kmw__card--${m.state}` : ''}`} aria-label="Monday report">
          <h3 className="kmw__card-title">Monday report</h3>
          {m ? (
            <>
              <p className={`kmw__strong kmw__monday kmw__monday--${m.state}`}>{m.line || 'No status recorded.'}</p>
              {m.receipt && <p className="kmw__line kmw__line--quiet">{m.receipt}</p>}
              {m.settled && !m.receipt && <p className="kmw__line kmw__line--quiet">Nothing more is needed this week.</p>}
              {mondayGo && <button type="button" className="kmw__card-go" onClick={mondayGo}>{m.action.label} →</button>}
              {!mondayGo && m.action && <p className="kmw__line">{m.action.label}.</p>}
            </>
          ) : <p className="kmw__line">NEURO couldn’t read this week’s report.</p>}
        </section>

        <section className="kmw__card kmw__card--judgement" aria-label="Needs your judgement">
          <h3 className="kmw__card-title">Needs your judgement</h3>
          {j ? (
            <>
              <p className="kmw__strong">{j.strong}</p>
              <p className="kmw__line">{j.line}</p>
              {Array.isArray(j.items) && j.items.length > 0 && (
                <ul className="kmw__judge-list">
                  {j.items.map((it) => {
                    const label = it.title || 'A promise';
                    const open = go(it.taskId ? { kind: 'task', taskId: it.taskId } : null);
                    return (
                      <li key={it.key}>
                        {open
                          ? <button type="button" className="kmw__judge-item" onClick={open}>{label}<span className="kmw__judge-why">{it.why}</span></button>
                          : <span className="kmw__judge-item">{label}<span className="kmw__judge-why">{it.why}</span></span>}
                      </li>
                    );
                  })}
                </ul>
              )}
              {j.more > 0 && <p className="kmw__line kmw__line--quiet">and {j.more} more.</p>}
            </>
          ) : <p className="kmw__line">Nothing is waiting on your judgement.</p>}
        </section>
      </div>
    </aside>
  );
}

// ── Holding the week: cards that lead somewhere (keep-my-word-cards-v1, 22 Oct 2026) ──
//
// Every card has ONE primary affordance, at most one quiet secondary link, and opens
// the exact record that explains it. The SHELL says what it can perform
// (`cardKinds`) and does it (`onCardOpen(target)` → { ok, say }); a target a shell
// cannot perform is never offered as a button — it is named, with where it lives.
// A read-only shell (the kiosk) can open every card's record and nothing that
// changes anything: starting a focus session and preparing a delivery note are
// never offered there. Every word is the server's.

/** Targets that change something — never offered by a read-only shell (pinned equal to the server's list). */
export const MUTATING_KINDS = ['session-start', 'prepare-delivery'];
const WHERE = { view: 'in NEURO on the desktop', task: 'in NEURO', note: 'in Obsidian', url: 'in Outlook', 'session-start': 'in NEURO or SAiM on your phone', 'prepare-delivery': 'in NEURO or SAiM on your phone' };
const CARD_TITLE = { kept: 'Keeping my word', monday: 'Monday report', next: 'Next', judgement: 'Needs your judgement' };

function canDo(target, { cardKinds, readOnly, onCardOpen }) {
  if (!target) return false;
  if (target.kind === 'detail') return true;
  if (readOnly && MUTATING_KINDS.includes(target.kind)) return false;
  return Boolean(onCardOpen) && (cardKinds || []).includes(target.kind);
}

/** One affordance: a button when this shell can do it, otherwise the plain fact of where it lives. */
function Affordance({ a, quiet = false, ctx, onDetail, busy = false, onResult }) {
  if (!a || !a.open) return null;
  const run = async () => {
    if (a.open.kind === 'detail') { onDetail(a.open.record); return; }
    if (busy) return;
    try {
      const r = await ctx.onCardOpen(a.open);
      if (onResult && r && (r.say || r.error)) onResult({ ok: r.ok !== false, say: r.say || r.error });
    } catch { if (onResult) onResult({ ok: false, say: 'NEURO didn’t answer — nothing was changed.' }); }
  };
  if (canDo(a.open, ctx)) {
    return <button type="button" className={quiet ? 'kmw__card-link' : 'kmw__card-go'} onClick={run} disabled={busy} data-target={a.open.kind}>{a.label}{quiet ? '' : ' →'}</button>;
  }
  if (ctx.readOnly && MUTATING_KINDS.includes(a.open.kind)) return <p className="kmw__line kmw__line--quiet">{a.label} — not from this screen.</p>;
  return <p className="kmw__line kmw__line--quiet">{a.label} — {WHERE[a.open.kind] || 'elsewhere'}.</p>;
}

function KeptDetail({ d, ctx, onResult }) {
  return (
    <>
      {d.week && <p className="kmw__line kmw__line--quiet">{d.week}</p>}
      {d.measured ? <p className="kmw__figure">{d.figure}</p> : <p className="kmw__figure kmw__figure--note">Not measured yet</p>}
      {(d.missing || []).length > 0 && (
        <div className="kmw__sheet-block">
          <p className="kmw__sheet-h">What evidence is missing</p>
          <ul className="kmw__sheet-list">{d.missing.map((m) => <li key={m}>{m}</li>)}</ul>
          {(d.affected || []).length > 0 && <p className="kmw__line">This affects {d.affected.length} promise{d.affected.length === 1 ? '' : 's'} below.</p>}
        </div>
      )}
      {d.notCounted && (d.notCounted.say || []).length > 0 && (
        <div className="kmw__sheet-block"><p className="kmw__sheet-h">Not counted</p><ul className="kmw__sheet-list">{d.notCounted.say.map((s) => <li key={s}>{s}</li>)}</ul></div>
      )}
      <p className="kmw__sheet-h">This week’s promises</p>
      {(d.promises || []).length === 0 ? <p className="kmw__line">No promise falls due this week.</p> : (
        <ul className="kmw__promises">
          {d.promises.map((p) => (
            <li key={p.key} className={`kmw__promise${p.atRisk ? ' kmw__promise--risk' : ''}`} data-key={p.key} data-task-id={p.taskId || ''}>
              <p className="kmw__promise-title">{p.title || 'A promise'}</p>
              <p className="kmw__line">{p.atRisk ? 'At risk · ' : ''}{p.outcomeSay}{p.due ? ` · ${p.due.say}` : ''}</p>
              {(p.evidence || []).map((e) => <p key={e} className="kmw__line kmw__line--quiet">{e}</p>)}
              {p.preparation && <p className="kmw__line kmw__line--quiet">{p.preparation}</p>}
              {p.action && <Affordance a={p.action} ctx={ctx} onDetail={() => {}} onResult={onResult} />}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function MondayDetail({ d, card, ctx, onResult }) {
  return (
    <>
      {d.rule && <p className="kmw__line">{d.rule.charAt(0).toUpperCase() + d.rule.slice(1)}.</p>}
      {d.due && <p className="kmw__line kmw__line--quiet">Due {d.due}.</p>}
      {d.say && <p className="kmw__line">{d.say}</p>}
      {d.receipt && <div className="kmw__sheet-block"><p className="kmw__sheet-h">Receipt</p><p className="kmw__line">{d.receipt.say}</p></div>}
      {d.report ? (
        <div className="kmw__sheet-block">
          <p className="kmw__sheet-h">The report that was sent</p>
          {d.report.subject && <p className="kmw__line"><strong>{d.report.subject}</strong></p>}
          {d.report.sentAtSay && <p className="kmw__line kmw__line--quiet">Sent {d.report.sentAtSay}{d.report.recipients.length ? ` to ${d.report.recipients.join(', ')}` : ''}{d.report.reportedByNick ? ' — recorded by you, not read back' : ''}.</p>}
          {d.report.excerpt && <p className="kmw__line kmw__excerpt">{d.report.excerpt}</p>}
        </div>
      ) : (d.state && d.state.startsWith('sent') ? <p className="kmw__line kmw__line--quiet">The sent words were not kept with the record.</p> : null)}
      <Affordance a={card.secondary} quiet ctx={ctx} onDetail={() => {}} onResult={onResult} />
      {card.primary && card.primary.open.kind !== 'detail' && <Affordance a={card.primary} ctx={ctx} onDetail={() => {}} onResult={onResult} />}
    </>
  );
}

function NextDetail({ d, card, ctx, onResult }) {
  if (!d.block) {
    return (
      <>
        <p className="kmw__line">{d.say}</p>
        {d.drafts ? <Affordance a={d.drafts} ctx={ctx} onDetail={() => {}} onResult={onResult} /> : <p className="kmw__line kmw__line--quiet">No saved draft is waiting for time either.</p>}
      </>
    );
  }
  return (
    <>
      <p className="kmw__strong">{d.block.when}</p>
      <p className="kmw__line">{d.block.title}. Protected time, just you.</p>
      {d.block.outlookUrl && <Affordance a={{ label: 'Open the calendar block', open: { kind: 'url', href: d.block.outlookUrl } }} quiet ctx={ctx} onDetail={() => {}} onResult={onResult} />}
      <div className="kmw__sheet-block">
        <p className="kmw__sheet-h">The draft</p>
        {d.draft ? (
          <>
            <p className="kmw__line kmw__path">{d.draft.path}</p>
            <Affordance a={{ label: 'Open the draft', open: { kind: 'note', path: d.draft.path, obsidianUrl: d.draft.obsidianUrl } }} quiet ctx={ctx} onDetail={() => {}} onResult={onResult} />
          </>
        ) : <p className="kmw__line kmw__line--quiet">No draft is saved for this block.</p>}
      </div>
      <div className="kmw__sheet-block">
        <p className="kmw__sheet-h">The task</p>
        {d.task ? (
          <>
            <p className="kmw__line">#{d.task.id}{d.task.text ? ` · ${d.task.text}` : ''}</p>
            <Affordance a={{ label: 'Open the task', open: { kind: 'task', taskId: d.task.id } }} quiet ctx={ctx} onDetail={() => {}} onResult={onResult} />
          </>
        ) : <p className="kmw__line kmw__line--quiet">No task is linked to this block.</p>}
      </div>
      {d.session && (d.session.possible
        ? <Affordance a={card.primary} ctx={ctx} onDetail={() => {}} onResult={onResult} />
        : <p className="kmw__line">{d.session.why}</p>)}
    </>
  );
}

function JudgementDetail({ d, ctx, onResult }) {
  const [i, setI] = useState(0);
  const items = d.items || [];
  if (!items.length) return <p className="kmw__line">{d.say}</p>;
  const at = Math.min(i, items.length - 1);
  const it = items[at];
  return (
    <>
      <p className="kmw__line kmw__line--quiet">{d.say}</p>
      <div className="kmw__review" data-key={it.key} data-task-id={it.taskId || ''}>
        <p className="kmw__sheet-h">{at + 1} of {items.length}</p>
        <p className="kmw__promise-title">{it.title || 'A promise'}</p>
        <p className="kmw__line">{it.why}</p>
        {(it.evidence || []).map((e) => <p key={e} className="kmw__line kmw__line--quiet">{e}</p>)}
        <div className="kmw__review-choices">
          {(it.choices || []).map((c) => <Affordance key={c.label} a={c} ctx={ctx} onDetail={() => {}} onResult={onResult} />)}
        </div>
        <div className="kmw__review-nav">
          <button type="button" className="kmw__card-link" disabled={at === 0} onClick={() => setI(at - 1)}>‹ Previous</button>
          <button type="button" className="kmw__card-link" disabled={at >= items.length - 1} onClick={() => setI(at + 1)}>Next promise ›</button>
        </div>
      </div>
    </>
  );
}

/** The drill-in: the exact record behind a card. Opens on every shell, the kiosk included. */
export function KmwCardSheet({ card, ctx, onClose }) {
  const [result, setResult] = useState(null);
  if (!card) return null;
  const d = card.detail || {};
  return (
    <div className="kmw__sheet" role="dialog" aria-modal="true" aria-label={CARD_TITLE[card.id]} data-card={card.id}>
      <div className="kmw__sheet-body">
        <div className="kmw__sheet-top">
          <h3 className="kmw__card-title">{CARD_TITLE[card.id]}</h3>
          <button type="button" className="kmw__card-link" onClick={onClose}>Close</button>
        </div>
        {card.id === 'kept' && <KeptDetail d={d} ctx={ctx} onResult={setResult} />}
        {card.id === 'monday' && <MondayDetail d={d} card={card} ctx={ctx} onResult={setResult} />}
        {card.id === 'next' && <NextDetail d={d} card={card} ctx={ctx} onResult={setResult} />}
        {card.id === 'judgement' && <JudgementDetail d={d} ctx={ctx} onResult={setResult} />}
        {result && <p className={`kmw__line${result.ok ? '' : ' kmw__draft-error'}`} role="status">{result.say}</p>}
        {ctx.readOnly && <p className="kmw__line kmw__line--quiet">This screen can show these records; it can’t act on them.</p>}
      </div>
    </div>
  );
}

/** NEURO's Now workspace: the four cards from `readout.cards`. */
function CardsReadout({ readout, ctx }) {
  const [open, setOpen] = useState(null);
  const [result, setResult] = useState(null);
  const c = readout.cards;
  const j = readout.judgement;
  const m = readout.monday;
  const nextD = c.next && c.next.detail;
  const card = (id, body) => {
    const k = c[id];
    if (!k) return null;
    return (
      <section className={`kmw__card kmw__card--${id}${id === 'monday' && m ? ` kmw__card--${m.state}` : ''}`} aria-label={CARD_TITLE[id]} data-card={id} data-state={k.state}>
        <h3 className="kmw__card-title">{CARD_TITLE[id]}</h3>
        {body}
        <Affordance a={k.primary} ctx={ctx} onDetail={setOpen} onResult={setResult} />
        {k.secondary && <Affordance a={k.secondary} quiet ctx={ctx} onDetail={setOpen} onResult={setResult} />}
      </section>
    );
  };
  return (
    <aside className="kmw__week kmw__week--workspace" aria-label="Holding the week">
      <p className="kmw__label">{readout.label}</p>
      <div className="kmw__cards">
        {card('kept', (
          <>
            {readout.figure ? <p className="kmw__figure">{readout.figure}</p> : <p className="kmw__figure kmw__figure--note">{readout.figureNote || 'Not measured yet'}</p>}
            {readout.line && <p className="kmw__line">{readout.line}</p>}
            {readout.trend && <p className="kmw__line kmw__trend">{readout.trend}</p>}
            {readout.reDated && <p className="kmw__line kmw__line--quiet">{readout.reDated}</p>}
          </>
        ))}
        {card('monday', m ? (
          <>
            <p className={`kmw__strong kmw__monday kmw__monday--${m.state}`}>{m.line || 'No status recorded.'}</p>
            {m.receipt && <p className="kmw__line kmw__line--quiet">{m.receipt}</p>}
          </>
        ) : <p className="kmw__line">NEURO couldn’t read this week’s report.</p>)}
        {card('next', nextD && nextD.block ? (
          <>
            <p className="kmw__strong">{nextD.block.when}</p>
            <p className="kmw__line">{nextD.block.title}.</p>
            {nextD.session && !nextD.session.possible && <p className="kmw__line kmw__line--quiet">{nextD.session.why}</p>}
          </>
        ) : <p className="kmw__line">No protected time is booked ahead.</p>)}
        {card('judgement', j ? (
          <>
            <p className="kmw__strong">{j.strong}</p>
            <p className="kmw__line">{j.line}</p>
          </>
        ) : <p className="kmw__line">Nothing is waiting on your judgement.</p>)}
      </div>
      {result && <p className={`kmw__line${result.ok ? '' : ' kmw__draft-error'}`} role="status">{result.say}</p>}
      {open && <KmwCardSheet card={c[open]} ctx={ctx} onClose={() => setOpen(null)} />}
    </aside>
  );
}

// When a card's primary is an action rather than its record, the locked entry opens the record,
// which holds that action — so it is named for what it opens.
const LOCKED_LABEL = { kept: 'See this week’s promises', monday: 'Open the Monday report', next: 'Open this block', judgement: 'Review them one at a time' };

/** The locked SAiM readout, with each entry opening the SAME card record (phone, kiosk). */
function LockedOpen({ readout, id, onOpen }) {
  const k = readout.cards && readout.cards[id];
  if (!k) return null;
  // On the locked scene the entry opens its record; the record holds every action this shell can do.
  const label = k.primary.open.kind === 'detail' ? k.primary.label : LOCKED_LABEL[id] || 'Open it';
  return <button type="button" className="kmw__entry-open" onClick={() => onOpen(id)} data-card={id}>{label}</button>;
}

export function KmwReadout({ readout, compact = false, workspace = false, onOpen = null, onCardOpen = null, cardKinds = null, readOnly = false }) {
  const [open, setOpen] = useState(null);
  if (!readout) return null;
  // The shell's card handler; NEURO's Now historically passed its view/task opener as `onOpen`.
  const ctx = { onCardOpen: onCardOpen || (onOpen ? async (t) => { onOpen(t); return null; } : null), cardKinds: cardKinds || (onOpen ? ['view', 'task'] : []), readOnly };
  if (workspace && readout.cards) return <CardsReadout readout={readout} ctx={ctx} />;
  if (workspace) return <WorkspaceReadout readout={readout} onOpen={onOpen} />;
  const lock = readout.cards ? (id) => <LockedOpen readout={readout} id={id} onOpen={setOpen} /> : () => null;
  return (
    <aside className={`kmw__week${compact ? ' kmw__week--compact' : ''}`} aria-label="Holding the week">
      <p className="kmw__label">{readout.label}</p>
      {readout.figure
        ? <p className="kmw__figure">{readout.figure}</p>
        : readout.figureNote ? <p className="kmw__figure kmw__figure--note">{readout.figureNote}</p> : null}
      {readout.line && <p className="kmw__line">{readout.line}{readout.trend && <><br /><span className="kmw__trend">{readout.trend}</span></>}</p>}
      {readout.reDated && <p className="kmw__line kmw__line--quiet">{readout.reDated}</p>}
      {lock('kept')}
      {readout.monday && readout.monday.line && (
        <>
          <hr className="kmw__rule" />
          <p className="kmw__label">{readout.monday.label}</p>
          <p className={`kmw__line kmw__monday kmw__monday--${readout.monday.state}`}>{readout.monday.line}</p>
          {lock('monday')}
        </>
      )}
      {/* Next: the card's own block when the contract has one (a saved draft's booked time
          the older readout cannot see), else the readout's line. */}
      {(() => {
        const nb = readout.cards && readout.cards.next && readout.cards.next.detail && readout.cards.next.detail.block;
        if (!nb && !readout.next) return null;
        return (
          <>
            <hr className="kmw__rule" />
            <p className="kmw__label">Next</p>
            <p className="kmw__strong">{nb ? nb.when : readout.next.strong}</p>
            <p className="kmw__line">{nb ? `${nb.title}. Protected time.` : readout.next.line}</p>
            {lock('next')}
          </>
        );
      })()}
      {readout.judgement && (
        <>
          <hr className="kmw__rule" />
          <p className="kmw__label">{readout.judgement.label}</p>
          <p className="kmw__strong">{readout.judgement.strong}</p>
          <p className="kmw__line">{readout.judgement.line}</p>
          {lock('judgement')}
        </>
      )}
      {open && readout.cards && <KmwCardSheet card={readout.cards[open]} ctx={ctx} onClose={() => setOpen(null)} />}
    </aside>
  );
}

export function KmwReceipt({ receipt }) {
  if (!receipt) return null;
  return (
    <section className="kmw__receipt" aria-label="Receipt">
      <p className="kmw__label kmw__label--live"><i aria-hidden="true" />{receipt.label}</p>
      <h2 className="kmw__headline">{receipt.headline}</h2>
      <p className="kmw__lead">{receipt.lead}</p>
      <div className="kmw__rows">
        {receipt.rows.map((r) => (
          <div key={r.label} className="kmw__row">
            <span className="kmw__rowlabel">{r.label}</span>
            <div>
              {r.title && <b className="kmw__rowtitle">{r.title}</b>}
              {(r.lines || []).map((l) => <p key={l} className="kmw__rowline">{l}</p>)}
              {r.path && <p className="kmw__rowline kmw__path">{r.path}</p>}
            </div>
          </div>
        ))}
      </div>
      <p className="kmw__checked">{receipt.checkedLabel}</p>
    </section>
  );
}

/** The draft the route handed back — read-only. Approval happens in Actions, never here. */
function DraftResult({ result, draft, onOpenActions }) {
  if (result.error) return <p className="kmw__rowline kmw__draft-error" role="status">Not drafted — {result.error}</p>;
  const a = result.action || {};
  const d = a.draft || {};
  return (
    <div className="kmw__draft-result" role="status">
      <p className="kmw__rowline kmw__draft-done">{result.already ? 'This is the delivery note already drafted — nothing new was created, and nothing has been sent.' : 'Drafted for your approval — nothing has been sent.'}</p>
      {Array.isArray(d.to) && d.to.length > 0 && <p className="kmw__rowline">To {d.to.map((r) => r.name ? `${r.name} <${r.email}>` : r.email).join(', ')}</p>}
      {d.subject && <p className="kmw__rowline">“{d.subject}”</p>}
      {d.body && <pre className="kmw__draft-body">{d.body}</pre>}
      <p className="kmw__rowline">{draft.review}</p>
      {draft.sendingOff && <p className="kmw__rowline">{draft.sendingOff}</p>}
      {onOpenActions && <div className="kmw__actions"><button type="button" className="kmw__open" onClick={() => onOpenActions(a.actionId || null)}>Review it in Actions</button></div>}
    </div>
  );
}

/**
 * Taking the promise forward IN PLACE (24 Oct 2026): one control, then the ONE
 * question SAiM needs answered (who it is owed to, or the next thing), asked
 * here — never "go and open the task". The shell's `onPromiseMove` does the
 * network (prepare / answer through the prepared-move routes); every word
 * shown is the server's. Nothing here sends, books or confirms anything.
 */
export function KmwMove({ move, onPromiseMove = null, readOnly = false, renderSave = null }) {
  const [busy, setBusy] = useState(false);
  const [savedId, setSavedId] = useState(null); // the record whose save step is showing — kept through its receipt
  const [local, setLocal] = useState(null); // the move a press or an answer just returned (promiseMove)
  const [note, setNote] = useState(null);   // { message, error } — a sentence, never a state
  const [text, setText] = useState('');
  if (!move && !local) return null;
  // ONE contract (26 Oct 2026): what the route returned IS the card's move. A
  // newer move from a poll wins over an older local one, never the other way.
  const cur = local && (!move || (local.moveKey === move.moveKey && (local.version || 0) >= (move.version || 0)) || move.state === 'offer') ? local : move;
  const can = Boolean(onPromiseMove) && !readOnly;
  const run = async (op, { answering = false } = {}) => {
    if (busy) return;
    setBusy(true);
    try {
      const r = promiseMoveResult(await onPromiseMove(op), { answering });
      if (r.kind === 'move') { setLocal(r.move); setNote(null); setText(''); }
      else if (r.kind === 'ask') { setLocal({ ...cur, state: 'ask', question: r.question, recordId: r.recordId, version: r.version, say: r.question.question }); setNote(null); setText(''); }
      else if (r.kind === 'refused') setNote({ message: r.message, error: true }); // the words stay in the box
      else { setNote({ message: r.say, error: false }); setText(''); }
    } catch {
      setNote({ message: answering ? 'NEURO didn’t answer. Your answer was not saved — it is still in the box.' : 'NEURO didn’t answer. Nothing was changed.', error: true });
    } finally { setBusy(false); }
  };
  const q = cur && ['ask', 'interview'].includes(cur.state) ? cur.question : null;
  const press = () => run({ action: 'prepare', ref: cur.ref });
  const withdraw = () => run({ action: 'withdraw', ref: cur.ref });
  const submit = (e) => {
    e.preventDefault();
    const t = text.trim();
    if (!t || !q) return;
    run({ action: 'answer', recordId: cur.recordId, version: cur.version, questionId: q.id, text: t }, { answering: true });
  };
  const park = () => run({ action: 'park', recordId: cur.recordId, version: cur.version, questionId: q.id });
  const oa = cur.owedAnswer || null;
  const iv = cur.interview || null;
  const id = `kmw-q-${String(cur.ref || 'p').replace(/[^A-Za-z0-9_-]/g, '-')}`;
  // The governed save step, IN this card (26 Oct 2026): a slot the SHELL fills with
  // the same prepared-move record, version, authority check, route and executor
  // SAiM Home uses — this card itself writes nothing. Any prepared draft waiting
  // on Nick (needs-decision / ready, or a legacy private draft mid-interview) is
  // saved here, so the card always has its next action. It stays mounted through
  // its own receipt.
  const saveable = Boolean(renderSave && can && cur.recordId && (['needs-decision', 'ready'].includes(cur.state) || (iv && cur.state === 'interview')));
  const saveId = saveable ? cur.recordId : (savedId && ['done', 'scheduled'].includes(cur.state) ? savedId : null);
  if (saveable && savedId !== cur.recordId) setSavedId(cur.recordId);
  return (
    <div className="kmw__row kmw__row--move">
      <span className="kmw__rowlabel">Next</span>
      <div>
        {cur.state === 'interview' && iv && <p className="kmw__rowline kmw__progress">Decision {iv.n} of {iv.total}</p>}
        {cur.state !== 'ask' && cur.state !== 'interview' && cur.say && <p className="kmw__rowline">{cur.say}</p>}
        {iv && iv.said && iv.said.length > 0 && (
          <div className="kmw__said">
            <p className="kmw__rowline kmw__said-head">You said</p>
            {iv.said.map((x) => <p key={x.id} className="kmw__rowline kmw__said-line"><b>{x.decision}:</b> {x.answer}</p>)}
          </div>
        )}
        {iv && iv.parked && iv.parked.length > 0 && (
          <p className="kmw__rowline kmw__parked">Parked — still unresolved: {iv.parked.map((x) => x.decision).join('; ')}.</p>
        )}
        {q ? (
          <form className="kmw__ask" onSubmit={submit}>
            <label className="kmw__rowline kmw__ask-q" htmlFor={id}>{q.question}</label>
            {q.why && <p className="kmw__rowline kmw__ask-why">{q.why}</p>}
            {can ? (
              <>
                {q.choices && q.choices.length > 0 && (
                  <div className="kmw__choices">
                    {q.choices.map((c) => <button key={c} type="button" className={`kmw__choice${text === c ? ' kmw__choice--on' : ''}`} onClick={() => setText(c)} disabled={busy}>{c}</button>)}
                  </div>
                )}
                {q.id === 'owed'
                  ? <input id={id} className="kmw__ask-input" type="text" maxLength={120} value={text} onChange={(e) => setText(e.target.value)} disabled={busy} placeholder="A full name, or a group" autoComplete="off" />
                  : <textarea id={id} className="kmw__ask-input kmw__ask-text" rows={3} maxLength={1000} value={text} onChange={(e) => setText(e.target.value)} disabled={busy} placeholder="In your own words" />}
                <div className="kmw__actions">
                  <button type="submit" className="kmw__open" disabled={busy || !text.trim()}>{busy ? 'Telling SAiM…' : 'Tell SAiM'}</button>
                  {q.canPark && <button type="button" className="kmw__choice" onClick={park} disabled={busy}>Park this for now</button>}
                </div>
              </>
            ) : <p className="kmw__rowline">Answer this in SAiM on your phone or desktop.</p>}
          </form>
        ) : cur.state === 'offer' && cur.control && can ? (
          <div className="kmw__actions"><button type="button" className="kmw__open" onClick={press} disabled={busy}>{busy ? 'One moment…' : cur.control}</button></div>
        ) : null}
        {cur.destinationSay && <p className="kmw__rowline kmw__dest">{cur.destinationSay}</p>}
        {saveId && <div className="kmw__save" key={saveId}>{renderSave({ recordId: saveId, state: cur.state })}</div>}
        {note && <p className={`kmw__rowline${note.error ? ' kmw__draft-error' : ' kmw__draft-done'}`} role="status">{note.message}</p>}
        {oa && cur.state === 'offer' && (
          <div className="kmw__owed">
            <p className="kmw__rowline">{oa.say}</p>
            {can && <button type="button" className="kmw__choice" onClick={withdraw} disabled={busy}>{oa.control}</button>}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The promise SAiM is holding, plus a way to switch to any other one at risk
 * (31 Oct 2026): "One more at risk" names each by title, and a tap shows it here.
 */
export function KmwThread(props) {
  const { thread } = props;
  const [pick, setPick] = useState(null);
  if (!thread) return null;
  const all = [thread, ...(thread.others || [])];
  const shown = all.find((x) => x.key === pick) || thread;
  const rest = all.filter((x) => x.key !== shown.key);
  const more = rest.length ? (
    <p className="kmw__more">
      {rest.length === 1 ? 'One more' : `${rest.length} more`} at risk:{' '}
      {rest.map((x, i) => (
        <span key={x.key}>{i ? '; ' : ''}<button type="button" className="kmw__morelink" onClick={() => setPick(x.key)}>{x.title}</button></span>
      ))}
    </p>
  ) : null;
  return <KmwThreadOne key={shown.key} {...props} thread={shown} more={more} />;
}

export function KmwThreadOne({ thread, onOpen = null, actions = false, onPrepareDelivery = null, onPromiseMove = null, onOpenActions = null, renderPromiseSave = null, renderTaskTools = null, asWhy = false, more = null }) {
  const [drafting, setDrafting] = useState(false);
  const [result, setResult] = useState(null);
  if (!thread) return null;
  const draft = thread.draft || null;
  const canDraft = Boolean(actions && draft && draft.control && onPrepareDelivery);
  const prepare = async () => {
    if (drafting) return;
    setDrafting(true);
    try {
      const r = await onPrepareDelivery(draft.key);
      setResult(r && r.ok ? r : { error: (r && r.error) || 'NEURO didn’t answer, so nothing was drafted.' });
    } catch (e) {
      setResult({ error: e && e.message ? e.message : 'NEURO didn’t answer, so nothing was drafted.' });
    } finally {
      setDrafting(false);
    }
  };
  // One control per state: where a delivery can be drafted, that IS the control.
  // A HELD thread offers none: opening the task resolves nothing it names (the
  // missing address or authority), so the held sentence stands alone.
  // Where SAiM can take the promise forward, that IS the control — opening the
  // task stays only where nothing else can move it (24 Oct 2026).
  const moving = Boolean(thread.move);
  // Open the task is always offered on Nick's own surfaces (31 Oct 2026): the card is a
  // task card too, and opening it resolves nothing a move or a hold is waiting on.
  const open = actions && onOpen && thread.taskId
    ? () => onOpen({ kind: 'task', id: thread.key, title: thread.title, taskId: thread.taskId })
    : null;
  return (
    <section className={`kmw__thread kmw__thread--${thread.preparation.state}${thread.held ? ' kmw__thread--held' : ''}${asWhy ? ' kmw__thread--why' : ''}`} aria-label={asWhy ? 'Why it matters' : 'Keeping your word'} data-promise-ref={thread.move ? thread.move.ref : undefined}>
      {/* As the WHY of the lead (22 Oct 2026) the title is the lead's — never said twice. */}
      <p className="kmw__label kmw__label--live"><i aria-hidden="true" />{asWhy ? `Why it matters · ${thread.label}` : thread.label}</p>
      {!asWhy && <h2 className="kmw__headline kmw__headline--thread">{thread.title}</h2>}
      <p className="kmw__lead">
        <span className="kmw__due">{thread.due.label}</span>
        {thread.owedTo && <span> · owed to {thread.owedTo}</span>}
        <span> · {thread.due.say}</span>
      </p>
      <div className="kmw__rows">
        <div className="kmw__row">
          <span className="kmw__rowlabel">{thread.preparation.label}</span>
          <div><p className="kmw__rowline">{thread.preparation.why}</p></div>
        </div>
        {draft && (
          <div className="kmw__row kmw__row--draft">
            <span className="kmw__rowlabel">Delivery</span>
            <div>
              <p className="kmw__rowline kmw__draft-say">{draft.say}</p>
              {draft.sendingOff && !result && <p className="kmw__rowline">{draft.sendingOff}</p>}
              {canDraft && !(result && result.ok) && (
                <div className="kmw__actions">
                  <button type="button" className="kmw__open" disabled={drafting} onClick={prepare}>{drafting ? 'Drafting…' : draft.control}</button>
                </div>
              )}
              {result && <DraftResult result={result} draft={draft} onOpenActions={onOpenActions} />}
            </div>
          </div>
        )}
        {moving && <KmwMove move={thread.move} onPromiseMove={actions ? onPromiseMove : null} readOnly={!actions} renderSave={actions ? renderPromiseSave : null} />}
        {thread.held && (
          <div className="kmw__row kmw__row--held">
            <span className="kmw__rowlabel">Held</span>
            <div><p className="kmw__rowline">{thread.held.say}</p></div>
          </div>
        )}
        <div className="kmw__row">
          <span className="kmw__rowlabel">Evidence</span>
          <div>{thread.evidence.map((e, i) => <p key={i} className="kmw__rowline">{e.fact}</p>)}</div>
        </div>
      </div>
      {/* The task's own tools (31 Oct 2026): Do this, Claude on the laptop, its linked notes —
          the SAME components the Tasks card mounts, supplied by the shell. */}
      {actions && renderTaskTools && thread.taskId && <div className="kmw__tools">{renderTaskTools({ taskId: thread.taskId })}</div>}
      {more}
      {open && (
        <div className="kmw__actions">
          <button type="button" className="kmw__open" onClick={open}>Open the task</button>
        </div>
      )}
    </section>
  );
}

/** The main surface: the receipt when there is one (the thread, if any, folded under it), else the thread. */
export function KmwMain({ kmw, onOpen = null, actions = false, onPrepareDelivery = null, onPromiseMove = null, onOpenActions = null, renderPromiseSave = null, renderTaskTools = null }) {
  const t = { onOpen, actions, onPrepareDelivery, onPromiseMove, onOpenActions, renderPromiseSave, renderTaskTools };
  if (!kmw) return null;
  if (kmw.receipt) {
    return (
      <div className="kmw__main">
        <KmwReceipt receipt={kmw.receipt} />
        {kmw.thread && (
          <details className="kmw__fold">
            <summary>{`Keeping your word — ${kmw.thread.title}`}</summary>
            <KmwThread thread={kmw.thread} {...t} />
          </details>
        )}
      </div>
    );
  }
  return <div className="kmw__main"><KmwThread thread={kmw.thread} {...t} /></div>;
}

/**
 * The promise as the WHY of the lead (22 Oct 2026): when the lead card IS this
 * promise's task, its Keep my word state (the question, the draft, the save)
 * sits directly under it instead of a folded line repeating its title.
 */
export function KmwWhy({ kmw, onOpen = null, actions = false, onPrepareDelivery = null, onPromiseMove = null, onOpenActions = null, renderPromiseSave = null, renderTaskTools = null }) {
  if (!kmw || !kmw.thread) return null;
  return <div className="kmw__main kmw__why"><KmwThread thread={kmw.thread} asWhy onOpen={onOpen} actions={actions} onPrepareDelivery={onPrepareDelivery} onPromiseMove={onPromiseMove} onOpenActions={onOpenActions} renderPromiseSave={renderPromiseSave} renderTaskTools={renderTaskTools} /></div>;
}

/** The folded entry beneath an urgent lead: recognisable by its title, opened on demand. */
export function KmwFolded({ kmw, onOpen = null, actions = false, onPrepareDelivery = null, onPromiseMove = null, onOpenActions = null, renderPromiseSave = null, renderTaskTools = null }) {
  if (!kmw || !kmw.entry) return null;
  return (
    <details className="kmw__fold kmw__fold--entry">
      <summary>{kmw.entry}</summary>
      <KmwMain kmw={kmw} onOpen={onOpen} actions={actions} onPrepareDelivery={onPrepareDelivery} onPromiseMove={onPromiseMove} onOpenActions={onOpenActions} renderPromiseSave={renderPromiseSave} renderTaskTools={renderTaskTools} />
    </details>
  );
}
