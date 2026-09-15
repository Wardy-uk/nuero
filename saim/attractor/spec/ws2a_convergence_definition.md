# WS2A Convergence Definition — Additional Views v0

## Work Package

`WS2A-WP1`

## Observable Success Criteria

WS2A is converged when behavioural evaluation confirms that:

1. Executive Dashboard renders successfully
2. Presence Mode renders successfully
3. both views are selectable through the current-view system
4. both views read from shared state rather than owning authoritative state
5. Mission Control still works

## Failure Conditions

- either new screen does not render
- view switching breaks
- state is duplicated into screens
- the build quietly depends on WS3 telemetry

## Manager Decision Rule

- Pass: WS2A converged
- Iterate: WS2A remains active with a bounded remediation slice
- Blocked: the many-views architecture is materially broken
