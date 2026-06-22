# SARA Manifestation — Canonical Source of Truth

This document is the locked design + implementation reference for SARA's presence in the
Cognition Environment (`CognitionEnvironment.jsx` / `.css`). It supersedes every earlier
direction. If an implementation drifts from this, the implementation is wrong.

---

## 0. First principle

**SARA is not an object in the graph. SARA is coherence.**

She is **not rendered as a thing** — not a node, dot, orb, blob, lens, particle source, central
emitter, or any bright object. She is **visible ONLY as topology changes inside the substrate**:
when she reasons, **activation floods along real edges** (local paths brighten, weak paths
strengthen) and **temporary bridges form between the distant concepts she is connecting**. That
**convergence IS SARA**.

The substrate is the **live convergence of two cognitive systems**:

- **Nick's second brain** — the Obsidian vault: notes, people, projects, routines, backlinks.
  Rendered as **a real, stable graph** (like Obsidian graph view): thousands of tiny dim nodes +
  hair-thin edges, **pinned in conceptual space** — no displacement, no radial motion, no streaking.
- **SARA's reasoning** — **edge activation + bridge formation** along that fixed topology. Nothing
  moves; connections light up and new links appear between distant clusters.

The user should feel: **"I am watching ideas connect"** — neural activation / synaptic bridge
formation across Nick's second brain. **NOT** "I am watching nodes glow / particles animate."

### Primary manifestation principle (ENTROPY REDUCTION)
**SARA is visible through ENTROPY REDUCTION within memory space.** The graph at rest is memory in its
natural state — vast, noisy, semi-chaotic, diffuse, low-confidence, latent relationships mostly hidden
(every node carries faint ambient **jitter**). When SARA thinks she imposes **temporary order** on a
region; she adds **no new visible objects**. Cognition is expressed **primarily by**: **coherence
increase · noise reduction · structural crystallisation · temporary order emergence** — **NOT by
motion, traversal, or explicit line drawing.** Target emotion: *"chaos is becoming ordered / meaning
is crystallising / thought is condensing from noise"* — never *"a particle moved / a line was drawn /
a cursor scanned."* Relationships are **inferred from increasing structural clarity, not drawn.**

