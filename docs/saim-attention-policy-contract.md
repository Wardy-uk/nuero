# SAiM Attention Policy — decision contract (DRAFT for approval)

**Status:** approved in principle 14 Oct 2026 (effective-deadline rule and the 17:11 outcome); §3 amended 15 Oct 2026 (scope); risk/urgency split and S3a added 15 Oct 2026; unclassified-type amendment, per-scope blindness and the decision table (§8) added 15 Oct 2026. The architecture boundary was approved in principle on 15 Oct 2026.

- **No UI is wired:** no surface reads `candidates` or `saim`.
- **Live on the Pi:** the first version of both fields went out on 15 Oct inside another session's push. It is additive and nothing reads it.
- **Not live:** the risk/urgency split and S3a are on the local branch `saim-risk-urgency`. Pushes and deployments from this work are frozen.

**Ownership.** NEURO owns facts and constraints. SAiM owns attention judgement: what she
leads with, what she asks Nick to do now, what she protects, and how that shows on each
surface. The policy runs on the server so every surface gets one answer. It is still
SAiM's product and SAiM's code. It never writes NEURO state, and NEURO never reads its
output as a fact.

---

## 1. Inputs: NEURO candidates and the facts each one carries

NEURO hands the policy one object, `neuro-candidates-v1`. Every candidate carries
`provenance` (source, read time), `known` (whether it was read) and `sphere` (work / personal / home / family / unknown) with its basis. A missing read is
`known:false`, never an empty list.

| Candidate | NEURO facts carried | Source |
|---|---|---|
| **block** | blockId, window (start/end), state (upcoming / running / interrupted / complete), tasks (ids, wording), focus-session state | task-blocks, focus-session |
| **meeting** | title, window, running, other people in it (yes / no / unknown), occurrence key | calendar cache |
| **approval** | count, action types, earliest expiry (`expires_at`), where it is approved, whether sending is switched on | prepared_actions |
| **attention item** | recordId, type, title, **risk** (none / low / medium / high / critical), **urgency** (`meeting-transition`, `ritual-due` or none), NEURO's original urgency word (`neuroUrgency`, for provenance), **`riskBasis`** (`classified` when NEURO has classified the item's type, else `unclassified`), reason, lifecycle state, allowed actions; for a meeting card: start, minutes away, other people attending | decision-engine + attention lifecycle |
| **ritual** | which ritual (standup / EOD), outstanding yes/no | ritual state |
| **commitment** | taskId, wording, planned date and its basis, direction, counterpart, open/done | world model |
| **protected time** | solo diary entry running now, title, window | calendar cache |
| **held / dropped** | items the gate held back, with NEURO's reason | attention |
| **risk** | capacity / overload findings, with severity | decision-engine |
| **constraints** | working hours (08:00–18:00), duty, quiet hours, pool readable, diary readable | attention settings, context-state |
| **data quality** | wording that contradicts the planned date (new NEURO fact — today it is computed in SAiM Alt) | task store |

## 2. SAiM's priority rules, and how the lead is explained

The first rule that applies sets the lead. Every rule has a fixed explanation template that
names the facts that decided it.

| # | Rule | Explanation (template) |
|---|---|---|
| S1 | **Blind** — NEURO's attention read failed | "I can't see your work right now — this isn't an all-clear." |
| S2 | **Critical risk** — an item whose *risk* is critical **and whose type NEURO has classified** (genuine harm, never a clock) | "{title} is critical: {reason}." |
| S2u | **Unclassified potential risk** — NEURO said critical about a type nobody has classified yet | "{title} — NEURO rated it critical, but this kind of item ({type}) hasn't been classified yet, so I'm treating it as possible risk." |
| S3 | **In a meeting** — running, other people in it | "You're in {title} until {end}; I'm holding everything else." |
| S3a | **Imminent meeting transition** — a meeting with other people starting within 10 minutes | "{title} starts in {n} minutes; I'll hold {block} for after it." |
| S4 | **Deadline inside the block** — an approval whose *effective deadline* falls before the block ends + 15 min | "{approval} has to go before {deadline}, and this block runs to {end}." |
| S5 | **Protected block** — a task block is running | "This is the time you blocked for {task}. I'm holding the rest until {end}." |
| S6 | **Judgement waiting** — an approval, with no block running | "{approval} is waiting for you in NEURO, before {deadline}." |
| S7 | **Top item** — NEURO's highest-ranked attention item | "{title}: {reason}." |
| S8 | **Protected diary time** — no block names it | "The diary protects this time, but no task block says what it's for." |
| S9 | **Block about to start** | "{task} starts at {start}." |
| S10 | **Ritual** | "{ritual} hasn't been done yet." |
| S11 | **Nothing** | "Nothing needs you right now." |

