# Executive Dashboard (available view)

Built in **WS2A-WP1**. The operational SARA view.

Registered in `frontend/src/state/views.js` as `executive-dashboard` (status:
`available`) and wired into `components/ViewRouter.jsx`. Implemented in
`ExecutiveDashboard.jsx` (+ `.css`).

It reads the **same shared state** as Mission Control via `useSaraState()` and owns no
data of its own: KPI tiles, the queue broken down by section, and the people roster all
come from the WS1 State Engine domains (`model.domains.*`); What Matters Now comes from
the shared placeholder presentation layer; the clock from the shared clock. It does not
depend on Home Assistant / WS3 telemetry.

Focus: queue, people and SLA metrics at depth.
