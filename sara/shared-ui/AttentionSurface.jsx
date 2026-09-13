import { useState } from 'react';
import Field from './Field';
import Dashboard from './Dashboard';
import Approach from './Approach';
import Shelf from './Shelf';
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
  // Answer a room offer: `(key, 'accept' | 'decline')`. Omitted on a surface
  // that cannot reach `/api/rooms`, in which case the offer is rendered as a
  // statement and no button is shown — never a control that fails when tapped.
  onRoomAct = null,
  // Ask for something to be opened on the laptop: `(appId) => {}`. Omitted on a
  // surface that cannot reach the route, in which case nothing is offered —
  // never a button that fails when tapped.
  onDeskOpen = null,
  // Per-app outcome: waiting | claimed | opened | failed | expired.
  deskStates = {},
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
  // How the feed is ARRANGED. 'list' is the original stack of rows; 'approach'
  // is the corridor — depth is time, pull is urgency, see sara/MANIFESTATION.md.
  //
  // ⚠ A prop rather than a rewrite, deliberately. This is a working ambient
  // surface on four devices; a look that cannot be put back is one nobody can
  // afford to try. Each shell opts in when it has been SEEN on that device.
  // ⚠ 'approach' is SARA's screen (Nick, 13 Sep 2026). `?look=list` is the way
  // back and is the reason this is still a prop: a look with no way out of it is
  // one that needs a deploy to undo, on devices that are on a wall.
  layout = 'approach',
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
    // Lights and heating in the room presence says he is standing in. Composed
    // by `backend/services/rooms.js`, carried beside `ambient` on the payload,
    // and rendered below. Null renders nothing, which is the normal case.
    rooms = null,
    // What he is working on, and whether he is at the laptop. Only the second
    // half is used here, and only to decide whether offering to open something
    // there is honest.
    work = null,
    dashboard = null, utterances = [], covered = null,
    // The sky. A top-level block (`{known, condition, tempC, unit, rain}`), read
    // here for the shelf — `known: false` is an unread sky, which is a different
    // fact from a clear one and is printed as such.
    weather = null,
    // ⚠ WHY THIS PANEL IS THE ONE ON SCREEN. `sara-surface` has composed it
    // since the ask flow shipped, `attention` carries it, four tests pin it —
    // and NO client read it, web or iOS. So the honesty it exists to provide
    // did not exist: the dashboard moved under him with nothing saying whether
    // that was the day changing or his own question. The comment above the
    // Dashboard mount states the distinction and then showed neither half.
    //
    // Null is the normal case and renders nothing — the situation changing is
    // what this surface DOES, and annotating that would be noise on every read.
    askedSurface = null,
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
  // ── What the corridor places ───────────────────────────────────────────────
  //
  // ⚠ THE DASHBOARD ROWS ARE THE FEED, not just `rest`. What is on this screen
  // on a normal day is the panel the composer filled — here, outside, next,
  // slept, did — and `rest` is often empty. A corridor fed only from `rest`
  // renders nothing on exactly the days there is something to show.
  //
  // ⚠ Nothing is re-ranked and nothing is re-worded: the order is the order the
  // composer sent, and every string is its own.
  //
  // ⚠ An ISO stamp is a TIME, not a note. The row carries `2026-09-13T13:55:00`
  // in `note`, which the list renders raw under the title — so the corridor
  // reads it as the hour the card belongs to and shows the clock time instead
  // of the stamp. That is the same fix the list still needs.
  const ISO_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
  const corridorCards = (() => {
    if (layout !== 'approach') return [];
    const out = [];
    if (dashboard?.now) {
      out.push({
        id: 'now', tag: 'now', title: dashboard.now.what,
        say: dashboard.now.meta || null, urgency: 'high',
      });
    }
    (dashboard?.rows || []).forEach((r, i) => {
      // ⚠ THE SKY IS ON THE SHELF, NOT THE TRACK. It has no hour, so it was
      // being placed by pull alone in the middle of the corridor while the
      // shelf printed the same reading — the same thing twice, on one screen,
      // which is the duplication this surface keeps removing.
      const when = String(r.when || '').toLowerCase();
      if (when === 'outside') return;
      // ⚠ `here` IS HER SENTENCE AGAIN. The row reads "home / Not a working day"
      // while she says "Not a working day" underneath and the shell's header
      // already prints the room — the same fact three times, which is the
      // duplication this whole layout exists to remove. Where he is belongs to
      // the place line, not the track.
      if (when === 'here') return;
      // ⚠ MIDNIGHT IS AN ALL-DAY EVENT, NOT AN HOUR. `2026-09-13T00:00:00` is
      // how an all-day entry arrives, and showing it as "00:00" states a time
      // nobody set — the one thing this corridor must never do. It keeps its
      // place in the order and is given no hour at all.
      const stamp = typeof r.note === 'string' && ISO_AT.test(r.note) ? r.note : null;
      const iso = stamp && stamp.slice(11, 16) !== '00:00' ? stamp : null;
      out.push({
        id: `dash-${i}`,
        tag: r.when || '',
        title: r.what,
        say: stamp ? null : (r.note || null),
        atLabel: r.countdown || (iso ? iso.slice(11, 16) : null) || r.meta || null,
        at: iso,
        // ⚠ THE WORD IS `crit`. `sara-surface` emits `level: 'crit'` — on the
        // `now` row above all, which is the PRIMARY — and this tested for
        // 'critical', a string nothing has ever sent. So the most important card
        // on the screen scored `normal` and was not pulled forward at all: the
        // corridor's one job, failing silently on its most important input.
        // Found by the iOS port reading both sides. Both spellings accepted, so
        // a composer that tidies the word later cannot break this again.
        urgency: r.level === 'warn' ? 'high'
          : (r.level === 'crit' || r.level === 'critical') ? 'critical'
            : 'normal',
      });
    });
    return out;
  })();

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

  // ── Her colour, once, for the whole surface ────────────────────────────────
  //
  // ⚠ The corridor, the shelf and the week's figure must all be the same blue.
  // The figure was still wearing the old panel's bright teal against a blue
  // field, which is a second answer about her state on one screen — the drift
  // `fieldDrive` exists to stop. It is set HERE and inherited, so there is one
  // place that decides and no component picks its own.
  const toneRgb = !poolAvailable ? '107, 116, 128'
    : pressing || context?.activity === 'firefighting' ? '224, 84, 58'
      : context?.activity === 'pre-meeting' ? '217, 138, 58'
        : '74, 127, 212';

  const nowMinutes = (() => {
    const d = new Date();
    return d.getHours() * 60 + d.getMinutes();
  })();

  return (
    <div
      className={`${rootClassName}${layout === 'approach' ? ' surface--approach' : ''}`}
      style={layout === 'approach' ? { '--approach-rgb': toneRgb } : undefined}
    >
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
          {/* ⚠ INSIDE the centrepiece in this layout, not below it. What she said
              and what he can say back are one object — the box IS the answer and
              the answers to it. Rendered as a separate row underneath, the box
              read as a statement with some buttons loose beneath it. */}
          {speaks && layout === 'approach' && (
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
        {/* ── The shelf ─────────────────────────────────────────────────────
            Hardware, not content: what she can reach right now. It has no hour
            so it never rides the corridor, and it never goes empty — a blank
            corner and a broken screen look identical.

            ⚠ It REPLACES the desk row in this layout rather than sitting beside
            it; two places offering to open the same laptop is the "same thing
            twice" this surface keeps removing. */}
        {!hideSecondary && layout === 'approach' && (
          <div className="surface__shelf">
            <Shelf
              weather={weather}
              rooms={rooms}
              work={work}
              deskStates={deskStates}
              onDeskOpen={onDeskOpen}
              onRoomAct={onRoomAct}
            />
          </div>
        )}

        {/* The corridor. Full-bleed behind her words, placing what the
            dashboard would have listed plus anything else in the feed. */}
        {!hideSecondary && layout === 'approach' && (corridorCards.length > 0 || rest.length > 0) && (
          <Approach
            cards={[...corridorCards, ...rest.map((c) => ({ ...c, tag: '' }))]}
            nowMinutes={nowMinutes}
            // ⚠ Nothing ahead means no corridor: the facts lie flat and equal,
            // which is what a finished day actually looks like. The centrepiece
            // is there either way — that is what was missing.
            quiet={!corridorCards.some((c) => {
              if (typeof c.at !== 'string') return false;
              const m = c.at.match(/T(\d{2}):(\d{2})/);
              return m ? Number(m[1]) * 60 + Number(m[2]) >= nowMinutes : false;
            })}
            onOpen={(card) => { if (card && card.recordId && onOpen) onOpen(card); }}
          />
        )}

        {!hideSecondary && dashboard && (
          <>
            {/* ⚠ SAID BEFORE THE PANEL, not after it. It explains what he is
                about to read; underneath, it would be a footnote to a screen he
                has already tried to make sense of.

                ⚠ And it is NOT gated on the question still being on screen. The
                ephemeral exchange clears, the moved dashboard does not — so a
                panel that outlives its question is exactly the case that needs
                the label, not the case that can do without it.

                ⚠ Hardcoded `surface__`, like every other CHILD class in this
                file — `rootClassName` is for the root element only and the
                stylesheet targets `.surface__*` literally, so interpolating it
                here would make this the one child that loses its styling the day
                a shell passes a different root. */}
            {askedSurface && (
              <p className="surface__because">Showing this because you asked.</p>
            )}
            <Dashboard dashboard={dashboard} hideRows={layout === 'approach'} />
          </>
        )}

        {/* ── What he could say ─────────────────────────────────────────────
            ⚠ EVERY ONE OF THESE IS A SENTENCE HE COULD HAVE SAID OUT LOUD, and
            that is the whole design: the buttons exist for when he can't speak,
            so they must be the same words rather than a second vocabulary of UI
            verbs competing with the first. The intent travels with each one, so
            nothing here parses language.

            The escape hatch is always the last of them and is never dropped —
            an ambient surface that is sometimes wrong must always have a way
            round it. */}
        {speaks && layout !== 'approach' && (
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
          layout === 'approach' ? null : (
            /* ⚠ The SAME `rest` the list renders, in the same order, with the
               same `covered` already applied. The corridor places what it is
               handed and judges nothing — see the header of Approach.jsx. */
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
          )
        )}

        {/* ── Open it on the desk ────────────────────────────────────────────
            The button half of the desk-intent pull channel.

            ⚠ ONLY WHEN HE IS AT THE LAPTOP. An intent expires in about one
            agent poll, so offering this while the machine is asleep queues
            something that dies unclaimed and reads as broken. `atDesk` is
            carried on every answer for exactly this.

            ⚠ "I can't see your laptop" and "you're not at it" are different
            facts and send him to different fixes, so the unknown case SAYS so
            rather than rendering nothing.

            ⚠ It reports the real outcome and never the word "sent" — `claimed`
            means the laptop took it, which is not the same as it working. */}
        {!hideSecondary && layout !== 'approach' && onDeskOpen && work && work.deskKnown === false && (
          <p className="surface__aside">I can&rsquo;t see your laptop, so I can&rsquo;t open anything on it.</p>
        )}
        {/* ⚠ WHAT IS OFFERED IS THE MACHINE'S OWN ANSWER, composed server-side
            as `work.deskOffer`. Every surface used to render the same
            hardcoded four, so a button could name a program the target
            machine does not have. Four clients each filtering for themselves
            is four chances to disagree about one laptop — the rule
            `say`/`speech`/`tab` already follow.

            ⚠ A machine that has not said what it can open gets NO buttons and
            a stated reason. Offering everything and hoping is what made the
            row untrustworthy in the first place. */}
        {!hideSecondary && layout !== 'approach' && onDeskOpen && work && work.atDesk && work.deskOffer
          && work.deskOffer.apps && work.deskOffer.apps.length > 0 && (
          <div className="surface__desk">
            <span className="surface__desklabel">
              Open on {work.deskOffer.host || 'your desk'}
            </span>
            {work.deskOffer.apps.map(({ id, label }) => (
              <button
                key={id}
                type="button"
                className="surface__deskbtn"
                disabled={deskStates[id] === 'waiting' || deskStates[id] === 'claimed'}
                onClick={() => onDeskOpen(id)}
              >{label}{deskStates[id] ? <span className="surface__deskstate"> · {deskStates[id]}</span> : null}</button>
            ))}
          </div>
        )}
        {/* It is at the desk and the machine offered nothing — say which fact
            that is, rather than leaving a gap where the row was. */}
        {!hideSecondary && onDeskOpen && work && work.atDesk && work.deskOffer
          && (!work.deskOffer.apps || work.deskOffer.apps.length === 0)
          && work.deskOffer.why && (
          <p className="surface__aside">Nothing to open — {work.deskOffer.why}.</p>
        )}

        {/* ── The room he is standing in ────────────────────────────────────
            Lights and heating, offered only where presence says he IS.

            ⚠ ABOVE ambient and BELOW the pool, deliberately. These are
            actionable, so they outrank a passive observation — and they are
            about right now, so they must never reach the primary slot ahead of
            a breaching escalation.

            ⚠ SHE ASKS; SHE DOES NOT ACT. Every offer here is a question, and
            `act` on the payload says only whether this KIND is rated to act
            unattended one day. Nothing on this screen switches anything on
            without a press.

            ⚠ NO `onRoomAct`, NO BUTTONS. A surface that cannot perform the
            action renders the offer as a statement rather than a control that
            fails when tapped — the same rule the action row below already
            follows.

            ⚠ Presence tracks the WATCH, not Nick, so the subject is named
            rather than assumed. A watch on the arm of the sofa is, to this,
            Nick on the sofa. */}
        {!hideSecondary && layout !== 'approach' && rooms?.offers?.length > 0 && (
          <ul className="surface__rooms">
            {rooms.offers.map((o) => (
              <li key={o.key} className="surface__room">
                <span className="surface__roomsay">{o.say}</span>
                {onRoomAct ? (
                  <span className="surface__roomacts">
                    <button type="button" className="surface__roombtn surface__roombtn--yes"
                      onClick={() => onRoomAct(o.key, 'accept')}>Yes</button>
                    <button type="button" className="surface__roombtn"
                      onClick={() => onRoomAct(o.key, 'decline')}>Not now</button>
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {/* "I could not see the room" is not "the room is fine". */}
        {!hideSecondary && rooms && rooms.known === false && (
          <p className="surface__aside surface__aside--warn">
            I can&rsquo;t see the house right now.
          </p>
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
