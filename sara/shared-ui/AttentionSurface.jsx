import { useState } from 'react';
import Field from './Field';
import Dashboard from './Dashboard';
import { isPressing } from './useFieldDrive';
import './AttentionSurface.css';

// AttentionSurface — the attention feed, rendered.
//
// ⚠ ONE source, shared by the phone (`sara/app` Surface) and the Pi kiosk
// (`sara/frontend` Presence). Nick's steer on 30 Aug was that the two "should
// essentially be the same app", and this is the half of that which matters: the
// RULES live here, once, so the two surfaces cannot come to disagree about what
// a payload means.
//
// The CHROME does not live here. Each shell passes its own — the phone brings a
// mic, a speech toggle and a notification-arrival card; the kiosk brings none of
// them and is not made to pretend otherwise. That split is deliberate: sharing
// the rules is what stops drift, sharing the furniture would only make both
// surfaces worse.
//
// It fetches nothing and decides nothing. `title`, `say`, `tab` and the
// transition wording are all composed server-side and rendered VERBATIM — this
// is the third renderer of one decision, not a third opinion.
//
// ── The rules it exists to hold in one place ────────────────────────────────
//
//   * THREE SILENCES, kept apart. "I can't see your work", "staying out of the
//     way" and "nothing pressing" are different facts and only the last is good
//     news. Conflating them is how a broken feed comes to look like a calm day.
//   * NOTHING IS HIDDEN SILENTLY. What the gate held back is counted and named.
//   * A TRANSITION LEADS when there is one — "leave now" is worthless five
//     minutes late — and it PROPOSES: every option opens a screen, none starts
//     a timer, writes a calendar or completes anything.
//   * "NOT NOW" ASKS HOW LONG rather than snoozing on a guess, and each answer
//     carries a REASON: a thing pushed back three times as "too big" is a
//     different problem from one pushed back as "not now".
//   * DISMISS IS OFFERED ONLY WHEN THE RECORD ALLOWS IT. An escalation is
//     deliberately not dismissable, and a button NEURO will refuse is worse
//     than no button at all.
//   * "THAT'S DONE" SAYS WHAT IT CLOSED. The card clearing and the task closing
//     are two outcomes; a held tick is not a completion, and the screen says so.

// How long "not now" means, in Nick's words rather than in minutes.
export const DEFERRALS = [
  { label: 'An hour', minutes: 60, reason: 'not-now' },
  { label: 'This afternoon', minutes: 240, reason: 'not-now' },
  { label: 'Tomorrow', minutes: 60 * 20, reason: 'no-context' },
  { label: 'Too big', minutes: 60 * 20, reason: 'too-big' },
];

// What "that's done" actually did, in words.
//
// ⚠ Resolving the CARD and closing the TASK are two outcomes, and the act route
// states both (`taskCompleted` + `taskWhy`) rather than implying one from the
// other. A tick held by the outcome-note rule comes back `taskCompleted: false`
// and `taskHeld: true`, so it renders as held — never as finished, never as failed.
// `taskWhy` is the server's own sentence and is shown verbatim — a second
// phrasing on the client is a second answer free to drift.
//
// `undefined` means the shell did not report a result at all, and says NOTHING
// rather than guessing — "it failed" over a completion that landed is the lie in
// the other direction.
export function describeCompletion(res) {
  if (res === undefined) return null;
  const why = typeof res?.taskWhy === 'string' && res.taskWhy
    ? res.taskWhy.charAt(0).toUpperCase() + res.taskWhy.slice(1)
    : null;
  if (!res || res.ok === false) {
    return {
      tone: 'warn',
      lead: 'That didn’t go through — the card is still open.',
      sub: (res && res.error) || 'NEURO didn’t confirm it.',
    };
  }
  if (res.taskCompleted === true) return { tone: 'done', lead: 'Done — and the task is closed.', sub: why };
  // Off his list with no task behind it — an escalation he dealt with. The
  // ticket is still open in Jira, and `taskWhy` says so.
  if (res.handled === true) return { tone: 'done', lead: 'Done — off your list.', sub: why };
  // ⚠ Held is its own outcome: the tick landed and the task closes when its
  // write-up exists. Rendered as "no task was closed" it read as the tick failing.
  if (res.taskHeld === true) return { tone: 'partial', lead: 'Ticked — held until its write-up is in.', sub: why };
  return { tone: 'partial', lead: 'Card cleared — no task was closed.', sub: why };
}

