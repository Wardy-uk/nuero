'use strict';

/**
 * Capability gaps — "I could do X for you, but I need Y" (13 Oct 2026).
 *
 * Nick: "neuro needs a 'self learning' feature - it should tell me I could do
 * [x] but I need [y] to do it (me to build additional features, more sensors
 * etc)". Then: "it should suggest capabilities — but only those that would
 * actually be useful to me personally", and "ANYTHING it knows about me is game".
 *
 * ── The usefulness test (the whole feature) ────────────────────────────────
 * A suggestion exists only if it can name all three:
 *   1. ANCHOR  — something Nick already cares about, cited by evidence id:
 *                a goal, a profile fact, a health finding, a question he
 *                asked, a time NEURO could not answer him.
 *   2. UNLOCKS — what NEURO could tell or do for him that it cannot today.
 *   3. CHANGES — what he would do differently with that answer.
 * Plus the NEED: what has to happen (build / sensor / setup / purchase /
 * integration) and roughly how big.
 *
 * A model proposes; the server JUDGES (`judge`, PURE). A suggestion citing an
 * id that was not in the evidence pack, or citing no personal anchor, or
 * missing any of the three answers, is REFUSED and the refusal is recorded —
 * the `checkSaimGrounding` rule: a prompt asking for grounding is necessary and
 * not sufficient. The CO2-sensor example that started this conversation is
 * exactly what the anchor rule exists to stop.
 *
 * ── Learning ────────────────────────────────────────────────────────────────
 * Two loops. (1) OBSERVED MISSES: chat replies where she said she could not see
 * or do something are evidence (`miss:*`), paired with the question that
 * prompted them. (2) VERDICTS: a rejection keeps Nick's reason and is shown to
 * the model next time; the same suggestion (by fingerprint) never returns
 * unless the evidence it cites has CHANGED (anchorHash) — a rejection is not a
 * permanent suppression of a need that later becomes real.
 *
 * ── What it never does ──────────────────────────────────────────────────────
 * It writes nothing on a read, notifies nobody, and acts on nothing by itself.
 * Accepting a "build" suggestion files it in the Feature Tracker; accepting any
 * other kind creates one NEURO task. Both are Nick's press.
 *
 * Store: `agent_state.capability_suggestions` (KV — an annotation-sized store,
 * the `ms_task_local` precedent; no schema change).
 */

const crypto = require('crypto');

