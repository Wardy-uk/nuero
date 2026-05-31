# WS5 Behavioural Specification — Context Inference v0

## Objective

Add the first bounded context-inference layer so SARA can answer "what does it think Nick is doing right now?" and "which view would it recommend?" using the converged state and telemetry seam.

## Required User-Visible Behaviour

1. The runtime exposes an inferred current context or activity state.
2. The runtime exposes a recommended view derived from that inferred context.
3. The runtime exposes confidence and reasons for the inference.
4. If inference inputs are missing or contradictory, SARA surfaces that honestly rather than pretending certainty.
5. Existing screens remain functional, and no automatic view switching occurs in this slice.

## Required Architectural Outcome

- Inference extends the shared state model; it does not create a parallel state owner.
- Telemetry remains input, not decision engine.
- The State Engine remains the sole producer of the shared model.
- Recommended view is advisory only in this slice.

## Initial Inference Scope

- derive a bounded current activity/context state from existing state domains and telemetry
- derive one recommended view from that same inference output
- expose supporting reasons/evidence

## Constraints

- No voice behaviour.
- No automatic screen switching.
- No distributed-node orchestration.
- No broad autonomous action execution.

## Evidence Expectations

The Build Agent should be able to point to:

- where inference inputs come from
- where inference output lives in the shared model
- how uncertainty or missing input is surfaced
- how recommended view remains advisory
