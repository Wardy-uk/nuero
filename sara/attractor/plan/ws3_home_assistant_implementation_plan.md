# WS3 Implementation Plan — Home Assistant Telemetry Bridge v0

## Intent

Prove that Home Assistant can feed the SARA shared model without taking over decision-making or view ownership.

## Delivery Order

1. Confirm the current provider/state-engine seam from converged WS1.
2. Define the bounded HA signals to ingest.
3. Add configuration and connection path.
4. Extend providers/state-engine to consume the telemetry.
5. Verify honest fallback behaviour when HA is absent.
6. Route to independent evaluation.

## Risks To Manage

- coupling HA directly into views
- unstable runtime when HA is unavailable
- over-expanding from telemetry ingestion into inference logic
