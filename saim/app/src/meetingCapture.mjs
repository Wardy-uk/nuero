// Capture from this meeting (21 Oct 2026). PURE — the payload and the receipt
// wording, kept out of the view so they pin without a browser.
//
// ⚠ NICK WRITES IT. One bounded kind he picks (decision / commitment / risk /
//   follow-up) and his own words — no summary, no attendee, no task, no promise
//   is invented. It is saved as an ordinary NEURO capture note through the
//   outbox (`capture.note`); nothing turns it into a task, an email or an
//   approval.
// ⚠ THE MEETING IS NEURO'S WORD, NEVER THE DEVICE'S. Only the canonical
//   meeting KEY travels; the server confirms it against the diary at the time
//   of capture and writes the subject itself. The receipt says whether it did.

export const MEETING_KINDS = Object.freeze([
  { id: 'decision', label: 'Decision', placeholder: 'The decision, in your words' },
  { id: 'commitment', label: 'Commitment', placeholder: 'Who committed to what, in your words' },
  { id: 'risk', label: 'Risk', placeholder: 'The risk, in your words' },
  { id: 'follow-up', label: 'Follow-up', placeholder: 'What needs following up, in your words' },
]);
const WORD = { decision: 'decision', commitment: 'commitment', risk: 'risk', 'follow-up': 'follow-up' };

/** The line above the box: which meeting, or that none is named. */
export function meetingLine(meeting) {
  if (meeting && meeting.subject) {
    const until = typeof meeting.scheduledEnd === 'string' && /T\d{2}:\d{2}/.test(meeting.scheduledEnd)
      ? ` · until ${meeting.scheduledEnd.slice(11, 16)}` : '';
    return `From “${meeting.subject}”${until}`;
  }
  return 'In a meeting — NEURO didn’t say which one, so this won’t be linked to a meeting.';
}

/** The outbox payload for `capture.note`. */
export function meetingPayload({ text, kind, meeting }) {
  const payload = { content: String(text || '').trim(), captureKind: WORD[kind] ? kind : 'decision' };
  if (meeting && typeof meeting.key === 'string' && meeting.key) payload.meetingKey = meeting.key;
  return payload;
}

function parseDetail(receipt) {
  try { return receipt && receipt.detail ? JSON.parse(receipt.detail) : null; } catch { return null; }
}

/**
 * The receipt, from THIS operation's outcome (outbox.outcomeFor) and receipt.
 *   confirmed → what was saved, where, and whether it is linked to the meeting
 *   pending   → queued on this device, not in NEURO
 *   refused   → NOT saved, the server's reason, the words kept
 */
export function receiptLine(outcome, receipt, { kind, meeting } = {}) {
  const word = WORD[kind] || 'note';
  const state = outcome && outcome.state;
  if (state === 'confirmed') {
    const d = parseDetail(receipt) || {};
    const where = d.path || (receipt && typeof receipt.canonicalId === 'string' ? receipt.canonicalId.replace(/^capture:/, '') : null);
    const at = where ? `, in ${where}` : '';
    if (d.meeting && d.meeting.subject) return { ok: true, msg: `Saved to NEURO — your ${word} from “${d.meeting.subject}”${at}.` };
    if (d.meetingWhy === 'not-confirmed') return { ok: true, msg: `Saved to NEURO — your ${word}${at}. NEURO couldn’t confirm the meeting from the diary, so it isn’t linked to it.` };
    return { ok: true, msg: `Saved to NEURO — your ${word}${at}. No meeting was named, so it isn’t linked to one.` };
  }
  if (state === 'refused') {
    return { ok: false, msg: `${(outcome && outcome.message) || 'NOT saved.'} Your words are kept in Waiting below.` };
  }
  return {
    ok: true,
    msg: meeting && meeting.subject && meeting.key
      ? `Queued on this device — not in NEURO yet. It names “${meeting.subject}”; NEURO checks that against the diary when it arrives.`
      : 'Queued on this device — not in NEURO yet.',
  };
}
