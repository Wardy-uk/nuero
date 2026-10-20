import { actable } from './manifest.mjs';
import { deskStateText, deskStateBusy } from '../alt-v2/model.mjs';
import { unnamedLine, waitingLine } from './manifest.mjs';

// The approved `working` desktop composition (wk__* geometry, unchanged) showing
// ONE adapter view-model. It renders the view-model and decides nothing.
//
// Two modes, and the difference is only WHO carries out a press:
//   live = null   the local preview: every control is inert and says so.
//   live = {...}  the SAiM Alt A/B release (16 Oct 2026): each control calls the
//                 shell's existing write path, and ONLY for what the payload
//                 offers — an action whose intent kind the shell cannot carry
//                 out, a destination with no app or no link, an ask with no task
//                 id, all stay inert. Nothing is invented to fill a gap.
//
//   live.onAct(utterance)        SAiM's own intent → the shell's onAct (NEURO's routes)
//   live.onDeskOpen(appId)       open/switch an app the laptop declared
//   live.linkFor(href)           a resolver link as a real URL, or null
//   live.onChoose(taskId, choice) Nick's one-tap activity answer — only on his press
//   live.deskStates, live.busy, live.dock, live.choiceNote

const INERT = 'Read-only preview';

function Dest({ d, live, primary = false }) {
  if (d.type === 'already') return <span className="wk__already">Already in front — no launch needed</span>;
  const href = live && d.type === 'link' ? live.linkFor(d.href) : null;
  const canDesk = Boolean(live && d.type === 'desk' && d.app && live.onDeskOpen);
  const st = canDesk ? (live.deskStates || {})[d.app] : null;
  if (!primary) {
    if (href) return <a className="mf__alt" href={href} target="_blank" rel="noopener noreferrer">{d.name}</a>;
    if (canDesk) return <button type="button" className="mf__altbtn" disabled={deskStateBusy(st)} onClick={() => live.onDeskOpen(d.app)}>{d.name}{st ? ` · ${deskStateText(st)}` : ''}</button>;
    return <span className="mf__inert" title={d.label}>{d.name}</span>;
  }
  return (
    <span className="wk__openwrap">
      {href
        ? <a className="wk__open" href={href} target="_blank" rel="noopener noreferrer">{d.label}</a>
        : canDesk
          ? <button type="button" className="wk__open" disabled={deskStateBusy(st)} onClick={() => live.onDeskOpen(d.app)}>{d.label}</button>
          : <button type="button" className="wk__open" disabled title={live ? 'This screen can’t open that' : INERT}>{d.label}</button>}
      {st ? <span className={`wk__desk v2-desk--${st}`}>{deskStateText(st)}</span> : (d.where && <span className="wk__desk">{d.where}</span>)}
    </span>
  );
}

