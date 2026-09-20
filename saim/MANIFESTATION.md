# How SAiM looks, and why

The visual contract for every surface that renders her: the phone PWA
(`saim/app`), the Pi 4 desk kiosk and the wall/study tablets (`saim/frontend`,
served by `saim/backend` on :3005), the Electron window (`saim/desktop-electron`,
which loads the same frontend), and the iOS app (`Wardy-uk/nuero-ios`).

**Read this before changing a pixel.** Everything here is a rule with a reason
attached. A prettier version that breaks one of them is a regression, however
much better it looks in a screenshot.

---

## What is permanently retired

**The orb.** A pulsing sphere that brightens when something happens. It went
because *a glowing blob says nothing* — it encoded no state anyone could read,
so it was decoration wearing the costume of a signal. Anything that reduces her
to a single featureless shape with a brightness is this again.

**The menu.** SAiM is not navigated. She surfaces what is needed and everything
she can do is sayable. The tab strip survives only as an escape hatch, because a
thing Nick cannot find is worse than a menu he does not need.

**The dashboard grid.** A wall of equal tiles, each with a number. It fails the
same test as the orb one level up: everything is equally present, so nothing is.

---

## The field is her (`fieldDrive.mjs`, `Field.jsx`)

The nebulous connected nodes are not a background. They are SAiM, and they are
present in **every** state she is seen in — the feed, both blind branches, the
lock screen, the clock screen, and behind the shell of both apps.

* **`dim` is 1 in every state.** She never fades. Nick, 6 Sep 2026: *"it should
  be the colour of her presence that changes, not the visibility."*
* **Colour carries the read** — a two-segment ramp, blue → orange → red, driven
  by `intensity`. Quiet 0.08, low→high confidence 0.37→0.60, firefighting 0.75,
  pressing 1 even when quiet.
* **Blind is GREY (`unresolved`) and is not on the ramp**, because blue would
  give an outage the colour of a quiet afternoon. It never settles.
* **The settle is LOCAL and carries confidence.** Order arrives as a bloom
  around one point and dissolves again; how completely it resolves is how
  confident the read is. The coherence on screen is the coherence of the read.
* **Pressing is a slow pulse that only ever BRIGHTENS** (~6.5s). Dipping below
  the floor would make her less visible exactly when something needs him. Under
  `prefers-reduced-motion` it becomes a steady lift, not nothing — that is a
  request for less movement, not less information.
* A hard-to-read sentence moves the **scrim**, never the field's own alphas.

---

## The layout: Approach (13 Sep 2026)

Chosen after eleven directions. It is the fusion of two: *Orrery* said time is a
line, *Strata* said urgency is distance. They are the same axis.

### The four rules

1. **Depth is time.** Where a thing sits is *when it is*. Now is at the
   viewer's face; the end of the day is at the horizon.
2. **Pull is urgency.** What needs him is dragged forward off its hour. A
   breaching escalation has no hour at all — it simply arrives, close.
3. **Every pulled thing keeps its tether** — a thin line back to the hour it
   really belongs to. Nothing is near without saying why it is near.
4. **The corner says what she READ, never what she concluded.** The console
   column is timestamped, monospace and faint. The moment a line in it starts
   editorialising it becomes a second, worse copy of her sentence, and the only
   reason to have it is that it is the one part of the screen that cannot
   flatter her.

### What goes where

* **Her sentence** is bottom-left and is the product. Everything else on screen
  is what the sentence is about.
* **The corridor** carries the feed — what is coming at him.
* **The console column**, top-left, is the evidence.
* **Her place**, under her name: `home · office · desk + watch`. The provenance
  is part of the label, because presence tracks the watch and the desk agent,
  not Nick — which is exactly why the lights *ask*.
* **The bottom-right corner is hardware, not content.** Weather now-and-next,
  the desk-intent apps where the laptop answered, the house doors where the
  house answered. It never rides the track (it has no hour), never competes for
  the lead slot, and **never goes empty**. What cannot be reached renders
  **dashed and dim** rather than missing — a control that would fail on the tap
  is worse than no control, and that is the three-light-states rule wearing
  different clothes.

### Orientation, not width

