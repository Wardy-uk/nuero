# AI gate — call inventory (22 Oct 2026)

Every request NEURO or VANTAGE makes to a paid, metered or local model, embedding,
speech or transcription service goes through ONE gate (`backend/services/ai-gate.js`,
byte-identical in both repos) and names a call class. The gate reserves the
worst case against one shared London-day ledger before the call
(`~/.ai-gate/ledger.db`, `AI_GATE_DB_PATH`; SQLite WAL, `BEGIN IMMEDIATE`, so two
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
`input-over-bound`, `unbounded-output`, `output-over-bound`, `concurrency`, `volume`.

Prices (USD per million tokens, input / output; checked 22 Oct 2026): Haiku 4.5
1/5 · Sonnet 4.5 3/15 · Sonnet 4.6 3/15 · Sonnet 5 2/10 · Opus 5 5/25 · Gemini 2.5
Flash 0.3/2.5 · GPT-4.1 2/8 · GPT-4.1 mini 0.4/1.6 · GPT-4o mini 0.15/0.6 ·
voyage-3.5-lite 0.02. Local providers (ollama, pi4worker, whisper, piper) cost 0
and are bounded by concurrency instead.

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
