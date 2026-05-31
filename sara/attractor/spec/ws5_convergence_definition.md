# WS5 Convergence Definition — Context Inference v0

## Work Package

`WS5-WP1`

## Observable Success Criteria

WS5 is converged when behavioural evaluation confirms that:

1. inferred context/activity state is exposed through the runtime
2. recommended view is exposed as advisory output
3. confidence and reasons are exposed
4. missing or contradictory input is surfaced honestly
5. existing screens remain functional and are not auto-switched

## Failure Conditions

- no real inference output is exposed
- recommended view silently drives UI switching
- confidence/reasons are absent or misleading
- existing screens break
- the slice drifts into voice or distributed-node work

## Manager Decision Rule

- Pass: WS5 converged
- Iterate: WS5 remains active with a bounded remediation slice
- Blocked: inference output is materially absent or dishonest