**Effective deadline.** If an approval's `expires_at` falls before Nick's next working
start, its effective deadline is the end of today's working hours. If he can't act on it
overnight, the deadline that matters is when he stops work.

**Risk vs urgency (15 Oct 2026).** NEURO's decision-engine used one word, `critical`, for two different facts. NEURO now splits it:

| decision-engine source | was | risk | urgency |
|---|---|---|---|
| unseen escalations | critical | **critical** | — |
| NOVA flag, risk ≥ 80 or legal | critical | **critical** | — |
| weekly risk report late | critical | **critical** | — |
| meeting with others ≤ 10 min away | critical | none | `meeting-transition` |
| standup nudge before 11:00 | critical | none | `ritual-due` |
| any type not listed | critical | **critical, `riskBasis: unclassified`** → S2u, and listed for review | — |

**Unclassified types (amendment, 15 Oct 2026).** A type NEURO has not classified must not stay "critical" for ever unexamined. So:
- NEURO marks it `riskBasis: unclassified`. A missing basis counts as unclassified, never as classified.
- SAiM leads with it **conservatively**, as potential risk. Rule S2u sits directly below S2, so possible harm is never quietly demoted, but it can never pass for classified risk.
- The trace names the type ("type “payroll_cutoff” is unclassified").
- Every decision carries **`review.unclassified`** — each unclassified type seen, its count, example refs, NEURO's word for it, and whether it led — with an action: classify it in `neuro-candidates` (`CLASSIFIED_TYPES` / `HOME_RISK`), then review the policy.
- Household needs-you kinds are classified the same way: hazard = critical; hazard sensor unreachable, door, heating = high; network = medium; an obligation = none.

S2 reads **risk only**, and only **classified** risk. A meeting about to start reaches the lead through S3a, and the standup through the ritual and held rules. It never goes through S2.

**S3a against an active task block.**
- Within 10 minutes of a meeting with other people, the meeting leads, even over a running block. People are waiting on a fixed clock. The block stays the **protected** context, and held items return when it does.
- More than 10 minutes out, the block leads (S5). The meeting is shown as **next**, with its countdown.
- Genuine risk (S2) and a meeting already running (S3) still outrank S3a.
- S3a outranks an approval deadline inside the block (S4), because the meeting has the nearer fixed time and other people.
- The 10 minutes is NEURO's own imminence window (decision-engine), so "imminent" means one thing everywhere.
- When the diary was not read, NEURO's meeting card alone can still trigger S3a.

Wherever S2–S4 interrupt a block, the block stays in **protected context**. It is never
dropped.

## 3. Surface input: scope, then manifestation

A surface carries two things: a **scope**, which filters the candidates *before* SAiM
selects a lead, and a **manifestation**, which only changes how the decision is shown.

| Surface | Scope | Manifestation |
|---|---|---|
| `work-desktop` | **work** | full: held list, all actions, desktop app launching |
| `work-tablet` | **work** | held list, all actions, no app launching |
| `home-pi` | **home** | ambient: held as a count, no actions (hand-off), may speak |
| `bedside-phone` | **home** | as `home-pi` |
| `phone` | **all** | constrained, interruption-oriented: held as a count, at most two actions, may speak |

**Scopes**

- **work** — work candidates, candidates of unknown sphere, and *relevant* personal context. Personal, home or family context is relevant when it is running now, timed today, due today or overdue, or rated critical.
- **home** — home and family candidates only. Work candidates, and candidates whose sphere is unknown, never become the lead and never appear as held work. They are only counted, as `scope.excluded`.
- **all** — every candidate.

