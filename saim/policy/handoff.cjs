'use strict';

/**
 * SAiM hand-off resolver — `saim-handoff-v1`. OWNED BY SAiM (C4, 15 Oct 2026).
 * Design: vault "NEURO-SAIM — SAiM Desktop Manifestation Implementation
 * Readiness" §2.1 (approved with the device-state amendment).
 *
 * "Open [app]" is how SAiM turns an attention decision into progress. This
 * decides WHERE Nick should go for the lead SAiM already chose — and nothing
 * else. It never picks the lead, never records state, never approves.
 *
 * Who owns what:
 *   NEURO   — the structured intent on each candidate (`handoffIntent`) and the
 *             canonical links / external targets (`targets`, and
 *             `constraints.targets` for the place to look when blind);
 *   device  — which apps exist, are available, running or in front, and when
 *             that was observed (`saim-device-v1`);
 *   SAiM    — the recommendation: the ACTIVITY table below and the rules.
 *
 * Inputs are VALIDATED first (shared/attention-contracts.cjs). An incompatible
 * contract is refused — `handoff: null` with `refused` — never guessed around.
 * NEURO's OPTIONAL hand-off fields are different: a malformed intent or link on
 * the lead (or a malformed `constraints.targets` when blind) degrades to "no
 * hand-off" with the reason. It never refuses the attention payload, and the
 * policy's decision stands — a bad link is not blindness. A list with any
 * malformed entry is not used at all: half of a bad list is not a link to trust.
 *
 * ⚠ IT NEVER READS RAW TITLES, TEXT, DESCRIPTIONS OR EXPLANATIONS. It reads a
 * candidate's id, kind, handoffIntent and targets; a decision's lead ref/rule
 * and surface; the device's declared apps. Labels on screen come from NEURO's
 * target labels and the device's app labels — never from a task's wording.
 * Pinned by a randomised-title test and a source scan.
 *
 * PURE: no I/O, no clock (`now` is passed), nothing from backend/.
 */

const CONTRACTS = require('../../shared/attention-contracts.cjs');
const { SURFACES } = require('./attention-policy.cjs');

const CONTRACT = CONTRACTS.SAIM_HANDOFF;
const RESOLVER_VERSION = '2026-10-15.2';
const MAX_ALTERNATIVES = 3;

/**
 * How old a device observation may be before its app state is not trusted.
 * Mirrors desktop-activity's FRESH_MINUTES (pinned equal by a test).
 */
const DEVICE_FRESH_MINUTES = 8;

/**
 * SAiM's recommendation table. `needs`: capabilities that can do the step, in
 * preference order (the primary). `also`: at most one further relevant
 * capability. `ai` / `music`: whether they help this step.
 */
const ACTIVITY = Object.freeze({
  draft:       { needs: ['ai'],             also: 'docs',    ai: true,  music: true },
  write:       { needs: ['docs'],           also: 'notes',   ai: true,  music: true },
  spreadsheet: { needs: ['sheets'],         also: 'docs',    ai: true,  music: false },
  email:       { needs: ['mail'],           also: null,      ai: false, music: false },
  code:        { needs: ['code'],           also: 'browser', ai: true,  music: true },
  read:        { needs: ['docs', 'browser'], also: null,     ai: false, music: true },
  call:        { needs: ['meeting:teams'],  also: null,      ai: false, music: false },
});

const ms = (iso) => { const t = Date.parse(iso || ''); return Number.isFinite(t) ? t : null; };

/** The result when there is nowhere honest to send Nick. */
const none = (base, reason, basis = []) => ({ ...base, handoff: null, reason, basis });

/**
 * @param {{ decision, candidates, device, now }} input
 *   decision   saim-attention-v1 (validated)
 *   candidates neuro-candidates-v2 (validated)
 *   device     saim-device-v1 (validated)
 */
