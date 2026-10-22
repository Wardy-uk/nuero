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

/** PURE view. */
export function DraftsView({ data, openKey = null, openMode = null, readOnly = false, opening = null, onOpen, onClose, renderItem }) {
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
  return (
    <section className="drafts" aria-label="Drafts">
      <h1 className="drafts__title">Drafts</h1>
      <p className="drafts__sub">Everything SAiM has prepared that isn’t finished — whoever started it. Nothing here is saved, booked or sent until you confirm it.</p>
      {readOnly && <p className="drafts__sub">This screen shows Drafts; it can’t act on them.</p>}
      {(data.gaps || []).map((g, i) => <p key={i} className="drafts__gap">{g}</p>)}
      {items.length === 0 ? (
        <p className="drafts__empty">Nothing in Drafts. When SAiM prepares something — or you ask it to make a Now item ready — it waits here until you save it, confirm it or put it off.</p>
      ) : (
        <ul className="drafts__list">
          {items.map((r) => {
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
    </section>
  );
}

/**
 * Container. `context` = { recordId?, moveKey?, open? } — a link to ONE entry
 * (a Now row just made ready, a card's "Open the draft"). `call` is the shell's
 * authenticated client ({status, body}); the phone builds its own.
 */
export default function Drafts({ call: injectedCall = null, context = null }) {
  const call = useMemo(() => injectedCall || makeCall({ fetchImpl: (...a) => fetch(...a), apiUrl, authHeaders }), [injectedCall]);
  const readOnly = useMemo(() => platformNow() === 'kiosk', []);
  const [data, setData] = useState(null);
  const [open, setOpen] = useState(null); // { moveKey, mode, initial? }
  const [opening, setOpening] = useState(null);
  const reload = useCallback(async () => { const d = await loadDrafts(call); setData(d); return d; }, [call]);
  useEffect(() => {
    let live = true;
    loadDrafts(call).then((d) => {
      if (!live) return;
      setData(d);
      const f = d.ok ? focusRow(d.items, context) : null;
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
      renderItem={(r) => <PromiseSave key={r.moveKey} recordId={r.recordId} call={call} drafts initial={(open && open.initial) || null} onChanged={() => reload()} />}
    />
  );
}
