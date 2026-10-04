'use strict';

/**
 * Situation synthesis (Build 12.3A–C) — the presentation's facts, combined into
 * a few statements about Nick's situation.
 *
 * Build 12.2 drew the presentation cleanly and the live Sunday still read as a
 * status page: a headline, then "Hiking · Saturday", then "Home · Living Room
 * 20° · 17° outside", then "Helen and Isaac are home", then a sleep line, then
 * a separate health dial ("Elevated / recovered 27"). Every fragment was true
 * and each had been interpreted once; nothing had put them TOGETHER. This
 * module is that step: it groups related facts into at most three THEMES, each
 * a short statement with the facts underneath it.
 *
 * ⚠ DETERMINISTIC TEMPLATES, NEVER A MODEL. Every sentence here is one of a
 *   small set of fixed phrasings filled from fields the server already set. A
 *   synthesis that could write anything could write something untrue, and this
 *   is the screen he trusts at a glance.
 * ⚠ IT RE-GROUPS, IT DOES NOT RE-JUDGE. Which facts matter was decided upstream
 *   (attention, life-state, `stress-score.isNotable`, `rhythm-read`'s sleep
 *   `notable`, presentation-intent's promotion bands). A fact enters a theme
 *   only through one of those decisions; nothing here lowers a bar to fill a
 *   slot. Unpromoted telemetry (an ordinary room temperature, the outside
 *   temperature, a normal night) goes to `hidden`, with its ref, so a renderer
 *   can still offer it behind "why" — it is never thrown away.
 * ⚠ NO CAUSALITY, NO DIAGNOSIS, NO ADVICE. The recovery theme says what the
 *   HRV-vs-baseline read says and carries stress-score's own caveats verbatim.
 *   It never links a short night to a low HRV, never says ill, never says rest.
 * ⚠ THEME TYPES ARE A FIXED LIST (`THEME_TYPES`). An unrecognised fact is
 *   hidden, never given a category invented at runtime. `work` and `personal`
 *   are deliberately absent: the presentation does not carry a domain, and
 *   guessing one from a title is the inference Build 10 forbade.
 * ⚠ ORDER IS SEMANTIC AND DECIDED HERE: priority class first (P0 > P1 > P2 >
 *   P3), then the fixed `THEME_TYPES` order. A renderer draws them in the order
 *   given and never re-sorts.
 * ⚠ PURE. Presentation + canonical payload in, synthesis out.
 */

const CONTRACT = 'synthesis-v1';

// The fixed vocabulary, in tie-break order within a priority class.
const THEME_TYPES = ['degraded', 'schedule', 'commitments', 'weather', 'recovery', 'presence'];

// How many themes each mode has room for. P0 outranks every theme, so when
// something needs him the themes shrink to one; a degraded read gets one, which
// is its own honesty.
const THEME_CAP = {
  'needs-attention': 1,
  degraded: 1,
  'in-meeting': 1,
  upcoming: 2,
  focus: 2,
};
const DEFAULT_CAP = 3;

const PRIORITY_RANK = { P0: 0, P1: 1, P2: 2, P3: 3, P4: 4 };

const TRAVEL_SENTENCE = {
  driving: 'You’re on the road.',
  walking: 'You’re out walking.',
  exercising: 'You’re exercising.',
};

/** "Helen" → "Helen is home too." / ["Helen","Isaac"] → "Helen and Isaac are home too." PURE. */
function householdSentence(who) {
  if (!Array.isArray(who) || !who.length) return null;
  const names = who.filter((n) => typeof n === 'string' && n.trim());
  if (!names.length) return null;
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return `${list} ${names.length === 1 ? 'is' : 'are'} home too.`;
}

