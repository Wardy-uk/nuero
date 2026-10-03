# WS1 Convergence Definition — State Engine v1

## Work Package

`WS1-WP1`

## Observable Success Criteria

WS1 is converged when behavioural evaluation confirms that:

1. the governed runtime exposes a real State Engine v1 model instead of the WS0 stub-only response
2. the model consistently includes current state, current location, and confidence
3. the frontend runtime surface can consume and show those values
4. seeded or hardcoded inputs are labelled honestly
5. model invalidity or generation failure is surfaced honestly enough for an operator to detect

## Failure Conditions

- the WS0 stub remains effectively unchanged
- state, location, or confidence are missing or inconsistently shaped
- frontend/runtime consumption breaks against the new contract
- the build silently presents seeded data as if it were live telemetry
- build work drifts into WS2 dashboard scope or other later workstreams

## Allowed Residuals

- seeded or hardcoded sources are allowed in WS1
- visual polish is not required
- Home Assistant and inference logic are not required

## Manager Decision Rule

- Pass: WS1 converged and WS2 planning may proceed on the validated contract
- Iterate: WS1 remains active with a bounded remediation brief
- Blocked: the governed runtime seam or contract has not actually been replaced
