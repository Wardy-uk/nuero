import { deskStateText, deskStateBusy } from './model.mjs';
import './working.css';

// SAiM Alt v2 — the `working` desktop composition (layout approved 14 Oct 2026).
//
// `WorkingView` renders ONE view-model (`model.workingView`) and decides
// nothing: each part is present because NEURO said so, or absent. A missing
// part hides that part only — the composition never collapses into a generic
// card. `WORKING` is the approved static fixture, in the same shape.

export const WORKING = Object.freeze({
  presence: 'SAiM · desk active · working',
  current: { label: 'Active', start: '14:00', end: '15:00', title: 'Customer Care training plan and refreshers', kind: 'block' },
  note: null,
  step: 'Draft the refresher headings.',
  actions: ['I’m on it', 'Make it smaller', 'Not now', 'That’s done'].map((say) => ({ say, intent: null })),
  tools: {
    recommended: { id: 'claude', label: 'Claude' },
    already: null,
    why: 'Draft the three refresher headings from the training-plan outline.',
    others: [{ id: 'music', label: 'Music' }, { id: 'browser', label: 'Browser' }, { id: 'code', label: 'VS Code' }],
  },
  next: { title: 'Nick Catch Up', time: '16:30', inText: 'In 49 minutes' },
  held: { count: 4, items: [] },
  judgement: { count: 0, say: null, where: null },
});

