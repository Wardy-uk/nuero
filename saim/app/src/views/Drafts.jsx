// Drafts (22 Oct 2026) — the ONE place every active, unfinished prepared item
// waits: private working drafts, prepared notes, reply drafts, meeting prep —
// however each began. Rendered by the SAiM web/phone app (a tab reached first
// from Review) and by NEURO desktop (its own view), from the SAME server list
// (GET /api/prepared-moves/drafts) over the SAME prepared-move store. Not a
// second store, and not the Home scene.
//
// Each row: what it is, one plain status, the precise reason, and at most ONE
// action. Opening a row shows THAT record in place (PromiseSave in drafts mode:
// the pinned PreparedMove — its exact question, the draft and its save step, the
// real confirmation, or the authority boundary with "What SAiM may do" opening
// here). A held row has no button. Nothing is saved, booked or sent until Nick
// confirms in the item itself.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiUrl, authHeaders } from '../api';
import { makeCall, load, askToConfirm, newSessionId } from '../preparedMove.mjs';
import { loadDrafts, focusRow } from '../drafts.mjs';
import { platformNow } from '../../../shared-ui/presentation/platform.mjs';
import PromiseSave from '../components/PromiseSave.jsx';
import './Drafts.css';

const TONE = { 'needs-answer': 'ask', 'ready-to-save': 'ready', 'ready-to-confirm': 'ready', 'waiting-allowance': 'wait', held: 'held' };

/**
 * PURE. One saved draft in "Ready for you to work on": what it is, exactly where it
 * lives, its task and its booked time, and direct routes to each (22 Oct 2026).
 * `onOpenNote` / `onOpenTask` come from the shell; absent, the note opens in
 * Obsidian and the task is named but not linked. The kiosk shows it read-only.
 */
