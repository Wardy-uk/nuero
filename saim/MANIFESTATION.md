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