The sphere of each candidate is a **NEURO fact** with its basis (§1). Examples: a classified calendar, the task's stored domain, the mailbox an approval sends from. SAiM never guesses a sphere. Unknown stays unknown, and each scope decides what to do with unknown.

**The consistency rule.** Within one scope, the lead, its rule and the protected context are the same on every manifestation for the same NEURO facts. A parity test enforces this. Different scopes may legitimately produce different leads from the same facts. Example: at 17:11 the work desktop leads with the task block, while the home Pi leads with home or family context, or with nothing.

A manifestation that cannot perform the recommended action shows the lead with a hand-off ("on the desktop"). It never substitutes a different lead.

## 4. Output: `saim-attention-v1`

```
lead:          { ref, kind, title, rule, why, deciding: [facts] }
protected:     { ref, what, until } | null     — what SAiM is guarding right now
held:          [{ ref, title, why held, returns: 'at {time}' | 'after this' }]
judgement:     [{ ref, what, where, deadline, effectiveDeadline }]
recommended:   { say, intent } | handOff       — one action, then alternatives
alternatives:  [{ say, intent }]
corrections:   [{ ref, issue }]
review:        { unclassified: [{ type, count, refs, neuroUrgency, ledThisDecision }], action } — policy-review diagnostics                 — data-quality flags back to NEURO, display only
surface:       { id, scope, manifestation }     — manifestation is the only part that varies within a scope
scope:         { id, excluded: { work, unknown, ... } } — what the scope filtered out, counted, never shown
policyVersion, decidedAt, trace: [{ rule, applies, why }]
```

## 5. The current case: running block vs an approval expiring tomorrow morning

**Facts at 17:11, 14 Oct:**
- Block 115 (16:00–17:30, NT-24162) is running.
- No focus session is running.
- One agenda request for tomorrow 09:00's London Office Regroup is waiting; `expires_at` is 06:00 tomorrow.
- EOD ritual outstanding.
- Four tasks due today; one has wording that contradicts its planned date.
- Working hours end at 18:00.

**Policy:**
- **Effective deadline** for the approval is 18:00 today, because 06:00 is before the next working start.
- **S4 does not apply.** 18:00 is after the block's end + 15 min (17:45), so there is still time once the block ends.
- **Lead: block 115 (S5).** "This is the time you blocked for NT-24162. I'm holding the rest until 17:30."
- **Protected:** block 115 until 17:30.
- **Judgement:** the agenda request — "before 18:00 today (expires 06:00 tomorrow)" — visible, not interrupting.
- **Held:** the EOD wrap and four tasks due today, returning at 17:30.
- **Recommended action:** "I'm on it" (start a focus session on NT-24162).
- **Correction:** West Hants — wording says "tomorrow", planned for today.
- **At 17:30, when the block ends:** if the approval is still waiting, it becomes the lead (S6): "The London Office Regroup agenda request is waiting in NEURO — send it before 18:00." The EOD wrap is next.

This differs from `attention-decision-v1` in one place: it replaces the fixed "60 minutes
before `expires_at`" rule with the effective-deadline test. The fixed rule would have let
this request wait until 05:00 tomorrow.

## 6. Blindness is per scope

S1 is judged on what the surface's scope depends on:
- **work** — NEURO's attention pool;
- **home** — the household model.

"I couldn't look" is never shown as "nothing": an unreadable household on the home Pi says "I can't see the house right now — this isn't an all-clear."

## 6a. Out of scope for v1

- **`attention.gate` is a current NEURO-side gate that feeds candidates. It is not SAiM policy.** Today the gate re-ranks, holds back (`dropped`) and quietens items before the policy sees them. In v1 its output is treated as input: its `primary`/`secondary` arrive as attention-item candidates, and its `dropped` arrive as held candidates with NEURO's reason. Whether that judgement moves under SAiM is a later decision.
- **Notifications.** The P0 digest and push policy are unchanged.

## 7. Placement (if approved)

- **Policy code:** `saim/policy/attention-policy.cjs`, pure. `require`d and executed by NEURO's backend for parity.
- **Candidates:** NEURO exposes `neuro-candidates-v1` on `/api/canonical/now`.
- **Policy output:** published alongside the candidates as `saim` (`saim-attention-v1`), never merged into NEURO's own fields.
- **Surfaces:** the control's presentation and SAiM Alt both render `saim.lead` / `protected` / `held` / `judgement` / `recommended`. Neither picks its own lead.
- **Superseded code:** `attention-decision-v1` (`59836e22`) is replaced, not shipped.