export default function AttentionSurface({
  data,
  error = null,
  busy = false,
  rootClassName = 'surface',
  onOpen,
  onAct,
  onNavigate,
  // What Nick could SAY next. Each utterance carries a structured intent, so no
  // shell ever parses language — see `backend/services/sara-surface.js`.
  // Omitting it falls back to the original buttons, which is what keeps a
  // failed composition from emptying the screen.
  onSay,
  // Slots. Each shell brings its own chrome; none of them is required.
  crownExtra = null,
  beforeSay = null,
  sayOverride = null,
  footAside = null,
  footExtra = null,
  hideSecondary = false,
}) {
  const [showWhy, setShowWhy] = useState(false);
  const [deferring, setDeferring] = useState(false);
  // ⚠ Keyed on the PROMPT, not a boolean. "Not now" dismisses THIS transition;
  // the next one must appear on its own. A boolean would silence every later
  // transition too, which is how a useful prompt becomes one nobody sees again.
  const [dismissedTransition, setDismissedTransition] = useState(null);
  // The result of the last "that's done". Held HERE rather than on the card,
  // because a completed card is resolved and leaves the feed on the next read —
  // the answer to "did that close the task?" must outlive the thing it is about.
  const [outcome, setOutcome] = useState(null);

  if (!data) {
    return (
      <div className={`${rootClassName} surface--bare`}>
        <Field confidenceLevel="low" degraded />
        <p className="surface__saylead">I can&rsquo;t reach the brain.</p>
        {error && <p className="surface__whyline">{error}</p>}
      </div>
    );
  }

  const {
    context, primary, secondary = [], dropped = [], quiet,
    rationale, poolAvailable, gaps = [], transition = null, ambient = null,
    dashboard = null, utterances = [], covered = null,
  } = data;

  // ── Saying it ONCE ─────────────────────────────────────────────────────────
  //
  // Nick, 8 Sep 2026: "find a better way to present this so I dont see the same
  // thing three times." One meeting was the transition prompt, the headline AND
  // an agenda row; one task was the headline, a dashboard row and a card in the
  // list below. Every one of those was a correct decision, taken three times by
  // three layers that could not see each other.
  //
  // ⚠ WHAT IS THE SAME THING IS THE COMPOSER'S CALL (`covered`), never worked
  // out here — three renderers each matching titles their own way is the drift
  // that `say` and `tab` are composed server-side to avoid. This only decides
  // what to DO about it, which is a rendering decision and belongs here.
  const coveredIds = new Set(Array.isArray(covered?.cardIds) ? covered.cardIds : []);
  const rest = secondary.filter((c) => c && !coveredIds.has(c.id));

  // ⚠ Whether the transition is on screen is CLIENT state — he can dismiss it —
  // so the headline is folded into it only while it is actually showing. A rule
  // that hid the headline on the server's word alone would leave the screen with
  // no lead at all the moment he pressed "not now", which is the worse failure
  // by far.
  const transitionShown = Boolean(!sayOverride && transition && dismissedTransition !== transition.prompt);
  const transitionSaysPrimary = transitionShown && covered?.transitionIsPrimary === true;

  const act = async (card, action, opts) => {
    if (!onAct) return undefined;
    const res = await onAct(card, action, opts);
    if (action === 'complete') setOutcome(describeCompletion(res));
    return res;
  };

  // A tapped sentence is the same sentence as a tapped button, so "that's done"
  // reports what it did whichever way he said it.
  const sayIt = async (u) => {
    const res = await onSay(u, primary);
    const intent = u && u.intent;
    if (intent && intent.kind === 'act' && intent.action === 'complete') setOutcome(describeCompletion(res));
  };

  // ⚠ Offered only where it can mean something: a shell that can act, a card
  // with a RECORD to act on, and a record that allows it. Without a record the
  // only route left is the legacy dismissal, and a "done" that quietly became a
  // dismissal is the exact bug the attention contract removed.
  const canComplete = (card) => Boolean(
    onAct && card && card.kind === 'item' && card.recordId
    && (card.actions || []).includes('complete'),
  );

  // ⚠ The sentences REPLACE the button row only when the brain composed them
  // AND the shell knows how to act on one. Either missing falls through to the
  // original buttons: a framing layer must never be able to leave the screen
  // with no way to answer it.
  const speaks = Boolean(onSay) && Array.isArray(utterances) && utterances.length > 0;

  // ── What counts as PRESSING ────────────────────────────────────────────────
  //
  // Nick, 31 Aug 2026: "change anything pressing to a slow pulse."
  //
  // ⚠ The rule itself lives in `useFieldDrive` and is IMPORTED, not restated,
  // because the shell's background field applies it too — two definitions of
  // "pressing" would be two answers free to drift, on the same screen.
  //
  // Critical or high only, and it must be an ITEM. On a normal working day
  // there is nearly always a primary, so pulsing on any of them would mean
  // pulsing all day, and a signal that is always on is one nobody sees.
  const pressing = isPressing(primary);

  return (
    <div className={rootClassName}>
      {/* The coherence on screen is the coherence of the READ — informative
          before a word is read, which is what keeps this from being a
          screensaver. */}
      <Field
        activity={context?.activity}
        confidenceLevel={context?.confidence?.level}
        quiet={quiet}
        degraded={!poolAvailable}
        pressing={pressing}
      />

      <div className="surface__content">
        <div className="surface__crown">
          <span className="surface__mark">SARA</span>
          <button
            type="button"
            className="surface__state"
            onClick={() => setShowWhy((v) => !v)}
            aria-expanded={showWhy}
            aria-label="Why SARA is showing this"
          >
            {context?.label ? context.label.toLowerCase() : 'unsure'}
          </button>
          {crownExtra}
        </div>

        {showWhy && (
          <div className="surface__why">
            {context?.summary && <p className="surface__whyline surface__whyline--lead">{context.summary}</p>}
            {(context?.reasons || []).map((r, i) => <p key={i} className="surface__whyline">{r}</p>)}
            {(context?.contradictions || []).map((c, i) => (
              <p key={`c${i}`} className="surface__whyline surface__whyline--warn">{c}</p>
            ))}
            {rationale && <p className="surface__whyline">{rationale}</p>}
            {gaps.length > 0 && (
              <p className="surface__whyline">Couldn&rsquo;t read: {gaps.map((g) => g.input).join(', ')}.</p>
            )}
            <p className="surface__whyline">
              Confidence {context?.confidence?.level} — {context?.confidence?.rationale}
            </p>
          </div>
        )}

        {beforeSay}

        <div className="surface__say">
          {/* What the last "that's done" did. Tap to clear — it stays until read,
              because a note that fades on its own is one he may never see. */}
          {outcome && !sayOverride && (
            <button
              type="button"
              className={`surface__outcome surface__outcome--${outcome.tone}`}
              onClick={() => setOutcome(null)}
              aria-label="Clear this note"
            >
              <span className="surface__outcomelead">{outcome.lead}</span>
              {outcome.sub && <span className="surface__outcomesub">{outcome.sub}</span>}
            </button>
          )}

          {/* A transition is time-critical and leads when there is one. */}
          {transitionShown && (
            <div className="surface__transition">
              <p className="surface__saylead">{transition.prompt}</p>
              <p className="surface__saysub">{transition.question}</p>
              <div className="surface__acts">
                {transition.tab && onNavigate && (
                  <button
                    type="button"
                    className="surface__btn surface__btn--go"
                    onClick={() => onNavigate(transition.tab)}
                  >
                    {transition.kind === 'leave-now' ? 'Open prep'
                      : transition.kind === 'post-meeting' ? 'Capture it'
                        : 'Pick it up'}
                  </button>
                )}
                <button
                  type="button"
                  className="surface__btn"
                  onClick={() => setDismissedTransition(transition.prompt)}
                >
                  Not now
                </button>
              </div>
            </div>
          )}

          {sayOverride || (primary ? (
            <>
              {/* ⚠ Not repeated under the transition that just named it. The
                  prompt above carries the title, the countdown and the way in;
                  restating all three is the "same thing three times" Nick was
                  looking at. The ACTIONS below stay either way — folding the
                  wording must never fold the way to answer it. */}
              {!transitionSaysPrimary && (
                <>
                  <p className="surface__saylead">{primary.title}</p>
                  {/* ⚠ He is ALREADY ON IT. The brain stamps `session` on the
                      card a running session is about, and without this line
                      SARA went on reading "you have not replied yet" as if
                      nobody had touched it. The `say` beneath stays — it is
                      still true — but it no longer stands alone. */}
                  {primary.session && (
                    <p className="surface__saysub surface__saysub--onit">
                      {primary.session.status === 'active' ? 'You’re on it' : 'You started this'}
                      {Number.isFinite(primary.session.elapsedMinutes) ? ` — ${primary.session.elapsedMinutes} min in` : ''}
                      {primary.session.nextStep ? ` · next: ${primary.session.nextStep}` : ''}
                    </p>
                  )}
                  {primary.say && <p className="surface__saysub">{primary.say}</p>}
                </>
              )}
              {primary.kind === 'item' && onAct && !speaks && (
                <>
                  <div className="surface__acts">
                    <button
                      type="button"
                      className="surface__btn surface__btn--go"
                      onClick={() => onOpen && onOpen(primary)}
                    >
                      {primary.actionHint || 'Open it'}
                    </button>
                    {/* The sentence he would say, not a UI verb. It is Nick's
                        explicit confirmation — the ONLY action that resolves —
                        and what it closed is reported below, never implied. */}
                    {canComplete(primary) && (
                      <button
                        type="button"
                        className="surface__btn"
                        disabled={busy}
                        onClick={() => { act(primary, 'complete'); setDeferring(false); }}
                      >
                        That&rsquo;s done
                      </button>
                    )}
                    {/* ⚠ "Not now" opens the durations rather than deferring on
                        a guess. A snooze whose length SARA picked is one Nick
                        has no reason to trust, and the length is most of what
                        the gesture means. */}
                    <button
                      type="button"
                      className="surface__btn"
                      disabled={busy}
                      onClick={() => setDeferring((v) => !v)}
                    >
                      Not now
                    </button>
                  </div>

                  {deferring && (
                    <div className="surface__acts surface__acts--defer">
                      {DEFERRALS.map((d) => (
                        <button
                          key={d.label}
                          type="button"
                          className="surface__btn surface__btn--small"
                          disabled={busy}
                          onClick={() => { act(primary, 'defer', { minutes: d.minutes, reason: d.reason }); setDeferring(false); }}
                        >
                          {d.label}
                        </button>
                      ))}
                      {/* Seen is NOT a snooze. It stops SARA asking again while
                          leaving the card exactly where it is — the one state
                          the old suppression timer could not express. */}
                      <button
                        type="button"
                        className="surface__btn surface__btn--small"
                        disabled={busy}
                        onClick={() => { act(primary, 'acknowledge'); setDeferring(false); }}
                      >
                        Seen it
                      </button>
                      {(primary.actions || []).includes('dismiss') && (
                        <button
                          type="button"
                          className="surface__btn surface__btn--small"
                          disabled={busy}
                          onClick={() => { act(primary, 'dismiss'); setDeferring(false); }}
                        >
                          Not mine
                        </button>
                      )}
                    </div>
                  )}
                </>
              )}
            </>
          ) : (
            // ⚠ THREE genuinely different facts, and only the last is good news.
            <>
              {!poolAvailable ? (
                <>
                  <p className="surface__saylead">I can&rsquo;t see your work right now.</p>
                  <p className="surface__saysub">So don&rsquo;t read this as an all-clear.</p>
                </>
              ) : quiet ? (
                <>
                  <p className="surface__saylead">{context?.summary || 'Staying out of the way.'}</p>
                  <p className="surface__saysub">Nothing here needs you.</p>
                </>
              ) : (
                <>
                  <p className="surface__saylead">Nothing pressing.</p>
                  <p className="surface__saysub">Everything&rsquo;s where it should be.</p>
                </>
              )}
            </>
          ))}
        </div>

        {/* ── What she's showing ────────────────────────────────────────────
            Nick, 31 Aug 2026: SARA is "a series of dashboards", and the
            dashboard is an ANSWER, not a destination — it changed because the
            situation changed or because he asked, never because he went
            looking. Which one to show is composed server-side beside `say`,
            `speech` and `tab`, so three surfaces cannot disagree about which
            moment this is.

            ⚠ BELOW her words, always. The sentence is the product; this is what
            the sentence is about. */}
        {!hideSecondary && dashboard && <Dashboard dashboard={dashboard} />}

        {/* ── What he could say ─────────────────────────────────────────────
            ⚠ EVERY ONE OF THESE IS A SENTENCE HE COULD HAVE SAID OUT LOUD, and
            that is the whole design: the buttons exist for when he can't speak,
            so they must be the same words rather than a second vocabulary of UI
            verbs competing with the first. The intent travels with each one, so
            nothing here parses language.

            The escape hatch is always the last of them and is never dropped —
            an ambient surface that is sometimes wrong must always have a way
            round it. */}
        {speaks && (
          <div className="surface__says">
            {utterances.map((u, i) => (
              <button
                key={`${u.say}-${i}`}
                type="button"
                className={`surface__say-btn${u.intent && u.intent.kind === 'reveal' ? ' surface__say-btn--quiet' : ''}`}
                disabled={busy}
                onClick={() => sayIt(u)}
              >
                {u.say}
              </button>
            ))}
          </div>
        )}

        {/* ⚠ `rest`, not `secondary` — what the dashboard above already shows is
            not listed again. Nothing has been dropped from the FEED: the pool
            reaches every other consumer whole, and `covered` is advisory. */}
        {!hideSecondary && rest.length > 0 && (
          <ul className="surface__rest">
            {rest.map((card) => (
              <li key={card.id}>
                <button type="button" className="surface__row" onClick={() => onOpen && onOpen(card)}>
                  <span className="surface__rowtitle">{card.title}</span>
                  {card.say && <span className="surface__rowsay">{card.say}</span>}
                </button>
              </li>
            ))}
          </ul>
        )}

        {/* ── What she has noticed ──────────────────────────────────────────
            Ambient observations: sat still a long time, no exercise for three
            days, a health trend against his own baseline, no food logged when
            he normally logs it.

            ⚠ BELOW the pool, never above it, and never in the primary slot.
            These are facts about right now, not things to decide about — a
            sitting-down prompt must never outrank a breaching escalation. They
            are here because he is already looking, and NOTHING here notifies.

            ⚠ A caveat is rendered whenever the observation carries one. Apple
            Health cannot separate exercise, illness, alcohol and a hard week,
            and dropping the caveat is how a reading becomes a diagnosis. */}
        {!hideSecondary && ambient?.observations?.length > 0 && (
          <ul className="surface__ambient">
            {ambient.observations.map((o, i) => (
              <li key={`${o.kind}-${i}`} className={`surface__amb surface__amb--${o.level || 'info'}`}>
                <span className="surface__ambtext">{o.text}</span>
                {o.detail && <span className="surface__ambdetail">{o.detail}</span>}
                {o.suggestion && <span className="surface__ambsuggest">{o.suggestion}</span>}
                {o.caveat && <span className="surface__ambcaveat">{o.caveat}</span>}
              </li>
            ))}
          </ul>
        )}

        <div className="surface__foot">
          {footAside}
          {/* Held is not lost, and "couldn't look" is not "nothing there". */}
          {!hideSecondary && dropped.length > 0 && (
            <p className="surface__aside">{dropped.length} held — {dropped[0].why}.</p>
          )}
          {!hideSecondary && context?.cannotSee && (
            <p className="surface__aside surface__aside--her">{context.cannotSee}</p>
          )}
          {error && <p className="surface__aside surface__aside--warn">That last read failed — this is what I had.</p>}
          {footExtra}
        </div>
      </div>
    </div>
  );
}
