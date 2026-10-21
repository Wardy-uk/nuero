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
/** The fixed holding place for private drafts with no single project home (Nick, 26 Oct 2026). */
const WORKING_FOLDER = 'Projects/Working';
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

/**
 * PURE. The decisions only Nick can make, as a short INTERVIEW (26 Oct 2026):
 * one plain question per decision, most useful first, each with a stable id
 * (the prepared-move answer's questionId). Fixed sentences chosen by the
 * promise's own words — nothing here is a suggestion of what to decide.
 *   → [{ id, decision, question, why }]
 */
function interviewFor(promiseText, { agreeBy = null, todayYmd = null } = {}) {
  const t = norm(promiseText);
  const out = [];
  if (/\b(target|goal|objective|kpi|measure)/.test(t)) out.push({ id: 'achievable', decision: 'What “achievable” means, and how it is measured', question: 'What does ‘achievable’ mean here, and how will you measure it?', why: 'SAiM has not proposed any targets — this is yours to set.' });
  if (/\b(incentive|reward|bonus|scheme)/.test(t)) out.push({ id: 'incentive', decision: 'What the incentive is, and what earns it', question: 'What is the incentive, and what earns it?', why: 'SAiM has not set any terms.' });
  out.push({ id: 'applies', decision: 'Who it applies to, and how they are heard', question: 'Who does it apply to, and how will the people it affects be heard before it is agreed?', why: 'SAiM doesn’t choose or judge anyone.' });
  if (/\b(agree|plan|sign off|approve)/.test(t)) {
    const passed = agreeBy && todayYmd && agreeBy < todayYmd;
    out.push({ id: 'agree', decision: 'Who you agree the plan with, and by when', question: 'Who will you agree the plan with, and by when?', why: agreeBy ? `Your note said ${agreeBy}${passed ? ', which has passed' : ''}. SAiM won’t contact anyone about it.` : 'SAiM won’t contact anyone about it.' });
  }
  if (out.length < 3) out.push({ id: 'outcome', decision: 'What you want decided when this is done', question: 'What do you want to have decided when this is done?', why: 'It tells the draft what it is for.' });
  return out;
}

/** PURE. The decision sentences (kept for callers that want them as lines). */
function decisionsFor(promiseText, opts = {}) { return interviewFor(promiseText, opts).map((q) => q.decision); }

/** PURE. Reminders worth checking before agreeing it — statements, not questions SAiM is waiting on. */
function questionsFor() {
  return [
    'Check what policy or guidance already covers this, and who owns it.',
    'Note what information you need before deciding, and where it lives.',
  ];
}

const PARK_ID = 'park';

/**
 * PURE. Where each interview question stands, from the move's answers (in
 * order). An answer row with the question's id is Nick's words; a `park` row
 * naming the question is an explicit "not now". The LATEST of the two counts,
 * so answering a parked question un-parks it.
 *   → { questions: [{ ...q, state: 'open'|'answered'|'parked', answer, by, at }], next, done, total, open }
 */
function interviewState(questions, answers) {
  const qs = (questions || []).map((q) => {
    let st = { state: 'open', answer: null, by: null, at: null };
    for (const a of answers || []) {
      // A comment marker in Nick's words could hide them from the screen below — never kept.
      if (a.questionId === q.id) st = { state: 'answered', answer: String(a.text || '').replace(/<!--|-->/g, '').replace(/\s*\n\s*/g, ' ').trim(), by: a.by || null, at: a.at || null };
      else if (a.questionId === PARK_ID && a.text === q.id) st = { state: 'parked', answer: null, by: a.by || null, at: a.at || null };
    }
    return { ...q, ...st };
  });
  const open = qs.filter((q) => q.state === 'open');
  return { questions: qs, next: open[0] ? { id: open[0].id, question: open[0].question, why: open[0].why } : null, done: qs.length - open.length, total: qs.length, open: open.length };
}

const SAID_OPEN = '<!-- you-said -->';
const SAID_CLOSE = '<!-- /you-said -->';