## 8. Decision table

Generated by `node backend/scripts/saim-policy-table.js` from the scenario runs that `backend/services/saim-policy-scenarios.test.js` asserts. Each run uses the real candidate composer and the real policy. Day: Thursday 15 Oct 2026, working hours 08:00–18:00, block 14:00–15:30 unless stated.

| # | Scenario | Surface → scope | Lead (rule) | Protected | Held | Recommended action |
|---|---|---|---|---|---|---|
| 1 | Active work block, non-urgent approval | work-desktop → work | Customer Care training plan and refreshers — **S5 protected block** | Customer Care training plan and refreshers (until 15:30) | Nick Ward to send breakdown of Parsons contacts (due today); West Hants Tennis Club: resolve the outstanding ticket (due today) | I’m on it |
| 2a | Active block, approval whose effective deadline is today (after the block) | work-desktop → work | Customer Care training plan and refreshers — **S5 protected block** | Customer Care training plan and refreshers (until 15:30) | Nick Ward to send breakdown of Parsons contacts (due today); West Hants Tennis Club: resolve the outstanding ticket (due today) | I’m on it |
| 2b | Active block, approval whose effective deadline falls inside the block | work-desktop → work | chase agenda: Ops sync — **S4 deadline inside the block** | Customer Care training plan and refreshers (until 15:30) | — | hand-off: Review it in NEURO (Actions, in NEURO on the desktop) |
| 3 | Meeting with others in under ten minutes, during an active block | work-desktop → work | Nick Catch Up — **S3a imminent meeting transition** | Customer Care training plan and refreshers (until 15:30) | — | Join / prep now |
| 4 | Out-of-hours home evening | home-pi → home | Put the bins out — **S7 top item** | — | 1 (count only) | — |
| 5a | Family item needing action, during work | work-desktop → work | Customer Care training plan and refreshers — **S5 protected block** | Customer Care training plan and refreshers (until 15:30) | Wedding anniversary today — nothing booked (needs you) | I’m on it |
| 5b | Home hazard (genuine risk), during work | work-desktop → work | Kitchen leak: water detected — **S2 critical risk** | Customer Care training plan and refreshers (until 15:30) | — | — |
| 6a | Unreadable or missing data — work desktop | work-desktop → work | — — **S1 blind** | — | — | — |
| 6b | Unreadable or missing data — home Pi | home-pi → home | — — **S1 blind** | — | 0 (count only) | — |
| 7 | Phone interruption with constrained actions (scenario 3 on the phone) | phone → all | Nick Catch Up — **S3a imminent meeting transition** | Customer Care training plan and refreshers (until 15:30) | 1 (count only) | Join / prep now (also: Not now) |
| 8 | Unclassified type rated critical, during an active block | work-desktop → work | Payroll cut-off for overtime claims — **S2u unclassified potential risk** | Customer Care training plan and refreshers (until 15:30) | — | — |

**1. Active work block, non-urgent approval**
- Candidates (kind/sphere): block/work×1, approval/work×1, commitment/work×2. Excluded by scope: none.
- Lead: “Customer Care training plan and refreshers” — “This is the time you blocked for Customer Care training plan and refreshers. I’m holding the rest until 15:30.”
- Judgement: chase agenda: Quarterly review — by Tue 09:00 (its own expiry). Policy review: —.
- Trace: S1 → S2 → S2u → S3 → S3a → S4 → **S5 protected block** — block:130 14:00–15:30 is running

**2a. Active block, approval whose effective deadline is today (after the block)**
- Candidates (kind/sphere): block/work×1, approval/work×1, commitment/work×2. Excluded by scope: none.
- Lead: “Customer Care training plan and refreshers” — “This is the time you blocked for Customer Care training plan and refreshers. I’m holding the rest until 15:30.”
- Judgement: chase agenda: The London Office Regroup — by Thu 18:00 (end of today’s working hours — it expires before you next start). Policy review: —.
- Trace: S1 → S2 → S2u → S3 → S3a → S4 → **S5 protected block** — block:130 14:00–15:30 is running

