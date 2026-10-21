import { useState } from 'react';
import { composeForSurface, groupContext } from './budget.mjs';
import './Situation.css';
import { KmwReadout, KmwMain, KmwFolded } from './KeepMyWord.jsx';

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

// "Watching TV" → "watching TV": the server's label is a state phrase written
// to stand alone; inside "Looks like you’re …" its first letter drops — unless
// the word is an acronym. Wording only; nothing about WHAT is inferred changes.
export function inSentence(label) {
  const s = String(label || '');
  if (s.length > 1 && s[1] === s[1].toUpperCase() && /[A-Z]/.test(s[1])) return s;
  return s.charAt(0).toLowerCase() + s.slice(1);
}

function Correction({ correction, activity, onCorrect, onNotNow, busy }) {
  const [open, setOpen] = useState(false);
  if (!correction || !onCorrect) return null;
  // ⚠ A CORRECTION, not a panel, and not a hyperlink: SAiM states her read in
  //   words, with one pill to say she is wrong. Unknown is the pill alone. The
  //   options appear only once he taps it.
  const read = activity
    ? `${activity.basis === 'declared' ? 'You said you’re' : 'Looks like you’re'} ${inSentence(activity.label)}`
    : null;
  return (
    <div className={`sit__activity${read ? '' : ' sit__activity--unknown'}`}>
      {read && !open && <span className="sit__activity-read">{read}</span>}
      {!open && (
        <button
          type="button"
          className="sit__pill"
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
    </div>
  );
}

const FOCAL_EYEBROW = { event: 'Next', transition: 'Next', commitment: 'Due', task: 'Due' };

// The one thing the eye lands on after the headline (12.1D): stronger than the
// context, weaker than anything that needs him.
function Focal({ item, onOpen, actions }) {
  const eyebrow = (item.kind === 'commitment' || item.kind === 'task') && !item.when ? 'Next' : (FOCAL_EYEBROW[item.kind] || 'Next');
  const inner = (
    <>
      <span className="sit__focal-eyebrow">{eyebrow}</span>
      <span className="sit__focal-title">{item.title}</span>
      {(item.when || item.summary) && (
        <span className="sit__focal-meta">
          {item.when && <span className="sit__focal-when">{item.when}</span>}
          {item.when && item.summary && <span aria-hidden="true"> · </span>}
          {item.summary && <span>{item.summary}</span>}
        </span>
      )}
    </>
  );
  return (
    <div className="sit__objects">
      {actions && onOpen ? (
        <button type="button" className="sit__focal" onClick={() => onOpen(item)}>{inner}</button>
      ) : <div className="sit__focal">{inner}</div>}
    </div>
  );
}

function ContextGroup({ items, honesty, ambient }) {
  const g = groupContext(items);
  if (!g.place && !g.lines.length && !(honesty && honesty.say && !ambient)) return null;
  // A place with nothing under it is a line, not an eyebrow over nothing.
  const placeAsLine = g.place && !g.lines.length;
  return (
    <div className="sit__ctx" role="group" aria-label={g.place ? `Around you: ${g.place}` : 'Around you'}>
      {g.place && !placeAsLine && <p className="sit__ctx-place">{g.place}</p>}
      {placeAsLine && <p className="sit__ctx-line">{g.place}</p>}
      {g.lines.map((line) => (
        <p key={line.id} className="sit__ctx-line">
          {line.items.map((c, j) => (
            <span key={c.id}>
              {j > 0 && <span className="sit__sep" aria-hidden="true"> · </span>}
              <Annotation item={c} />
            </span>
          ))}
        </p>
      ))}
      {!ambient && honesty && honesty.say && <p className="sit__honesty">{honesty.say}</p>}
    </div>
  );
}

function Details({ items, mode, open }) {
  return (
    <details className="sit__details" open={open}>
      {/* What the read rests on, attached to the read — not a label floating in
          space (12.1H). In a degraded read it is what she cannot see. */}
      <summary>{mode === 'degraded' ? 'What I can’t see' : 'What this is based on'}</summary>
      <ul>
        {items.map((d) => (
          <li key={d.id}>
            {d.label}
            {Array.isArray(d.items) && d.items.length > 0 && (
              <ul>{d.items.map((x) => <li key={x.input}>{x.input}{x.why ? ` — ${x.why}` : ''}</li>)}</ul>
            )}
          </li>
        ))}
      </ul>
    </details>
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

/** The only modes on which a prepared move may lead. */
const CALM_MODES = new Set(['calm', 'working', 'off-duty']);
/** Modes that are themselves a lead (a held move folds beneath them). */
const LEAD_MODES = new Set(['degraded', 'in-meeting', 'needs-attention', 'focus', 'upcoming']);

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
  // The one next step (a rendered control group from the shell), drawn under
  // the headline so it is in the main scene, never behind "Show me everything".
  step = null,
  // Below everything: the shell's escape hatch ("Show me everything").
  foot = null,
  // A note from the shell (a failed room act, a voice error), below the blocks.
  note = null,
  // What must come straight after the situation: the passing question and her
  // answer, what an act just did, or why he arrived from a notification.
  lead = null,
  // SAiM's one prepared decision, drawn right under the situation (19 Oct 2026).
  prepared = null,
  // What kind of prepared moment is showing: { kind: 'actionable', headline }
  // or { kind: 'held' } (PreparedMove.momentOf), or null.
  preparedMoment = null,
  // Keep my word: the shell's call to POST /api/promises/:key/prepare (only
  // PREPARES the governed draft) and its hand-off to Actions. Absent → no control.
  onPrepareDelivery = null,
  // Keep my word: take a held promise forward as a prepared move. Absent → no control.
  onPromiseMove = null,
  onOpenActions = null,
  // The locked Keep my word scene (dark amber network, readout left, main
  // surface right). The SAiM shells opt in; NEURO's own Now does not.
  scene = false,
}) {
  const plan = composeForSurface(presentation, profile);
  if (!presentation) return null;
  const s = presentation.situation || {};
  const about = s.about || null;

  const drawnAsObject = new Set();
  for (const blk of plan.blocks) {
    if (blk.type === 'needsYou' || blk.type === 'primary' || blk.type === 'focal') for (const it of blk.items) drawnAsObject.add(it.id);
  }
  // Diagnostics attach to the read they explain (12.1H): drawn under the
  // context group when there is one, on their own only when there is not.
  const hasContext = plan.blocks.some((b) => b.type === 'context');
  const hasNeedsYou = plan.blocks.some((b) => b.type === 'needsYou');
  // ⚠ AN ACTIONABLE PREPARED MOVE IS NEVER DRAWN UNDER A QUIET "NOTHING NEEDS
  // YOU" HEADING. With no Needs-you item above it, the move's own state leads
  // (its headline, composed on the server from the packet). A Needs-you item
  // keeps the headline; a held move leaves the quiet state alone; a degraded
  // read keeps saying it cannot see.
  // ⚠ HARD RULE (20 Oct 2026): it leads ONLY on a calm/neutral state — no
  // Needs-you item, no P0 or urgent primary (risk, approval, urgent task),
  // and a mode that is calm, working or off duty (not degraded, in a meeting, a protected
  // block/focus, upcoming, bedtime or travelling). Otherwise the existing lead
  // stays first and the move is reached through a folded entry below it, its
  // action button hidden until he opens it.
  // A primary is a lead when it is P0 (a risk, an approval) or urgent; an
  // ordinary task follows the move rather than displacing it.
  const hasPrimary = plan.blocks.some((b) => b.type === 'primary' && (b.items || []).some((it) => it.priority === 'P0' || it.urgency === 'critical' || it.urgency === 'high'));
  const calmState = !hasNeedsYou && !hasPrimary && CALM_MODES.has(plan.mode);
  const actionable = Boolean(preparedMoment && preparedMoment.kind === 'actionable' && preparedMoment.headline);
  const momentLeads = actionable && calmState;
  // Where the move goes when it does not lead: after the LAST lead block — a
  // Needs-you list AND a P0 primary can both be on screen, and the move must
  // follow both (live, 20 Oct 2026: it sat between the Weekly Risk report and
  // a started 1-2-1). With no lead block, after the situation header.
  const isLeadBlock = (b) => b.type === 'needsYou' || (b.type === 'primary' && (b.items || []).some((it) => it.priority === 'P0' || it.urgency === 'critical' || it.urgency === 'high'));
  const lastLead = plan.blocks.reduce((at, b, idx) => (isLeadBlock(b) ? idx : at), -1);
  const situationAt = plan.blocks.findIndex((b) => b.type === 'situation');
  const anchorAt = lastLead >= 0 ? lastLead : situationAt;
  // A held move (off duty / leave) has no action; it folds only under a real lead.
  const realLead = hasNeedsYou || hasPrimary || LEAD_MODES.has(plan.mode);
  const fold = Boolean(preparedMoment) && (actionable ? !momentLeads : realLead);
  // ⚠ ONE stable element whatever the state: switching the wrapper's element
  // type remounts PreparedMove, which reloads, resets the moment and flips the
  // wrapper back — a loop in which the move never shows. So it is always a
  // <details>: open with its summary hidden when the move leads, closed behind
  // its entry when it follows a lead.
  const preparedEl = !prepared ? null : (
    <details className={`sit__prepared${fold ? ' sit__prepared--entry' : ' sit__prepared--shown'}`} open={fold ? undefined : true}>
      <summary className="sit__prepared-entry">{(preparedMoment && preparedMoment.entry) || 'Prepared work'}</summary>
      {prepared}
    </details>
  );
  // The foot (escape hatch, laptop row) belongs after the content and before
  // the dock — not stranded below the composer (12.1I).
  const hasAsk = Boolean(ask) && plan.blocks.some((b) => b.type === 'ask');
  // The laptop launch row is about the desk you are sat at; the wall is not
  // it, so the foot never renders there even now the wall carries full content.
  const showFoot = foot && plan.actions && plan.profile !== 'kiosk';
  const footEl = (note || showFoot) ? (
    <>
      {note && <div className="sit__note">{note}</div>}
      {showFoot && <div className="sit__foot">{foot}</div>}
    </>
  ) : null;
  // The summary is dropped only when the thing it is about is drawn as an object
  // right beneath it — never otherwise.
  const showSummary = !momentLeads && s.summary && !(about && drawnAsObject.has(about));
  const headline = momentLeads ? preparedMoment.headline : s.headline;
  // Keep my word (21 Oct 2026, the locked timefield scene): the readout sits
  // beside everything; the receipt or the held/calm thread takes the main
  // surface ONLY when the server says it leads (no urgent lead) and SAiM's
  // actionable prepared move is not already leading. Otherwise it folds,
  // recognisably, beneath the last lead. Never on the watch.
  const kmw = plan.profile !== 'watch' && presentation.keepMyWord ? presentation.keepMyWord : null;
  const kmwLeads = Boolean(kmw && kmw.leads && !momentLeads);
  const kmwFolded = kmw && !kmwLeads && (kmw.receipt || kmw.thread)
    ? <KmwFolded key="kmw-folded" kmw={kmw} onOpen={onOpen} actions={plan.actions} onPrepareDelivery={onPrepareDelivery} onPromiseMove={onPromiseMove} onOpenActions={onOpenActions} />
    : null;
  // On an ambient surface the item the summary is about carries its hand-off
  // ("Review in Actions, in NEURO on the desktop.") as a second line.
  const aboutItem = about
    ? [...(presentation.needsYou || []), presentation.primary].filter(Boolean).find((i) => i.id === about)
    : null;
  // On the wide scene the basis is folded behind its summary (still one tap
  // away, still named — "What I can’t see" stays visible as the summary) so
  // the home is one screen.
  const foldDetails = Boolean(kmw && scene && plan.profile !== 'phone');
  // Only the watch is ambient now: the wall carries the desktop's content (5 Oct 2026).
  const ambient = plan.profile === 'watch';

  return (
    <section
      className={`sit sit--${plan.profile}${kmw ? ' sit--kmw' : ''}${kmw && scene ? ' sit--scene' : ''} sit--mode-${plan.mode} sit--tone-${s.tone || 'calm'} sit--level-${s.attentionLevel || 'none'}${preparedMoment ? ' sit--with-moment' : ''}${momentLeads ? ' sit--moment-leads' : ''}`}
      data-mode={plan.mode}
      data-profile={plan.profile}
    >
      {field && <div className="sit__field" aria-hidden="true">{field}</div>}
      {/* Keyed on the mode so a change of situation recomposes with a fade
          (and nothing at all under reduced motion). */}
      <div className="sit__body" key={plan.mode}>
        {kmw && <KmwReadout readout={kmw.readout} compact={plan.profile === 'phone'} />}
        {plan.blocks.map((blk, i) => {
          switch (blk.type) {
            case 'situation':
              return [
                kmwLeads ? (
                  <header key={i} className={`sit__situation sit__situation--kmw sit__situation--kmw-${kmw.state}`}>
                    <KmwMain kmw={kmw} onOpen={onOpen} actions={plan.actions} onPrepareDelivery={onPrepareDelivery} onPromiseMove={onPromiseMove} onOpenActions={onOpenActions} />
                    {lead && <div className="sit__lead">{lead}</div>}
                  </header>
                ) : (
                  <header key={i} className={`sit__situation sit__situation--${blk.variant}`} aria-live="polite">
                    <h2 className="sit__headline">{headline}</h2>
                    {showSummary && <p className="sit__summary">{s.summary}</p>}
                    {kmw && scene && !kmw.thread && !kmw.receipt && kmw.benchWhy && <p className="kmw__quiet">{kmw.benchWhy}</p>}
                    {ambient && aboutItem && aboutItem.summary && <p className="sit__handoff">{aboutItem.summary}</p>}
                    {step}
                    {lead && <div className="sit__lead">{lead}</div>}
                  </header>
                ),
                // Outside the live region: a whole prepared move must not be re-announced on every poll.
                i === anchorAt && preparedEl ? <div key={`${i}-prepared`}>{preparedEl}</div> : null,
                i === anchorAt ? kmwFolded : null,
              ];
            case 'needsYou':
              return [
                <div key={i} className="sit__objects" role="list" aria-label="Needs you">
                  {blk.items.map((it) => (
                    <article key={it.id} role="listitem" className="sit__object sit__object--p0">
                      <span className="sit__object-tag">Needs you</span>
                      <p className="sit__object-title">{it.title}</p>
                      {it.summary && <p className="sit__object-sub">{it.summary}</p>}
                    </article>
                  ))}
                  {blk.overflow > 0 && <p className="sit__more">and {blk.overflow} more</p>}
                </div>,
                i === anchorAt && preparedEl ? <div key={`${i}-prepared`}>{preparedEl}</div> : null,
                i === anchorAt ? kmwFolded : null,
              ];
            case 'primary': {
              const it = blk.items[0];
              return [(
                <div key={i} className="sit__objects">
                  {renderPrimary ? renderPrimary(it) : (
                    <article className={`sit__object sit__object--${it.priority === 'P0' ? 'p0' : 'p1'}`}>
                      <span className="sit__object-tag">{it.priority === 'P0' ? 'Needs you' : 'Now'}</span>
                      <p className="sit__object-title">{it.title}</p>
                      {it.summary && <p className="sit__object-sub">{it.summary}</p>}
                    </article>
                  )}
                </div>
              ), i === anchorAt && preparedEl ? <div key={`${i}-prepared`}>{preparedEl}</div> : null, i === anchorAt ? kmwFolded : null];
            }
            case 'focal':
              return <Focal key={i} item={blk.items[0]} onOpen={onOpen} actions={plan.actions} />;
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
                  {/* Under a focal "Next" object the rest of the list is what comes after it. */}
                  <h3 className="sit__label">{plan.blocks.some((b) => b.type === 'focal') ? 'Later' : 'Next'}</h3>
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
              const detailsBlk = plan.blocks.find((b) => b.type === 'details');
              if (!ambient) {
                // Near surfaces: a small grouped block, then the correction row.
                return (
                  <div key={i} className="sit__ctxblock">
                    <ContextGroup items={blk.items} honesty={blk.honesty} ambient={ambient} />
                    {detailsBlk && <Details items={detailsBlk.items} mode={plan.mode} open={detailsBlk.variant === 'open' && !foldDetails} />}
                    {plan.actions && blk.correction && (
                      <Correction correction={blk.correction} activity={activity} onCorrect={onCorrect} onNotNow={onNotNow} busy={correcting} />
                    )}
                  </div>
                );
              }
              return (
                <p key={i} className="sit__context">
                  {blk.items.map((c, j) => (
                    <span key={c.id} className="sit__ctx-item">
                      {j > 0 && <span className="sit__sep" aria-hidden="true"> · </span>}
                      {c.kind === 'activity' && c.basis === 'inferred' && !ambient && <span className="sit__inferred">Inferred: </span>}
                      <Annotation item={c} />
                    </span>
                  ))}
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
              // Attached under the context group when there is one (above).
              if (hasContext && !ambient) return null;
              return <Details key={i} items={blk.items} mode={plan.mode} open={blk.variant === 'open' && !foldDetails} />;
            case 'ask':
              return ask ? (
                <div key={i} className="sit__tailwrap">
                  {footEl}
                  <div className="sit__tail"><div className={`sit__ask sit__ask--${blk.variant}`}>{ask}</div></div>
                </div>
              ) : null;
            default:
              return null;
          }
        })}
        {/* ⚠ The shell's foot (laptop launch row, escape hatch) is CONTROLS, so
            it obeys the budget like everything else: never on a wall. With a
            dock it was drawn above the dock, inside the 'ask' block. */}
        {!hasAsk && footEl}
      </div>
    </section>
  );
}
