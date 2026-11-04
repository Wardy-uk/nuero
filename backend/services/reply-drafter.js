// Drafting a reply that is RIGHT about who is talking to whom — or asking first.
//
// Until 30 Oct 2026 every draft path handed the model From, Subject and body
// and said "draft a reply as Nick Ward". Nothing said who the email was TO, so
// every email read as addressed to Nick. Live: Stephen Mitchell wrote to Rich
// Combellack (COO) asking for a Dezrez escalation contact, with Nick on Cc, and
// the draft answered Stephen as if Nick owned the problem — and promised to
// chase Dezrez and report back "by end of day tomorrow", none of which Nick had
// said. A fluent reply that commits Nick to work is the expensive failure here.
//
// Nick's call (30 Oct 2026): ASK FIRST. When he is not the addressee, or the
// reply needs facts or decisions only he has, the drafter returns 1-3 short
// questions instead of words; his answers come back as the steer and the next
// press drafts. When it already has enough, it just drafts.
//
// One module, three callers (the work Inbox card, the personal inbox card and
// the queued "Draft a reply" action), so the three cannot drift again — they
// had three copies of the same flawed prompt.

const MAX_QUESTIONS = 3;

// 4 Nov 2026: Nick had typed his whole reply and pressed Draft with AI. The
// route cut his text at 1000 chars (mid-sentence) and the model, reading it as
// a "steer", asked whether he had finished — with nowhere to answer except the
// box holding his reply. A box holding a written reply is his DRAFT: the model
// tidies it and never asks. Short text is still a steer.
const OWN_DRAFT_CHARS = 200;
const MAX_OWN_DRAFT = 8000;

/** Is this box text a written reply rather than a steer? PURE. */
function looksLikeOwnDraft(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  return t.length >= OWN_DRAFT_CHARS || t.split(/\n\s*\n/).length >= 2;
}

function _norm(list) {
  return (Array.isArray(list) ? list : [])
    .map((r) => (typeof r === 'string'
      ? (r.includes('@') ? { name: '', email: r.toLowerCase() } : { name: r, email: '' })
      : { name: r?.name || '', email: String(r?.email || r?.address || '').toLowerCase() }))
    .filter((r) => r.name || r.email);
}

function _label(r) {
  return r.name ? (r.email ? `${r.name} <${r.email}>` : r.name) : r.email;
}

/**
 * Where Nick sits on this email. PURE.
 *   'to'      — he is a direct addressee
 *   'cc'      — he is only copied
 *   'none'    — he is on neither list (a forward, a list, a bcc)
 *   'unknown' — the recipient lists could not be read (cached copy only)
 * Matched on his addresses, and on his full name only when an entry carries no
 * address at all — never on a first name.
 */
function positionOf({ to, cc, recipients }, { selfAddresses = [], selfName = 'Nick Ward' } = {}) {
  const toList = _norm(recipients?.to || to);
  const ccList = _norm(recipients?.cc || cc);
  if (!toList.length && !ccList.length) return 'unknown';
  const mine = new Set(selfAddresses.filter(Boolean).map((a) => String(a).toLowerCase()));
  const name = String(selfName || '').toLowerCase();
  const isMe = (r) => (r.email ? mine.has(r.email) : (name && r.name.toLowerCase() === name));
  if (toList.some(isMe)) return 'to';
  if (ccList.some(isMe)) return 'cc';
  return 'none';
}

const POSITION_LINE = {
  to: 'Nick is a direct addressee of this email.',
  cc: 'Nick is only COPIED (Cc) on this email. It is addressed to someone else, and that person is the one being asked to act.',
  none: 'Nick is NOT on the To or Cc line of this email (it reached him another way). It is not addressed to him.',
  unknown: 'The To/Cc lists could not be read, so who this email is addressed to is unknown.',
};

