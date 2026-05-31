# WS2A Implementation Plan — Additional Views v0

## Intent

Prove that the many-views architecture can carry more than one real screen without introducing a second source of truth.

## Delivery Order

1. Confirm the current shared-state and current-view baseline from converged WS2.
2. Add any shared placeholder presentation needed for Executive Dashboard and Presence Mode.
3. Implement Executive Dashboard v0.
4. Implement Presence Mode v0.
5. Verify runtime switching across all three real screens.
6. Route to independent evaluation.

## Risks To Manage

- smuggling telemetry assumptions into a view-only slice
- duplicating data in screens
- breaking Mission Control while adding more views
