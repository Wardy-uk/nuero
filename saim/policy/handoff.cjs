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
const LINKS = require('../../shared/neuro-links.cjs');
const { SURFACES } = require('./attention-policy.cjs');

const CONTRACT = CONTRACTS.SAIM_HANDOFF;
const RESOLVER_VERSION = '2026-10-16.1';
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

const NO_LAUNCH = Object.freeze({
  'S8 protected diary time': 'No task says what this time is for, so there’s no app to send you to.',
  'S10 ritual': 'The ritual happens in SAiM itself.',
  'S4r short ritual due now': 'The standup happens in SAiM itself; your block picks up straight after.',
  'S11 nothing': 'Nothing needs you, so there’s nowhere to go.',
});

const ms = (iso) => { const t = Date.parse(iso || ''); return Number.isFinite(t) ? t : null; };

/** The result when there is nowhere honest to send Nick. */
const none = (base, reason, basis = []) => ({ ...base, handoff: null, reason, basis });
/** NEURO's own explicit gaps for the lead, attached when there is no hand-off. */
const withGaps = (r, c) => (r.handoff === null && !r.refused && c && Array.isArray(c.handoffGaps) && c.handoffGaps.length ? { ...r, neuroGaps: c.handoffGaps.map((g) => g.field) } : r);

/**
 * @param {{ decision, candidates, device, now }} input
 *   decision   saim-attention-v2 (validated)
 *   candidates neuro-candidates-v2 (validated)
 *   device     saim-device-v1 (validated)
 */
function resolveHandoff(input = {}) {
  const r = resolve(input);
  const c = r.decidedFor && input.candidates && Array.isArray(input.candidates.candidates) ? input.candidates.candidates.find((x) => x.id === r.decidedFor) : null;
  return withGaps(r, c);
}

