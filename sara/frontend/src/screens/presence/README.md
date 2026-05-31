# Presence (available view)

Built in **WS2A-WP1**. The calm ambient SARA view.

Registered in `frontend/src/state/views.js` as `presence` (status: `available`) and
wired into `components/ViewRouter.jsx`. Implemented in `PresenceMode.jsx` (+ `.css`).

It reads the **same shared state** as Mission Control via `useSaraState()` and owns no
data of its own: a large clock from the shared clock, location and status from the
model, the briefing line the engine derives, and the next item from the shared
placeholder presentation layer. It shows *less* of the same model — never a different
model — and does not depend on Home Assistant / WS3 telemetry.

Focus: a calm ambient view for when SARA is just present.
