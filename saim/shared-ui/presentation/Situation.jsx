import { useState } from 'react';
import { composeForSurface } from './budget.mjs';
import './Situation.css';

// Situation — the adaptive SAiM composition (Build 12).
//
// ONE semantic state from NEURO (`presentation` on /api/canonical/now), drawn
// differently by device, distance and situation. The phone, the kiosk and the
// desktop all mount this file; what differs is the PROFILE their shell declares,
// and `budget.mjs` turns that into blocks.
//
// Three visual levels, and the hierarchy is carried by type and space before
// any border:
//   1. EDITORIAL  — the situation headline and its one sentence
//   2. OBJECTS    — something that needs him, or the one current thing: the
//                   only things drawn as cards
//   3. ANNOTATION — place, room, weather, sleep, what he is doing: inline text,
//                   never a tile of its own unless the server promoted it
//
// ⚠ IT DECIDES NOTHING. Order, priority, wording and what the summary is about
//   are all the server's. This file chooses only how loud each thing is.
// ⚠ NO SECTION EXISTS BECAUSE A COMPONENT DOES. A block with nothing in it is
//   not drawn — no empty headings, no "Room" card on a surface that has no room.

function joinWho(item) {
  return item.value ? `${item.label} ${item.value}` : item.label;
}

function Annotation({ item }) {
  return (
    <span className="sit__ann" title={item.detail || undefined}>
      {joinWho(item)}
      {item.detail && <span className="sit__ann-detail"> · {item.detail}</span>}
    </span>
  );
}

function Correction({ correction, activity, onCorrect, onNotNow, busy }) {
  const [open, setOpen] = useState(false);
  if (!correction || !onCorrect) return null;
  // ⚠ A CORRECTION, not a panel: one quiet affordance beside what SAiM thinks he
  //   is doing. It only becomes a visible question when she genuinely cannot tell.
  return (
    <span className="sit__correct">
      {!open && (
        <button
          type="button"
          className={`sit__correct-btn${correction.asking && !activity ? ' sit__correct-btn--ask' : ''}`}
          onClick={() => setOpen(true)}
          aria-expanded="false"
        >
          {activity ? correction.prompt : (correction.asking ? 'What are you up to?' : 'Tell me what you’re doing')}
        </button>
      )}
      {open && (
        <span className="sit__correct-opts" role="group" aria-label="What are you up to?">
          {(correction.options || []).map((o) => (
            <button
              key={o.doing}
              type="button"
              className={`sit__chip${correction.current === o.doing ? ' sit__chip--on' : ''}`}
              disabled={busy}
              onClick={async () => { await onCorrect(o.doing); setOpen(false); }}
            >{o.label}</button>
          ))}
          <button
            type="button"
            className="sit__chip sit__chip--quiet"
            onClick={() => { setOpen(false); if (correction.asking && onNotNow) onNotNow(); }}
          >{correction.asking ? 'Not now' : 'Never mind'}</button>
        </span>
      )}
    </span>
  );
}

function NextRow({ item, onOpen, actions }) {
  const inner = (
    <>
      {item.when && <span className="sit__when">{item.when}</span>}
      <span className="sit__next-title">{item.title}</span>
      {item.summary && <span className="sit__next-sub">{item.summary}</span>}
    </>
  );
  return (
    <li className={`sit__next sit__next--${item.kind}`}>
      {actions && onOpen ? (
        <button type="button" className="sit__next-btn" onClick={() => onOpen(item)}>{inner}</button>
      ) : <span className="sit__next-btn">{inner}</span>}
    </li>
  );
}

