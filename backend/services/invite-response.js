'use strict';

/**
 * Answering meeting invites (30 Oct 2026).
 *
 * Nick: "meeting invites should allow me to accept/decline", and "an invite
 * that has been auto declined due to annual leave still shows as unread".
 *
 * Two doors, one tidy-up:
 *   - `respond(emailId, response)` — Nick's press on an invite card in the
 *     Inbox. Reads the invite LIVE (never trusts the card), refuses his own
 *     meeting and a cancelled one, answers through the ledger
 *     (`microsoft.calendar.respond`), reads the answer back, then tidies.
 *   - `tidyForEvent(event)` — the leave guard after a confirmed decline: find
 *     the invite email(s) for that event, mark them read, close their cards.
 *
 * Tidying is best-effort and never fails the answer: the meeting HAS been
 * answered by then, and a card that lingers is a smaller fault than an answer
 * reported as failed.
 */

const WRITER = 'microsoft.calendar.respond';
const RESPONSE_SAY = { accept: 'Accepted', tentative: 'Tentatively accepted', decline: 'Declined' };

function _cal() { return require('./action-calendar'); }

/** Read-only view of an invite for the card. */
async function describe(emailId) {
  const inv = await _cal().inviteOf(emailId);
  if (!inv) return { ok: false, error: 'Outlook could not be read — try again.' };
  if (inv.gone) return { ok: false, error: 'This email is no longer in your mailbox.' };
  if (!inv.isInvite) return { ok: true, isInvite: false };
  if (!inv.event) return { ok: true, isInvite: true, event: null, note: 'The meeting is no longer in your calendar.' };
  return { ok: true, isInvite: true, event: inv.event, canAnswer: !inv.event.isOrganizer && !inv.event.isCancelled };
}

/** Mark the email read in Outlook and close its triage card. Never throws. */
async function _tidy(emailId, response) {
  let markedRead = false;
  try { markedRead = (await _cal().markMessageRead(emailId)).outcome === 'accepted'; } catch { /* reported below */ }
  let closed = false;
  try { closed = require('./email-triage').closeAnsweredInvite(emailId, { response }); } catch (e) {
    console.warn('[Invite] could not close the triage card:', e.message);
  }
  return { markedRead, closed };
}

async function respond(emailId, response, { comment = '', initiatedBy = 'nick', now = Date.now() } = {}) {
  const cal = _cal();
  if (!cal.RESPONSES[response]) return { ok: false, status: 400, error: 'response must be accept, tentative or decline' };
  const inv = await cal.inviteOf(emailId);
  if (!inv) return { ok: false, status: 503, error: 'Outlook could not be read — nothing was sent.' };
  if (inv.gone) return { ok: false, status: 404, error: 'This email is no longer in your mailbox — nothing was sent.' };
  if (!inv.isInvite) return { ok: false, status: 409, error: 'This email is not a meeting invite.' };
  const ev = inv.event;
  if (!ev) return { ok: false, status: 409, error: 'The meeting is no longer in your calendar — nothing was sent.' };
  if (ev.isOrganizer) return { ok: false, status: 409, error: 'This is your own meeting — there is nothing to answer.' };
  if (ev.isCancelled) return { ok: false, status: 409, error: 'This meeting was cancelled — nothing was sent.' };

  const want = cal.RESPONSE_STATE[response];
  if (ev.response === want) {
    const tidy = await _tidy(emailId, response);
    return { ok: true, already: true, say: `You had already ${want === 'declined' ? 'declined' : 'answered'} “${ev.subject}”.`, ...tidy };
  }

  const ext = require('./external-writes');
  const key = `invite-respond:${ev.id}@${ev.start || ''}:${response}`;
  const claim = ext.begin({ writer: WRITER, key, target: ev.subject || 'a meeting',
    request: { eventId: ev.id, start: ev.start, response }, initiatedBy, now });
  if (!claim.ok && !claim.duplicate) return { ok: false, status: 409, error: claim.why };
  if (claim.duplicate) {
    const tidy = await _tidy(emailId, response);
    return { ok: true, already: true, say: `${RESPONSE_SAY[response]} “${ev.subject}” already.`, ...tidy };
  }

  let r;
  try { r = await cal.respondEvent(ev.id, response, { comment }); } catch (e) { r = { outcome: 'uncertain', category: e.message }; }
  if (r.outcome === 'rejected') {
    ext.settle(claim.entry.id, { status: 'failed', result: { status: r.status, category: r.category } });
    return { ok: false, status: 502, error: `Microsoft refused it (${r.status || r.category}) — nothing was sent.` };
  }
  if (r.outcome !== 'accepted') {
    ext.settle(claim.entry.id, { status: 'uncertain', result: { status: r.status, category: r.category } });
    return { ok: false, status: 504, uncertain: true, error: 'No clear answer from Microsoft — check Outlook before pressing again.' };
  }
  const back = await cal.responseOf(ev.id).catch(() => null);
  const confirmed = back === want || (response === 'decline' && back === 'gone');
  ext.settle(claim.entry.id, { status: confirmed ? 'confirmed' : 'applied-unverified', readback: back || 'unreadable' });
  if (response === 'decline') {
    try { require('./prepared-actions').withdrawAgendaChase(ev.id, { why: 'you declined it', now }); } catch { /* best effort */ }
  }
  const tidy = await _tidy(emailId, response);
  console.log(`[Invite] ${RESPONSE_SAY[response]} "${ev.subject}" (${ev.start}) — ${confirmed ? 'read back' : 'not read back'}`);
  return {
    ok: true, verified: confirmed, response,
    say: `${RESPONSE_SAY[response]} “${ev.subject}”${confirmed ? '' : ' — Microsoft took it, but the calendar has not shown it yet'}. The organiser has been told.`,
    ...tidy,
  };
}

/**
 * After a decline made elsewhere (the leave guard): the invite email(s) for
 * that event are marked read and leave the panel. Never throws.
 */
async function tidyForEvent(ev, { response = 'decline' } = {}) {
  try {
    const found = await _cal().invitesForEvent(ev.id, ev.subject);
    if (!found) return { ok: false, reason: 'inbox unreadable' };
    let n = 0;
    for (const m of found) {
      const t = await _tidy(m.id, response);
      if (t.markedRead || t.closed) n++;
    }
    return { ok: true, tidied: n, found: found.length };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

module.exports = { WRITER, describe, respond, tidyForEvent };