**2b. Active block, approval whose effective deadline falls inside the block**
- Candidates (kind/sphere): block/work×1, approval/work×1. Excluded by scope: none.
- Lead: “chase agenda: Ops sync” — “chase agenda: Ops sync has to be dealt with before 15:00, and this block runs to 15:30.”
- Judgement: —. Policy review: —.
- Trace: S1 → S2 → S2u → S3 → S3a → **S4 deadline inside the block** — effective deadline 15:00 today (its own expiry); block ends 15:30 + 15 min

**3. Meeting with others in under ten minutes, during an active block**
- Candidates (kind/sphere): block/work×1, meeting/work×1, attention-item/unknown×1. Excluded by scope: none.
- Lead: “Nick Catch Up” — “Nick Catch Up starts in 8 minutes; I’ll hold Customer Care training plan and refreshers for after it.”
- Judgement: —. Policy review: —.
- Trace: S1 → S2 → S2u → S3 → **S3a imminent meeting transition** — “Nick Catch Up” with other people starts in 8 min (≤ 10) — outranks block:130

**4. Out-of-hours home evening**
- Candidates (kind/sphere): approval/work×1, ritual/work×1, commitment/work×2, home/home×1, personal-date/family×1. Excluded by scope: work×4.
- Lead: “Put the bins out” — “Put the bins out — collection is tomorrow morning.”
- Judgement: —. Policy review: —.
- Trace: S1 → S2 → S2u → S3 → S3a → S4 → S5 → S6 → **S7 top item** — “Put the bins out” needs you

**5a. Family item needing action, during work**
- Candidates (kind/sphere): block/work×1, personal-date/family×1. Excluded by scope: none.
- Lead: “Customer Care training plan and refreshers” — “This is the time you blocked for Customer Care training plan and refreshers. I’m holding the rest until 15:30.”
- Judgement: —. Policy review: —.
- Trace: S1 → S2 → S2u → S3 → S3a → S4 → **S5 protected block** — block:130 14:00–15:30 is running

**5b. Home hazard (genuine risk), during work**
- Candidates (kind/sphere): block/work×1, home/home×1. Excluded by scope: none.
- Lead: “Kitchen leak: water detected” — “Kitchen leak: water detected is critical: a household hazard sensor is reporting.”
- Judgement: —. Policy review: —.
- Trace: S1 → **S2 critical risk** — “Kitchen leak: water detected” carries critical risk (hazard)

**6a. Unreadable or missing data — work desktop**
- Candidates (kind/sphere): none. Excluded by scope: none.
- Lead: none — “I can’t see your work right now — this isn’t an all-clear.”
- Judgement: —. Policy review: —.
- Trace: **S1 blind** — NEURO could not read the attention pool

**6b. Unreadable or missing data — home Pi**
- Candidates (kind/sphere): none. Excluded by scope: none.
- Lead: none — “I can’t see the house right now — this isn’t an all-clear.”
- Judgement: —. Policy review: —.
- Trace: **S1 blind** — NEURO could not read the household model

**7. Phone interruption with constrained actions (scenario 3 on the phone)**
- Candidates (kind/sphere): block/work×1, meeting/work×1, attention-item/unknown×2. Excluded by scope: none.
- Lead: “Nick Catch Up” — “Nick Catch Up starts in 8 minutes; I’ll hold Customer Care training plan and refreshers for after it.”
- Judgement: —. Policy review: —.
- Trace: S1 → S2 → S2u → S3 → **S3a imminent meeting transition** — “Nick Catch Up” with other people starts in 8 min (≤ 10) — outranks block:130

**8. Unclassified type rated critical, during an active block**
- Candidates (kind/sphere): block/work×1, attention-item/unknown×1. Excluded by scope: none.
- Lead: “Payroll cut-off for overtime claims” — “Payroll cut-off for overtime claims — NEURO rated it critical, but this kind of item (payroll_cutoff) hasn’t been classified yet, so I’m treating it as possible risk.”
- Judgement: —. Policy review: payroll_cutoff×1.
- Trace: S1 → S2 → **S2u unclassified potential risk** — “Payroll cut-off for overtime claims” — NEURO said critical, but type “payroll_cutoff” is unclassified
