# WS3 Convergence Definition — Home Assistant Telemetry Bridge v0

## Work Package

`WS3-WP1`

## Observable Success Criteria

WS3 is converged when behavioural evaluation confirms that:

1. Home Assistant telemetry is ingested through the runtime
2. the shared state model reflects that telemetry
3. telemetry absence or failure is surfaced honestly
4. existing screens remain functional

## Failure Conditions

- HA telemetry is not actually ingested
- state engine and views disagree about live vs unavailable telemetry
- screens break when HA is unavailable
- the slice expands into screen redesign or later workstreams

## Manager Decision Rule

- Pass: WS3 converged
- Iterate: WS3 remains active with a bounded remediation slice
- Blocked: telemetry bridge is materially absent or destabilising
