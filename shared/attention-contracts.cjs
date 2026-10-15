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
 * the Alt adapter (over both).
 *
 * Hand-off (15 Oct 2026): v2 candidates MAY carry `handoffIntent` and
 * `targets`, and `constraints` MAY carry `targets` (the place to look when
 * blind). They are optional — absent means "NEURO stated no intent / no link",
 * which the resolver says honestly. They are NOT part of checkCandidates: a
 * malformed intent or link degrades THAT candidate to "no hand-off" (checked by
 * the resolver with `handoffProblem` / `targetsProblem`) and never refuses the
 * attention payload or turns a valid SAiM decision into blindness. `saim-device-v1` is the device's
 * declared apps and their state; `saim-handoff-v1` is the resolver's output.
 */

const NEURO_CANDIDATES = 'neuro-candidates-v2';
// v2 (15 Oct 2026): adds required `known` (C3) and `display` (C5). The live Pi's
// v1 has neither — same reasoning as neuro-candidates-v2: one name, one shape.
const SAIM_ATTENTION = 'saim-attention-v2';
const SAIM_DEVICE = 'saim-device-v1';
const SAIM_HANDOFF = 'saim-handoff-v1';

const SUPPORTED = Object.freeze({
  'neuro-candidates': Object.freeze([NEURO_CANDIDATES]),
  'saim-attention': Object.freeze([SAIM_ATTENTION]),
  'saim-device': Object.freeze([SAIM_DEVICE]),
  'saim-handoff': Object.freeze([SAIM_HANDOFF]),
});

/** Every candidate kind neuro-candidates-v2 may carry. An unknown kind is a refusal. */
const CANDIDATE_KINDS = Object.freeze(['block', 'meeting', 'protected-time', 'approval', 'attention-item', 'ritual', 'commitment', 'held', 'home', 'personal-date']);
/** Kinds whose facts MUST carry the v2 risk split. */
const RISK_KINDS = new Set(['attention-item', 'home']);
const RISK_BASES = new Set(['classified', 'unclassified']);

/** NEURO's structured hand-off intent — a closed vocabulary. */
const INTENT_KINDS = Object.freeze(['work-step', 'meeting', 'approval', 'risk', 'none']);
/** What a work step IS, as NEURO knows it from a stated field — never parsed from a title. */
const ACTIVITIES = Object.freeze(['draft', 'write', 'spreadsheet', 'email', 'code', 'read', 'call']);
/** The roles a NEURO-owned link can play. */
const TARGET_ROLES = Object.freeze(['canonical', 'control', 'join', 'prep', 'source']);
/** What a declared app can do. */
const CAPABILITIES = Object.freeze(['ai', 'music', 'docs', 'sheets', 'mail', 'code', 'browser', 'notes', 'meeting:teams']);
/** http(s), a SAiM route, or a NEURO view relative to wherever the client knows NEURO lives. */
const HREF = /^(https?:\/\/|saim:|neuro:)[^\s]+$/;
/** What NEURO may say it could not supply. */
const GAP_FIELDS = Object.freeze(['intent', 'activity', 'canonical', 'control', 'join', 'prep', 'provider', 'source']);
function gapsProblem(list, at) {
  if (list === undefined) return null;
  if (!Array.isArray(list)) return `${at} is not a list`;
  for (let i = 0; i < list.length; i += 1) {
    const g = list[i];
    if (!isObj(g) || !GAP_FIELDS.includes(g.field) || !isStr(g.why)) return `${at}[${i}] needs a known field and a why`;
  }
  return null;
}