function resolveHandoff({ decision, candidates, device, now = Date.now() } = {}) {
  const base = { contract: CONTRACT, owner: 'saim', resolverVersion: RESOLVER_VERSION, decidedAt: new Date(now).toISOString(), decidedFor: null, rule: null };

  // 1. Contracts — refuse anything incompatible, before reading it.
  for (const chk of [CONTRACTS.checkAttention(decision), CONTRACTS.checkCandidates(candidates), CONTRACTS.checkDevice(device)]) {
    if (!chk.ok) {
      return { ...base, handoff: null, reason: 'I can’t work out where to send you — an input didn’t match its contract.', basis: [],
        refused: { family: chk.family, problem: chk.reason, got: chk.got, supported: chk.supported } };
    }
  }
  const lead = decision.lead;
  const out = { ...base, decidedFor: lead.ref, rule: lead.rule };
  if (decision.refused) return none(out, 'SAiM couldn’t read NEURO’s candidates, so there’s nowhere to send you.', ['decision.refused']);

  const byId = new Map(candidates.candidates.map((c) => [c.id, c]));
  const leadCand = lead.ref == null ? null : byId.get(lead.ref);
  if (lead.ref != null && !leadCand) {
    return { ...out, handoff: null, reason: 'I can’t work out where to send you — the decision names something NEURO didn’t send.', basis: [],
      refused: { family: 'saim-handoff', problem: 'decision.lead.ref is not among the candidates', got: lead.ref, supported: CONTRACTS.SUPPORTED['saim-handoff'] } };
  }

  // 2. The device: availability and state, judged once, with its freshness.
  const surface = SURFACES[decision.surface.id];
  const deskLaunch = Boolean(surface && surface.manifestation.deskLaunch);
  const observedAt = ms(device.observedAt);
  const fresh = device.known && observedAt != null && now - observedAt <= DEVICE_FRESH_MINUTES * 60000 && observedAt <= now + 60000;
  const deviceProblem = !device.known ? 'the laptop isn’t reachable' : observedAt == null ? 'the laptop hasn’t said when it last reported' : !fresh ? 'what the laptop last reported is out of date' : null;
  const apps = fresh ? device.apps.filter((a) => a.available) : [];
  const withCap = (cap) => apps.find((a) => a.capabilities.includes(cap)) || null;

  /** A desk app as a destination: already in front, switch to it, or open it. */
  const deskDest = (app) => {
    if (!deskLaunch) return { label: `${app.label}, on the desktop`, target: { type: 'elsewhere', where: 'the desktop', app: app.id } };
    if (app.foreground === true) return { label: `Already open — carry on in ${app.label}`, target: { type: 'already', app: app.id } };
    if (app.running === true) return { label: `Switch to ${app.label}`, target: { type: 'desk', app: app.id, mode: 'switch' } };
    return { label: `Open ${app.label}`, target: { type: 'desk', app: app.id, mode: 'open' } };
  };
  const linkDest = (t, label) => ({ label, target: { type: 'link', href: t.href, role: t.role } });
  const targetOf = (c, role) => (c && Array.isArray(c.targets) ? c.targets.find((t) => t.role === role) : null) || null;

  const done = (primary, alternatives, why, basis) => ({ ...out, handoff: { primary, alternatives: limitAlternatives(primary, alternatives), why }, reason: null, basis });

  const rule = lead.rule;
  const leadProblem = leadCand ? CONTRACTS.handoffProblem(leadCand) : null;
  if (leadProblem) return none(out, 'NEURO’s hand-off details for this are malformed, so SAiM won’t use them.', [`${lead.ref}: ${leadProblem}`]);
  const intent = leadCand && leadCand.handoffIntent ? leadCand.handoffIntent : null;
  if (intent && intent.kind === 'none') return none(out, 'NEURO says there’s nowhere to go for this.', ['handoffIntent.kind = none']);

  // S1 — blind: only where NEURO says the failure can be seen. Never a desk app.
  if (rule === 'S1 blind') {
    const kp = CONTRACTS.targetsProblem(candidates.constraints.targets, 'constraints.targets');
    if (kp) return none(out, 'NEURO’s link for where to look is malformed, so SAiM won’t use it.', [kp]);
    const t = (Array.isArray(candidates.constraints.targets) ? candidates.constraints.targets : []).find((x) => x.role === 'source');
    return t ? done(linkDest(t, `Open ${t.label || 'Sources in NEURO'}`), [], 'Where NEURO shows which feed stopped. SAiM can’t tell which connection failed, so it won’t suggest an app.', ['constraints.targets.source'])
      : none(out, 'NEURO gave no place to look, and SAiM won’t guess one.', ['constraints.targets: no source']);
  }

  // S2 — confirmed risk: the real control surface, else the item in NEURO.
  if (rule === 'S2 critical risk') {
    const t = targetOf(leadCand, 'control') || targetOf(leadCand, 'canonical');
    if (!t) return none(out, 'NEURO gave no link to act on this.', [`${lead.ref}.targets: no control or canonical`]);
    return done(linkDest(t, t.role === 'control' ? `Open ${t.label || 'the control'}` : 'Open it in NEURO'), [], t.role === 'control' ? 'Where this can actually be dealt with.' : 'NEURO is the only place this can be acted on.', [`${lead.ref}.targets.${t.role}`]);
  }

  // S2u — possible risk: the item in NEURO only; SAiM doesn't know the fixer.
  if (rule === 'S2u unclassified potential risk') {
    const t = targetOf(leadCand, 'canonical');
    return t ? done(linkDest(t, 'Open it in NEURO'), [], 'This kind of item isn’t classified, so SAiM doesn’t know which tool fixes it. NEURO holds the item.', [`${lead.ref}.targets.canonical`])
      : none(out, 'NEURO gave no link to this item.', [`${lead.ref}.targets: no canonical`]);
  }

  // S3 / S3a — the meeting: its own app (with state) or join link, and prep.
  if (rule === 'S3 meeting' || rule === 'S3a imminent meeting transition') {
    const join = targetOf(leadCand, 'join');
    const prep = targetOf(leadCand, 'prep');
    const provider = (join && join.provider) || (intent && intent.provider) || null;
    const app = provider ? withCap(`meeting:${provider}`) : null;
    const appDest = app ? deskDest(app) : null;
    const joinDest = join ? linkDest(join, (app && app.label) || join.label ? `Join in ${(app && app.label) || join.label}` : 'Join the meeting') : null;
    const prepDest = prep ? linkDest(prep, 'Open meeting prep') : null;
    const basis = [join && 'targets.join', prep && 'targets.prep', app && `device.${app.id}`].filter(Boolean);
    let order;
    if (rule === 'S3 meeting') {
      order = appDest && appDest.target.type === 'already' ? [appDest, joinDest, prepDest] : [joinDest || appDest, prepDest];
    } else {
      order = [prepDest, appDest && appDest.target.type === 'already' ? null : (joinDest || appDest)];
    }
    order = order.filter(Boolean);
    if (!order.length) {
      const why = !join && !prep && !provider ? 'NEURO gave no join link, prep or meeting app for this.'
        : provider && !app && deviceProblem ? `SAiM can’t offer the meeting app — ${deviceProblem}.`
          : 'Nothing declared on this device can open this meeting.';
      return none(out, why, basis);
    }
    return done(order[0], order.slice(1), rule === 'S3 meeting' ? 'You’re in it — the meeting itself first, then the prep.' : 'Prep first; join when it starts.', basis);
  }

  // S4 / S6 — judgement: exactly that action in NEURO. Never an approve target.
  if (rule === 'S4 deadline inside the block' || rule === 'S6 judgement waiting') {
    const t = targetOf(leadCand, 'canonical');
    return t ? done(linkDest(t, 'Open this in NEURO Actions'), [], 'SAiM doesn’t approve outbound actions — that happens in NEURO, with the approval code.', [`${lead.ref}.targets.canonical`])
      : none(out, 'NEURO gave no link to this exact action.', [`${lead.ref}.targets: no canonical`]);
  }

  // S5 / S7 / S9 — a work step: SAiM's recommendation over declared, available apps.
  if (rule === 'S5 protected block' || rule === 'S7 top item' || rule === 'S9 block about to start') {
    if (!intent || intent.kind !== 'work-step') return none(out, 'NEURO stated no next step to open anything for.', [`${lead.ref}.handoffIntent missing`]);
    const spec = intent.activity ? ACTIVITY[intent.activity] : null;
    if (!spec) return none(out, 'NEURO didn’t say what kind of work this is, so SAiM won’t guess an app.', [`${lead.ref}.handoffIntent.activity = null`]);
    if (deviceProblem) return none(out, `SAiM can’t recommend an app — ${deviceProblem}.`, ['device']);
    const primaryApp = spec.needs.map(withCap).find(Boolean) || null;
    if (!primaryApp) return none(out, `Nothing declared on this device can do this (${spec.needs.join(' or ')}).`, ['device']);
    const alts = [];
    if (spec.ai && !primaryApp.capabilities.includes('ai')) alts.push(withCap('ai'));
    if (spec.music && !primaryApp.capabilities.includes('music')) alts.push(withCap('music'));
    if (spec.also) alts.push(withCap(spec.also));
    return done(deskDest(primaryApp), alts.filter((a) => a && a.id !== primaryApp.id).map(deskDest),
      'The app SAiM recommends for this step, and the ones that help.',
      [`${lead.ref}.handoffIntent.activity = ${intent.activity}`, `device.${primaryApp.id}`]);
  }

  // S8 / S10 / S11 — nothing to launch.
  const why = rule === 'S8 protected diary time' ? 'No task says what this time is for, so there’s no app to send you to.'
    : rule === 'S10 ritual' ? 'The ritual happens in SAiM itself.'
      : 'Nothing needs you, so there’s nowhere to go.';
  return none(out, why, [`rule ${rule}`]);
}

/**
 * THE one place the alternatives contract is enforced: drop empties, "already
 * open" apps (nowhere to go) and duplicates of the primary or each other, keep
 * order, and stop at MAX_ALTERNATIVES. Exported so the cap is exercised
 * directly — the resolver's own rules cannot produce four today.
 */
function limitAlternatives(primary, alternatives) {
  const seen = new Set([key(primary)]);
  const alts = [];
  for (const d of alternatives || []) {
    if (!d || d.target.type === 'already') continue;
    const k = key(d);
    if (seen.has(k)) continue;
    seen.add(k);
    alts.push(d);
    if (alts.length === MAX_ALTERNATIVES) break;
  }
  return alts;
}

function key(d) { return d.target.type === 'link' ? `link:${d.target.href}` : `app:${d.target.app}`; }

module.exports = { CONTRACT, RESOLVER_VERSION, MAX_ALTERNATIVES, DEVICE_FRESH_MINUTES, ACTIVITY, resolveHandoff, limitAlternatives };
