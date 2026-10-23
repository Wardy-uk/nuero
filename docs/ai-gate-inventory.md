# AI gate — call inventory (22 Oct 2026)

Every request NEURO or VANTAGE makes to a paid, metered or local model, embedding,
speech or transcription service goes through ONE gate (`backend/services/ai-gate.js`,
byte-identical in both repos) and names a call class. The gate reserves the
worst case against one shared London-day ledger before the call
(the explicit absolute `AI_GATE_DB_PATH`, the same file in both apps — see **The
shared ledger: path contract** below; SQLite WAL, `BEGIN IMMEDIATE`, so two
processes cannot both take the last reservation), then settles the actual cost.

**Mode: SHADOW.** Nothing is refused. What the gate *would* refuse is recorded
with its reason and shown in NEURO → Settings → **AI budget (shadow)** and VANTAGE
→ Admin. There is **no daily cap** (`dailyCapUsd: null`) — Nick has not chosen one.
`AI_GATE_MODE=enforce` exists and is not set anywhere.

Settlement order: the vendor's own charged cost → reported tokens × the price table
→ **pessimistic** (the reserved worst case, when usage was not reported) →
**unknown** (null, never zero, when no price exists). Unsettled tickets expire after
15 minutes and settle pessimistically. Tickets are single-use; a tool-loop round and
a retry each take their own.

Refusal reasons (recorded, not enforced): `unknown-class`, `unknown-model`,
`unknown-price`, `model-not-allowed`, `provider-not-allowed`, `unbounded-input`,
`input-over-bound`, `unbounded-output`, `output-over-bound`, `concurrency`, `volume`,
`daily-cap` (only when `AI_GATE_DAILY_CAP_USD` is set — it is not).

Prices (USD per million tokens, input / output; checked 22 Oct 2026): Haiku 4.5
1/5 · Sonnet 4.5 3/15 · Sonnet 4.6 3/15 · Sonnet 5 2/10 · Opus 5 5/25 · Gemini 2.5
Flash 0.3/2.5 · GPT-4.1 2/8 · GPT-4.1 mini 0.4/1.6 · GPT-4o mini 0.15/0.6 ·
voyage-3.5-lite 0.02. Local providers (ollama, pi4worker, whisper, piper) cost 0
and are bounded by concurrency instead.

## The shared ledger: path contract (23 Oct 2026)

NEURO and VANTAGE must write ONE ledger, and nothing may rely on them running as
the same Unix user. So:

- **`AI_GATE_DB_PATH` is required** in both deployed `.env` files, set to the SAME
  **absolute** path. There is no default: a path derived from each process's home
  directory silently splits the ledger in two the day the apps run as different
  users. (Under `node --test` only, a test that sets none gets a throwaway file.)
- **Both apps refuse to start** (`assertLedgerConfig`, first thing after `.env` is
  loaded) when the path is unset, relative, its folder is missing or not a folder,
  the folder is not readable+writable, or the file exists but is not
  readable+writable. The error names the problem. Nothing is created by the check.
- **Proof they share it is the ledger's own id**, minted inside the file
  (`gate_meta.ledger_id`) — never path text. Each app registers itself at startup
  (`gate_apps`: configured path, resolved path, host, pid, start time). NEURO asks
  VANTAGE's `/api/ai-gate/profile` for its ledger id 45 s after start and hourly
  (`ai-gate-peer.js`, read-only, over the existing NEURO → VANTAGE read path);
  a mismatch is logged and shown in Settings → AI budget. VANTAGE Admin warns when
  NEURO has not registered on its ledger.
- Cap: `AI_GATE_DAILY_CAP_USD` exists (committed = settled cost + open worst cases,
  read inside the IMMEDIATE transaction) and is **unset** — Nick has not chosen one.

