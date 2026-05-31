# Focus (planned view)

Placeholder for a future SARA view. **Not built in WS2-WP1.**

Registered in `frontend/src/state/views.js` as `focus` (status: `planned`).
Selecting it renders the shared `PlannedView` placeholder.

When this view is built, it will read the **same shared state** as Mission Control
(`useSaraState()`), add a `<screen>.jsx` here, and be wired into
`components/ViewRouter.jsx`. It must not introduce its own source of truth.

Intended focus: one thing, timeboxed — the current do-next.