/** "Saturday" out of "Sat 09:00" / "Saturday" / "Tomorrow 09:00" / "in 20 min". PURE. */
const DAY_ABBR = { Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday', Fri: 'Friday', Sat: 'Saturday', Sun: 'Sunday' };
function scheduleLabel(when) {
  if (!when) return 'Next';
  const first = String(when).split(' ')[0];
  if (DAY_ABBR[first]) return DAY_ABBR[first];
  if (/^(Today|Tomorrow|Now)$/.test(first) || Object.values(DAY_ABBR).includes(first)) return first;
  if (/^in$|^Starting$/.test(first)) return 'Soon';
  return 'Next';
}
/** The time part left after the day word, if any ("Sat 09:00" → "09:00"). PURE. */
function scheduleTime(when) {
  if (!when) return null;
  const parts = String(when).split(' ');
  const first = parts[0];
  if (DAY_ABBR[first] || /^(Today|Tomorrow)$/.test(first) || Object.values(DAY_ABBR).includes(first)) {
    return parts.slice(1).join(' ') || null;
  }
  return when;
}

function ev(ref, kind, label, source) {
  return { ref, kind, label, source: source || null };
}

// ── theme builders (each returns a theme or null) ───────────────────────────

function degradedTheme(pres) {
  if (pres.mode !== 'degraded') return null;
  const h = pres.situation && pres.situation.honesty;
  return {
    id: 'theme:degraded',
    type: 'degraded',
    label: 'What I can’t see',
    headline: (pres.situation && pres.situation.summary) || 'I can’t read enough to be sure.',
    summary: h && h.cannotSee && h.cannotSee.length ? `Couldn’t read: ${h.cannotSee.join(', ')}.` : null,
    lines: [],
    priority: 'P1',
    confidence: 'low',
    evidenceRefs: ['situation.honesty'],
    evidence: [ev('situation.honesty', 'honesty', h && h.say ? h.say : 'Too little answered.', 'presentation')],
  };
}

/** The next thing — the item the situation is about if it is in Next, else Next's first. */
function scheduleTheme(pres, used) {
  const next = Array.isArray(pres.next) ? pres.next : [];
  const about = pres.situation && pres.situation.about;
  const pick = next.find((n) => about && n.id === about) || next[0];
  if (!pick) return null;
  // ⚠ SAID ONCE. When the situation's own sentence is about this item (an
  //   upcoming meeting: "Standup starts in 20 minutes.") a theme repeating it
  //   is the duplication Build 12 removed.
  if (about && pick.id === about && pres.situation.summary) return null;
  used.add(pick.id);
  const isCommitment = pick.kind === 'commitment' || pick.kind === 'task';
  const others = next.filter((n) => n.id !== pick.id).length;
  return {
    id: `theme:${isCommitment ? 'commitments' : 'schedule'}`,
    type: isCommitment ? 'commitments' : 'schedule',
    label: isCommitment ? (pick.when ? `Due ${pick.when}` : 'Due') : scheduleLabel(pick.when),
    headline: pick.title || 'Untitled',
    summary: isCommitment ? (pick.summary || null) : scheduleTime(pick.when),
    lines: [],
    more: others,
    itemRef: pick.id,
    priority: 'P2',
    confidence: 'high',
    evidenceRefs: [`next:${pick.id}`],
    evidence: [ev(`next:${pick.id}`, pick.kind, [pick.title, pick.when].filter(Boolean).join(' · '), pick.kind === 'event' ? 'calendar' : pick.kind)],
  };
}

function weatherTheme(pres, used) {
  const rain = (pres.observations || []).find((o) => o.id === 'rain' && o.promoted);
  if (!rain) return null;
  used.add('rain');
  return {
    id: 'theme:weather', type: 'weather', label: 'Weather',
    headline: rain.title, summary: rain.summary || null, lines: [],
    priority: 'P2', confidence: 'medium',
    evidenceRefs: ['observation:rain'],
    evidence: [ev('observation:rain', 'weather', rain.title, 'forecast')],
  };
}

/**
 * The body, ONLY when something upstream already decided it is worth saying:
 * `readiness.notable` (stress-score's ladder — everything but "Balanced") or
 * a sleep observation the presentation promoted (`lastNight.notable`).
 */
function recoveryTheme(pres, payload, used) {
  const r = payload && payload.readiness;
  const readinessNotable = !!(r && r.known === true && r.notable === true
    && Number.isFinite(r.hrv) && Number.isFinite(r.baselineMs) && Number.isFinite(r.deviation));
  const sleepObs = (pres.observations || []).find((o) => o.id === 'sleep' && o.promoted);
  if (!readinessNotable && !sleepObs) return null;
  const sleepCtx = (pres.context || []).find((c) => c.id === 'sleep');
  const evidence = [];
  const lines = [];
  let headline; let summary = null; let label;
  if (readinessNotable) {
    // ⚠ The direction is the sign of stress-score's own HRV z-score against his
    //   14-day baseline — its whole model. "Lower" means HRV below baseline and
    //   nothing more; no cause, no advice.
    label = 'Recovery';
    headline = r.deviation < 0 ? 'Lower than usual' : 'Higher than usual';
    summary = `HRV ${r.hrv}ms vs ${r.baselineMs} baseline`;
    evidence.push(ev('readiness', 'readiness', `${r.label || 'Off baseline'} — HRV ${r.hrv}ms against a ${r.baselineDays || 14}-day baseline of ${r.baselineMs}ms`, 'apple-health'));
    used.add('readiness');
  } else {
    label = 'Last night';
    headline = sleepObs.title;
    summary = sleepObs.summary || null;
  }
  // The night is the same body read — kept with it rather than as its own line.
  const night = sleepObs || sleepCtx;
  if (night) {
    if (readinessNotable) lines.push([night.title || night.label, night.summary || night.detail].filter(Boolean).join(' — '));
    evidence.push(ev('sleep', 'sleep', [night.title || night.label, night.summary || night.detail].filter(Boolean).join(' — '), 'apple-health'));
    used.add('sleep');
  }
  for (const c of (r && Array.isArray(r.caveats) ? r.caveats : [])) lines.push(c);
  return {
    id: 'theme:recovery', type: 'recovery', label, headline, summary, lines,
    priority: 'P2',
    // A wrist sensor read against a personal baseline: never better than medium,
    // and stress-score's own caveat (exercise reads like stress) travels with it.
    confidence: 'medium',
    evidenceRefs: evidence.map((e) => e.ref),
    evidence,
  };
}

function presenceTheme(pres, payload, used) {
  const life = (payload && payload.life) || {};
  const place = life.place || {};
  const doing = life.declared ? life.declared.doing : life.doing;
  const lines = [];
  const evidence = [];
  let label; let headline;
  if (place.kind === 'home') { label = 'Home'; headline = 'You’re home.'; }
  else if (place.kind === 'work') { label = 'Work'; headline = 'You’re at work.'; }
  else if (place.kind === 'out') { label = 'Out'; headline = TRAVEL_SENTENCE[doing] || 'You’re out.'; }
  else return null;
  evidence.push(ev('context:place', 'place', place.label || label, 'life-state'));
  used.add('place');
  const hh = life.household;
  if (place.kind === 'home' && hh && hh.othersHome && Array.isArray(hh.who)) {
    const s = householdSentence(hh.who);
    if (s) { lines.push(s); evidence.push(ev('context:household', 'household', s, 'home-assistant')); used.add('household'); }
  }
  // A room temperature presentation-intent PROMOTED (outside its band) belongs
  // here; an ordinary one is telemetry and stays hidden.
  const roomObs = (pres.observations || []).find((o) => o.id === 'room-temp' && o.promoted);
  let priority = 'P3';
  if (roomObs) {
    lines.push([roomObs.title, roomObs.summary].filter(Boolean).join('. '));
    evidence.push(ev('observation:room-temp', 'room', roomObs.title, 'home-assistant'));
    used.add('room-temp');
    priority = 'P2';
  }
  const conf = String(life.confidence || '').toLowerCase();
  return {
    id: 'theme:presence', type: 'presence', label, headline, summary: null, lines,
    priority,
    confidence: life.declared ? 'high' : (['high', 'medium', 'low'].includes(conf) ? conf : 'medium'),
    evidenceRefs: evidence.map((e) => e.ref),
    evidence,
  };
}

/**
 * Compose the synthesis. PURE.
 * @param {object} pres     presentation-v1 (already composed)
 * @param {object} payload  the canonical Now payload it was composed from
 */
function synthesise(pres, payload = {}) {
  if (!pres || !pres.situation) return null;
  const used = new Set();
  const candidates = [
    degradedTheme(pres),
    scheduleTheme(pres, used),
    weatherTheme(pres, used),
    recoveryTheme(pres, payload, used),
    pres.mode === 'degraded' ? null : presenceTheme(pres, payload, used),
  ].filter(Boolean);

  candidates.sort((a, b) => (PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority])
    || (THEME_TYPES.indexOf(a.type) - THEME_TYPES.indexOf(b.type)));
  const cap = THEME_CAP[pres.mode] ?? DEFAULT_CAP;
  const themes = candidates.slice(0, cap);
  const cut = candidates.slice(cap).map((t) => ({ ref: t.id, kind: t.type, label: t.headline, why: 'over the theme budget for this mode' }));

  // Everything not drawn into a theme, by ref, so "why" can still show it.
  const hidden = [...cut];
  for (const c of pres.context || []) {
    if (c.kind === 'activity') continue; // lives on the correction line
    if (!used.has(c.id)) hidden.push({ ref: `context:${c.id}`, kind: c.kind, label: c.value ? `${c.label} ${c.value}` : c.label, why: 'ordinary — not unusual enough to say' });
  }
  for (const o of pres.observations || []) {
    if (!used.has(o.id)) hidden.push({ ref: `observation:${o.id}`, kind: o.kind, label: o.title, why: o.promoted ? 'over the theme budget for this mode' : 'not promoted' });
  }
  const r = payload && payload.readiness;
  if (r && r.known === true && !used.has('readiness') && Number.isFinite(r.hrv)) {
    hidden.push({ ref: 'readiness', kind: 'readiness', label: `${r.label || 'Reading'} — HRV ${r.hrv}ms`, why: r.notable ? 'over the theme budget for this mode' : 'on his usual baseline' });
  }

  const s = pres.situation;
  return {
    contract: CONTRACT,
    situation: {
      mode: pres.mode,
      headline: s.headline,
      summary: s.summary || null,
      tone: s.tone || null,
      attentionLevel: s.attentionLevel || null,
      about: s.about || null,
      complete: !!(s.honesty && s.honesty.complete),
    },
    themes,
    hidden,
  };
}

module.exports = { CONTRACT, THEME_TYPES, THEME_CAP, DEFAULT_CAP, synthesise, householdSentence, scheduleLabel, scheduleTime };