/**
 * PURE. The brief. → { text, gaps, facts, interview }
 *   gaps      = every decision (they need Nick's own time, so a private block may be proposed)
 *   interview = interviewState(...) — the one next question, and the progress
 */
function compose({ title, promiseText, dueLabel = null, source = null, lines = [], leftOut = 0, said = [], answers = [], todayYmd = null }) {
  const agreeBy = (/\b(\d{4}-\d{2}-\d{2})\b/.exec(String(promiseText || '')) || [])[1] || null;
  const iv = interviewState(interviewFor(promiseText, { agreeBy, todayYmd }), answers);
  const reminders = questionsFor();
  const facts = [{ text: `The commitment: “${promiseText}”.`, cite: (source && source.path) || 'the promise', kind: 'source' }];
  for (const l of lines) facts.push({ text: l.text, cite: `${source.path}:${l.line}`, kind: 'source' });
  for (const s of said) facts.push({ text: s.text, cite: 'you said', kind: 'you' });
  const answered = iv.questions.filter((q) => q.state === 'answered');
  const parked = iv.questions.filter((q) => q.state === 'parked');
  const open = iv.questions.filter((q) => q.state === 'open');
  for (const q of answered) facts.push({ text: `${q.decision}: ${q.answer}`, cite: 'you said', kind: 'you' });
  const text = [
    `# ${title} — private draft`, '',
    `> **${LABEL}** Prepared by SAiM from your notes. SAiM has not set any targets, judged anyone, or contacted anyone. What you said is in your own words; what is still to decide is listed for you.`, '',
    '## The commitment', '',
    `- “${promiseText}”${source && source.title ? ` _(${source.title})_` : ''}`,
    ...(dueLabel ? [`- ${dueLabel}.`] : []), '',
    '## What your notes say', '',
    ...(lines.length ? lines.map((l) => `- ${l.text} _(${source.path}:${l.line})_`) : ['- _(Nothing else in the source note is about this.)_']),
    ...(leftOut ? ['', `_${leftOut} line${leftOut === 1 ? '' : 's'} naming colleagues or their circumstances ${leftOut === 1 ? 'was' : 'were'} left out — ${leftOut === 1 ? 'it is' : 'they are'} in the source note._`] : []), '',
    ...(answered.length || said.length ? [SAID_OPEN, '## You said', '', '_Your own words — not SAiM’s conclusions._', '',
      ...answered.map((q) => `- **${q.decision}:** ${q.answer}`), ...said.map((x) => `- ${x.text}`), SAID_CLOSE, ''] : []),
    ...(parked.length ? ['## Parked — still unresolved', '', ...parked.map((q) => `- ${q.decision} — you parked this; it is not decided.`), ''] : []),
    ...(open.length ? ['## Still to decide', '', ...open.map((q) => `- ${q.decision}`), ''] : []),
    '## Worth checking before you agree it', '',
    ...reminders.map((q) => `- ${q}`), '',
  ].join('\n');
  return { text, gaps: iv.questions.map((q) => q.decision), facts, interview: iv };
}

/**
 * PURE. The draft WITHOUT Nick's own words (the "You said" section). The
 * employment screens run over what SAiM wrote, not over what Nick said in his
 * own private draft — his words are his, and quoting them back is not SAiM
 * acting on an employment matter.
 */
function samText(text) {
  const s = String(text || '');
  const a = s.indexOf(SAID_OPEN); const b = s.indexOf(SAID_CLOSE);
  return a >= 0 && b > a ? s.slice(0, a) + s.slice(b + SAID_CLOSE.length) : s;
}

/** PURE. Does this text carry the private label (the executor's and recheck's guard)? */
function isPrivateDraft(text) { return String(text || '').includes(LABEL); }

module.exports = { LABEL, CANNOT, CAN, PROMISE, CONTROL, WORKING_FOLDER, MAX_LINES, PARK_ID, sourceLines, interviewFor, interviewState, decisionsFor, questionsFor, compose, samText, isPrivateDraft };