**Pi configuration — reviewed 23 Oct 2026, NOT yet applied (needs Nick's approval).**

Measured read-only on pi5 (not assumed):

| | NEURO | VANTAGE |
|---|---|---|
| PM2 process | `neuro-backend` | `vantage-backend` |
| runs as | `nickw` (uid 1000), umask 0022 | `nickw` (uid 1000), umask 0022 |
| working directory | `/mnt/data/nuero/backend` | `/mnt/data/vantage` |
| env file it loads | `/mnt/data/nuero/backend/.env` (`dotenv.config()` — relative to the working dir) | `/mnt/data/vantage/backend/.env` (explicit `__dirname` path) |
| `AI_GATE_*` set today | none | none |

`/mnt/data` is `nickw:nickw 755` on ext4 (SQLite locking is reliable there). Both apps
are ONE user, so the narrowest folder that works is **owner-only `0700`** — no group
bit, no setgid, no sudo. (The earlier `2775` recipe was wider than needed.) The
startup check and the verifier still never ASSUME one user: if the apps are ever
split across users, the startup check refuses the one that cannot read and write,
and the verifier names it.

Steps, in order, as `nickw` on pi5 — **before** the code deploys:

```bash
install -d -m 0700 /mnt/data/ai-gate
cp -p /mnt/data/nuero/backend/.env   /mnt/data/nuero/backend/.env.bak-ai-gate-2026-10-23
cp -p /mnt/data/vantage/backend/.env /mnt/data/vantage/backend/.env.bak-ai-gate-2026-10-23
printf '\nAI_GATE_DB_PATH=/mnt/data/ai-gate/ledger.db\n' >> /mnt/data/nuero/backend/.env
printf '\nAI_GATE_DB_PATH=/mnt/data/ai-gate/ledger.db\n' >> /mnt/data/vantage/backend/.env
grep -H '^AI_GATE_DB_PATH=' /mnt/data/nuero/backend/.env /mnt/data/vantage/backend/.env   # both lines, same path
stat -c '%U %a' /mnt/data/ai-gate                                                          # nickw 700
```

⚠ Without those lines both servers refuse to start — by design. Then deploy BOTH apps
and restart both (`pm2 restart neuro-backend vantage-backend`); `saim-backend` is
unaffected. Rollback: redeploy the previous commits — older code ignores the variable.

**Post-deploy verification** (wait ≥ 60 s after the restart so NEURO's first peer
check has run). Node 22 explicitly — a bare `node` over ssh is v20, which segfaults
better-sqlite3:

```bash
cd /mnt/data/nuero && PATH=$HOME/.nvm/versions/node/v22.22.2/bin:$PATH \
  node backend/scripts/ai-gate-verify.js --live --lock-probe
```

It must end `✔ NEURO and VANTAGE write the one shared ledger.` It checks, each by name:
the two `.env` paths (unset / relative / different after realpath); the folder (missing /
not a folder / not readable+writable / writable by group or others); the file (not
created yet / not readable+writable); WAL mode; both apps registered on THIS file from a
running process; **`--live`**: each running app's `/api/ai-gate/profile` reports the
same ledger id as the file (an identity mismatch, or an app that cannot be asked, is a
problem; NEURO's own peer check is shown); **`--lock-probe`**: takes the write lock and
rolls back with a 3 s busy timeout — a held or unlockable ledger is a lock/concurrency
failure. It writes no data, never prints a PIN, and exits 0 / 1 (problems) / 2 (could
not run). Then Settings → AI budget should read "VANTAGE writes the same ledger ✓".

Proven by `ai-gate-two-apps.test.js` (two processes — NEURO's gate + registry and
VANTAGE's own copy + registry — racing $0.05 tickets under a $1 cap in enforce:
exactly 20 allowed, ≤ cap, 60 unique ids, every second settle refused and recorded),
`ai-gate-ledger-config.test.js` (startup refusals in a child process with the test
context removed; one file = one id across processes) and
`scripts/ai-gate-verify.test.js` (9: dotenv parsing, path rules, missing/not-a-folder/unwritable, too-wide folder, identity against stub apps with PINs never printed, and a real second process holding the write lock; identity, lock and width mutation-checked). ⚠ Measured: a DEFERRED transaction does not
overspend either (SQLite WAL refuses the stale write), but that refusal returns a
degraded, admitted ticket — fail-open under contention. IMMEDIATE is pinned.

## Where the gate sits

At the network edge, in the provider layer, so no caller can miss it:

| Provider file | What it gates |
|---|---|
| `providers/openrouter-provider.js` | `chat`, `streamChat`, `chatWithTools` (one ticket per round) |
| `providers/anthropic-provider.js` | messages, streaming (usage from `finalMessage()`), vision, tools |
| `providers/openai-provider.js` | chat |
| `providers/ollama-provider.js` | every export, plus `rawChat` for the standup's hand-rolled streams |
| `providers/voyage-provider.js` (new) | embeddings (`post`) |
| `providers/tts-provider.js` (new) | speech (`requestAudio`) |
| `services/pi4-worker-client.js` | the retired Pi 4 worker (still gated if re-enabled) |
| `services/voice-capture.js` | local faster-whisper transcription |
| VANTAGE `backend/services/openrouter.js` | `attempt()` — one ticket per attempt |

`ai-gate-enforcement.test.js` (and VANTAGE's `ai-gate.test.js`) scan the source:
a provider SDK import, or a fetch to a provider host, outside the provider/gate
layer fails the suite. The one named exemption is `worker/server.js` (the Pi 4
worker, retired 15 Aug 2026 — its Ollama calls are gated at
`pi4-worker-client.js`, the only way in).

## NEURO classes and their callers

| Class | Caller(s) | Route |
|---|---|---|
| `chat_stream`, `chat_sync` | `claude.js` chat | ai-routing (OpenRouter first) |
| `chat_tools` | `claude.js` tool loop | tool provider |
| `standup_interactive`, `eod_interactive` | `routes/standup.js`, `standup-session.js` | ai-routing / Ollama `rawChat` |
| `standup_tools`, `eod_tools` | `standup-session.js` | tool provider |
| `standup_questions`, `eod_questions` | `routes/standup.js` | ai-routing |
| `standup_prewarm`, `eod_prewarm` | `routes/standup.js` (local warm-up) | Ollama `rawChat` |
| `profile_interview`, `profile_interview_tools`, `profile_seed` | `profile-interview.js`, `profile.js` | ai-routing / tools |
| `email_triage`, `email_summary`, `email_draft` | `email-triage`, `email-actions`, `routes/personal-inbox.js`, `suggestion-engine` | ai-routing |
| `email_triage_shadow` | `triage-shadow.js` (off by default) | OpenRouter |
| `briefing_synthesis`, `focus_enhancement`, `drilldown_framing` | `briefing.js`, `briefing-weekly.js`, `ai-provider.js` | ai-routing |
| `import_classification`, `transcript_processing`, `journal_prompts` | imports, Plaud, journal | ai-routing (local first) |
| `knowledge_consolidation`, `knowledge_enrichment` | `knowledge-memory.js` | ai-routing |
| `capability_suggestions`, `event_parse`, `drink_lookup`, `task_short_title` | `capability-gaps`, `event-parser`, `drink-profiles`, `task-titles` | ai-routing |
| `saim_move_reply`, `saim_move_prep`, `saim_move_note` | `prepared-move-drafter.js` | ai-routing (cloud) |
| `vesta_photo` | `vesta-vision.js` | Anthropic vision |
| `medical_scan` | `medical-records.js` | Anthropic vision |
| `task_agent` | `task-agent.js` ("Do this", 23 Oct 2026; branch `task-agent-do-this`, not deployed) | Anthropic `chatWithTools`, one ticket per model request (≤12 a run, ≤4k output each, 90 s timeout, no SDK retries); default model `claude-sonnet-4-6` (in the installed SDK's list, priced here and in ai-cost); an unpriced override is refused before any call. **The only class with a Settings-controlled `maxPerDay`** (`ai-gate-classes.setClassLimit`, `POST /api/ai-gate/class-limit`, Settings → AI budget): UNSET; in shadow it is recorded as `volume`, only `enforce` refuses. Recommended first-day value 40 (not set — Nick's decision); enforcement stays off. ai-routing's `isCloudAllowed`/`recordUsage` still apply. Live-provider proof (`task-agent-live.test.js`) written and NOT yet run — it needs a disposable key in `%LOCALAPPDATA%\neuro\task-agent-live-anthropic.key`; the production key is never used. See `docs/task-agent.md`. |
| `embeddings_index`, `embeddings_query` | `embeddings.js` (3 sites) | Voyage |
| `tts_speak` | `tts.js` | OpenRouter audio |
| `voice_transcribe` | `voice-capture.js` | local faster-whisper |

Local concurrency: Ollama 2, whisper 1, Pi 4 worker 1 (provider-wide); embeddings
indexing 2; TTS 2. **No class has a daily volume limit** — that is a decision.

## VANTAGE classes

`radar` (40,000 in / 4,000 out, concurrency 1), `brief`, `coach`, `findings`,
`connection_test`. Radar was routed first. Its share of today's spend is shown on
both Settings pages ("Radar — N% of today").

## Removed while routing

- `email-triage.classifyWithOllama` — dead code, a direct Ollama fetch.
- The unused Ollama constants in `imports.js`.
- `routes/standup.js`'s four direct Ollama fetches now go through `rawChat`.

## Unresolved — recorded in shadow, needs a decision before enforcement

1. **TTS has no known price.** `openai/gpt-audio-mini` (audio tokens) is not in the
   price table, so every `tts_speak` call settles as unknown and would be refused as
   `unknown-price`. Pennies a month, but it must be priced or allowed explicitly.
2. **TTS output bound.** The request sets no `max_tokens`; the class bound (4,096)
   is the gate's, so it is recorded as `unbounded-output`. Choose a `max_tokens`.
3. **The client can name the TTS model** (`TTS_MODEL` / request). The allow-list
   decides; an unlisted model is `model-not-allowed`.
4. **`mistralai/mistral-small-3.2-24b-instruct`** (triage shadow, off by default)
   has no price entry.
5. **The greeter's house voice** goes through Home Assistant's Wyoming bridge to
   NEURO's `/api/tts/speak` — gated there; HA's own Piper fallback is local and
   outside NEURO.
6. **`worker/server.js`** stays exempt from the source scan (retired; gated at its
   only caller).
7. **Other OpenRouter keys.** The gate sees calls made with the shared key by these
   two apps only; the account's key list needs a management-key review before the
   ledger is treated as the whole account.
