# iOS SARA — parity gaps against the web SARA (11 Sep 2026)

For the session working on `Wardy-uk/nuero-ios`. Found by a code-level audit of the
iOS repo at `c5d590d` against the web SARA (`sara/app` + `sara/shared-ui`, which
the phone PWA, the laptop's Electron window and the Pi kiosk all render) and the
NEURO backend. Every item was confirmed in Swift, not taken from HANDOFF or commit
messages. Nothing here was changed in the iOS repo — it is yours.

⚠ One correction first: iOS commit `2d1c9e9` says the colour ramp was "rolled to
the PWA and the Pi kiosk in the same change". The web half (`38491b3`) was written
that day but only reached `main` on 11 Sep, so the web was fading her for five
days. It is live now, plus the resting alphas raised to your 0.42 / 0.24 — the
"platform difference" note in `c225350` did not hold in a browser either
(screenshot-verified in the laptop's Electron window). The web drive and palette
now live in `sara/shared-ui/fieldDrive.mjs`, mirroring `FieldDrive.swift`, pinned
by `backend/services/field-drive.test.js`.

## Server features iOS does not render yet

| Gap | NEURO contract | Notes |
|---|---|---|
| `now` band + countdown | `/api/attention` → `now` on the surface/dashboard, per-row `countdown` | Composed server-side; never recompute. `minutesAway: null` means across a day boundary, not zero. See CLAUDE.md "What is on NOW, what is next, and saying each of them ONCE". |
| `covered` dedupe | `/api/attention` → `covered.cardIds`, `covered.transitionIsPrimary` | Advisory, filters nothing server-side; fold the headline only while the transition is actually on screen. |
| Meeting finished early / resume | `POST /api/attention/meeting/finished` `{key}`, `POST /api/attention/meeting/resume` | Arrives as a `meeting` utterance intent. A stale key is refused with the right one named. |
| "Show me everything" | `reveal` utterance | `SaraState.say` sets `showEverything`, which nothing reads — the escape hatch is a no-op. |
| Session pause | `POST /api/session/pause` / `/resume` | `NeuroAction.pauseSession` exists, no button. |
| Return / recovery prompt | `recovery` (resume / settle) on `/api/adhd` / `/api/session` | Decoded in NeuroKit but only rendered in the NEURO app. "Make it smaller" leads every return prompt. |
| Estimate close-out | `POST /api/session/finish` returns the close-out line | Show verbatim; zero is a measurement. Finish currently always sends `completeTask:false`. |
| Tasks: WIP | `PATCH /api/tasks/:id` status; `POST /api/todos/wip-ms` for Microsoft (team-visible) | |
| Tasks: "not today" | `POST /api/todos/lane/defer` `{reason}` / `lane/undefer` | Reason required; unrecognised is refused. |
| Tasks: edit beyond due | `PATCH /api/tasks/:id` (moscow, priority, estimate + `estimateExact`) | Draft, one PATCH on Save. |
| Similar-task warning | `/api/capture/todo` → `similar` | Report, never block or merge. |
| Weekly target: set | `GET/POST /api/weekly-target` | Unset is not zero; a suggestion is a proposal. |
| Muted prompts | `GET /api/attention/muted`, `DELETE /api/attention/muted/:kind` | NEW 11 Sep. Before this the only way back was asking SARA in the standup. |
| Health signals + ack | `GET /api/health/signals`, `POST/DELETE /api/health/signals/:id/ack` | Acked findings still returned; ack of something not in the current pass is refused. |
| Chat streaming | SSE `/api/chat` | iOS is sync-only (deliberate per your notes — worth revisiting for long answers). |
| Test notification truth | `POST /api/push/test` | Changed 11 Sep: now returns `{ok, outcome, reason, sentCount, failedCount, subscriptions}` instead of an unconditional ok. Relevant if the NEURO app calls it. |

## iOS-side bugs found in the audit

- `SaraState.say` → `session` intent swallows errors with `try?`.
- `pendingPlan` (notification routing) is stored and never consumed.
- `SaraState.complete(_:)`, `snoozeNudge`, `FreshnessBar`, `SaraScreen` are unused.
- The `nick-now` snapshot is cached in memory only, so an offline cold start has nothing to show (the PWA keeps it in IndexedDB).
- `NK PushRegistration` (`/api/push/apns/register`) is never called — expected without a paid account, but worth a visible "not available" rather than silence.
- `SaraWatchComplication/` has no Xcode target, so it is never built; the watch app cannot auto-pair because the phone never sends the PIN.
- PIN: no sign-out or change-PIN; a 401 clears it silently.
- Surface has a mic but no typed ask.

## iOS-only features the web does not have (for the other direction)

Background HealthKit sync; local notifications after a background wake with a
deliverability check; home/lock-screen widgets with a still field and a 6h stale
mark; Live Activity for the session; on-device outbox receipts for ticks; voice
picker with samples; away/leave flags on the Prep heading; "Couldn't read" on Today.
(The web gained a test-notification button, muted prompts, session start/pause,
return prompt, close-out, Tasks WIP/not-today/edit, weekly-target setting and
health signals on 11 Sep.)
