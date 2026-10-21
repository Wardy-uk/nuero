'use strict';

/**
 * A PRIVATE, NON-DECISIVE working draft for Nick (25 Oct 2026).
 *
 * The policy boundary. Anything consequential or outward about employment stays
 * a hard stop: SAiM never sends or contacts colleagues; never selects,
 * evaluates, ranks, rewards, disciplines or sets terms for named employees;
 * never presents a recommendation as an employment decision; never makes a
 * commitment, People-note change, task assignment, shared-board change or
 * publication. What IS allowed, for a held promise whose own wording is
 * ordinary but whose SOURCE NOTE discusses people's employment: a structured
 * brief that helps Nick do the work himself — and nothing else.
 *
 * ⚠ DETERMINISTIC — NO MODEL CALL. Nothing in the brief is generated: the
 * commitment and due date are quoted, source lines are copied verbatim, and
 * the decisions/questions are fixed sentences chosen by the promise's own
 * words. So the brief cannot invent a target, a performance fact, a recipient,
 * a policy or a commitment, by construction.
 *
 * ⚠ A source line that names a person (a People note) or touches employment
 * (promise-ledger.CONTEXT_PATTERNS — performance, absence, leave, contract…)
 * is LEFT OUT and counted, never quoted: the brief must not read as anyone's
 * evaluation. The source note itself is untouched.
 *
 * PURE: text in, text out. The planner does the reading.
 */

const LABEL = 'Private draft for Nick — no decision made, nothing sent.';
const CANNOT = 'SAiM can’t carry out an employment action for this.';
const CAN = 'SAiM can prepare a private draft for you.';
const PROMISE = 'SAiM will prepare a private draft for you. It will not make an employment decision, contact anyone, or send anything.';
const CONTROL = 'Prepare a private working draft';
const MAX_LINES = 6;

const STOP = new Set(['define', 'agree', 'plan', 'with', 'that', 'this', 'from', 'into', 'their', 'there', 'about', 'what', 'when', 'will', 'have', 'make', 'nick', 'ward', 'should', 'would', 'could', 'achievable', 'targets', 'target']);
const norm = (s) => String(s || '').replace(/[’']/g, "'").replace(/\s+/g, ' ').trim().toLowerCase();
const tokensOf = (s) => [...new Set(norm(s).split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOP.has(w)))];

/**
 * PURE. The source note's lines that are about this commitment and safe to
 * quote. → { lines: [{ text, line }], leftOut }
 */
function sourceLines(noteText, promiseText, roster, { max = MAX_LINES } = {}) {
  const ledger = require('./promise-ledger');
  const want = tokensOf(promiseText);
  const exact = norm(promiseText).replace(/[^a-z0-9 ]/g, '');
  const lines = []; let leftOut = 0;
  const raw = String(noteText || '').replace(/\r\n/g, '\n').split('\n');
  let inFront = raw[0] === '---';
  raw.forEach((l, i) => {
    if (i === 0 && inFront) return;
    if (inFront) { if (l === '---') inFront = false; return; }
    const text = l.replace(/^\s*(?:[-*+]|\d+\.)\s+(\[[ xX]\]\s+)?/, '').replace(/\*\*/g, '').trim();
    if (!text || /^#/.test(text) || text.length < 12) return;
    const n = norm(text).replace(/[^a-z0-9 ]/g, '');
    const shared = want.filter((w) => n.split(' ').includes(w)).length;
    const relevant = (exact && n.includes(exact.slice(0, 40))) || shared >= 2;
    if (!relevant) return;
    const named = roster ? ledger.namesIn(text, roster) : { people: [], ambiguous: [] };
    const about = ledger.CONTEXT_PATTERNS.some((re) => re.test(text));
    if (named.people.length || named.ambiguous.length || about) { leftOut += 1; return; }
    if (lines.length < max && !lines.some((x) => x.text === text)) lines.push({ text, line: i + 1 });
  });
  return { lines, leftOut };
}

/** PURE. The decisions only Nick can make — fixed sentences, chosen by the promise's words. */
function decisionsFor(promiseText, { agreeBy = null, todayYmd = null } = {}) {
  const t = norm(promiseText);
  const out = [];
  if (/\b(target|goal|objective|kpi|measure)/.test(t)) out.push('What “achievable” means here, and the measure each target is judged by. SAiM has not proposed any targets.');
  if (/\b(incentive|reward|bonus|scheme)/.test(t)) out.push('What the incentive is and what earns it. SAiM has not set any terms.');
  out.push('Who it applies to, and how the people it affects are heard before anything is agreed.');
  if (/\b(agree|plan|sign off|approve)/.test(t)) {
    const passed = agreeBy && todayYmd && agreeBy < todayYmd;
    out.push(`Who you agree the plan with, and by when${agreeBy ? ` — your note said ${agreeBy}${passed ? ', which has passed' : ''}` : ''}.`);
  }
  if (out.length < 3) out.push('What you want to have decided when this is done.');
  return out;
}

/** PURE. The questions to answer before deciding — fixed sentences. */
function questionsFor() {
  return [
    'What policy or guidance already covers this, and who owns it?',
    'What information do you need before deciding, and where does it live?',
  ];
}

/**
 * PURE. The brief. → { text, gaps, facts }
 *   gaps = the decisions (they need Nick's own time, so a private block may be proposed)
 */
function compose({ title, promiseText, dueLabel = null, source = null, lines = [], leftOut = 0, said = [], todayYmd = null }) {
  const agreeBy = (/\b(\d{4}-\d{2}-\d{2})\b/.exec(String(promiseText || '')) || [])[1] || null;
  const decisions = decisionsFor(promiseText, { agreeBy, todayYmd });
  const questions = questionsFor();
  const facts = [{ text: `The commitment: “${promiseText}”.`, cite: (source && source.path) || 'the promise', kind: 'source' }];
  for (const l of lines) facts.push({ text: l.text, cite: `${source.path}:${l.line}`, kind: 'source' });
  for (const s of said) facts.push({ text: s.text, cite: 'you said', kind: 'you' });
  const text = [
    `# ${title} — private draft`, '',
    `> **${LABEL}** Prepared by SAiM from your notes. SAiM has not set any targets, judged anyone, or contacted anyone. Everything to decide is listed below for you.`, '',
    '## The commitment', '',
    `- “${promiseText}”${source && source.title ? ` _(${source.title})_` : ''}`,
    ...(dueLabel ? [`- ${dueLabel}.`] : []), '',
    '## What your notes say', '',
    ...(lines.length ? lines.map((l) => `- ${l.text} _(${source.path}:${l.line})_`) : ['- _(Nothing else in the source note is about this.)_']),
    ...(leftOut ? ['', `_${leftOut} line${leftOut === 1 ? '' : 's'} naming colleagues or their circumstances ${leftOut === 1 ? 'was' : 'were'} left out — ${leftOut === 1 ? 'it is' : 'they are'} in the source note._`] : []), '',
    ...(said.length ? ['## You said', '', ...said.map((s) => `- ${s.text}`), ''] : []),
    '## Decisions only you can make', '',
    ...decisions.map((d) => `- ${d}`), '',
    '## Questions to answer first', '',
    ...questions.map((q) => `- ${q}`), '',
  ].join('\n');
  return { text, gaps: decisions, facts };
}

/** PURE. Does this text carry the private label (the executor's and recheck's guard)? */
function isPrivateDraft(text) { return String(text || '').includes(LABEL); }

module.exports = { LABEL, CANNOT, CAN, PROMISE, CONTROL, MAX_LINES, sourceLines, decisionsFor, questionsFor, compose, isPrivateDraft };
