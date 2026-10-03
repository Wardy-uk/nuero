# WS1 Implementation Plan — State Engine v1

## Intent

Introduce a real State Engine v1 behind the existing governed runtime response so SARA can represent state, location, and confidence through one shared model before any dashboard expansion.

## Delivery Order

1. Confirm the current WS0 runtime seam in the governed workspace.
2. Define the State Engine v1 contract for state, location, and confidence.
3. Implement seeded or hardcoded providers that feed the contract honestly.
4. Assemble one shared model through the State Engine.
5. Expose the model through the existing backend runtime response.
6. Update the runtime frontend surface only as needed to reflect the new values.
7. Add contract validation/tests and report build readiness.
8. Route to independent evaluation before any WS2 work begins.

## Suggested Build Shape

### Slice A — Contract

- define the root model shape
- define required fields for state, location, and confidence
- make invalid models detectably invalid

### Slice B — Providers

- add seeded or hardcoded providers for each domain
- label each provider/output honestly as seeded or hardcoded

### Slice C — Engine assembly

- derive one shared model from the providers
- ensure backend health/runtime surfaces derive from the same model source

### Slice D — Surface compatibility

- update the existing frontend runtime surface only enough to show the WS1 contract
- avoid dashboard redesign or broader UI expansion

### Slice E — Verification

- add tests or validation for the contract
- confirm runtime endpoint behaviour and non-regression of the WS0 runtime loop

## Risks To Manage

- importing assumptions from the nuero runtime instead of the governed daypilot baseline
- expanding into WS2 dashboard behaviour
- surfacing seeded inputs as if they were live telemetry
- splitting state ownership across multiple modules or surfaces

## Exit Condition

WS1 exits build only when the State Engine v1 contract is materially present in this governed workspace and the Build Agent can declare it ready for independent behavioural evaluation.