function targetProblem(t, at) {
  if (!isObj(t)) return `${at} is not an object`;
  if (!TARGET_ROLES.includes(t.role)) return `${at}.role "${t.role}" is not a target role`;
  if (typeof t.href !== 'string' || !HREF.test(t.href)) return `${at}.href is not an http(s), saim: or neuro: link`;
  if (/\/approve\b/i.test(t.href)) return `${at}.href is an approve link — a hand-off never approves`;
  if (t.href.startsWith('neuro:')) {
    const n = LINKS.parseNeuroHref(t.href);
    if (!n) return `${at}.href is not a valid neuro: link (a view, or one exact item)`;
    if (t.role === 'prep' && !(n.item && n.item.kind === 'meeting-prep')) return `${at} is a prep target that is not a meeting-prep link`;
  }
  if (t.label != null && !isStr(t.label)) return `${at}.label is not text`;
  if (t.provider != null && !isStr(t.provider)) return `${at}.provider is not text`;
  return null;
}
function targetsProblem(list, at) {
  if (list === undefined) return null;
  if (!Array.isArray(list)) return `${at} is not a list`;
  for (let i = 0; i < list.length; i += 1) { const p = targetProblem(list[i], `${at}[${i}]`); if (p) return p; }
  return null;
}
function intentProblem(x, at) {
  if (x === undefined || x === null) return null;
  if (!isObj(x)) return `${at} is not an object`;
  if (!INTENT_KINDS.includes(x.kind)) return `${at}.kind "${x.kind}" is not an intent kind`;
  if (x.kind === 'work-step' && !(x.activity === null || ACTIVITIES.includes(x.activity))) return `${at}.activity "${x.activity}" is not an activity`;
  if (x.provider != null && !isStr(x.provider)) return `${at}.provider is not text`;
  if (x.unsure != null && typeof x.unsure !== 'boolean') return `${at}.unsure is not true/false`;
  if (x.unsure === true && x.activity != null) return `${at} is unsure but names an activity`;
  return null;
}
const SUGGESTION_BASES = new Set(['source', 'observed']);
function suggestionsProblem(list, at) {
  if (list === undefined) return null;
  if (!Array.isArray(list)) return `${at} is not a list`;
  for (let i = 0; i < list.length; i += 1) {
    const s = list[i];
    if (!isObj(s) || !ACTIVITIES.includes(s.activity) || !SUGGESTION_BASES.has(s.basis)) return `${at}[${i}] needs an activity and a basis (source / observed)`;
    if (s.ref != null && !isStr(s.ref)) return `${at}[${i}].ref is not text`;
  }
  return null;
}

/** Every lead rule saim-attention-v2 may name. */
const ATTENTION_RULES = Object.freeze([
  'S1 blind', 'S2 critical risk', 'S3 meeting', 'S2u unclassified potential risk', 'S3a imminent meeting transition',
  'S4 deadline inside the block', 'S5 protected block', 'S6 judgement waiting', 'S7 top item', 'S8 protected diary time',
  'S9 block about to start', 'S10 ritual', 'S11 nothing',
]);

const LINKS = require('./neuro-links.cjs');
const DISPLAY = require('./display-text.cjs');
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
    const dp = c.display;
    if (!isObj(dp) || !['title', 'timing', 'explanation'].every((x) => dp[x] === null || typeof dp[x] === 'string')) return refuse(F, `${at}.display missing (title / timing / explanation)`, input.contract);
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
  // C3: every rail section says whether it was read, with a reason when not.
  if (!isObj(d.known)) return refuse(F, 'known missing', d.contract);
  for (const s of ['protected', 'held', 'judgement', 'next']) {
    const k = d.known[s];
    if (!isObj(k) || typeof k.known !== 'boolean') return refuse(F, `known.${s} missing`, d.contract);
    if (k.known === false && !isStr(k.why)) return refuse(F, `known.${s} is not read but gives no reason`, d.contract);
  }
  // C5: display text exists and carries nothing a person shouldn't read.
  const disp = d.display;
  if (!isObj(disp) || !isObj(disp.lead) || !isStr(disp.lead.sentence)) return refuse(F, 'display.lead missing', d.contract);
  const strings = [disp.lead.title, disp.lead.sentence, disp.lead.when, disp.protected && disp.protected.what, disp.next && disp.next.title, disp.next && disp.next.when,
    ...(Array.isArray(disp.held) ? disp.held.flatMap((h) => [h.title, h.why, h.returns]) : []),
    ...(Array.isArray(disp.judgement) ? disp.judgement.flatMap((j) => [j.what, j.by, j.basis]) : [])];
  const bad = strings.find((s) => s != null && !DISPLAY.isSafeDisplay(s));
  if (bad !== undefined) return refuse(F, 'display carries a raw id, timestamp or internal type', d.contract);
  return { ok: true, family: F, contract: d.contract };
}

/**
 * Check the device's declared apps (saim-device-v1). Per app: id, label,
 * capabilities, available, running / foreground (true / false / null = unknown).
 * `observedAt` is when the agent last reported; `known: false` = unreachable.
 */