export function WorkingView({
  v, focus = null, onAct = null, onDeskOpen = null, deskStates = {}, busy = false,
  heldOpen = false, onToggleHeld = null, dock = null, error = null, neuroUrl = null,
}) {
  const c = v.current;
  const rec = v.tools && v.tools.recommended;
  const recState = rec ? deskStates[rec.id] : null;
  const hasRail = v.next || v.held || v.judgement;

  return (
    <div className="wk">
      <p className="wk__presence">{v.presence}</p>
      {error && <p className="wk__stale" role="status">Couldn’t refresh — {error}. Showing the last read.</p>}
      {focus && focus.note && <p className="wk__stale" role="status">{focus.note}</p>}

      <div className={`wk__grid${hasRail ? '' : ' wk__grid--solo'}`}>
        <section className="wk__main" aria-label="Current work">
          {c && (
            <div className="wk__block">
              <p className="wk__state">
                <span className="wk__dot" aria-hidden="true" />
                {c.label.toUpperCase()}{c.start && c.end ? ` · ${c.start}–${c.end}` : ''}
              </p>
              {c.title && <h1 className="wk__title" title={c.fullTitle && c.fullTitle !== c.title ? c.fullTitle : undefined}>{c.title}</h1>}
              {c.stale && <StaleFlag stale={c.stale} neuroUrl={neuroUrl} />}
              {v.meeting && v.meeting.remaining && <p className="wk__remaining">{v.meeting.remaining}</p>}
              {v.meeting && <p className="wk__holding">SAiM is holding everything else.</p>}
            </div>
          )}
          {v.note && <p className={c ? 'wk__note' : 'wk__note wk__note--lead'}>{v.note}</p>}

          {(v.step || v.actions.length > 0) && (
            <div className="wk__next">
              {v.step && <p className="wk__step"><span className="wk__k">Next</span>{v.step}</p>}
              {v.actions.length > 0 && (
                <div className="wk__acts">
                  {v.actions.map((a, i) => (
                    <button
                      key={`${a.say}:${i}`}
                      type="button"
                      className={`wk__act${i === 0 ? ' wk__act--lead' : ''}`}
                      disabled={!onAct || busy || !a.intent}
                      onClick={() => onAct && a.intent && onAct(a)}
                    >{a.say}</button>
                  ))}
                </div>
              )}
            </div>
          )}

          {v.meeting && v.meeting.after && (
            <div className="wk__after">
              <p className="wk__label">After this</p>
              <p className="wk__afterrow">
                <span className="wk__aftertime">{v.meeting.after.start}{v.meeting.after.end ? `–${v.meeting.after.end}` : ''}</span>
                <span className="wk__aftertitle" title={v.meeting.after.fullTitle && v.meeting.after.fullTitle !== v.meeting.after.title ? v.meeting.after.fullTitle : undefined}>{v.meeting.after.title}</span>
              </p>
              {v.meeting.cue && <p className="wk__cue">{v.meeting.cue}</p>}
            </div>
          )}

          {v.tools && (
            <div className="wk__place">
              <p className="wk__label">Best next place</p>
              {(rec || v.tools.already) && (
                <div className="wk__placerow">
                  <div>
                    <p className="wk__app">{(rec || v.tools.already).label}</p>
                    <p className="wk__why">{v.tools.why}</p>
                  </div>
                  {v.tools.already
                    ? <span className="wk__already">Already open — carry on there</span>
                    : onDeskOpen
                      ? (
                        <span className="wk__openwrap">
                          <button type="button" className="wk__open" disabled={deskStateBusy(recState)} onClick={() => onDeskOpen(rec.id)}>Open {rec.label}</button>
                          {recState && <span className="wk__desk">{deskStateText(recState)}</span>}
                        </span>
                      )
                      : <span className="wk__already">This screen can’t reach the laptop</span>}
                </div>
              )}
              {v.tools.others.length > 0 && (
                <p className="wk__others">
                  <span className="wk__k">Other ways in</span>
                  {v.tools.others.map((o, i) => (
                    <span key={o.id}>
                      {i > 0 && ' · '}
                      {onDeskOpen
                        ? <button type="button" className="wk__otherbtn" disabled={deskStateBusy(deskStates[o.id])} onClick={() => onDeskOpen(o.id)}>{o.label}</button>
                        : o.label}
                      {deskStates[o.id] && <span className="wk__desk"> ({deskStateText(deskStates[o.id])})</span>}
                    </span>
                  ))}
                </p>
              )}
            </div>
          )}

          {dock && <div className="wk__dockwrap">{dock}</div>}
        </section>

        {hasRail && (
          <aside className="wk__rail" aria-label="Around this">
            {v.next && (
              <div className="wk__railitem">
                <p className="wk__label">{v.next.label || 'Next'}</p>
                <p className="wk__railtitle" title={v.next.fullTitle && v.next.fullTitle !== v.next.title ? v.next.fullTitle : undefined}>{v.next.title}</p>
                <p className="wk__railmeta">{v.next.time}{v.next.inText ? ` · ${v.next.inText}` : ''}</p>
              </div>
            )}
            {v.held && (
              <div className="wk__railitem">
                <p className="wk__label">Holding the day</p>
                <p className="wk__railsub">
                  {v.held.summary || (v.held.count === 0 ? 'Nothing held back.' : `${v.held.count} ${v.held.count === 1 ? 'item' : 'items'} held while this block is live.`)}
                </p>
                {staleHeld(v.held) > 0 && (
                  <p className="wk__railstale">
                    {staleHeld(v.held) === 1 ? '1 held task has' : `${staleHeld(v.held)} held tasks have`} out-of-date wording
                    {neuroUrl ? <> — <a className="wk__link wk__link--inline" href={tasksHref(neuroUrl)} target="_blank" rel="noopener noreferrer">fix in NEURO</a></> : null}
                  </p>
                )}
                {v.held.count > 0 && v.held.items.length > 0 && onToggleHeld && (
                  <button type="button" className="wk__link" aria-expanded={heldOpen} onClick={onToggleHeld}>{heldOpen ? 'Hide held work' : 'Show held work'}</button>
                )}
                {heldOpen && (
                  <ul className="wk__held">{v.held.items.map((h, i) => (
                    <li key={i}>
                      <span title={h.fullTitle && h.fullTitle !== h.title ? h.fullTitle : undefined}>{h.title}</span>
                      {h.why ? <span className="wk__muted"> — {h.why}</span> : null}
                      {h.stale ? <span className="wk__stalemark" title={h.stale.reason}> · wording out of date</span> : null}
                    </li>
                  ))}</ul>
                )}
              </div>
            )}
            {v.judgement && (
              <div className={`wk__railitem${v.judgement.count ? '' : ' wk__railitem--quiet'}`}>
                <p className="wk__label">Needs your judgement</p>
                {v.judgement.count
                  ? (
                    <>
                      <p className="wk__railsub">{v.judgement.say || `${v.judgement.count} waiting for you.`}</p>
                      {neuroUrl && <a className="wk__link" href={`${String(neuroUrl).replace(/\/+$/, '')}/?view=actions`} target="_blank" rel="noopener noreferrer">Open Actions in NEURO</a>}
                    </>
                  )
                  : <p className="wk__railsub">Nothing waiting for your judgement.</p>}
              </div>
            )}
          </aside>
        )}
      </div>
    </div>
  );
}

const tasksHref = (neuroUrl) => `${String(neuroUrl).replace(/\/+$/, '')}/?view=todos`;
const staleHeld = (held) => (held && Array.isArray(held.items) ? held.items.filter((h) => h.stale).length : 0);

/** Rule 4: the record's wording contradicts its planned date — said, and routed to NEURO to fix. */
function StaleFlag({ stale, neuroUrl }) {
  return (
    <p className="wk__stale-wording" role="note">
      The task’s wording is out of date — it {stale.reason}. Showing a neutral title.
      {neuroUrl ? <> <a className="wk__link wk__link--inline" href={tasksHref(neuroUrl)} target="_blank" rel="noopener noreferrer">Fix the wording in NEURO</a></> : null}
    </p>
  );
}

export default function WorkingFixture() {
  return <WorkingView v={WORKING} onDeskOpen={() => {}} />;
}