export default function ManifestView({ v, live = null }) {
  const r = v.rail;
  const busy = Boolean(live && live.busy);
  return (
    <div className={`wk mf mf--${v.tone}`}>
      {/* Desk state is an operational read, not part of the moment: debug only on the live page. */}
      {(!live || live.debug) && <p className="wk__presence">{v.presence}</p>}
      <div className="wk__grid">
        <section className={`wk__main${live && live.prepared ? ' mf__main--prep' : ''}`} aria-label="Current work">
          <div className="wk__block">
            <p className="wk__state mf__state"><span className="wk__dot mf__dot" aria-hidden="true" />{v.state.toUpperCase()}</p>
            <h1 className={`wk__title${v.sentence ? '' : ' mf__title--sentence'}`}>{v.title}</h1>
            {v.sentence && <p className="mf__why">{v.sentence}</p>}
            {v.clock && (
              <p className={`mf__clock mf__clock--${v.clock.state}`} role="status">
                <span className="mf__clocknow">{v.clock.elapsed}</span>
                {v.clock.remaining && <span className="mf__clockleft"> · {v.clock.remaining}</span>}
                {v.clock.started && <span className="wk__muted"> · {v.clock.started}</span>}
              </p>
            )}
          </div>

          {/* SAiM's prepared move (the shared component). Rendered ONCE, here, so
              it never remounts mid-confirmation; CSS order puts it straight under
              the lead when it leads, or after the lead's own content otherwise. */}
          {live && live.prepared && (
            <div className={`mf__prepared${live.preparedLeads ? ' mf__prepared--lead' : ''}`}>{live.prepared}</div>
          )}

          {v.refused && (
            <div className="mf__blind">
              <p className="wk__label">Why</p>
              <p className="mf__blindnote">{live && !live.debug
                ? 'What NEURO sent didn’t line up, so I’m not guessing. Nothing on this screen means “nothing waiting” — check NEURO directly.'
                : `${v.refused.why} Nothing on this screen means “nothing waiting”.`}</p>
            </div>
          )}

          {v.unreadLead && (
            <div className="mf__blind">
              <p className="wk__label">What I couldn’t read</p>
              <ul>{v.unreadLead.map((x) => <li key={x}>{x}</li>)}</ul>
              <p className="mf__blindnote">Nothing on this screen means “nothing waiting”. Check NEURO directly until I can see again.</p>
            </div>
          )}

          {v.guard && (
            <div className="mf__guard">
              <p className="wk__label">Protected</p>
              <p className="mf__guardrow"><span className="mf__guardwhat">{v.guard.what}</span>{v.guard.until && <span className="mf__guarduntil">until {v.guard.until}</span>}</p>
              <p className="mf__guardsay">{v.guard.verb}</p>
            </div>
          )}

          {v.room && (
            <div className="wk__place mf__dest mf__room" aria-label="This room">
              <p className="wk__label">This room</p>
              {v.room.offers.map((o) => (
                <div key={o.say} className="wk__placerow">
                  <div><p className="wk__app">{o.say}</p></div>
                  <span className="mf__roomacts">
                    {o.actions.map((a) => {
                      const on = Boolean(live && live.onAct && actable(a));
                      return (
                        <button key={a.say} type="button" className={a.lead ? 'wk__open' : 'wk__act'} disabled={!on || busy}
                          title={on ? undefined : (live ? 'This screen can’t do that' : INERT)}
                          onClick={on ? () => live.onAct(a) : undefined}>{a.say}</button>
                      );
                    })}
                  </span>
                </div>
              ))}
              {v.room.lines.map((l) => <p key={l} className="wk__why mf__roomline">{l}</p>)}
            </div>
          )}

          {v.basis && (
            <div className="wk__place mf__dest mf__basis">
              <p className="wk__label">About</p>
              <div className="wk__placerow">
                <div>
                  <p className="wk__app">{v.basis.title}</p>
                  {v.basis.why && <p className="wk__why">{v.basis.why}</p>}
                </div>
                {v.basis.actions.map((a) => {
                  const on = Boolean(live && live.onAct && actable(a));
                  return (
                    <button key={a.say} type="button" className="wk__open" disabled={!on || busy}
                      title={on ? undefined : (live ? 'This screen can’t do that' : INERT)}
                      onClick={on ? () => live.onAct(a) : undefined}>{a.say}</button>
                  );
                })}
              </div>
            </div>
          )}

          {v.choice && (
            <div className="wk__place mf__dest mf__choice">
              <p className="wk__label">Suggested</p>
              <div className="wk__placerow">
                <div>
                  <p className="wk__app">{v.choice.title}</p>
                  {v.choice.why && <p className="wk__why">{v.choice.why}</p>}
                </div>
                {(() => {
                  const on = Boolean(live && live.onAct && actable(v.choice.action));
                  return (
                    <button type="button" className="wk__open" disabled={!on || busy}
                      title={on ? undefined : (live ? 'This screen can’t do that' : INERT)}
                      onClick={on ? () => live.onAct(v.choice.action) : undefined}>{v.choice.action.say}</button>
                  );
                })()}
              </div>
            </div>
          )}

          {v.actions.length > 0 && (
            <div className="wk__next">
              <div className="wk__acts" aria-label="Tell SAiM where you are">
                {v.actions.map((a) => {
                  const on = Boolean(live && live.onAct && actable(a));
                  return (
                    <button key={a.say} type="button" disabled={!on || busy} className={`wk__act${a.lead ? ' wk__act--lead' : ''}`}
                      title={on ? undefined : (live ? 'This screen can’t do that' : INERT)}
                      onClick={on ? () => live.onAct(a) : undefined}>{a.say}</button>
                  );
                })}
              </div>
            </div>
          )}

          {v.handoff && (
            <div className={`wk__place mf__dest mf__dest--${v.handoff.kind}`}>
              <p className="wk__label">{v.handoff.heading}</p>
              <div className="wk__placerow">
                <div>
                  <p className="wk__app">{v.handoff.primary.name}</p>
                  {v.handoff.why && <p className="wk__why">{v.handoff.why}</p>}
                </div>
                <Dest d={v.handoff.primary} live={live} primary />
              </div>
              {v.handoff.alternatives.length > 0 && (
                <p className="wk__others"><span className="wk__k">Other ways in</span>{v.handoff.alternatives.map((o, i) => <span key={o.label}>{i > 0 && ' · '}<Dest d={o} live={live} /></span>)}</p>
              )}
            </div>
          )}

          {v.joinGap && <p className="mf__gap" role="note">{v.joinGap}</p>}

          {v.ask && <AskWayIn v={v} live={live} busy={busy} />}
          {live && live.choiceNote && !v.ask && <p className="wk__docknote" role="status">{live.choiceNote}</p>}
          {!v.handoff && !v.ask && v.handoffNote && <p className="mf__noaction">{v.handoffNote}</p>}

          <div className="wk__dockwrap">
            {live ? (live.dock || null) : (
              <div className="wk__dock">
                <input className="wk__ask" placeholder="Ask SAiM or capture anything… (read-only preview)" readOnly />
                <button type="button" className="wk__dockbtn wk__dockbtn--ask" disabled>Ask</button>
                <button type="button" className="wk__dockbtn" disabled>Capture</button>
              </div>
            )}
          </div>
        </section>

        <aside className="wk__rail" aria-label="Around this">
          <RailBox label="Next" section={r.next} empty="Nothing else in the diary today.">
            {(x) => (
              <>
                <p className="wk__railtitle">{x.title}</p>
                {x.when && <p className="wk__railmeta">{x.when}</p>}
                {x.actions && x.actions.length > 0 && (
                  <div className="mf__nextacts">
                    {x.actions.map((a) => {
                      const on = Boolean(live && live.onAct && actable(a));
                      return (
                        <button key={a.say} type="button" className="wk__act mf__nextbtn" disabled={!on || busy}
                          title={on ? undefined : (live ? 'This screen can’t do that' : INERT)}
                          onClick={on ? () => live.onAct(a) : undefined}>{a.say}</button>
                      );
                    })}
                  </div>
                )}
              </>
            )}
          </RailBox>
          {/* "Holding the day" / "held — back …" only while SAiM protects a meeting, a block or timed
              diary time (v.protecting). Without one, nothing is being held: the rest is simply waiting. */}
          <RailBox label={v.protecting ? 'Holding the day' : 'Also waiting'} section={r.held} empty={v.protecting ? 'Nothing held back.' : 'Nothing else waiting.'} isEmpty={(x) => !x.count}>
            {(x) => (v.protecting ? (
              <>
                <p className="wk__railsub">{`${x.count} ${x.count === 1 ? 'item' : 'items'} held${x.returns ? ` — back ${x.returns}` : ''}.`}</p>
                <RailItems x={x} live={live} busy={busy} more="held" />
                {x.unnamed > 0 && <p className="wk__railmeta mf__unnamed">{unnamedLine(x.unnamed)}</p>}
              </>
            ) : (
              <>
                <p className="wk__railsub">{waitingLine(x.count)}</p>
                <RailItems x={x} live={live} busy={busy} more="waiting" />
              </>
            ))}
          </RailBox>
          <RailBox label="Needs your judgement" section={r.judgement} empty="Nothing waiting for your judgement." isEmpty={(x) => !x.items.length}>
            {(x) => x.items.map((j, i) => (
              <div key={i} className="mf__judge">
                <p className="wk__railtitle">{j.what}</p>
                {(j.by || j.basis) && <p className="wk__railmeta">{j.by ? `before ${j.by}` : ''}{j.basis ? ` — ${j.basis}` : ''}</p>}
                {(() => {
                  const href = live && j.neuroHref ? live.linkFor(j.neuroHref) : null;
                  return href ? <a className="wk__act mf__nextbtn" href={href} target="_blank" rel="noreferrer">Open in NEURO Actions</a> : null;
                })()}
              </div>
            ))}
          </RailBox>
        </aside>
      </div>
    </div>
  );
}