const STORE_KEY = 'capability_suggestions';
const NEED_KINDS = ['build', 'sensor', 'setup', 'purchase', 'integration'];
const EFFORTS = ['small', 'medium', 'large'];
// Evidence kinds that count as "something Nick cares about". `sense` / `setup`
// / `captured` are context — a sensor being stale is not, by itself, a reason
// he would want anything.
const PERSONAL_KINDS = ['goal', 'profile', 'health', 'asked', 'miss'];
const MAX_SUGGESTIONS_PER_RUN = 8;
const MAX_OPEN = 20;
const MAX_KEPT_DECIDED = 60;
const ASKED_DAYS = 30;
const MISS_RE = /\b(i (?:don['’]t|do not|can['’]t|cannot|couldn['’]t|could not) (?:have|see|access|read|reach|tell|know|check)|no access to|not (?:connected|available) to me|i have no (?:way|data|access)|outside what i can see)\b/i;

// ── pure ────────────────────────────────────────────────────────────────────

const clip = (s, n) => {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** Normalised identity of a suggestion: what is needed, not how it was worded. PURE. */
function fingerprint(s) {
  const words = `${(s.need && s.need.what) || ''}`.toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/)
    .filter((w) => w.length > 2 && !['the', 'and', 'for', 'with', 'your', 'from', 'into', 'that'].includes(w));
  return [...new Set(words)].sort().join(' ') || clip(s.title, 60).toLowerCase();
}

/** Hash of the evidence a suggestion cites, so a rejection can expire when it changes. PURE. */
function anchorHash(anchors, evidenceById) {
  const parts = (anchors || []).slice().sort().map((id) => `${id}=${(evidenceById.get(id) || {}).text || ''}`);
  return crypto.createHash('sha1').update(parts.join('\n')).digest('hex').slice(0, 16);
}

/**
 * The usefulness test. Returns { ok, suggestion } or { ok:false, why }. PURE.
 * `evidenceById`: Map id → { kind, text }.
 */
function judge(raw, evidenceById) {
  if (!raw || typeof raw !== 'object') return { ok: false, why: 'not an object' };
  const title = clip(raw.title, 120);
  const unlocks = clip(raw.unlocks, 400);
  const changes = clip(raw.changes, 400);
  const need = raw.need || {};
  const kind = String(need.kind || '').toLowerCase();
  const what = clip(need.what, 240);
  if (!title) return { ok: false, why: 'no title' };
  if (!unlocks) return { ok: false, why: `"${title}": does not say what it would unlock` };
  if (!changes) return { ok: false, why: `"${title}": does not say what you would do differently` };
  if (!NEED_KINDS.includes(kind)) return { ok: false, why: `"${title}": need kind "${need.kind}" is not one of ${NEED_KINDS.join('/')}` };
  if (!what) return { ok: false, why: `"${title}": does not say what is needed` };
  const anchors = [...new Set((Array.isArray(raw.anchors) ? raw.anchors : []).map(String))];
  if (!anchors.length) return { ok: false, why: `"${title}": cites no evidence` };
  const unknown = anchors.filter((id) => !evidenceById.has(id));
  if (unknown.length) return { ok: false, why: `"${title}": cites evidence that does not exist (${unknown.slice(0, 3).join(', ')})` };
  if (!anchors.some((id) => PERSONAL_KINDS.includes(evidenceById.get(id).kind))) {
    return { ok: false, why: `"${title}": cites nothing you care about — only ${anchors.map((id) => evidenceById.get(id).kind).join('/')}` };
  }
  const effort = EFFORTS.includes(String(need.effort || '').toLowerCase()) ? String(need.effort).toLowerCase() : null;
  return {
    ok: true,
    suggestion: {
      title, unlocks, changes, anchors,
      need: { kind, what, effort, how: clip(need.how, 400) || null },
      anchorText: anchors.map((id) => ({ id, kind: evidenceById.get(id).kind, text: clip(evidenceById.get(id).text, 200) })),
    },
  };
}

/** Parse the model's answer. A truncated or unreadable answer is refused, never partially kept. PURE. */
function parseProposals(text) {
  const t = String(text || '').trim();
  const start = t.indexOf('[');
  const end = t.lastIndexOf(']');
  if (start < 0 || end <= start) return { ok: false, why: 'no JSON array in the answer' };
  try {
    const arr = JSON.parse(t.slice(start, end + 1));
    if (!Array.isArray(arr)) return { ok: false, why: 'answer is not an array' };
    return { ok: true, items: arr };
  } catch (e) {
    return { ok: false, why: `answer did not parse (${e.message})` };
  }
}

/**
 * Fold a run's judged suggestions into the store. PURE (now passed in).
 *  - an open suggestion with the same fingerprint is refreshed in place;
 *  - a rejected one stays suppressed unless the evidence it cites changed;
 *  - accepted / done ones are never re-offered;
 *  - open suggestions that this run did not re-propose are kept (a quiet week
 *    does not withdraw them) but capped at MAX_OPEN, oldest dropped.
 */
function merge(store, judged, now) {
  const items = Array.isArray(store && store.items) ? store.items.map((x) => ({ ...x })) : [];
  const byFp = new Map(items.map((x) => [x.fingerprint, x]));
  const added = [];
  const suppressed = [];
  for (const s of judged) {
    const prior = byFp.get(s.fingerprint);
    if (prior) {
      if (prior.status === 'open') {
        Object.assign(prior, s, { id: prior.id, status: 'open', firstSeenAt: prior.firstSeenAt, lastSeenAt: now, seenCount: (prior.seenCount || 1) + 1 });
        continue;
      }
      if (prior.status === 'rejected' && prior.anchorHash !== s.anchorHash) {
        Object.assign(prior, s, { id: prior.id, status: 'open', reopenedBecause: 'the evidence behind it changed since you rejected it', previousRejection: prior.reason || null, reason: null, decidedAt: null, lastSeenAt: now, seenCount: (prior.seenCount || 1) + 1 });
        added.push(prior.id);
        continue;
      }
      suppressed.push({ title: s.title, status: prior.status });
      continue;
    }
    const id = `cap:${crypto.createHash('sha1').update(s.fingerprint).digest('hex').slice(0, 10)}`;
    const row = { ...s, id, status: 'open', firstSeenAt: now, lastSeenAt: now, seenCount: 1, reason: null, decidedAt: null };
    items.push(row);
    byFp.set(s.fingerprint, row);
    added.push(id);
  }
  const open = items.filter((x) => x.status === 'open').sort((a, b) => String(b.lastSeenAt).localeCompare(String(a.lastSeenAt)));
  const decided = items.filter((x) => x.status !== 'open').sort((a, b) => String(b.decidedAt || '').localeCompare(String(a.decidedAt || '')));
  return { items: [...open.slice(0, MAX_OPEN), ...decided.slice(0, MAX_KEPT_DECIDED)], added, suppressed };
}

/** Compose the prompt from the evidence pack and past verdicts. PURE. */
function buildPrompt({ evidence, decided, captured }) {
  const lines = [];
  lines.push('You are SAiM, the assistant layer of NEURO — Nick Ward\'s personal system (Head of Technical Support, neurodivergent: his difficulty is starting things, not knowing them).');
  lines.push('NEURO already sees: his calendars, work email, Jira escalations, Obsidian vault, Apple Health (Watch, HiLo blood pressure, MyFitnessPal), phone location and state, the laptop\'s foreground app, Home Assistant (lights, Hive heating, presence, room sensors), a weather station, his car journeys, his finances via Tally.');
  lines.push('');
  lines.push('Task: suggest capabilities NEURO does NOT have yet that would be genuinely useful to Nick personally — features he could build, sensors he could fit, setup steps, purchases or integrations.');
  lines.push('');
  lines.push('THE USEFULNESS TEST — every suggestion must pass all three or must not be written:');
  lines.push('1. anchors: cite evidence ids below. At least one must be a goal, profile, health, asked or miss item — something HE cares about. Never suggest a generic gadget ("a CO2 sensor would let me tell you to open a window") unless his own evidence points at it.');
  lines.push('2. unlocks: the specific thing NEURO could then tell him or do, that it cannot today.');
  lines.push('3. changes: what he would actually do differently with that. If nothing would change, drop the idea.');
  lines.push('Prefer the cheapest need that unlocks it. Do not suggest anything already set up, already captured in the tracker, or already rejected for the same reason. Do not diagnose health conditions; a health anchor is a reason to measure, not a verdict.');
  lines.push('');
  lines.push('EVIDENCE (id — kind — text):');
  for (const e of evidence) lines.push(`${e.id} — ${e.kind} — ${clip(e.text, 300)}`);
  if (captured.length) {
    lines.push('');
    lines.push('ALREADY IN HIS FEATURE TRACKER (do not re-suggest):');
    for (const c of captured) lines.push(`- ${clip(c, 160)}`);
  }
  if (decided.length) {
    lines.push('');
    lines.push('PAST VERDICTS (learn from these — a rejection reason tells you what he does not value):');
    for (const d of decided) lines.push(`- ${d.status.toUpperCase()}: "${clip(d.title, 120)}"${d.reason ? ` — his reason: ${clip(d.reason, 200)}` : ''}`);
  }
  lines.push('');
  lines.push(`Answer with ONLY a JSON array (at most ${MAX_SUGGESTIONS_PER_RUN}, fewer is fine, [] is fine), best first. Each element:`);
  lines.push('{"title": "...", "anchors": ["id", ...], "unlocks": "...", "changes": "...", "need": {"kind": "build|sensor|setup|purchase|integration", "what": "...", "how": "one concrete first step", "effort": "small|medium|large"}}');
  lines.push('Write to Nick in plain British English, second person, no hedging, no praise.');
  return lines.join('\n');
}

// ── evidence ────────────────────────────────────────────────────────────────

/** Everything NEURO knows that could anchor a suggestion. Never throws; every unreadable source is a named gap. */
async function gatherEvidence({ now = new Date() } = {}) {
  const evidence = [];
  const gaps = [];
  const add = (id, kind, text) => { if (text) evidence.push({ id, kind, text: clip(text, 400) }); };
  const tryRead = async (name, fn) => { try { await fn(); } catch (e) { gaps.push(`${name}: ${e.message}`); } };

  await tryRead('goals', async () => {
    const goals = require('./canonical-read').listGoals({ status: 'active' }) || [];
    goals.forEach((g, i) => add(`goal:${i + 1}`, 'goal', `${g.title}${g.importance ? ` (${g.importance})` : ''}${g.description ? ` — ${g.description}` : ''}`));
  });

  await tryRead('profile', async () => {
    const r = require('./profile').read();
    if (!r.ok) throw new Error(r.why || 'unreadable');
    const facts = (r.profile && r.profile.facts) || {};
    let n = 0;
    for (const [section, list] of Object.entries(facts)) {
      for (const f of list || []) {
        if (n >= 60) break;
        n += 1;
        add(`profile:${n}`, 'profile', `${section}: ${f.text || f.fact || f}`);
      }
    }
  });

  await tryRead('health', async () => {
    const pic = require('./health-picture').read({ now });
    // Unread inputs already arrive as `gap` insights, so they are evidence too.
    (pic.insights || []).forEach((i, k) => add(`health:${k + 1}`, 'health', `[${i.level}] ${i.title}. ${i.finding || ''}`));
  });

  await tryRead('senses', async () => {
    const snap = require('./signals').snapshot(now);
    (snap.signals || []).filter((s) => s.state && s.state !== 'live').forEach((s, k) => {
      add(`sense:${k + 1}`, 'sense', `${s.label} is ${s.state} — it is how NEURO knows ${s.what}${s.why ? ` (${s.why})` : ''}`);
    });
  });

  await tryRead('setup', async () => {
    const st = await require('./setup-check').check();
    (st.items || []).filter((i) => i.status !== 'done' && i.status !== 'skipped').forEach((i, k) => {
      add(`setup:${k + 1}`, 'setup', `${i.title} (${i.status}, ${i.need}) — ${i.why} ${i.evidence || ''}`);
    });
  });

  await tryRead('chat', async () => {
    const rows = require('../db/database').getDb().prepare(
      `SELECT conversation_id, role, content, created_at FROM conversations
        WHERE created_at >= datetime('now', ?) ORDER BY id ASC`
    ).all(`-${ASKED_DAYS} days`);
    const lastUser = new Map();
    let asked = 0;
    let missed = 0;
    for (const r of rows) {
      if (r.role === 'user') {
        lastUser.set(r.conversation_id, r.content);
        const q = clip(r.content, 200);
        if (q.length >= 12 && asked < 40) { asked += 1; add(`asked:${asked}`, 'asked', `${String(r.created_at).slice(0, 10)}: ${q}`); }
      } else if (MISS_RE.test(r.content) && missed < 20) {
        missed += 1;
        const q = lastUser.get(r.conversation_id);
        const m = r.content.match(MISS_RE);
        const at = Math.max(0, m.index - 80);
        add(`miss:${missed}`, 'miss', `${String(r.created_at).slice(0, 10)}: he asked "${clip(q || '?', 160)}" and she answered "…${clip(r.content.slice(at, at + 220), 220)}"`);
      }
    }
  });

  let captured = [];
  await tryRead('feature tracker', async () => {
    const r = require('./feature-tracker').listCaptured({ limit: 50 });
    if (!r.ok) throw new Error(r.error || 'unreadable');
    captured = (r.items || []).map((x) => x.title || x.text || String(x));
  });

  return { evidence, gaps, captured };
}

// ── store ───────────────────────────────────────────────────────────────────

function _db() { return require('../db/database'); }

function load() {
  const raw = _db().getState(STORE_KEY);
  if (!raw) return { items: [], lastRun: null };
  try {
    const v = JSON.parse(raw);
    return { items: Array.isArray(v.items) ? v.items : [], lastRun: v.lastRun || null };
  } catch {
    // An unreadable store is never overwritten by an empty one.
    const e = new Error('the capability store is unreadable');
    e.unreadable = true;
    throw e;
  }
}

function save(store) { _db().setState(STORE_KEY, JSON.stringify(store)); }

/** The read model. Writes nothing. */
function list() {
  let store;
  try { store = load(); } catch (e) { return { ok: false, known: false, why: e.message, open: [], decided: [], lastRun: null }; }
  const open = store.items.filter((x) => x.status === 'open');
  const decided = store.items.filter((x) => x.status !== 'open');
  return { ok: true, known: true, open, decided, lastRun: store.lastRun, needKinds: NEED_KINDS };
}

let _running = false;

/**
 * Gather, ask, judge, merge. `ask(prompt)` is injectable for tests; the default
 * is a cloud call (forceCloud — the Pi's local models cannot reason over this).
 */
async function refresh({ now = new Date(), ask = null } = {}) {
  if (_running) return { ok: false, why: 'a refresh is already running' };
  _running = true;
  const at = now.toISOString();
  try {
    let store;
    try { store = load(); } catch (e) { return { ok: false, why: e.message }; }
    const pack = await gatherEvidence({ now });
    const evidenceById = new Map(pack.evidence.map((e) => [e.id, e]));
    if (!pack.evidence.some((e) => PERSONAL_KINDS.includes(e.kind))) {
      const lastRun = { at, ok: false, why: 'nothing personal could be read to anchor a suggestion on', gaps: pack.gaps, proposed: 0, kept: 0, refused: [] };
      save({ ...store, lastRun });
      return { ok: false, ...lastRun };
    }
    const decided = store.items.filter((x) => x.status !== 'open').slice(0, 30);
    const prompt = buildPrompt({ evidence: pack.evidence, decided, captured: pack.captured });
    let text;
    try {
      if (ask) text = await ask(prompt);
      else {
        const r = await require('./ai-routing').runTask('capability_suggestions', { prompt, maxTokens: 3000 }, { forceCloud: true });
        if (!r || !r.text) throw new Error((r && r.reason) || 'no AI provider answered');
        text = r.text;
      }
    } catch (e) {
      const lastRun = { at, ok: false, why: `could not ask: ${e.message}`, gaps: pack.gaps, proposed: 0, kept: 0, refused: [] };
      save({ ...store, lastRun });
      return { ok: false, ...lastRun };
    }
    const parsed = parseProposals(text);
    if (!parsed.ok) {
      const lastRun = { at, ok: false, why: parsed.why, gaps: pack.gaps, proposed: 0, kept: 0, refused: [] };
      save({ ...store, lastRun });
      return { ok: false, ...lastRun };
    }
    const refused = [];
    const judged = [];
    for (const raw of parsed.items.slice(0, MAX_SUGGESTIONS_PER_RUN)) {
      const j = judge(raw, evidenceById);
      if (!j.ok) { refused.push(j.why); continue; }
      const s = j.suggestion;
      judged.push({ ...s, fingerprint: fingerprint(s), anchorHash: anchorHash(s.anchors, evidenceById) });
    }
    if (refused.length) console.warn(`[CapabilityGaps] refused ${refused.length}: ${refused.join(' | ')}`);
    const merged = merge(store, judged, at);
    const lastRun = {
      at, ok: true, why: null, gaps: pack.gaps,
      evidenceCount: pack.evidence.length,
      proposed: parsed.items.length, kept: judged.length, added: merged.added.length,
      refused, suppressed: merged.suppressed,
    };
    save({ items: merged.items, lastRun });
    console.log(`[CapabilityGaps] ${parsed.items.length} proposed, ${judged.length} passed the test, ${merged.added.length} new, ${refused.length} refused, ${merged.suppressed.length} already decided`);
    return { ok: true, ...lastRun };
  } finally {
    _running = false;
  }
}

const DECISIONS = ['accept', 'reject', 'done', 'reopen'];

/**
 * Nick's verdict. accept → a build goes into the Feature Tracker, anything else
 * becomes one NEURO task; reject keeps his reason (shown to the model next run);
 * done says it now exists; reopen undoes a verdict.
 */
function decide(id, { decision, reason = null, now = new Date() } = {}) {
  if (!DECISIONS.includes(decision)) { const e = new Error(`decision must be one of ${DECISIONS.join(', ')}`); e.status = 400; throw e; }
  const store = load();
  const item = store.items.find((x) => x.id === id);
  if (!item) { const e = new Error('no such suggestion'); e.status = 404; throw e; }
  const at = now.toISOString();
  let filed = null;
  if (decision === 'reopen') {
    Object.assign(item, { status: 'open', decidedAt: null, reason: null });
  } else if (decision === 'accept') {
    if (item.status === 'accepted') return { ok: true, already: true, item };
    const notes = `${item.unlocks} — needs: ${item.need.what}. Why: ${item.changes}`;
    if (item.need.kind === 'build') {
      const r = require('./feature-tracker').captureFeature({ title: item.title, notes, system: 'NEURO', source: 'capability suggestion' });
      if (!r.ok) { const e = new Error(`could not file it in the tracker: ${r.error}`); e.status = 502; throw e; }
      filed = { kind: 'tracker', number: r.number };
    } else {
      // Tasks carry no notes field, so the why rides in the text — a task that
      // says what to fit but not why is one that never gets done.
      const t = require('./task-store').createTask({
        text: clip(`${item.need.what}${item.need.how ? ` — ${item.need.how}` : ''} (so NEURO can: ${item.unlocks})`, 400),
        source: 'capability-suggestion',
      });
      filed = { kind: 'task', taskId: t && (t.id || t.task_id) };
    }
    Object.assign(item, { status: 'accepted', decidedAt: at, reason: clip(reason, 300) || null, filed });
  } else {
    Object.assign(item, { status: decision === 'reject' ? 'rejected' : 'done', decidedAt: at, reason: clip(reason, 300) || null });
  }
  save(store);
  return { ok: true, item, filed };
}

module.exports = {
  judge, fingerprint, anchorHash, parseProposals, merge, buildPrompt,
  gatherEvidence, list, refresh, decide,
  NEED_KINDS, PERSONAL_KINDS, DECISIONS, MISS_RE, STORE_KEY,
};
