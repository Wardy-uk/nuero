# Programme Tracker — SARA

## Programme Status

- Start date: 2026-05-30
- Current stage: WS0-WS3 converged; WS5 planning activated as the next bounded state-layer track
- Current in-scope workstreams: WS0, WS1, WS2, WS3, WS5
- Current active track: WS5 — Context Inference
- Current phase recommendation: infer a first bounded "what Nick is doing now" model from the converged state and telemetry seam before activating voice or distributed-node work

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
- WS2A behavioural spec: `../spec/ws2a_additional_views_behavioural_spec.md`
- WS2A build brief: `../spec/ws2a_build_brief.md`
- WS2A convergence definition: `../spec/ws2a_convergence_definition.md`
- WS2A implementation plan: `../plan/ws2a_additional_views_implementation_plan.md`
- WS3 behavioural spec: `../spec/ws3_home_assistant_behavioural_spec.md`
- WS3 build brief: `../spec/ws3_build_brief.md`
- WS3 convergence definition: `../spec/ws3_convergence_definition.md`
- WS3 implementation plan: `../plan/ws3_home_assistant_implementation_plan.md`
- WS5 behavioural spec: `../spec/ws5_context_inference_behavioural_spec.md`
- WS5 build brief: `../spec/ws5_build_brief.md`
- WS5 convergence definition: `../spec/ws5_convergence_definition.md`
- WS5 implementation plan: `../plan/ws5_context_inference_implementation_plan.md`
- Workstream tracker: `workstream_tracker.md`
- WS5 build handoff: `../manager_log/ws5_build_handoff_2026-05-31.md`
- WS5 eval handoff: `../manager_log/ws5_eval_handoff_2026-05-31.md`

---

## Workstream Status

| Workstream | Status | Notes |
|-----------|--------|-------|
| WS0 Infrastructure & Runtime | Converged | Runtime and launcher path established in the governed `nuero` workspace |
| WS1 State Engine | Converged | State Engine v1 and the location/confidence iteration are behaviourally accepted |
| WS2 Dashboard | Converged | Mission Control and the many-views foundation are behaviourally accepted |
| WS2A Additional Views | Converged | Executive Dashboard and Presence Mode are behaviourally accepted |
| WS3 Home Assistant Integration | Converged | Telemetry ingestion is behaviourally accepted against live, absent, and failing states |
| WS4 Voice Interface | Not started | Explicitly out of scope |
| WS5 Context Inference | Ready for build | First bounded inference slice may derive current activity and recommended view from converged state + telemetry |
| WS6 Distributed Nodes | Not started | Explicitly out of scope |

---

## Current Programme Judgments

- `nuero` is the authoritative SARA workspace.
- WS2 must build on the converged WS1 contract rather than inventing a separate UI data model.
- Mission Control is the first view, not the final home screen.
- Later screens must continue to read from shared state and must not be bundled together with telemetry ingestion.
- WS3 must enrich the State Engine contract and providers without silently absorbing UI design work.
- WS5 should enrich the State Engine with inference output, but it must not auto-switch views or masquerade as voice or node orchestration.
- Behavioural evaluation remains mandatory before any active slice can converge.

---

## Next Manager Actions

1. Route the formal WS5 brief for bounded context inference against the converged state and telemetry seam.
2. Keep WS5 inference separate from WS4 voice behaviour and WS6 distributed-node work.
3. Route WS5 to independent evaluation only after a governed build-status report is present.
4. Do not activate WS4 or WS6 inside this slice.
