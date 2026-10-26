'use strict';

/**
 * NEURO's AI call classes — the names the gate admits (22 Oct 2026).
 *
 * Every model, embedding, TTS or local-model request NEURO makes names one of
 * these. A request naming anything else is still admitted in SHADOW mode and is
 * counted as `unknown-class`, which is how a new caller gets noticed rather than
 * silently spending.
 *
 * Bounds are CEILINGS a single request may claim, not budgets. They are set at
 * each provider's hard limits (or the call's own existing max_tokens), so they
 * refuse only a request that is genuinely unbounded — never ordinary use. There
 * is no `maxPerDay` anywhere, deliberately: a daily volume or spending cap is
 * Nick's decision and has not been made.
 *
 * Concurrency IS bounded for local workloads (the Pi has one Ollama, one
 * faster-whisper), which is the "local workloads too" half of the gate.
 */

const TEXT_IN = 200000;   // the largest context any allow-listed text model takes
const TEXT_OUT = 16000;

const text = (extra = {}) => ({ maxInputTokens: TEXT_IN, maxOutputTokens: TEXT_OUT, ...extra });

const REGISTRY = {
  // ── conversation (latency-sensitive, OpenRouter first) ─────────────────
  chat_stream: text(), chat_sync: text(), chat_tools: text(),
  standup_interactive: text(), eod_interactive: text(), standup_tools: text(), eod_tools: text(),
  standup_questions: text(), eod_questions: text(),
  profile_interview: text(), profile_interview_tools: text(), profile_seed: text(),
  // ── email ──────────────────────────────────────────────────────────────
  email_triage: text(), email_triage_shadow: text(), email_summary: text(), email_draft: text(),
  // ── briefings, knowledge, background ───────────────────────────────────
  briefing_synthesis: text(), focus_enhancement: text(), drilldown_framing: text(),
  import_classification: text(), transcript_processing: text(), journal_prompts: text(),
  knowledge_consolidation: text(), knowledge_enrichment: text(),
  capability_suggestions: text(), event_parse: text(), drink_lookup: text(), task_short_title: text(),
  watched_reply_judge: text(), ticket_reply_draft: text(), uat_request_extract: text(),
  // ── SAiM prepared moves (drafting only) ────────────────────────────────
  saim_move_reply: text(), saim_move_prep: text(), saim_move_note: text(),
  // ── "Do this" task agent (Anthropic tool loop, cloud only; one ticket per
  //    round). Prepares and drafts; grants no authority. See services/task-agent.js.
  task_agent: text({ local: false, maxOutputTokens: 8000 }),
  // The synthetic "Test Anthropic connection" in Settings: one bounded fixture request.
  task_agent_test: text({ local: false, maxOutputTokens: 64 }),
  // ── vision (Anthropic, cloud only) ─────────────────────────────────────
  vesta_photo: text({ local: false, maxOutputTokens: 8000 }),
  medical_scan: text({ local: false, maxOutputTokens: 8000 }),
  // ── embeddings (Voyage): input only, batch of ≤128 chunks × ≤32k tokens ─
  embeddings_index: { local: false, noOutput: true, maxInputTokens: 128 * 32000, maxConcurrent: 2 },
  embeddings_query: { local: false, noOutput: true, maxInputTokens: 32000 },
  // ── speech ─────────────────────────────────────────────────────────────
  // OpenRouter audio: output is audio tokens; the bound is the request's own.
  tts_speak: { local: false, maxInputTokens: 4000, maxOutputTokens: 4096, maxConcurrent: 2 },
  voice_transcribe: { local: true, noOutput: true, maxInputTokens: 1e6, maxConcurrent: 1 },
  // ── local-only warm-ups ────────────────────────────────────────────────
  standup_prewarm: text({ local: true }), eod_prewarm: text({ local: true }),

  // Provider-wide concurrency: two classes can still contend for one local server.
  $providers: {
    ollama: { maxConcurrent: 2 },
    whisper: { maxConcurrent: 1 },
    pi4worker: { maxConcurrent: 1 },
  },
};

/** The class names (without the provider table) — for the registry test and the profile. */
const CLASS_NAMES = Object.keys(REGISTRY).filter((k) => !k.startsWith('$'));

module.exports = { REGISTRY, CLASS_NAMES };