function buildPrompt({ message, position, steer, persona = 'work', ownDraft = '' }) {
  const to = _norm(message.recipients?.to || message.to).map(_label).join(', ') || '(unknown)';
  const cc = _norm(message.recipients?.cc || message.cc).map(_label).join(', ') || '(none)';
  const who = persona === 'personal'
    ? 'Nick Ward, writing from his own personal mail (not as Head of Technical Support). Friendly, plain, British English, short.'
    : 'Nick Ward, Head of Technical Support at Nurtur. Direct, warm and concise — British English, no corporate padding.';
  if (ownDraft) return buildPolishPrompt({ message, who, to, cc, steer, ownDraft });
  const mustAsk = position !== 'to' && !steer;
  return `You prepare email replies for ${who}

${POSITION_LINE[position] || POSITION_LINE.unknown}

Rules:
- Read who wrote to whom. Never reply as if Nick were the addressee when he is not, and never answer a request that was made of someone else as though Nick had been asked.
- Never commit Nick to an action, a date, a deadline or a fact he has not given you in his steer. No "I'll chase", "I'll get back to you by…", "I've spoken to…" unless his steer says so.
- If you cannot write a reply Nick could send as-is — because he is not the addressee and has not said what he wants to say, or because the reply needs a fact or decision only he has — do NOT draft. Instead output exactly the word QUESTIONS on the first line, then 1-${MAX_QUESTIONS} short questions to Nick, one per line, each starting "- ". Ask only what you need; the first question may be whether he wants to reply at all.
${mustAsk ? '- In this case Nick has given no steer and is not the addressee, so you MUST output QUESTIONS.\n' : ''}${steer ? '- Nick has given a steer: DRAFT from it. Ask again only if the steer leaves out something the reply literally cannot be written without — never to confirm what he has already said.\n' : ''}- Otherwise output only the reply body: no subject line, no commentary. Sign off "Nick".${steer ? `

Nick's steer (his own words — follow it, and treat it as his answers to any questions): ${steer}` : ''}

From: ${message.from || 'Unknown'}${message.fromEmail ? ` <${message.fromEmail}>` : ''}
To: ${to}
Cc: ${cc}
Subject: ${message.subject || '(no subject)'}

${String(message.body || message.preview || '').replace(/\s+\n/g, '\n').slice(0, 4000)}`;
}

/** Nick wrote the reply himself: tidy it, never ask. PURE. */
function buildPolishPrompt({ message, who, to, cc, steer, ownDraft }) {
  return `You tidy email replies for ${who}

Nick has written his own reply below. Polish it so he can send it:
- Fix spelling, grammar, punctuation and awkward phrasing; tighten where it rambles.
- Keep every fact, ticket number, name, date and commitment exactly as he wrote it. Add nothing he did not say, remove nothing of substance, invent no promises or dates.
- Keep his structure, his greeting and his sign-off; keep his voice.
- If a sentence is unfinished, finish it only from what he says elsewhere in the draft; otherwise leave it as written.
- Do NOT ask questions. Output only the reply body — no subject line, no commentary.${steer ? `

Nick also said: ${steer}` : ''}

Nick's draft:
${ownDraft}

--- The email he is replying to ---
From: ${message.from || 'Unknown'}${message.fromEmail ? ` <${message.fromEmail}>` : ''}
To: ${to}
Cc: ${cc}
Subject: ${message.subject || '(no subject)'}

${String(message.body || message.preview || '').replace(/\s+\n/g, '\n').slice(0, 4000)}`;
}

/** Read the model's answer. PURE. A QUESTIONS answer with no questions is unreadable (null). */
function parseAnswer(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  const m = t.match(/^\**\s*QUESTIONS\s*\**:?\s*\n?([\s\S]*)$/i);
  if (!m) return { kind: 'draft', text: t };
  const questions = m[1].split('\n')
    .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
    .filter(Boolean)
    .slice(0, MAX_QUESTIONS);
  return questions.length ? { kind: 'questions', questions } : null;
}

/** The question asked when the model is unavailable or drafted anyway. PURE. */
function fallbackQuestion(message, position) {
  const to = _norm(message.recipients?.to || message.to).map((r) => r.name || r.email);
  const addressee = to.length ? to.join(', ') : 'someone else';
  const where = position === 'cc' ? 'you’re only copied' : 'you’re not on the To line';
  return {
    kind: 'questions',
    questions: [`This is addressed to ${addressee}; ${where}. Do you want to reply, and if so, what do you want to say?`],
  };
}

/**
 * Split what the card sent into the drafter's inputs. PURE.
 * `instruction` = the reply box; `answers` = his answers to the drafter's
 * questions (their own field, so answering never overwrites his reply).
 */
function inputsFrom(body = {}) {
  const box = String(body.instruction || '').trim();
  const answers = String(body.answers || '').trim().slice(0, 2000);
  if (looksLikeOwnDraft(box)) return { ownDraft: box.slice(0, MAX_OWN_DRAFT), steer: answers };
  return { ownDraft: '', steer: [box, answers].filter(Boolean).join('\n').slice(0, 3000) };
}

/**
 * Draft, or ask. Returns { kind: 'draft', text, provider } |
 * { kind: 'questions', questions, provider, position } | null (AI unavailable
 * and Nick IS the addressee — the caller keeps its canned fallback).
 */
async function draft({ message, steer = '', ownDraft = '', persona = 'work', selfAddresses = [], runTask }) {
  const position = positionOf(message, { selfAddresses });
  ownDraft = String(ownDraft || '').trim().slice(0, MAX_OWN_DRAFT);
  const prompt = buildPrompt({ message, position, steer, persona, ownDraft });
  const mustAsk = position !== 'to' && position !== 'unknown' && !steer && !ownDraft;
  let parsed = null;
  let provider = 'fallback';
  try {
    const run = runTask || require('./ai-routing').runTask;
    const r = await run('email_draft', { prompt, maxTokens: ownDraft ? 2000 : 600 });
    parsed = parseAnswer(r?.text);
    // His own draft is never answered with questions — keep his words.
    if (ownDraft && parsed?.kind === 'questions') parsed = null;
    if (parsed) provider = r.provider;
  } catch (e) {
    console.warn('[ReplyDrafter] model failed:', e.message);
  }
  // Not the addressee and no steer: a draft here is exactly the 30 Oct bug, so
  // it is never returned — ask instead, whatever the model did.
  if (mustAsk && parsed?.kind !== 'questions') parsed = fallbackQuestion(message, position);
  if (!parsed && ownDraft) return { kind: 'draft', text: ownDraft, provider: 'unchanged', position };
  if (!parsed) return null;
  return { ...parsed, provider, position };
}

module.exports = { draft, positionOf, buildPrompt, parseAnswer, fallbackQuestion, looksLikeOwnDraft, inputsFrom, MAX_QUESTIONS };