The Pi panel and the tablets are **landscape** (1280×720 / ~1280×800); iOS is
**portrait** (~390×844). Portrait **narrows the corridor rather than shortening
it** — fewer lanes, same depth. Depth costs legibility by design, so anything
past mid-track is a shape and not a sentence; that is affordable on a wall and
is the real risk on a phone, and it is why the lane count changes and the
horizon does not.

---

## What she is DOING (20 Sep 2026)

The feed said what she had READ, what she thought MATTERED and how confident the
read was. It never said whether anything was **under way** — so a request Nick
had made ten seconds earlier and a completely idle afternoon produced the same
screen, and the only place "in flight" existed at all was a `useState` inside the
phone PWA, invisible to the kiosk, to iOS and to the phone's own next poll.

**The loop she is visibly in**:
`observe → assess → recommend → obtain approval → execute → verify → report`.

* **A REQUEST SENT IS NOT AN ACTION COMPLETED.** `executing` means the ask is
  out, `verifying` means something took it and has not said what happened, and
  **neither is success**. The outcome is reported when it is known, or the
  failure is, and nothing in between claims either. A card that clears itself on
  an error is one he believes worked.
* **One vocabulary, composed server-side** — `shared/operation-phase.cjs`,
  mirrored in `Operation.swift` and pinned across the two repos. The phase and
  its `label` arrive on the payload and are rendered **verbatim**; an
  unrecognised phase renders **nothing**, never its own raw id.
* **`unavailable` outranks everything**, including a request in flight. It is
  not a status — it says how much of the rest of the screen can be believed, and
  a surface that has gone blind must never look calm. A routine gap does **not**
  reach it: a warning that is always on is one nobody reads.
* **The resting phases carry no detail line.** `standing_by`, `quiet` and
  `monitoring` are true for hours; a line that is there most of every day costs
  the reading of the ones that matter.
* **The label lives in the crown, monospace and faint** — the console register,
  beside the context word, not above the sentence. "in a meeting · QUIET" is one
  sentence made of two different facts. It takes **her** colour when live and
  has no palette of its own.
* **The only phase a shell decides for itself is its own**: `assessing` while it
  is waiting on a question, `executing` while a write of its own is out. That is
  a fact about the device, not an inference about Nick's day — and it is
  transient, so a client-local phase can never survive contrary server data.
  Even then the **words** come from the shared vocabulary.
* **Never spinner dots.** Thinking is a thin line shifting in her colour; under
  `prefers-reduced-motion` it becomes a steady line, not nothing.

**Deliberately not on the lock-screen widget.** A phase is a right-now fact and
a widget refreshes on iOS's budget (~15–30 min) against a five-minute deadline,
so it would reliably show an operational state that had already ended — the
stale-reading-as-current failure this whole layer exists to remove.

## Everything she can do is sayable (20 Sep 2026)

The sentences have been composed server-side for weeks and could only ever be
**tapped**: saying *"not now"* streamed a chat answer about deferring rather
than deferring anything. The tap path and the spoken path were two vocabularies
and only one of them worked.

* **No client parses language.** The brain composes, per utterance, the exact
  `phrases` that mean it; `shared/heard.cjs` (and `Heard.swift`) does string
  equality against that list. A client is never inferring what he meant.
* **Ambiguity is refused, never guessed.** A phrase two offered sentences claim
  matches neither and falls through to chat, where a wrong answer costs a
  sentence — acting on a coin toss costs a deferral he did not make.
* **Only what is on offer.** The list is bounded by what the record allows, so a
  verb NEURO would refuse is no more reachable by voice than by thumb.
* **An unmatched sentence is a QUESTION, never a failed command.**
* **What she heard is shown before it is acted on**, in the words of the
  sentence that ran rather than the raw dictation — that is the *report* half.
* ⚠ **"Do it" is deliberately absent, and it is a seam.** It should mean
  *perform the prepared action awaiting your word* — but the offered verbs are
  open / not-now / done / seen / dismiss and none of them is that action. The
  one genuinely prepared, held-back write on the payload is a **room offer**,
  which has no utterance at all. Making "do it" honest means giving room offers
  a sentence first.

## The honesty rules the layout must not break

These pre-date the look and outlive it. They live in
`shared-ui/AttentionSurface.jsx` and are not to be reimplemented in a renderer.