export function WorkRow({ item, readOnly = false, busy = false, onOpenNote = null, onOpenTask = null, onCompleteTask = null, onAbandon = null, onRestore = null, history = false }) {
  const t = item.task;
  return (
    <li className={`drafts__row drafts__row--${history ? 'done' : 'work'}`} data-move-key={item.moveKey} data-record-id={item.recordId}>
      <div className="drafts__head">
        <span className={`drafts__status drafts__status--${history ? 'held' : 'ready'}`}>{item.status}</span>
        <span className="drafts__kind">{item.kindLabel}</span>
      </div>
      <p className="drafts__name">{item.title}</p>
      {item.path && <p className="drafts__path"><span className="drafts__label">Saved to</span> <code>{item.path}</code></p>}
      {t && <p className="drafts__meta"><span className="drafts__label">Task</span> #{t.id}{t.text ? ` · ${t.text}` : ''}{t.status && t.status !== 'open' && t.status !== 'in-progress' ? ` (${t.status})` : ''}</p>}
      {item.block && <p className="drafts__meta"><span className="drafts__label">Booked</span> {item.block.label}</p>}
      {!readOnly && (
        <div className="drafts__actions">
          {item.path && (onOpenNote
            ? <button type="button" className="drafts__go" onClick={() => onOpenNote(item)}>Open the draft</button>
            : item.obsidianUrl && <a className="drafts__go" href={item.obsidianUrl}>Open the draft</a>)}
          {t && onOpenTask && <button type="button" className="drafts__go drafts__go--quiet" onClick={() => onOpenTask(t)}>Open the task</button>}
          {item.outlookUrl && <a className="drafts__go drafts__go--quiet" href={item.outlookUrl} target="_blank" rel="noreferrer">View the calendar block</a>}
          {!history && t && onCompleteTask && t.status !== 'unknown' && <button type="button" className="drafts__go drafts__go--quiet" disabled={busy} onClick={() => onCompleteTask(item)}>Work’s done — tick the task</button>}
          {!history && onAbandon && <button type="button" className="drafts__go drafts__go--quiet" disabled={busy} onClick={() => onAbandon(item)}>Abandon this draft</button>}
          {history && item.canRestore && onRestore && <button type="button" className="drafts__go drafts__go--quiet" disabled={busy} onClick={() => onRestore(item)}>Bring it back</button>}
        </div>
      )}
    </li>
  );
}

const STAGE_TONE = { verified: 'ready', confirmed: 'wait', 'partly-done': 'ask', practice: 'held', prepared: 'wait' };

/**
 * PURE. Today's prepared, confirmed and verified work (22 Oct 2026) — compact and
 * findable (#drafts-today). Every word is the server's: the stage the executor
 * stamped, the exact time a calendar step carried, and a vault location only for a
 * live note that read back. A practice run is labelled, never "done". Unreadable is
 * said, never shown as an empty day.
 */
export function TodayHistory({ today, readOnly = false, onOpenNote = null }) {
  if (!today) return null;
  const items = today.items || [];
  return (
    <section className="drafts__today" id="drafts-today" aria-label="Today">
      <h2 className="drafts__section">Today</h2>
      {today.known === false && <p className="drafts__gap">I couldn’t read all of today’s records ({(today.gaps || []).map((g) => g.source).join(', ')}) — this list may be short.</p>}
      {items.length === 0 ? (
        <p className="drafts__empty drafts__empty--small">Nothing prepared or confirmed today.</p>
      ) : (
        <ul className="drafts__today-list">
          {items.map((h) => (
            <li key={h.moveKey} className={`drafts__today-row drafts__today-row--${h.stage}`} data-move-key={h.moveKey} data-stage={h.stage}>
              <span className="drafts__today-time">{h.atSay || '—'}</span>
              <span className="drafts__today-body">
                <span className={`drafts__status drafts__status--${STAGE_TONE[h.stage] || 'held'}`}>{h.stageSay}</span>
                <span className="drafts__today-title">{h.title}</span>
                {h.when && <span className="drafts__today-meta">{h.when.practice ? 'Sandbox block' : 'Calendar'} · {h.when.say}</span>}
                {h.note && <span className="drafts__today-meta">Note · <code>{h.note.path}</code></span>}
                {h.reply && <span className="drafts__today-meta">Reply draft in Actions — not sent</span>}
                {!readOnly && h.note && onOpenNote && <button type="button" className="drafts__go drafts__go--quiet" onClick={() => onOpenNote({ path: h.note.path, title: h.title, moveKey: h.moveKey })}>Open the note</button>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** PURE view. */
export function DraftsView({ data, openKey = null, openMode = null, readOnly = false, opening = null, onOpen, onClose, renderItem, busy = false, onOpenNote = null, onOpenTask = null, onCompleteTask = null, onAbandon = null, onRestore = null, message = null }) {
  if (!data) return <section className="drafts" aria-label="Drafts"><h1 className="drafts__title">Drafts</h1><p className="drafts__sub">Reading Drafts…</p></section>;
  if (!data.ok) {
    return (
      <section className="drafts" aria-label="Drafts">
        <h1 className="drafts__title">Drafts</h1>
        <p className="drafts__gap" role="status">I couldn’t read Drafts ({data.why}). That isn’t the same as there being none.</p>
      </section>
    );
  }
  const items = data.items || [];
  const sec = data.sections || { confirm: items, work: [], communication: [], history: [] };
  const confirmItems = (sec.confirm || items).filter((r) => r.kind !== 'email-reply');
  const replyItems = (sec.confirm || items).filter((r) => r.kind === 'email-reply');
  const rowProps = { readOnly, busy, onOpenNote, onOpenTask, onCompleteTask, onAbandon, onRestore };
  const nothing = !items.length && !(sec.work || []).length && !(sec.communication || []).length && !(sec.history || []).length;
  return (
    <section className="drafts" aria-label="Drafts">
      <h1 className="drafts__title">Drafts</h1>
      {/* ⚠ Not "nothing is saved or booked until you confirm" — the page shows saved drafts and booked time below. */}
      <p className="drafts__sub">Nothing is saved, booked or sent without your confirmation. Once confirmed, your draft and planned work stay here until you finish or abandon them.</p>
      {readOnly && <p className="drafts__sub">This screen shows Drafts; it can’t act on them.</p>}
      {(data.gaps || []).map((g, i) => <p key={i} className="drafts__gap">{g}</p>)}
      {message && <p className="drafts__msg" role="status">{message}</p>}
      {nothing && <p className="drafts__empty">Nothing in Drafts. When SAiM prepares something — or you ask it to make a Now item ready — it waits here until you save it, confirm it or put it off.</p>}

      <TodayHistory today={data.today} readOnly={readOnly} onOpenNote={onOpenNote} />

      <h2 className="drafts__section" id="drafts-confirm">Needs your confirmation</h2>
      {confirmItems.length === 0 && replyItems.length === 0 ? (
        <p className="drafts__empty drafts__empty--small">Nothing needs your confirmation.</p>
      ) : (
        <ul className="drafts__list">
          {[...confirmItems, ...replyItems].map((r) => {
            const open = openKey === r.moveKey;
            return (
              <li key={r.moveKey} className={`drafts__row drafts__row--${TONE[r.status] || 'held'}${open ? ' drafts__row--open' : ''}`} data-move-key={r.moveKey} data-record-id={r.recordId}>
                <div className="drafts__head">
                  <span className={`drafts__status drafts__status--${TONE[r.status] || 'held'}`}>{r.statusLabel}</span>
                  <span className="drafts__kind">{r.kindLabel}</span>
                </div>
                <p className="drafts__name">{r.title}</p>
                <p className="drafts__say">{r.say}</p>
                {!readOnly && r.action && !open && (
                  <button type="button" className="drafts__go" disabled={opening === r.moveKey} onClick={() => onOpen(r, r.action.open)}>{opening === r.moveKey ? 'Opening…' : r.action.label}</button>
                )}
                {open && (
                  <div className="drafts__item">
                    {renderItem(r, openMode)}
                    <button type="button" className="drafts__close" onClick={onClose}>Close</button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <h2 className="drafts__section" id="drafts-work">Ready for you to work on</h2>
      {(sec.work || []).length === 0 ? (
        <p className="drafts__empty drafts__empty--small">No saved drafts waiting. A private working draft you save stays here — with its booked time — until you tick its task or abandon it.</p>
      ) : (
        <ul className="drafts__list">{sec.work.map((w) => <WorkRow key={w.moveKey} item={w} {...rowProps} />)}</ul>
      )}

      <h2 className="drafts__section" id="drafts-communication">Communication drafts</h2>
      {(sec.communication || []).length === 0 ? (
        <p className="drafts__empty drafts__empty--small">No confirmed reply drafts.</p>
      ) : (
        <ul className="drafts__list">
          {sec.communication.map((c) => (
            <li key={c.moveKey} className="drafts__row drafts__row--held" data-move-key={c.moveKey}>
              <div className="drafts__head"><span className="drafts__status drafts__status--held">{c.status}</span><span className="drafts__kind">{c.kindLabel}</span></div>
              <p className="drafts__name">{c.title}</p>
            </li>
          ))}
        </ul>
      )}

      {(sec.history || []).length > 0 && (
        <details className="drafts__history">
          <summary>{sec.history.length} finished or abandoned</summary>
          <ul className="drafts__list">{sec.history.map((h) => <WorkRow key={h.moveKey} item={h} history {...rowProps} />)}</ul>
        </details>
      )}
    </section>
  );
}

/**
 * Container. `context` = { recordId?, moveKey?, open? } — a link to ONE entry
 * (a Now row just made ready, a card's "Open the draft"). `call` is the shell's
 * authenticated client ({status, body}); the phone builds its own.
 */
export default function Drafts({ call: injectedCall = null, context = null, onOpenNote = null, onOpenTask = null }) {
  const call = useMemo(() => injectedCall || makeCall({ fetchImpl: (...a) => fetch(...a), apiUrl, authHeaders }), [injectedCall]);
  const readOnly = useMemo(() => platformNow() === 'kiosk', []);
  const [data, setData] = useState(null);
  const [open, setOpen] = useState(null); // { moveKey, mode, initial? }
  const [opening, setOpening] = useState(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);
  const reload = useCallback(async () => { const d = await loadDrafts(call); setData(d); return d; }, [call]);
  useEffect(() => {
    let live = true;
    loadDrafts(call).then((d) => {
      if (!live) return;
      setData(d);
      const f = d.ok ? focusRow(d.items, context, (d.sections || {}).work) : null;
      // A LINK opens the item; it never requests a confirmation on its own. Only pressing
      // "Open the confirmation" in the list does (that press is Nick asking for it).
      if (f && f.open && !readOnly) setOpen({ moveKey: f.row.moveKey, mode: f.open === 'confirm' ? 'view' : f.open });
      if (f && typeof document !== 'undefined') setTimeout(() => { const el = document.querySelector(`[data-move-key="${CSS.escape(f.row.moveKey)}"]`); if (el && el.scrollIntoView) el.scrollIntoView({ block: 'start' }); }, 0);
    });
    return () => { live = false; };
  }, [call, context && context.recordId, context && context.moveKey]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <DraftsView
      data={data}
      openKey={open && open.moveKey}
      openMode={open && open.mode}
      readOnly={readOnly}
      onOpen={async (r, mode) => {
        if (mode !== 'confirm') { setOpen({ moveKey: r.moveKey, mode }); return; }
        // "Open the confirmation" IS the press: the confirmation is requested here, on the SAME
        // route the save button uses — never by anything that runs on its own.
        setOpening(r.moveKey);
        try {
          const s = await load(call, { recordId: r.recordId });
          const initial = s && s.kind === 'ready' && s.view && s.view.move && (s.view.move.options || []).length
            ? await askToConfirm(call, { view: s.view, option: s.option, sessionId: newSessionId() }) : s;
          setOpen({ moveKey: r.moveKey, mode, initial });
        } finally { setOpening(null); }
      }}
      opening={opening}
      onClose={() => { setOpen(null); reload(); }}
      busy={busy}
      message={message}
      onOpenNote={onOpenNote}
      onOpenTask={onOpenTask}
      // Ticking the task IS Nick saying the work is done; the draft then moves to History.
      onCompleteTask={async (w) => {
        setBusy(true); setMessage(null);
        try {
          const r = await call(`/api/tasks/${encodeURIComponent(w.task.id)}/complete`, { method: 'POST', body: {} });
          setMessage(r.status === 200 ? `Ticked task #${w.task.id} — “${w.title}” is in History.` : `NEURO answered ${r.status}; the task was not ticked.`);
        } catch { setMessage('NEURO didn’t answer; the task was not ticked.'); }
        await reload(); setBusy(false);
      }}
      onAbandon={async (w) => {
        setBusy(true); setMessage(null);
        try {
          const r = await call('/api/prepared-moves/drafts/outcome', { method: 'POST', body: { moveKey: w.moveKey, outcome: 'abandoned' } });
          setMessage(r.body && r.body.ok ? `Abandoned “${w.title}”. The note and any booked block are still there; it is in History.` : ((r.body && r.body.error) || `NEURO answered ${r.status}.`));
        } catch { setMessage('NEURO didn’t answer; nothing changed.'); }
        await reload(); setBusy(false);
      }}
      onRestore={async (w) => {
        setBusy(true); setMessage(null);
        try { await call('/api/prepared-moves/drafts/outcome', { method: 'POST', body: { moveKey: w.moveKey, outcome: 'restore' } }); } catch { /* the re-read shows it */ }
        await reload(); setBusy(false);
      }}
      renderItem={(r) => <PromiseSave key={r.moveKey} recordId={r.recordId} call={call} drafts initial={(open && open.initial) || null} onChanged={() => reload()} onOpenNote={onOpenNote} />}
    />
  );
}