/**
 * An activity SAiM does not know (16 Oct 2026): ONE clear route — the task in NEURO —
 * and the activity choices behind a closed "Choose a way in…" control. Nothing is saved
 * unless Nick opens it and presses an option. "Not sure" is not offered: the NEURO
 * route IS the honest path when nobody has classified the work.
 */
function AskWayIn({ v, live, busy }) {
  const a = v.ask;
  const href = live && a.neuroHref ? live.linkFor(a.neuroHref) : null;
  return (
    <div className="wk__place mf__dest mf__dest--work mf__ask">
      <p className="wk__label">Best next place</p>
      <div className="wk__placerow">
        <div>
          <p className="wk__app">The task in NEURO</p>
          {v.handoffNote && <p className="wk__why">{v.handoffNote}</p>}
        </div>
        <span className="wk__openwrap">
          {href
            ? <a className="wk__open" href={href} target="_blank" rel="noopener noreferrer">Open task in NEURO</a>
            : <button type="button" className="wk__open" disabled title={live ? 'This screen can’t open that' : INERT}>Open task in NEURO</button>}
          <span className="wk__desk">opens in a new tab</span>
        </span>
      </div>
      {a.options.length > 0 && (
        <details className="mf__way">
          <summary>Choose a way in…</summary>
          <div className="wk__acts">
            {a.options.map((o) => {
              const on = Boolean(live && live.onChoose && a.taskId != null && o.choice);
              return (
                <button key={o.label} type="button" disabled={!on || busy} className="wk__act"
                  title={o.basis ? `Suggested ${o.basis}` : (on ? undefined : INERT)}
                  onClick={on ? () => live.onChoose(a.taskId, o.choice) : undefined}>
                  {o.label}{o.suggested ? ' · suggested' : ''}
                </button>
              );
            })}
          </div>
          <p className="wk__why">
            {a.deviceSpecific ? 'Saved for this task; SAiM then picks the app on each device.' : 'The laptop’s report is out of date, so these are kinds of work, not apps.'}
            {live ? ' Nothing is saved unless you pick one.' : ' (Answers aren’t saved in this read-only preview.)'}
          </p>
        </details>
      )}
      {live && live.choiceNote && <p className="wk__docknote" role="status">{live.choiceNote}</p>}
    </div>
  );
}

