# Programme Tracker — SARA

## Programme Status

- Start date: 2026-05-30
- Current stage: WS2 planning activated; Mission Control v0 ready for bounded build handoff
- Current in-scope workstreams: WS0, WS1, WS2
- Current active workstream: WS2 — Dashboard
- Current phase recommendation: build Mission Control v0 as the first interchangeable view on top of the converged WS1 state contract

---

## Vision Guardrails

- SARA is a persistent operating layer, not a chatbot-first product.
- There is one shared SARA brain and shared state across embodiments.
- Context and state understanding come before conversational behaviour.
- The State Engine is the protected architectural centre.
- Home Assistant is the telemetry bus, not the decision engine.
- Pi nodes are embodiments and interfaces, not autonomous brains.
- SARA UI must remain view-based: one state, many views.

---

## Core Artefacts

- Charter: `../spec/programme_charter.md`
- Workstreams: `../spec/workstream_definitions.md`
- WS2 behavioural spec: `../spec/ws2_mission_control_behavioural_spec.md`
- WS2 build brief: `../spec/ws2_build_brief.md`
- WS2 convergence definition: `../spec/ws2_convergence_definition.md`
- WS2 implementation plan: `../plan/ws2_mission_control_implementation_plan.md`
- Workstream tracker: `workstream_tracker.md`
- Build handoff log: `../manager_log/ws2_build_handoff_2026-05-31.md`
- Eval handoff log: `../manager_log/ws2_eval_handoff_2026-05-31.md`

---

## Workstream Status

| Workstream | Status | Notes |
|-----------|--------|-------|
| WS0 Infrastructure & Runtime | Converged | Runtime and launcher path established in the governed `nuero` workspace |
| WS1 State Engine | Converged | State Engine v1 and the location/confidence iteration are behaviourally accepted |
| WS2 Dashboard | Ready for build | Mission Control v0 is the first interchangeable screen; must read only from shared state |
| WS3 Home Assistant Integration | Not started | Explicitly out of scope for current slice |
| WS4 Voice Interface | Not started | Explicitly out of scope |
| WS5 Context Inference | Not started | Explicitly out of scope |
| WS6 Distributed Nodes | Not started | Explicitly out of scope |

---

## Current Programme Judgments

- `nuero` is the authoritative SARA workspace.
- WS2 must build on the converged WS1 contract rather than inventing a separate UI data model.
- Mission Control is the first view, not the final home screen.
- Manual current-view selection must exist in architecture now, even if only one view renders initially.
- Behavioural evaluation remains mandatory before WS2 can converge.

---

## Next Manager Actions

1. Route the formal WS2 Mission Control brief against the governed `nuero` baseline.
2. Require Build to create the view system and launcher without allowing any screen to own authoritative state.
3. Route WS2 to independent evaluation only after a governed build-status report is present.
4. Keep WS3+ out of scope.