function checkDevice(dev) {
  const F = 'saim-device';
  if (!isObj(dev)) return refuse(F, 'not an object', dev === null ? null : typeof dev);
  if (!SUPPORTED[F].includes(dev.contract)) return refuse(F, 'unsupported contract', dev.contract == null ? null : String(dev.contract));
  if (typeof dev.known !== 'boolean') return refuse(F, 'known is not a boolean', dev.contract);
  if (!(dev.observedAt === null || isStr(dev.observedAt))) return refuse(F, 'observedAt is not a time or null', dev.contract);
  if (!Array.isArray(dev.apps)) return refuse(F, 'apps is not a list', dev.contract);
  const seen = new Set();
  for (let i = 0; i < dev.apps.length; i += 1) {
    const a = dev.apps[i]; const at = `apps[${i}]`;
    if (!isObj(a) || !isStr(a.id) || !isStr(a.label)) return refuse(F, `${at} needs an id and a label`, dev.contract);
    if (seen.has(a.id)) return refuse(F, `${at}.id "${a.id}" is declared twice`, dev.contract);
    seen.add(a.id);
    if (!Array.isArray(a.capabilities) || a.capabilities.some((c) => !CAPABILITIES.includes(c))) return refuse(F, `${at}.capabilities has an unknown capability`, dev.contract);
    if (typeof a.available !== 'boolean') return refuse(F, `${at}.available is not a boolean`, dev.contract);
    for (const k of ['running', 'foreground']) if (!(a[k] === null || typeof a[k] === 'boolean')) return refuse(F, `${at}.${k} is not true/false/null`, dev.contract);
  }
  return { ok: true, family: F, contract: dev.contract };
}

const DEST_TYPES = new Set(['desk', 'already', 'link', 'elsewhere']);
/** Check a resolver output (saim-handoff-v1) — for the adapter, when built. */
function checkHandoff(h) {
  const F = 'saim-handoff';
  if (!isObj(h)) return refuse(F, 'not an object', h === null ? null : typeof h);
  if (!SUPPORTED[F].includes(h.contract)) return refuse(F, 'unsupported contract', h.contract == null ? null : String(h.contract));
  if (h.owner !== 'saim' || !isStr(h.resolverVersion)) return refuse(F, 'owner/resolverVersion missing', h.contract);
  if (h.handoff === null) {
    if (!isStr(h.reason)) return refuse(F, 'no hand-off without a reason', h.contract);
    if (h.ask != null) {
      const a = h.ask;
      const CHOICES = [...ACTIVITIES, 'unsure'];
      if (!isObj(a) || !isStr(a.question) || !Number.isInteger(a.taskId) || !Array.isArray(a.options) || !a.options.length) return refuse(F, 'ask malformed', h.contract);
      if (a.options.some((o) => !isObj(o) || !CHOICES.includes(o.choice) || !isStr(o.label))) return refuse(F, 'ask option malformed', h.contract);
      if (a.options[a.options.length - 1].choice !== 'unsure') return refuse(F, 'the last ask option must be "Not sure"', h.contract);
      if (new Set(a.options.map((o) => o.choice)).size !== a.options.length) return refuse(F, 'an ask option repeats', h.contract);
    }
    return { ok: true, family: F, contract: h.contract };
  }
  if (!isObj(h.handoff) || !isObj(h.handoff.primary) || !Array.isArray(h.handoff.alternatives)) return refuse(F, 'handoff malformed', h.contract);
  if (h.handoff.alternatives.length > 3) return refuse(F, 'more than three alternatives', h.contract);
  for (const d of [h.handoff.primary, ...h.handoff.alternatives]) {
    if (!isObj(d) || !isStr(d.label) || !isObj(d.target) || !DEST_TYPES.has(d.target.type)) return refuse(F, 'destination malformed', h.contract);
    if (d.name !== undefined && !isStr(d.name)) return refuse(F, 'destination name malformed', h.contract);
  }
  if (h.handoff.alternatives.some((d) => d.target.type === 'already')) return refuse(F, 'an "already open" app is never an alternative', h.contract);
  return { ok: true, family: F, contract: h.contract };
}

module.exports = {
  NEURO_CANDIDATES, SAIM_ATTENTION, SAIM_DEVICE, SAIM_HANDOFF, SUPPORTED, CANDIDATE_KINDS, ATTENTION_RULES,
  INTENT_KINDS, ACTIVITIES, TARGET_ROLES, CAPABILITIES,
  checkCandidates, checkAttention, checkDevice, checkHandoff,
  handoffProblem: (c) => intentProblem(c && c.handoffIntent, 'handoffIntent') || targetsProblem(c && c.targets, 'targets') || gapsProblem(c && c.handoffGaps, 'handoffGaps') || suggestionsProblem(c && c.activitySuggestions, 'activitySuggestions'),
  GAP_FIELDS,
  targetsProblem,
};