/**
 * The rail's waiting items as compact candidates (16 Oct 2026): a few, actionable first,
 * the rest behind "Show N more". Each button is SAiM's own action for that item — Do now
 * when nothing is protected, Make next / After HH:MM when something is.
 */
function RailItems({ x, live, busy, more }) {
  return (
    <>
      {x.items.length > 0 && <ul className="wk__held mf__cands">{x.items.map((h, i) => <HeldRow key={i} h={h} live={live} busy={busy} />)}</ul>}
      {x.more && x.more.length > 0 && (
        <details className="mf__more">
          <summary>{`Show ${x.more.length} more${more === 'held' ? ' held' : ''}`}</summary>
          <ul className="wk__held mf__cands">{x.more.map((h, i) => <HeldRow key={i} h={h} live={live} busy={busy} />)}</ul>
        </details>
      )}
    </>
  );
}

function HeldRow({ h, live, busy }) {
  const acts = h.actions || [];
  return (
    <li className={`mf__cand${h.risky ? ' mf__heldrisk' : ''}`}>
      <span className="mf__candtitle">{h.title}</span>
      {(h.why || h.risky) && <span className="wk__muted mf__candwhy">{h.why || 'possible risk, not yet classified'}</span>}
      {acts.length > 0 && (
        <span className="mf__candacts">
          {acts.map((a) => {
            const on = Boolean(live && live.onAct && actable(a));
            return (
              <button key={a.say} type="button" className="wk__act mf__nextbtn" disabled={!on || busy}
                title={on ? undefined : (live ? 'This screen can’t do that' : INERT)}
                onClick={on ? () => live.onAct(a) : undefined}>{a.say}</button>
            );
          })}
        </span>
      )}
    </li>
  );
}

/** One rail box: not read (with the reason), empty, or its content. Never "nothing" for an unread section. */
function RailBox({ label, section, empty, isEmpty = (x) => x.empty, children }) {
  const unread = section && section.unread;
  const blank = !unread && (!section || isEmpty(section));
  return (
    <div className={`wk__railitem${unread || blank ? ' wk__railitem--quiet' : ''}`}>
      <p className="wk__label">{label}</p>
      {unread ? <p className="wk__railsub mf__unread">Not read — {section.why}.</p>
        : blank ? <p className="wk__railsub">{empty}</p>
          : children(section)}
    </div>
  );
}
