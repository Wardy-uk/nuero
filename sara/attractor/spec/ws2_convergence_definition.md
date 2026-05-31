# WS2 Convergence Definition — Mission Control v0

## Work Package

`WS2-WP1`

## Observable Success Criteria

WS2 is converged when behavioural evaluation confirms that:

1. a Pi desktop launcher exists or documented installable launcher instructions exist
2. Mission Control v0 launches and renders successfully
3. placeholder/shared state data appears in the screen
4. quick action buttons render
5. the app architecture supports future screens through a current-view system
6. no screen owns authoritative state

## Failure Conditions

- launcher path is absent or unusable
- Mission Control does not render
- required Mission Control content is missing
- state is hardcoded inside the screen instead of sourced from shared state
- the architecture is locked to one final home screen

## Allowed Residuals

- placeholder/static values are allowed
- only Mission Control needs to render now
- future views may be placeholder folders or READMEs only

## Manager Decision Rule

- Pass: WS2 converged
- Iterate: WS2 remains active with a bounded remediation brief
- Blocked: launcher or view/state architecture is materially absent