function resolve({ decision, candidates, device, now = Date.now() } = {}) {
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
    if (!deskLaunch) return { name: app.label, label: `${app.label}, on the desktop`, target: { type: 'elsewhere', where: 'the desktop', app: app.id } };
    if (app.foreground === true) return { name: app.label, label: `Already open — carry on in ${app.label}`, target: { type: 'already', app: app.id } };
    if (app.running === true) return { name: app.label, label: `Switch to ${app.label}`, target: { type: 'desk', app: app.id, mode: 'switch' } };
    return { name: app.label, label: `Open ${app.label}`, target: { type: 'desk', app: app.id, mode: 'open' } };
  };
  // `name` is the destination (shown in the card); `label` is the verb on the button.
  const linkDest = (t, label, name) => ({ name, label, target: { type: 'link', href: t.href, role: t.role } });
  const targetOf = (c, role) => (c && Array.isArray(c.targets) ? c.targets.find((t) => t.role === role) : null) || null;

  const done = (primary, alternatives, why, basis) => ({ ...out, handoff: { primary, alternatives: limitAlternatives(primary, alternatives), why }, reason: null, basis });

  const rule = lead.rule;
  const leadProblem = leadCand ? CONTRACTS.handoffProblem(leadCand) : null;
  if (leadProblem) return none(out, 'NEURO’s hand-off details for this are malformed, so SAiM won’t use them.', [`${lead.ref}: ${leadProblem}`]);
  const intent = leadCand && leadCand.handoffIntent ? leadCand.handoffIntent : null;
  // The rules that never launch anything say their own reason first.
  if (NO_LAUNCH[rule]) return none(out, NO_LAUNCH[rule], [`rule ${rule}`]);
  if (intent && intent.kind === 'none') return none(out, 'NEURO says there’s nowhere to go for this.', ['handoffIntent.kind = none']);

  // S1 — blind: only where NEURO says the failure can be seen. Never a desk app.
  if (rule === 'S1 blind') {
    const kp = CONTRACTS.targetsProblem(candidates.constraints.targets, 'constraints.targets');
    if (kp) return none(out, 'NEURO’s link for where to look is malformed, so SAiM won’t use it.', [kp]);
    const t = (Array.isArray(candidates.constraints.targets) ? candidates.constraints.targets : []).find((x) => x.role === 'source');
    return t ? done(linkDest(t, `Open ${t.label || 'Sources in NEURO'}`, t.label || 'Sources in NEURO'), [], 'Where NEURO shows which feed stopped. SAiM can’t tell which connection failed, so it won’t suggest an app.', ['constraints.targets.source'])
      : none(out, 'NEURO gave no place to look, and SAiM won’t guess one.', ['constraints.targets: no source']);
  }

  // S2 — confirmed risk: the real control surface, else the item in NEURO.
  if (rule === 'S2 critical risk') {
    const t = targetOf(leadCand, 'control') || targetOf(leadCand, 'canonical');
    if (!t) return none(out, 'NEURO gave no link to act on this.', [`${lead.ref}.targets: no control or canonical`]);
    return done(linkDest(t, t.role === 'control' ? `Open ${t.label || 'the control'}` : 'Open it in NEURO', t.role === 'control' ? (t.label || 'The control') : 'This item in NEURO'), [], t.role === 'control' ? 'Where this can actually be dealt with.' : 'NEURO is the only place this can be acted on.', [`${lead.ref}.targets.${t.role}`]);
  }

  // S2u — possible risk: the item in NEURO only; SAiM doesn't know the fixer.
  if (rule === 'S2u unclassified potential risk') {
    const t = targetOf(leadCand, 'canonical');
    return t ? done(linkDest(t, 'Open it in NEURO', 'This item in NEURO'), [], 'This kind of item isn’t classified, so SAiM doesn’t know which tool fixes it. NEURO holds the item.', [`${lead.ref}.targets.canonical`])
      : none(out, 'NEURO gave no link to this item.', [`${lead.ref}.targets: no canonical`]);
  }

  // S3 / S3a — the meeting: its own app (with state) or join link, and prep.
  if (rule === 'S3 meeting' || rule === 'S3a imminent meeting transition') {
    const join = targetOf(leadCand, 'join');
    const prep = targetOf(leadCand, 'prep');
    const provider = (join && join.provider) || (intent && intent.provider) || null;
    const app = provider ? withCap(`meeting:${provider}`) : null;
    const appDest = app ? deskDest(app) : null;
    const joinDest = join ? linkDest(join, (app && app.label) || join.label ? `Join in ${(app && app.label) || join.label}` : 'Join the meeting', (app && app.label) || join.label || 'The meeting') : null;
    const prepDest = prep ? linkDest(prep, 'Open meeting prep', 'Meeting prep') : null;
    const basis = [join && 'targets.join', prep && 'targets.prep', app && `device.${app.id}`].filter(Boolean);
    let order;
    if (rule === 'S3 meeting') {
      order = appDest && appDest.target.type === 'already' ? [appDest, joinDest, prepDest] : [joinDest || appDest, prepDest];
    } else {
      // About to start (16 Oct 2026): the calendar's own join link is the way in when it has one;
      // prep is the second route. Without a join link, prep leads as before (and the gap is said).
      order = joinDest ? [joinDest, prepDest] : [prepDest, appDest && appDest.target.type === 'already' ? null : appDest];
    }
    order = order.filter(Boolean);
    if (!order.length) {
      const why = !join && !prep && !provider ? 'NEURO gave no join link, prep or meeting app for this.'
        : provider && !app && deviceProblem ? `SAiM can’t offer the meeting app — ${deviceProblem}.`
          : 'Nothing declared on this device can open this meeting.';
      return none(out, why, basis);
    }
    return done(order[0], order.slice(1), rule === 'S3 meeting' ? 'You’re in it — the meeting itself first, then the prep.'
      : joinDest ? 'Join from here when it starts; prep is the other way in.' : 'Prep first; join when it starts.', basis);
  }

  // S4 / S6 — judgement: exactly that action in NEURO. Never an approve target.
  if (rule === 'S4 deadline inside the block' || rule === 'S6 judgement waiting') {
    const t = targetOf(leadCand, 'canonical');
    return t ? done(linkDest(t, 'Open this in NEURO Actions', 'This action in NEURO Actions'), [], 'SAiM doesn’t approve outbound actions — that happens in NEURO, with the approval code.', [`${lead.ref}.targets.canonical`])
      : none(out, 'NEURO gave no link to this exact action.', [`${lead.ref}.targets: no canonical`]);
  }

  // S5 / S7 / S9 — a work step: SAiM's recommendation over declared, available apps.
  if (rule === 'S5 protected block' || rule === 'S5f chosen focus' || rule === 'S7 top item' || rule === 'S9 block about to start') {
    if (!intent || intent.kind !== 'work-step') return none(out, 'NEURO stated no next step to open anything for.', [intent ? `${lead.ref}.handoffIntent.kind = ${intent.kind}, not a work step` : `${lead.ref}.handoffIntent missing`]);
    const spec = intent.activity ? ACTIVITY[intent.activity] : null;
    // A task that IS a Jira ticket (16 Oct 2026): the ticket is worked in Jira, so its own
    // page is the primary browser hand-off — from NEURO's structured control target (the
    // jira-tasks ledger / the ticket's own URL, or a strictly recognised key). The key on
    // the button comes from that target's `key` field, never from the task's wording.
    const jira = (Array.isArray(leadCand.targets) ? leadCand.targets : []).find((t) => t.role === 'control' && t.provider === 'jira') || null;
    if (jira) {
      // `key` is checked as a ticket key by the contract (shared/attention-contracts targetProblem).
      const key = typeof jira.key === 'string' && jira.key ? jira.key : null;
      const primary = linkDest(jira, key ? `Open ${key} in Jira` : 'Open the ticket in Jira', key ? `${key} in Jira` : (jira.label || 'The ticket in Jira'));
      const taskLink = targetOf(leadCand, 'canonical');
      const apps = spec && !deviceProblem ? [spec.needs.map(withCap).find(Boolean)].filter(Boolean).map(deskDest) : [];
      return done(primary, [...apps, taskLink ? linkDest(taskLink, 'Open the task in NEURO', 'The task in NEURO') : null],
        'The ticket is worked in Jira; the task stays in NEURO.',
        [`${lead.ref}.targets.control (jira${jira.basis ? `, ${jira.basis}` : ''})`, ...(taskLink ? [`${lead.ref}.targets.canonical`] : [])]);
    }
    if (!spec) {
      const taskLink = targetOf(leadCand, 'canonical');
      // "Not sure — open the task in NEURO": Nick's own answer, so it is a hand-off, not a gap.
      if (intent.unsure && taskLink) {
        return done(linkDest(taskLink, 'Open the task in NEURO', 'The task in NEURO'), [], 'You said you’re not sure what this needs — the task is in NEURO.', [`${lead.ref}.handoffIntent.unsure`]);
      }
      const r = none(out, intent.unsure ? 'You said you’re not sure what this needs, and NEURO gave no link to the task.' : 'NEURO doesn’t know what kind of work this is yet, so SAiM won’t guess an app.', [`${lead.ref}.handoffIntent.activity = null`]);
      const ask = intent.unsure ? null : askFor(leadCand, taskLink, deviceProblem ? null : apps);
      return ask ? { ...r, ask } : r;
    }
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

/**
 * "What will you use?" — SAiM's one-tap question for a task whose activity
 * nobody has stated (option C). Nick answers with an ACTIVITY, stored per task
 * (POST /api/task-activity/:taskId); the app is SAiM's per-device judgement, so
 * an option is labelled with this device's app when one is declared and
 * available, and with the plain activity otherwise. NEURO's suggestions
 * (source / observed) come FIRST and are marked — they are never pre-chosen.
 * The last option is always "Not sure — open the task in NEURO". Only asked
 * when there is one exact task to store the answer against.
 */
const ACTIVITY_WORD = Object.freeze({ draft: 'Drafting with AI', write: 'Writing', spreadsheet: 'A spreadsheet', email: 'Email', code: 'Code', read: 'Reading', call: 'A call' });
function askFor(cand, taskLink, apps) {
  const parsed = taskLink ? LINKS.parseNeuroHref(taskLink.href) : null;
  if (!parsed || !parsed.item || parsed.item.kind !== 'task') return null;
  const suggested = new Map();
  for (const s of (cand && Array.isArray(cand.activitySuggestions) ? cand.activitySuggestions : [])) if (!suggested.has(s.activity)) suggested.set(s.activity, s.basis);
  const order = [...suggested.keys(), ...Object.keys(ACTIVITY).filter((a) => !suggested.has(a))];
  const options = order.map((activity) => {
    const app = apps ? ACTIVITY[activity].needs.map((cap) => apps.find((a) => a.capabilities.includes(cap))).find(Boolean) : null;
    return {
      choice: activity,
      label: app ? app.label : ACTIVITY_WORD[activity],
      ...(app ? { app: app.id } : {}),
      ...(suggested.has(activity) ? { suggested: true, basis: suggested.get(activity) } : {}),
    };
  });
  // Two activities can land on one app (writing and reading are both Word). A repeated
  // label is told apart by the kind of work, or Nick sees two identical buttons.
  const counts = new Map();
  for (const o of options) counts.set(o.label, (counts.get(o.label) || 0) + 1);
  for (const o of options) if (o.app && counts.get(o.label) > 1) o.label = `${o.label} — ${ACTIVITY_WORD[o.choice][0].toLowerCase()}${ACTIVITY_WORD[o.choice].slice(1)}`;
  options.push({ choice: 'unsure', label: 'Not sure — open the task in NEURO' });
  return { question: 'What will you use?', taskId: Number(parsed.item.id), options, deviceSpecific: Boolean(apps) };
}

function key(d) { return d.target.type === 'link' ? `link:${d.target.href}` : `app:${d.target.app}`; }

module.exports = { CONTRACT, RESOLVER_VERSION, MAX_ALTERNATIVES, DEVICE_FRESH_MINUTES, ACTIVITY, resolveHandoff, limitAlternatives };