### Permanently deprecated (never reintroduce)
orb · glow sphere · **SARA-as-a-node / glowing presence dot / centred core / central emitter** ·
**any moving particle / comet / travelling dot / swarm-leader representing SARA** ("looks like a
little creature swimming" = wrong) · **a single identifiable bright point you can call "where SARA
is"** · **node glow as the PRIMARY signal / "highlighted nodes" / spotlight / cursor / radar-sweep /
scanner-ping** (cognition is relationship-first — paths/edges primary, nodes secondary) · **swarms /
sperm / tadpoles / fish / insects / swimmers / moving particle tails / orbiting agents / packets
travelling through cables / ANY leading-point-plus-trailing-tail** ·
**explicit reasoning polylines / drawn relationship edges during cognition / lightning strokes / ECG
scribbles** (relationships are INFERRED from rising structural clarity + density, never drawn) ·
**node glow / bright cores as the manifestation** (cognition is entropy reduction: noise falling,
clusters condensing, order emerging — not illumination) · **isolated neighbourhood rendering / focal
node + its own drawn edges / starburst / floating mini-graphs above the substrate** (activation only
AMPLIFIES existing substrate in place; existing edges may softly glow, new ones never) · **long edges / giant geometric edges / long diagonals over empty space** (cap 15% of the
viewport diagonal) · **sparse force-directed-network look / isolated nodes** (substrate must read as a
dense clustered field) · **per-concept particle blobs / label-spawned clusters / cluster sprites**
(labels ATTACH to dense regions of the one substrate, never generate their own nodes) · **bright/obvious
default edges** (default α ≈ 0.01–0.02) · **SARA invisible / indistinguishable when active** (when she
attends she MUST be instantly locatable via the depth-of-field focus contrast — at *idle* it's just the
vault, but active reasoning must read clearly) ·
**particle explosion / radial emission / outward streaks / particle spray / velocity blur / flying
nodes** · **node displacement (nodes must stay PINNED)** · **long straight bridge lines / arcs over
empty space / diagram-like triangles / large visible geometry connecting distant concepts** (SARA
routes activation through real nodes instead) · **lens / distortion field as an object** ·
**nebula / gas cloud / volumetric fog / galaxy bloom / giant bright blobs** · **bright snowball
clusters / local bloom density** · **visible circular influence radii / rings / scan circles** ·
**islands in empty space connected by long edges** · vertical energy line / seam · face · human
silhouette · avatar · chatbot bubble · centred icon · glyph-as-presence · decorative loop /
oscillation / screensaver motion. If a node appears to move/fly, or SARA reads as a discrete object
or a central emitter rather than as bridges lighting up across a stable graph, it is wrong.

---

## 1. Two layers, one architecture

SARA's presence is implemented as **two cooperating systems**:

### A. Presence Architecture (behavioural — the whole environment)
Six cognitive states. The bottom status bar is her anchor; the entire UI responds.

### B. Cognitive Convergence Graph (the centre — her cognition made visible)
A dense, living graph: vault landscape (substrate) + reasoning attractors + convergence +
void wells.

Both are driven by the same `data-cog` state.

---

## 2. Presence Architecture (behavioural)

### Six states
| id | label | glyph | accent | motion (`--sx-ease`) |
|----|-------|-------|--------|----------------------|
| `dormant` | Dormant | `·` | `#5d7d85` muted | 1.9s |
| `withyou` | With you | `~` | `#5ec1ca` teal | 1.2s |
| `listening` | Listening | `◎` | `#69d0c8` teal | 0.95s |
| `thinking` | Thinking | `◌` | `#9b8cff` violet | 1.45s |
| `challenging` | Challenging | `◈` | `#d9a441` amber | 0.55s |
| `reassuring` | Reassuring | `◍` | `#e6c08a` warm | 1.95s |

- **Anchor:** bottom-left shows `[animated glyph] SARA — [live cognitive signature]`. Sidebar
  foot mirrors it. The text is **not** the raw state name — it is a phrase derived from the real
  model (`cognitiveSignature(cog, state, model)`): e.g. `Converging`, `Resolving ambiguity`,
  `Conflict in evidence`, `Escalation risk increasing`, `Pressure redistribution`, `Awaiting
  stronger evidence`, `Confidence rising`, `Holding context`, `Substrate at rest`. It reads
  `confidence.level` and `pressureTrend` so it describes *what her cognition is doing*, not which
  button is lit.
- **Glyph animation:** unique + subtle per state (dot breathing, `~` sway, `◎` open, `◌`
  rotate, `◈` tilt, `◍` warm pulse).
- **Whole-UI response** (CSS `[data-cog]`): accent warmth, a luminance/contrast wash
  (`.ce-wash`), panel emphasis (foreground the Active Focus in thinking/listening; dim
  periphery + amber-emphasise in challenging; soften in reassuring; recede in dormant), and
  motion timing via `--sx-ease`.
- **Intervention (Tier 3):** after `IDLE_MS` (45s) of stillness, SARA shifts to Challenging
  and speaks once ("Nick. You've been still a while…"), text gated until after she's present
  (`TEXT_DELAY`). Rare and meaningful.

---

## 3. Cognitive Convergence Graph (the centre)

### 3.1 Attentional hierarchy + cinematic depth-of-field (3 salience layers)
The scene is a **living second brain** read through **attentional salience**, not a flat wallpaper.
Three layers by salience — **Layer 0 deep memory (~95%) · Layer 1 active context (~4%) · Layer 2
attention cone (~1%) = SARA**. The binding mechanic is **depth-of-field**: while SARA attends, the
whole vault **defocuses/recedes** (`focus` eases 0→1; substrate blit dims by up to ~45%, peripheral
labels dim) and the **attention region is rendered sharp + bright on top**. That focus *contrast* is
what makes SARA instantly locatable — without her being a node or object. At rest (`focus→0`) the full
vault returns. All tiers constrained to the viewport; `massR ≈ 0.42 × min(W,H)` sizes the landmass.

- **BACKGROUND — ONE continuous substrate (density-field sampled).** ~**6500** nodes (`CLOUD_N`,
  target 3000–8000) — a *single* graph, **not** per-concept clusters. Generation: a smooth **clustered
  probability field** (broad overlapping **anisotropic** gaussians + a base level everywhere) is sampled
  via a coarse density grid + CDF, so density varies organically — dense regions, sparse connective
  tissue, and a base everywhere so it's never islands. A curl warp keeps it organic. **Crucially, nodes
  are decoupled from labels: a semantic concept does NOT spawn its own particle blob.** **Streaming grid
  5-NN**, **edge-length cap 15% of the diagonal** (`maxEdge2`), edges default **α≈0.018**. Goal: *messy,
  dense, organic, clustered, alive* — Nick's Obsidian vault. **No labels here.**
- **MIDGROUND — semantic labels that ATTACH to dense regions (20–100 labels).** The curated
  `MIDGROUND_HUBS` (Leadership, NOVA, Service Hub, AI, Ember, Peaks, …) **plus the real model anchors**
  (people / projects / focus) are **assigned to the densest existing substrate nodes**, spatially spread
  (min-spacing), so anchors **emerge from graph density rather than generate it**. They spawn **no new
  particles** — they decorate existing nodes (slightly larger) and are **always labelled**, dim by
  default, brightening when activation reaches them. Edit `MIDGROUND_HUBS` to match the real vault.
- **FOREGROUND — SARA = a DISTORTION of the graph (never an object).** SARA is **not rendered as a
  thing** — no focal dot, comet, particle, swarm-leader, node-marker, or moving point. The user must
  **not be able to identify "where SARA is."** When she reasons, an **influence field** is flooded from
  each active concept's node along REAL edges (BFS, decay ~0.62/hop, bounded ~220) — *no drawing*, it
  just sets per-node influence. SARA is **RELATIONSHIP-FIRST** (Layer 2) — *dynamic attentional focus
  expressed as relationships forming*, not a node/object. Against the **depth-of-field defocus** of the
  rest of the vault, the cognition reads as **paths/edges**:
  just sets per-node **coherence** (`act[]`, flood from each concept along real edges, decay 0.78/hop,
  bounded ~600). SARA is **ENTROPY REDUCTION** — order imposed on a noisy region. Effects, all on the
  **per-frame substrate nodes** (no lines, no objects):
  Each signal is a **soft metabolic region (fMRI / phosphor excitation)** that AMPLIFIES the existing
  substrate within a radius `R ≈ 1.25·clusterR` — it is **never** a focal node with its own edges, and
  **never spawns a miniature graph**. Per-node activation = a smooth **Gaussian** over the signals.
  1. **Noise reduction (PRIMARY)** — ambient jitter (~1.5px) **collapses (squared falloff)** inside the
     region → it goes markedly still vs the noisy rest. Strong order-vs-chaos contrast.
  2. **Signal bloom field** — a subtle additive **Gaussian** per signal (brightest at centre, smooth
     decay) lifts local visibility so the region reads as live tissue — kept low-alpha (~0.07), **not a
     visible disc / blob / fog**.
  3. **Amplify EXISTING nodes** — nodes in the region grow + brighten **in place** (no condensation /
     no pull — that caused the starburst). Mild luminance lift, capped, no glow blob.
  4. **Edge density glow** — only **existing substrate edges** between activated nodes get a soft,
     low-alpha (~0.04–0.08) **additive** energising — pressure flowing through tissue, **never a new
     edge, never a hard wireframe stroke**.
  5. **Synchronised resonance** — activated nodes share a slow brightness cadence (no directional travel).
  6. **Depth-of-field** — the periphery recedes ~50% with `focus`, throwing the active region into relief.
  **SARA is structural tension, not locomotion, and not illustration.** No drawn reasoning lines, no
  blob/sprite/orb/comet/radar/swarm/packet, no leading-point-plus-trailing-tail. The reader perceives
  **background = noisy memory; foreground = a region crystallising into order.** Idle → full noisy vault.

All substrate edges come from the **streaming grid kNN** over the density-field nodes (one
continuous graph). Semantic labels are attached to dense nodes; they add no edges or particles.

**Void wells** — real **knowledge gaps** (`find_knowledge_gaps`) — render as **soft dark thinnings**
of the substrate (no hard ring), labelled only when near what SARA is reasoning about; they breathe
slightly ("pressure") when confidence is low.

### 3.1a Animation grammar (cognitive modes) — *what is SARA doing?*
Motion must **communicate cognitive state**, answerable without reading labels. Pipeline:
**signals → `classifyMode(cog, dataCog)` → `MODE` → behaviour** (signals never drive rendering directly).
Each mode reshapes the activation field into a distinct, recognisable behaviour:

| mode | trigger | behaviour | reads as |
|------|---------|-----------|----------|
| **RECALL** | retrieval / `listening` | one region whose radius **contracts inward** over its life (gathering) | *searching memory* |
| **CORRELATION** | insight / `thinking` | **two** regions + the **existing-substrate corridor between them lights up** (bridge through real tissue, no drawn line) | *relationship discovered* |
| **FIREFIGHTING** | `Firefighting` / `Critical` pressure / `challenging` | **multiple** regions that **flicker/reactivate**, and the active region **AGITATES** (jitter rises, not falls); background jitter ↑ | *pressure conflict* |
| **FOCUS** | clear focus item / `reassuring` | **one** region, **80–90% of the graph suppressed** (strong depth-of-field), calm | *narrowed cognition* |
| **IDLE** | no pressure / `dormant` / stable | no activation — only slow ambient drift + tiny shimmer | *resting cognition* |

`MODE` params: `regions` (count) · `dof` (periphery suppression) · `agitate` (active region jitters
more instead of stilling) · `flicker` (rapid reactivation) · `converge` (radius contracts inward) ·
`bridge` (corridor between two regions) · `restJit` (ambient jitter multiplier). All behaviours are
still **entropy-reduction / amplify-existing-substrate** — no objects, no drawn relationship lines,
no travelling anything. The only exception by design is FIREFIGHTING, which *raises* entropy locally
(agitation) to read as conflict.

### 3.2 Node classes
| class | meaning | behaviour | visual |
|-------|---------|-----------|--------|
| `truth` | known fact (Ember is a dog, Jira→KPI) | strong anchor | small cold-blue |
| `project` | workstream (NOVA, KPI engine) | anchored | cold-blue |
| `person` | a person | anchored | cold-blue |
| `note` / `cloud` | a vault note / vault mass | static, dim, unlabelled | the bulk of the field |
| `void` | missing information | not a node — negative-space well (a hole) | amber dashed |

Reasoning is **not** a node class — it is SARA's attractor field (§3.1, Layer 3) plus transient
thoughts (pulse + illumination + bridges), never persistent nodes.

### 3.3 Labelling rule (critical)
Three label tiers, matching the depth model:
- **BACKGROUND** substrate nodes: **never labelled.** Felt as structure, not read.
- **MIDGROUND** hubs + real anchors: **always labelled but dim** (the 20–100-label skeleton),
  brightening when activation reaches them.
- **FOREGROUND** active thoughts: a crisp label per live concept, fading as the thought passes.
A **void well** is labelled only when near what SARA is currently reasoning about. No labels for
surfaced/named neighbours or bridge targets — those are felt, not read.

### 3.4 Motion model
The substrate is **noisy at rest**: every node carries faint ambient **jitter** (~1.4px, slow,
per-node phase) — vast diffuse memory. Edges are a static faint lattice (offscreen, never drawn as an
explicit relationship during cognition). SARA's only effect is **entropy reduction**, tuned for **high contrast**: a signal is a soft radial
metabolic region that **amplifies the existing substrate in place** — jitter **collapses (squared
falloff)** so the region stills, existing nodes **grow + lift luminance**, a subtle additive **bloom**
lifts local visibility, and **existing** edges between activated nodes get a soft low-alpha additive
glow (pressure through tissue). **No condensation/pull** (it made starbursts), no node travel, no
head/tail, and **no new edges drawn**. The periphery defocuses ~50%. **Order replaces noise locally,
then relaxes.** If the eye locks onto a moving "thing", a drawn wireframe, or a floating mini-graph, it is wrong.

**Field centre = inertial, no ping-pong.** Two-stage smoothing: a slowly-drifting destination
(low-pass of the active-reasoning centroid, else the anchors at rest → transitions feel
*intentional and rare*) chased by an **inertial spring** (low stiffness `0.002` + heavy damping
`0.88` → momentum, never snaps to a node). Clamped to the viewport every frame. The field never
leaves the viewport.

- **Allowed:** clustering, collapse, expansion, hesitation, reconfiguration, temporary
  symmetry that breaks, attractors sweeping through and lighting regions.
- **Forbidden:** rigid loops, spinning, perfect circles, equal spacing, static layouts,
  decorative oscillation.

### 3.5 Per-state inference parameters (`INFER`)
`active` = concurrent thoughts · `gap` = ms between thoughts · `litR` = illumination radius
(×spread) · `pulse` = pulse intensity · `tempo` = attention speed · `bridges` = max transient
bridges · `distort` = local pull(+)/push(−) · `sub` = substrate visibility (1 = full, lower =
**compression**: the irrelevant tissue is veiled) · `region` = **SARA's field strength**
(0 = no curvature, 1 = strong convergence) — drives field radius, compression amount, and the
brightness of the structure that resolves out of the tissue.

| state | active | gap | litR | pulse | tempo | bridges | distort | sub | region |
|-------|--------|-----|------|-------|-------|---------|---------|-----|--------|
| dormant | 0 | — | 0.0 | 0.0 | 0.03 | 0 | 0 | 1.0 | 0.15 |
| withyou | 1 | 3600 | 0.20 | 0.5 | 0.05 | 2 | +0.2 | 0.9 | 0.5 |
| listening | 1 | 2800 | 0.22 | 0.6 | 0.06 | 3 | +0.25 | 0.82 | 0.6 |
| thinking | 3 | 1400 | 0.26 | 0.95 | 0.09 | 4 | +0.4 | 0.6 | 0.9 |
| challenging | 3 | 850 | 0.22 | 1.0 | 0.14 | 3 | −0.5 | 0.6 | 0.85 |
| reassuring | 2 | 2600 | 0.24 | 0.6 | 0.045 | 3 | +0.25 | 0.82 | 0.7 |

**`region` (field strength) + `sub` (compression) are SARA, not decoration.** When she engages,
the bulk tissue dims (compression veil, eased) and her field bends the region she is reasoning
over into bright structure. **Confidence drives stability:** `instab = 1 − confidence.score`
adds a tremor to in-field nodes (damped by strength), makes the **void wells "pressure"**, and
unsettles the field. High confidence → calm and still; low → restless. Field strength by tier:

- **Dormant** (`region` 0.15): minimal curvature — quiet tissue, barely a bend.
- **Peripheral** (withyou / listening, 0.5–0.6): subtle compression begins to form structure.
- **Manifest** (thinking, 0.9): strong convergence around the active reasoning; **dynamic local
  distortions** (time-varying compression) — she sees connections you don't.
- **Challenging** (0.85): strong but turbulent — the field strains.
- **Reassuring** (0.7): fluid, soft, calm convergence.

---

## 4. Live data mapping

The graph is built from the shared model (`/api/state`) + a cognition graph endpoint.
**It is her actual cognitive content, not a depiction.**

| Layer | Source |
|-------|--------|
| Substrate nodes | vault notes (`list_vault`) — dense; named anchors from `domains.people`, `domains.queue`, `domains.focus.current` |
| Substrate edges | **real** `vault_backlinks` / `related_notes` |
| Reasoning attractors | `inference.reasons`, `nova.eyesOn.items` (hot), people assessments (`domains.people` flags), `domains.focus.current.reason` |
| Void wells | **real** `find_knowledge_gaps` |

When the backend cognition graph is unavailable, the renderer falls back to a synthesised
dense substrate seeded from the model's named nodes (never empty), and surfaces this honestly.

---

## 5. Rendering style
- Palette: deep navy / near-black background · muted teal (convergence) · cool blue
  (memory) · cool white (cores) · subtle amber (voids / warning cognition). No neon.
- Compositing: edges + glows additive (`lighter`); crisp cores + labels `source-over`.
- Premium, cinematic, restrained. Centre stays clear of the workspace panels.

---

## 6. Hard constraints
SARA must **not** appear as: a person, face, avatar, chatbot bubble, glowing orb, centred
icon, seam, or glyph-as-presence. The dashboard layout (sidebar / focus / ambient / signals /
bottom bar) is **not** to be redesigned. Motion that reads as decoration is rejected.

---

## 7. Validation tests (must all pass)
1. Does the graph feel alive?
2. Does it feel inhabited?
3. Does it feel intelligent?
4. Would removing it make the dashboard feel empty?
5. Does it feel like shared cognition between Nick and SARA?
6. Does it read as a **window into a much larger field**, not a sparse diagram?

---

## 8. File map
- `CognitionEnvironment.jsx` — view, six-state Presence Architecture, the convergence-graph
  engine (`buildGraph` + the rAF force sim), intervention.
- `CognitionEnvironment.css` — dark theme, `[data-cog]` whole-UI response, glyph animations,
  anchor + state switcher.
- `sara/backend/src/routes/cognitionGraph.js` (Phase 4) — assembles the live vault graph
  (notes + backlinks) + knowledge gaps from NEURO; served at `/api/cognition/graph`.

---

## 9. Performance & stability invariants
- 60 FPS target. Memory substrate (`CLOUD_N ≈ 9500`) built once via density-field sample + streaming
  grid-5-NN. **The ENTIRE resting graph (edges + nodes) is baked to the offscreen layer and blitted
  each frame — it is STATIC.** Only the small **active region** is redrawn per frame (overlay).
- **Stability (no flicker/strobe) — invariants that MUST hold:**
  1. **Static background.** The whole substrate is the offscreen blit. **Do NOT jitter/redraw every
     node each frame** — a per-frame jitter of all ~9500 nodes reads as a *boiling/flickering field*
     (this was the bug). Per-frame motion is confined to the active region (a few hundred nodes).
  2. **Deterministic graph.** `buildCloud` calls `seedRng(...)` (mulberry32) first → the layout is
     IDENTICAL on every build. **No `Math.random()` in the render path** (only at thought-spawn, rare).
  3. **Build once per dimension.** `size()` caches `lastW/lastH` and returns early if unchanged — a
     spurious ResizeObserver tick must never regenerate the graph mid-animation.
  4. **Continuous values only.** Per-frame motion/opacity is time-based (`sin/cos(t…)`), eased; full
     `clearRect` each frame (no fade trails, no dark-over-bright overlay).
  5. **One rAF.** The loop id is stored on `canvas.__ceRaf`; any stale loop is cancelled before a new
     mount starts, and cleanup cancels on unmount. Never two loops on one canvas.
  6. **Mode params interpolate** (`focus` eased ~0.025/frame). Depth-of-field is **mode-driven**, never
     gated on `active.length` (that pulsed the whole vault as thoughts cycled).
- FIREFIGHTING agitation is **gentle unrest**, not a strobe (shallow, slow). `size()` skips while the
  canvas is 0-size (degenerate grid → hang). `CLOUD_N` is tunable on the Pi.
