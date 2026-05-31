# SARA Programme Charter

## Purpose

Create SARA as a persistent, context-aware personal operating layer with one shared understanding of Nick's world across embodiments.

## Protected Architectural Decisions

### Principle 1 — One SARA

There is one SARA brain and one shared state model.

### Principle 2 — Context Before Conversation

Context comes before conversational behaviour.

### Principle 3 — State Engine First

The State Engine is the protected centre of the platform.

### Principle 4 — Central Brain

The long-term architecture is one brain with multiple embodiments.

### Principle 5 — Home Assistant Is The Telemetry Bus

Home Assistant is the telemetry collection layer, not the decision engine.

### Principle 6 — Nodes Are Interfaces

Nodes are embodiments and interfaces, not independent brains.

### Principle 7 — One State, Many Views

SARA’s UI must be view-based and interchangeable.

Screens are representations of state.

Screens must not own data.

All screens must read from the same shared state/context model.

A screen may format, prioritise, or hide data, but it must not become a separate source of truth.

SARA must support:

- automatic recommended view from State Engine
- manual user-selected view
- future swipe/touch navigation between views
- future screen plugin architecture

The final UI is expected to evolve through usage and evaluation.

Do not hardcode the project around a single home screen.

## Governance Rules

- Work only through bounded workstreams and phase-sized build briefs.
- Keep implementation and evaluation context separated.
- Require behavioural evaluation for convergence.
- Prevent WS2 from collapsing architecture into a single hardcoded screen.
- Preserve the shared-state contract as the only source of truth for all views.

## Current Scope Boundary

Only WS0, WS1, and WS2 are in current programme scope.

- WS0 and WS1 are converged.
- WS2 is active.
- WS3 through WS6 remain not started.
