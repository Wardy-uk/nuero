# Phone quiet during a focus block — the iOS Shortcut

NEURO already holds its OWN pushes while a focus block runs (focus-hold). This
is for everything else on the phone: Teams, WhatsApp, mail. NEURO cannot turn on
an iOS Focus itself, so a Shortcut on the phone asks NEURO and turns one on.

## Why a Shortcut, and not the NEURO app

iOS has **no public API for an app to turn a Focus on or off**. What exists:

- `INFocusStatusCenter` — an app may *read* whether a Focus is on (with
  permission). Read only.
- `SetFocusFilterIntent` (Focus filters) — an app can *react* when Nick's Focus
  changes. Still not a way to start one.
- The Shortcuts action **Set Focus** — the only supported way to turn one on, and
  only Shortcuts (or Nick) can run it.

So the NEURO and SAiM iOS apps cannot do this natively (checked against
`nuero-ios`: no App Intents or Focus code exists, and none could set a Focus).
The Shortcut below is the supported route.

## What NEURO answers

`GET /api/focus-blocks/focus-state` → 

```json
{ "ok": true, "inFocus": true, "until": "2026-11-02T11:15:00.000Z", "task": "Write the rota cover plan", "blockId": 412 }
```

`inFocus` is true only from the moment Nick **picks a task** in a focus block
until the block ends (or he stops after two minutes, or says Done). It is never
inferred from the diary. When not in focus: `inFocus: false`, the rest null.
It is a read: the API token works.

## Build the Shortcut (once)

Name it **NEURO focus**.

1. **Get Contents of URL**
   - URL: `https://pi5.tailecb90f.ts.net/api/focus-blocks/focus-state`
   - Method: GET
   - Headers: `X-NEURO-API-TOKEN` = *(the token from `backend/.env` on the Pi —
     never paste it into a note or a repo)*
2. **Get Dictionary Value** — Key `inFocus` from *Contents of URL*.
3. **If** *Dictionary Value* **is** `1` (Shortcuts shows true as 1):
   1. **Get Dictionary Value** — Key `until` from *Contents of URL*.
   2. **Get Dates from Input** — *Dictionary Value* (the ISO time becomes a date).
   3. **Set Focus** — *Do Not Disturb* (or a "Focus block" Focus you create in
      Settings → Focus, with Teams/people allowed as you like) → **On** →
      **Until: Time** → *Dates*.
4. **Otherwise** — nothing. (Do not turn the Focus off here: if Nick turned one
   on himself, this must not undo it. A Focus started by step 3 ends on its own
   at `until`.)
5. **End If**

Because the Focus is set *until the block's end*, it switches itself off when the
block ends — nothing has to run at the end. If the block is extended (More time),
the next run moves `until` on.

## Make it run

iOS cannot run a Shortcut "every few minutes", so pick one (or both):

**A. Time-of-day automations (no taps).** Shortcuts → Automation → **+** →
**Time of Day** → e.g. 09:02 → Daily (or weekdays) → **Run Immediately** (turn
"Notify When Run" off) → action *Run Shortcut: NEURO focus*. Repeat for each
start time blocks usually land on (e.g. :02 and :32 past each working hour,
09:02–17:32). A block picked at 10:31 is caught at 10:32. Clumsy to set up, but
then hands-free.

**B. From the moment you pick a task (recommended next build).** The SAiM web
app can open `shortcuts://run-shortcut?name=NEURO%20focus` straight after a
successful **Start** on the phone — a web page may open that link from a tap,
and the lock-screen widget already uses the same idea (`OPEN_SHORTCUT`). That
makes the Focus come on the instant Nick starts. It is a small change in
`saim/shared-ui/FocusBlock.jsx`'s phone shell and is NOT built yet.

## What this does not do

- It never turns a Focus **off**.
- It never runs on its own schedule beyond the automations you create.
- It holds nothing: whatever iOS's Focus allows through still comes through.
