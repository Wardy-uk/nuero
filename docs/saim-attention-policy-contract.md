# SAiM Attention Policy — decision contract (DRAFT for approval)

**Status:** approved in principle 14 Oct 2026 (effective-deadline rule and the 17:11 outcome); §3 amended 15 Oct 2026 (scope). Nothing is wired. The local commit `59836e22`
(`attention-decision-v1`) is evidence only. If this contract is approved, that code moves
under SAiM ownership as described in §7.

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
| **attention item** | recordId, type, title, severity (normal / high / critical), reason, lifecycle state, allowed actions | decision-engine + attention lifecycle |
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
| S2 | **Critical** — an item NEURO rated critical | "{title} is critical: {reason}." |
| S3 | **In a meeting** — running, other people in it | "You're in {title} until {end}; I'm holding everything else." |
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
corrections:   [{ ref, issue }]                 — data-quality flags back to NEURO, display only
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

## 6. Out of scope for v1

- **`attention.gate` is a current NEURO-side gate that feeds candidates. It is not SAiM policy.** Today the gate re-ranks, holds back (`dropped`) and quietens items before the policy sees them. In v1 its output is treated as input: its `primary`/`secondary` arrive as attention-item candidates, and its `dropped` arrive as held candidates with NEURO's reason. Whether that judgement moves under SAiM is a later decision.
- **Notifications.** The P0 digest and push policy are unchanged.

## 7. Placement (if approved)

- **Policy code:** `saim/policy/attention-policy.cjs`, pure. `require`d and executed by NEURO's backend for parity.
- **Candidates:** NEURO exposes `neuro-candidates-v1` on `/api/canonical/now`.
- **Policy output:** published alongside the candidates as `saim` (`saim-attention-v1`), never merged into NEURO's own fields.
- **Surfaces:** the control's presentation and SAiM Alt both render `saim.lead` / `protected` / `held` / `judgement` / `recommended`. Neither picks its own lead.
- **Superseded code:** `attention-decision-v1` (`59836e22`) is replaced, not shipped.
