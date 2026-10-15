'use strict';

/**
 * The attention contracts — names, supported versions and the shape each
 * version promises (C6, 15 Oct 2026). PURE: no backend, no I/O, no clock.
 *
 * Why this exists: the live `neuro-candidates-v1` and the branch's carried the
 * SAME name over DIFFERENT shapes (the branch added `facts.risk` / `riskBasis` /
 * `urgency`). A consumer that cannot tell them apart misreads one as the other.
 * So every consumer checks the contract NAME against an explicit SUPPORTED list
 * and the SHAPE that version promises, and REFUSES anything else — it never
 * falls back and never reads part of a payload.
 *
 *   - An unknown EXTRA field is ignored (forward-compatible additions).
 *   - A missing REQUIRED field, a wrong type, or an unsupported name is a refusal.
 *   - A breaking change is a NEW name (`-v3`), never an edit to what `-v2` means.
 *
 * Producers: backend/services/neuro-candidates.js (neuro-candidates),
 * saim/policy/attention-policy.cjs (saim-attention).
 * Consumers: the policy (over candidates); later, the SAiM hand-off resolver and
 * the Alt adapter (over both). Reserved, not built: `saim-handoff-v1`.
 */

const NEURO_CANDIDATES = 'neuro-candidates-v2';
const SAIM_ATTENTION = 'saim-attention-v1';

const SUPPORTED = Object.freeze({
  'neuro-candidates': Object.freeze([NEURO_CANDIDATES]),
  'saim-attention': Object.freeze([SAIM_ATTENTION]),
});

/** Every candidate kind neuro-candidates-v2 may carry. An unknown kind is a refusal. */
const CANDIDATE_KINDS = Object.freeze(['block', 'meeting', 'protected-time', 'approval', 'attention-item', 'ritual', 'commitment', 'held', 'home', 'personal-date']);
/** Kinds whose facts MUST carry the v2 risk split. */
const RISK_KINDS = new Set(['attention-item', 'home']);
const RISK_BASES = new Set(['classified', 'unclassified']);

/** Every lead rule saim-attention-v1 may name. */
const ATTENTION_RULES = Object.freeze([
  'S1 blind', 'S2 critical risk', 'S3 meeting', 'S2u unclassified potential risk', 'S3a imminent meeting transition',
  'S4 deadline inside the block', 'S5 protected block', 'S6 judgement waiting', 'S7 top item', 'S8 protected diary time',
  'S9 block about to start', 'S10 ritual', 'S11 nothing',
]);

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const isStr = (x) => typeof x === 'string' && x.length > 0;
const refuse = (family, reason, got) => ({ ok: false, family, reason, got: got === undefined ? null : got, supported: SUPPORTED[family] });

/**
 * Check a neuro-candidates payload. Returns { ok: true } or a refusal
 * { ok: false, family, reason, got, supported }. Never throws.
 */
function checkCandidates(input) {
  const F = 'neuro-candidates';
  if (!isObj(input)) return refuse(F, 'not an object', input === null ? null : typeof input);
  if (!SUPPORTED[F].includes(input.contract)) return refuse(F, 'unsupported contract', input.contract == null ? null : String(input.contract));
  if (!isStr(input.readAt)) return refuse(F, 'readAt missing', input.contract);
  if (!Array.isArray(input.candidates)) return refuse(F, 'candidates is not a list', input.contract);
  const k = input.constraints;
  if (!isObj(k)) return refuse(F, 'constraints missing', input.contract);
  if (typeof k.poolReadable !== 'boolean') return refuse(F, 'constraints.poolReadable is not a boolean', input.contract);
  if (!(k.homeReadable === null || typeof k.homeReadable === 'boolean')) return refuse(F, 'constraints.homeReadable is not true/false/null', input.contract);
  for (let i = 0; i < input.candidates.length; i += 1) {
    const c = input.candidates[i];
    const at = `candidates[${i}]`;
    if (!isObj(c)) return refuse(F, `${at} is not an object`, input.contract);
    if (!CANDIDATE_KINDS.includes(c.kind)) return refuse(F, `${at}.kind "${c.kind}" is not a v2 kind`, input.contract);
    if (!isStr(c.id)) return refuse(F, `${at}.id missing`, input.contract);
    if (!isObj(c.facts)) return refuse(F, `${at}.facts missing`, input.contract);
    if (!isObj(c.sphere) || !('value' in c.sphere)) return refuse(F, `${at}.sphere missing`, input.contract);
    if (RISK_KINDS.has(c.kind)) {
      if (!isStr(c.facts.risk)) return refuse(F, `${at}.facts.risk missing (v1 shape?)`, input.contract);
      if (!RISK_BASES.has(c.facts.riskBasis)) return refuse(F, `${at}.facts.riskBasis missing (v1 shape?)`, input.contract);
    }
  }
  return { ok: true, family: F, contract: input.contract };
}

/**
 * Check a saim-attention decision (for the resolver and adapter, when built).
 * A refused decision (`refused` set) is itself valid: it is an honest S1.
 */
function checkAttention(d) {
  const F = 'saim-attention';
  if (!isObj(d)) return refuse(F, 'not an object', d === null ? null : typeof d);
  if (!SUPPORTED[F].includes(d.contract)) return refuse(F, 'unsupported contract', d.contract == null ? null : String(d.contract));
  if (d.owner !== 'saim') return refuse(F, 'owner is not saim', d.contract);
  if (!isStr(d.policyVersion)) return refuse(F, 'policyVersion missing', d.contract);
  if (!isObj(d.surface) || !isStr(d.surface.id) || !isStr(d.surface.scope)) return refuse(F, 'surface missing', d.contract);
  if (!isObj(d.lead) || !ATTENTION_RULES.includes(d.lead.rule)) return refuse(F, `lead.rule "${d.lead && d.lead.rule}" is not a v1 rule`, d.contract);
  if (!(Array.isArray(d.held) || (isObj(d.held) && Number.isInteger(d.held.count)))) return refuse(F, 'held is neither a list nor a count', d.contract);
  if (!Array.isArray(d.judgement)) return refuse(F, 'judgement is not a list', d.contract);
  if (!Array.isArray(d.alternatives)) return refuse(F, 'alternatives is not a list', d.contract);
  if (!Array.isArray(d.trace)) return refuse(F, 'trace is not a list', d.contract);
  if (d.refused != null && (!isObj(d.refused) || d.lead.rule !== 'S1 blind')) return refuse(F, 'a refused decision must lead S1 blind', d.contract);
  return { ok: true, family: F, contract: d.contract };
}

module.exports = { NEURO_CANDIDATES, SAIM_ATTENTION, SUPPORTED, CANDIDATE_KINDS, ATTENTION_RULES, checkCandidates, checkAttention };
