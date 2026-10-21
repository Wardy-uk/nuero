'use strict';

/**
 * The words of a prepared move's deliverable (21 Oct 2026). The model WRITES;
 * it does not decide. It is handed only the source material the planner
 * gathered and told to use nothing else; the planner then refuses any draft
 * that brings in a name, number, date, address or link the sources do not
 * hold (prepared-move-planner.ungrounded). Recipients, attendees, paths and
 * times never come from here.
 *
 * Output contract: { ok, text, gaps: [string], provider } | { ok:false, why }.
 * `gaps` are the things only Nick can supply — the model names them rather
 * than filling them in, and a gap is what makes the planner propose a block.
 */

const TASK = {
  'email-reply': 'saim_move_reply',
  'meeting-prep': 'saim_move_prep',
  'project-note': 'saim_move_note',
};

const RULES = [
  'Use ONLY the facts below. Do not add names, numbers, dates, times, prices, links or commitments that are not in them.',
  'Where something is needed that the facts do not say, do NOT guess — list it under GAPS instead.',
  'British English. Direct, warm, concise. No preamble and no commentary about yourself.',
  'Never promise anything on Nick’s behalf beyond what the facts already say he has agreed.',
].join('\n- ');

function facts(input) {
  return (input.facts || []).map((f) => `- ${f.kind === 'you' ? 'Nick said: ' : ''}${f.text}`).join('\n') || '- (none)';
}

/** PURE. The prompt for one kind. */
function promptFor(kind, input) {
  if (kind === 'email-reply') {
    const e = input.email || {};
    return `Draft Nick Ward's reply to this email. Sign off "Nick".\n- ${RULES}\n\nThen on a new line write GAPS: followed by one gap per line (or "GAPS: none").\n\nFrom: ${e.fromName || e.from || 'the sender'}\nSubject: ${e.subject || ''}\n\nTHE EMAIL:\n${String(e.body || '').slice(0, 5000)}\n\nOTHER FACTS:\n${facts(input)}\n\nReply body only, then GAPS:`;
  }
  if (kind === 'meeting-prep') {
    const m = input.meeting || {};
    return `Write Nick Ward's preparation for the meeting "${m.title || input.title}": 3-6 short bullet points of what to raise or check, each drawn from the facts.\n- ${RULES}\n\nThen on a new line write GAPS: followed by one gap per line (or "GAPS: none").\n\nPEOPLE IN IT: ${(m.people || []).join(', ') || '(not known)'}\n\nFACTS:\n${facts(input)}\n\nBullets only, then GAPS:`;
  }
  const t = input.task || {};
  return `Write a first draft of the working note for Nick Ward's task "${t.text || input.title}" — the actual content of the deliverable, not a plan to write it. Short headed sections and bullets.\n- ${RULES}\n\nThen on a new line write GAPS: followed by one gap per line (or "GAPS: none").\n\nFACTS FROM HIS NOTES:\n${facts(input)}\n\nDraft only, then GAPS:`;
}

/** PURE. Split the model's answer into the text and the gaps it named. */
function parse(raw) {
  const s = String(raw || '').replace(/\r\n/g, '\n').trim();
  const at = s.search(/^\s*GAPS\s*:/im);
  const text = (at >= 0 ? s.slice(0, at) : s).trim();
  const tail = at >= 0 ? s.slice(at).replace(/^\s*GAPS\s*:\s*/i, '') : '';
  const gaps = tail.split('\n').map((l) => l.replace(/^[-*\d.)\s]+/, '').trim()).filter((l) => l && !/^none\.?$/i.test(l)).slice(0, 5);
  return { text, gaps };
}

async function draft(kind, input, { runTask = null } = {}) {
  if (!TASK[kind]) return { ok: false, why: 'no drafter for this kind' };
  const run = runTask || ((t, p, o) => require('./ai-routing').runTask(t, p, o));
  let r;
  try {
    r = await run(TASK[kind], { prompt: promptFor(kind, input), maxTokens: 900 }, { forceCloud: true, timeout: 60000 });
  } catch (e) { return { ok: false, why: e.message }; }
  if (!r || !r.text || !String(r.text).trim()) return { ok: false, why: (r && r.reason) || 'the model gave no answer' };
  const p = parse(r.text);
  if (!p.text) return { ok: false, why: 'the model gave no draft' };
  return { ok: true, text: p.text, gaps: p.gaps, provider: r.provider || null };
}

module.exports = { TASK, promptFor, parse, draft };
