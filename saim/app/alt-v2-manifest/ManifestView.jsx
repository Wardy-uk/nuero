// The approved `working` desktop composition (wk__* geometry, unchanged) showing
// ONE adapter view-model. Read-only: nothing here writes — buttons are inert in
// this local build and say so. It renders the view-model and decides nothing.

export default function ManifestView({ v }) {
  const r = v.rail;
  return (
    <div className={`wk mf mf--${v.tone}`}>
      <p className="wk__presence">{v.presence}</p>
      <div className="wk__grid">
        <section className="wk__main" aria-label="Current work">
          <div className="wk__block">
            <p className="wk__state mf__state"><span className="wk__dot mf__dot" aria-hidden="true" />{v.state.toUpperCase()}</p>
            <h1 className={`wk__title${v.sentence ? '' : ' mf__title--sentence'}`}>{v.title}</h1>
            {v.sentence && <p className="mf__why">{v.sentence}</p>}
          </div>

          {v.refused && (
            <div className="mf__blind">
              <p className="wk__label">Why</p>
              <p className="mf__blindnote">{v.refused.why} Nothing on this screen means “nothing waiting”.</p>
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

          {v.actions.length > 0 && (
            <div className="wk__next">
              <div className="wk__acts" aria-label="Tell SAiM where you are">
                {v.actions.map((a, i) => <button key={a.say} type="button" disabled className={`wk__act${i === 0 ? ' wk__act--lead' : ''}`} title="Read-only preview">{a.say}</button>)}
              </div>
            </div>
          )}

          {v.handoff && (
            <div className={`wk__place mf__dest mf__dest--${v.handoff.kind}`}>
              <p className="wk__label">{v.handoff.heading}</p>
              <div className="wk__placerow">
                <div>
                  <p className="wk__app">{v.handoff.primary.label}</p>
                  {v.handoff.why && <p className="wk__why">{v.handoff.why}</p>}
                </div>
                {v.handoff.primary.type === 'already'
                  ? <span className="wk__already">Already in front — no launch needed</span>
                  : (
                    <span className="wk__openwrap">
                      <button type="button" className="wk__open" disabled title="Read-only preview">{v.handoff.primary.label}</button>
                      {v.handoff.primary.where && <span className="wk__desk">{v.handoff.primary.where}</span>}
                    </span>
                  )}
              </div>
              {v.handoff.alternatives.length > 0 && (
                <p className="wk__others"><span className="wk__k">Other ways in</span>{v.handoff.alternatives.map((o, i) => <span key={o.label}>{i > 0 && ' · '}<span className="mf__inert">{o.label}</span></span>)}</p>
              )}
            </div>
          )}

          {v.joinGap && <p className="mf__gap" role="note">{v.joinGap}</p>}

          {v.ask && (
            <div className="wk__place mf__ask">
              <p className="wk__label">{v.ask.question}</p>
              <div className="wk__acts">
                {v.ask.options.map((o) => (
                  <button key={o.label} type="button" disabled className={`wk__act${o.suggested ? ' wk__act--lead' : ''}`} title={o.basis ? `Suggested ${o.basis}` : 'Read-only preview'}>
                    {o.label}{o.suggested ? ' · suggested' : ''}
                  </button>
                ))}
              </div>
              <p className="wk__why">{v.ask.deviceSpecific ? 'Your answer is saved for this task; SAiM picks the app on each device.' : 'The laptop’s report is out of date, so these are kinds of work, not apps.'} (Answers aren’t saved in this read-only preview.)</p>
            </div>
          )}
          {!v.handoff && !v.ask && v.handoffNote && <p className="mf__noaction">{v.handoffNote}</p>}

          <div className="wk__dockwrap">
            <div className="wk__dock">
              <input className="wk__ask" placeholder="Ask SAiM or capture anything… (read-only preview)" readOnly />
              <button type="button" className="wk__dockbtn wk__dockbtn--ask" disabled>Ask</button>
              <button type="button" className="wk__dockbtn" disabled>Capture</button>
            </div>
          </div>
        </section>

        <aside className="wk__rail" aria-label="Around this">
          <RailBox label="Next" section={r.next} empty="Nothing else in the diary today.">
            {(x) => <><p className="wk__railtitle">{x.title}</p>{x.when && <p className="wk__railmeta">{x.when}</p>}</>}
          </RailBox>
          <RailBox label="Holding the day" section={r.held} empty="Nothing held back." isEmpty={(x) => !x.count}>
            {(x) => (
              <>
                <p className="wk__railsub">{`${x.count} ${x.count === 1 ? 'item' : 'items'} held${x.returns ? ` — back ${x.returns}` : ''}.`}</p>
                {x.items.length > 0 && (
                  <ul className="wk__held">{x.items.map((h, i) => <li key={i} className={h.risky ? 'mf__heldrisk' : ''}><span>{h.title}</span>{h.why && <span className="wk__muted"> — {h.why}</span>}</li>)}</ul>
                )}
              </>
            )}
          </RailBox>
          <RailBox label="Needs your judgement" section={r.judgement} empty="Nothing waiting for your judgement." isEmpty={(x) => !x.items.length}>
            {(x) => x.items.map((j, i) => (
              <div key={i} className="mf__judge">
                <p className="wk__railtitle">{j.what}</p>
                {(j.by || j.basis) && <p className="wk__railmeta">{j.by ? `before ${j.by}` : ''}{j.basis ? ` — ${j.basis}` : ''}</p>}
              </div>
            ))}
          </RailBox>
        </aside>
      </div>
    </div>
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