export default function Situation({
  presentation,
  profile = 'phone',
  // Draws the one current thing with the shell's own controls (done / not now /
  // start). Absent, the primary is drawn as a plain object with no buttons.
  renderPrimary = null,
  onOpen = null,
  onOffer = null,
  onCorrect = null,
  onNotNow = null,
  correcting = false,
  // The field, mounted behind everything. A slot because each shell drives it.
  field = null,
  // The way to talk to her. A slot because whether a mic exists is a fact about
  // the DEVICE (Electron exposes speech recognition with nothing behind it).
  ask = null,
  // Below everything: the shell's escape hatch ("Show me everything").
  foot = null,
  // A note from the shell (a failed room act, a voice error), below the blocks.
  note = null,
  // What must come straight after the situation: the passing question and her
  // answer, what an act just did, or why he arrived from a notification.
  lead = null,
}) {
  const plan = composeForSurface(presentation, profile);
  if (!presentation) return null;
  const s = presentation.situation || {};
  const about = s.about || null;

  const drawnAsObject = new Set();
  for (const blk of plan.blocks) {
    if (blk.type === 'needsYou' || blk.type === 'primary') for (const it of blk.items) drawnAsObject.add(it.id);
  }
  // The summary is dropped only when the thing it is about is drawn as an object
  // right beneath it — never otherwise.
  const showSummary = s.summary && !(about && drawnAsObject.has(about));
  // On an ambient surface the item the summary is about carries its hand-off
  // ("Review in Actions, in NEURO on the desktop.") as a second line.
  const aboutItem = about
    ? [...(presentation.needsYou || []), presentation.primary].filter(Boolean).find((i) => i.id === about)
    : null;
  const ambient = plan.profile === 'kiosk' || plan.profile === 'watch';

  return (
    <section
      className={`sit sit--${plan.profile} sit--mode-${plan.mode} sit--tone-${s.tone || 'calm'} sit--level-${s.attentionLevel || 'none'}`}
      data-mode={plan.mode}
      data-profile={plan.profile}
    >
      {field && <div className="sit__field" aria-hidden="true">{field}</div>}
      {/* Keyed on the mode so a change of situation recomposes with a fade
          (and nothing at all under reduced motion). */}
      <div className="sit__body" key={plan.mode}>
        {plan.blocks.map((blk, i) => {
          switch (blk.type) {
            case 'situation':
              return (
                <header key={i} className={`sit__situation sit__situation--${blk.variant}`} aria-live="polite">
                  <h2 className="sit__headline">{s.headline}</h2>
                  {showSummary && <p className="sit__summary">{s.summary}</p>}
                  {ambient && aboutItem && aboutItem.summary && <p className="sit__handoff">{aboutItem.summary}</p>}
                  {lead && <div className="sit__lead">{lead}</div>}
                </header>
              );
            case 'needsYou':
              return (
                <div key={i} className="sit__objects" role="list" aria-label="Needs you">
                  {blk.items.map((it) => (
                    <article key={it.id} role="listitem" className="sit__object sit__object--p0">
                      <span className="sit__object-tag">Needs you</span>
                      <p className="sit__object-title">{it.title}</p>
                      {it.summary && <p className="sit__object-sub">{it.summary}</p>}
                    </article>
                  ))}
                  {blk.overflow > 0 && <p className="sit__more">and {blk.overflow} more</p>}
                </div>
              );
            case 'primary': {
              const it = blk.items[0];
              return (
                <div key={i} className="sit__objects">
                  {renderPrimary ? renderPrimary(it) : (
                    <article className={`sit__object sit__object--${it.priority === 'P0' ? 'p0' : 'p1'}`}>
                      <span className="sit__object-tag">{it.priority === 'P0' ? 'Needs you' : 'Now'}</span>
                      <p className="sit__object-title">{it.title}</p>
                      {it.summary && <p className="sit__object-sub">{it.summary}</p>}
                    </article>
                  )}
                </div>
              );
            }
            case 'offers':
              return (
                <ul key={i} className="sit__offers">
                  {blk.items.map((it) => (
                    <li key={it.id} className="sit__offer">
                      <span className="sit__offer-say">{it.title}</span>
                      {plan.actions && onOffer && (
                        <span className="sit__offer-acts">
                          <button type="button" className="sit__chip sit__chip--yes" onClick={() => onOffer(it, true)}>Yes</button>
                          <button type="button" className="sit__chip" onClick={() => onOffer(it, false)}>No</button>
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              );
            case 'next':
              return (
                <div key={i} className="sit__nextblock">
                  <h3 className="sit__label">Next</h3>
                  <ul className="sit__nextlist">
                    {blk.items.map((it) => <NextRow key={it.id} item={it} onOpen={onOpen} actions={plan.actions} />)}
                  </ul>
                  {blk.overflow > 0 && !ambient && <p className="sit__more">{blk.overflow} more later</p>}
                </div>
              );
            case 'observations':
              return (
                <ul key={i} className="sit__obs">
                  {blk.items.map((it) => (
                    <li key={it.id} className={`sit__ob${it.promoted ? ' sit__ob--promoted' : ''}`}>
                      <span className="sit__ob-title">{it.title}</span>
                      {it.summary && !ambient && <span className="sit__ob-sub">{it.summary}</span>}
                    </li>
                  ))}
                </ul>
              );
            case 'context': {
              const activity = blk.items.find((c) => c.kind === 'activity') || null;
              return (
                <p key={i} className="sit__context">
                  {blk.items.map((c, j) => (
                    <span key={c.id} className="sit__ctx-item">
                      {j > 0 && <span className="sit__sep" aria-hidden="true"> · </span>}
                      {c.kind === 'activity' && c.basis === 'inferred' && !ambient && <span className="sit__inferred">Inferred: </span>}
                      <Annotation item={c} />
                      {c.kind === 'activity' && plan.actions && (
                        <> <Correction correction={blk.correction} activity={activity} onCorrect={onCorrect} onNotNow={onNotNow} busy={correcting} /></>
                      )}
                    </span>
                  ))}
                  {!activity && plan.actions && blk.correction && (
                    <span className="sit__ctx-item">
                      {blk.items.length > 0 && <span className="sit__sep" aria-hidden="true"> · </span>}
                      <Correction correction={blk.correction} activity={null} onCorrect={onCorrect} onNotNow={onNotNow} busy={correcting} />
                    </span>
                  )}
                  {!ambient && blk.honesty && blk.honesty.say && (
                    <span className="sit__honesty">{blk.honesty.say}</span>
                  )}
                </p>
              );
            }
            case 'tracked':
              return blk.variant === 'count' ? (
                <p key={i} className="sit__more sit__tracked">
                  {blk.count} other thing{blk.count === 1 ? '' : 's'} tracked. They can wait.
                </p>
              ) : (
                <details key={i} className="sit__details sit__tracked">
                  <summary>{blk.count} other thing{blk.count === 1 ? '' : 's'} tracked</summary>
                  <ul>{blk.items.map((it) => <li key={it.id}>{it.title}</li>)}</ul>
                </details>
              );
            case 'details':
              return (
                <details key={i} className="sit__details" open={blk.variant === 'open'}>
                  <summary>{plan.mode === 'degraded' ? 'What I can’t see' : 'Behind this'}</summary>
                  <ul>
                    {blk.items.map((d) => (
                      <li key={d.id}>
                        {d.label}
                        {Array.isArray(d.items) && d.items.length > 0 && (
                          <ul>{d.items.map((g) => <li key={g.input}>{g.input}{g.why ? ` — ${g.why}` : ''}</li>)}</ul>
                        )}
                      </li>
                    ))}
                  </ul>
                </details>
              );
            case 'ask':
              return ask ? <div key={i} className={`sit__ask sit__ask--${blk.variant}`}>{ask}</div> : null;
            default:
              return null;
          }
        })}
        {note && <div className="sit__note">{note}</div>}
        {foot && <div className="sit__foot">{foot}</div>}
      </div>
    </section>
  );
}
