# WS2 Implementation Plan — Mission Control v0

## Intent

Deliver the first usable SARA screen while establishing a reusable screen/view architecture that stays subordinate to one shared state model.

## Delivery Order

1. Confirm the converged WS1 shared-state baseline and where Mission Control will read from it.
2. Define the current-view model and future view identifiers.
3. Create shared UI placeholder state for Mission Control-specific fields.
4. Implement the Mission Control v0 screen using shared state only.
5. Add future-view placeholders without building those screens.
6. Create the Pi desktop launcher path and installation instructions.
7. Verify launcher path, Mission Control rendering, and shared-state discipline.
8. Route to independent evaluation.

## Suggested Build Shape

### Slice A — View architecture

- define the `SaraView` type
- define `currentView`
- establish the screens directory structure

### Slice B — Shared UI state

- create a shared state module or context for Mission Control placeholder content
- keep screen formatting separate from data ownership

### Slice C — Mission Control screen

- implement the first screen only
- optimise for calm, light, desk-distance readability on a 7-inch display

### Slice D — Launcher path

- create `scripts/start-sara.sh`
- create `desktop/SARA.desktop`
- document installation to the Pi desktop

## Risks To Manage

- allowing Mission Control to become a de facto permanent home screen architecture
- screen-level state ownership
- over-expanding into the other views
- drifting into WS3 Home Assistant work

## Exit Condition

WS2 exits build only when Mission Control, the view system, and the launcher path are materially present in the governed workspace and ready for independent behavioural evaluation.