* **THREE SILENCES, kept apart.** *"I can't see your work"*, *"staying out of
  the way"* and *"nothing pressing"* are different facts and only the last is
  good news.
* **Nothing is hidden silently.** What the gate held back is counted and named.
* **A transition leads**, and it PROPOSES — it starts no timer, writes no
  calendar, completes nothing.
* **"Not now" asks how long** and records a REASON.
* **Dismiss is offered only where the record allows it.**
* **"That's done" says what it closed** — the card clearing and the task closing
  are two outcomes, and a held tick is neither finished nor failed.
* **Everything spoken is composed server-side** (`say`, `speech`, `tab`,
  `surface`, `utterances`). A renderer is the third renderer of one decision,
  never a third opinion.

---

## Deliberately not drawn

Not every feature earns pixels. The design-token export and the iOS parity
screens are about other surfaces; the route and payload audits are guards. A
thing that has no moment at which Nick would want it in front of him does not go
on this screen just because it was built.

---

## How this applies to the rest of SAiM

Approach is the ambient surface. Most of SAiM is not that — Tasks, Ask, Prep,
Capture, Review, Controls, the lock and clock screens, the widget, a
notification. The question for each is **which half of this document applies**,
and the answer is the same every time: **the rules export, the scene does not.**

### What exports, everywhere

* **One light source.** Every surface is lit by HER — one colour, taken from
  `fieldDrive` and inherited, never picked locally. When she goes amber the
  whole app goes with her. A screen with its own palette is a second opinion
  about what state she is in.
* **Hierarchy by light, not by decoration.** One thing is brightest; everything
  else is a fraction of it. Equal weight everywhere is the scatter of equal
  boxes, whatever the layout.
* **Say it once.** Whatever the composer has already said is not said again
  lower down. `covered` is the composer's call, never a renderer's.
* **Never invent.** No time, no number, no name that did not arrive on the
  payload. A missing value is absent or named, never a plausible default.
* **Named gaps, never counted.** "I couldn't read the diary" is information;
  "2 gaps" is a number he cannot act on. And it is never styled as an error —
  it is her being honest, not something failing.
* **A control only where a route exists**, and **unreachable renders dashed
  rather than missing**. A button NEURO would refuse is worse than no button.
* **One vocabulary, composed server-side and rendered verbatim.** Three
  renderers of one decision, never three opinions.

### What does NOT export

* **The corridor.** Depth is time, and a screen with no time in it has no
  corridor — that is why a finished day stands it down. A task list, a
  settings page or a chat has no hours, and imposing a receding perspective on
  one would be decoration wearing the costume of information. **Do not fit
  Tasks or Review into a corridor.**
* **The centrepiece, in most places.** It answers "so, now?", and only the
  ambient surface is asking that. A list is a list: its job is to be scanned,
  and a hero on it just makes one row arbitrarily loud. The exception is any
  screen that genuinely has ONE answer — the return prompt, a meeting about to
  start, a room offer.
* **The shelf.** It is what she can reach FROM HERE, which is a fact about the
  ambient surface and the device. A destination screen is already about one
  thing and does not need a shelf beside it.

### The rule that decides which

Ask what the screen is FOR. **She comes to him** on the ambient surface, so it
is composed, lit and answerable, and it holds one thing. **He goes to** the
destinations — he arrived wanting something specific — so they are quiet,
scannable and utilitarian, and they should NOT be dressed up as scenes. Making
Tasks look like the Surface would be the menu SAiM does not have, in costume.

### Where the rest of SAiM is currently short (13 Sep 2026)

Written down as findings, not as a plan:

* **The secondary screens are not lit by her at all.** The shell field is driven
  behind them, but their own cards and rows use flat borders and the system
  accent, so the app looks like two products. This is the one thing from
  tonight that should genuinely be pushed everywhere.
* **The widget** renders `say` and `speech` verbatim — correct — but takes no
  colour from `fieldDrive`, so a red day and a quiet Sunday look identical on
  the lock screen.
* **iOS still writes some of its own wording** in places the web composes; every
  one of those is a future drift. The silences were the worst and are fixed;
  the rest should be audited the same way.
