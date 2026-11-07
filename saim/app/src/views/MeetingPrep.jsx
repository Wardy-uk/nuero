import { useEffect, useMemo, useState } from 'react';
import { apiFetch, apiUrl, authHeaders } from '../api';
import { makeCall } from '../preparedMove.mjs';
import OwedActions from '../../../shared-ui/OwedActions.jsx';
import { Lit, LitLabel } from '../../../shared-ui/Lit.jsx';
import { ContextItem } from '../../../shared-ui/TaskContext.jsx';
import { platformNow } from '../../../shared-ui/presentation/platform.mjs';
import './MeetingPrep.css';

// Meeting prep / calendar = glance at what's next and its prep before you walk in.
// GET /api/meeting-prep → { meeting: {..., prep}, laterToday[], message? }
// People HR's words for the absence where it gave any ("Annual Leave"), else the
// bare status said as words rather than a slug.
function awayWords(away) {
  if (away?.reason) return away.reason;
  const s = String(away?.status || '').replace(/_/g, ' ').trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : 'Booked off';
}

function fromNow(mins) {
  if (mins == null) return '';
  if (mins < 0) return 'now';
  if (mins < 60) return `in ${mins}m`;
  const h = Math.floor(mins / 60), m = mins % 60;
  return `in ${h}h${m ? ` ${m}m` : ''}`;
}

/** The prep path: THIS meeting when SAiM named one (its hand-off's own link), else the next one. */
export function prepPath(context) {
  const id = context && typeof context.eventId === 'string' ? context.eventId : '';
  return id ? `/api/meeting-prep?event=${encodeURIComponent(id)}` : '/api/meeting-prep';
}

/**
 * Calendar care (1 Nov 2026): the agenda NEURO drafted for a meeting Nick
 * organises whose invite says nothing. Add agenda prepares the governed body
 * update and confirms it with one press (every attendee gets Outlook's update).
 * Read-only on the kiosk — it has no door to change the calendar.
 */
function PrepAgenda({ offer }) {
  const [text, setText] = useState(offer.text);
  const [state, setState] = useState({ busy: false, note: null, done: false });
  const kiosk = platformNow() === 'kiosk';
  const gaps = text.match(/\[[^\]\n]{1,80}\]/g) || [];
  const post = (path, body) => apiFetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .catch((e) => ({ ok: false, error: e.message }));
  const add = async () => {
    setState({ busy: true, note: null, done: false });
    const r = await post('/api/calendar-care/agenda/add', { key: offer.key, text });
    if (!r.ok || !r.action) return setState({ busy: false, note: r.error || 'Nothing was added.', done: false });
    const a = r.action;
    let sid = '';
    try { const b = new Uint8Array(12); crypto.getRandomValues(b); sid = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(''); } catch { sid = `s${Date.now()}`; }
    const g = await post(`/api/prepared-actions/${encodeURIComponent(a.actionId)}/intent-grant`, { version: a.version || 1, payloadHash: a.payloadHash, surface: 'neuro-web', sessionId: sid });
    if (!g.ok) return setState({ busy: false, note: g.error || 'It needs confirming again.', done: false });
    const x = await post(`/api/prepared-actions/${encodeURIComponent(a.actionId)}/execute-direct`, { grantId: g.grantId, payloadHash: a.payloadHash });
    const ok = x.ok && ['executed', 'verified'].includes(x.status);
    if (ok) await post('/api/calendar-care/agenda/done', { key: offer.key });
    setState({ busy: false, done: ok, note: ok ? (x.status === 'verified' ? 'Added — checked in your calendar.' : 'Added — confirming it in your calendar now.') : (x.error || x.detail || `Not added (${x.status || 'unknown'}).`) });
  };
  return (
    <div className="mp__block">
      <LitLabel className="mp__h">No agenda on the invite</LitLabel>
      {kiosk
        ? <pre className="mp__agenda">{text}</pre>
        : <textarea className="mp__agenda" value={text} rows={Math.min(10, text.split('\n').length + 1)} onChange={(e) => setText(e.target.value)} disabled={state.done} />}
      {gaps.length > 0 && <div className="mp__gapnote">Fill in or delete {gaps.join(', ')} first.</div>}
      {!kiosk && !state.done && (
        <button className="btn" disabled={state.busy || gaps.length > 0 || !text.trim()} onClick={add}>{state.busy ? 'Adding…' : 'Add agenda'}</button>
      )}
      <div className="mp__gapnote">Every attendee gets Outlook’s update.</div>
      {state.note && <div className="mp__gapnote">{state.note}</div>}
    </div>
  );
}

export default function MeetingPrep({ context = null }) {
  const [state, setState] = useState({ loading: true, error: null, data: null });
  const path = prepPath(context);
  // Chase / Done on "Noted as outstanding" (7 Nov 2026) — five minutes before the
  // 1-2-1 is when he notices. Never on the kiosk (no send or write door there).
  const owedCall = useMemo(() => (platformNow() === 'kiosk' ? null : makeCall({ fetchImpl: (...a) => fetch(...a), apiUrl, authHeaders })), []);

  useEffect(() => {
    let live = true;
    apiFetch(path)
      .then((data) => live && setState({ loading: false, error: null, data }))
      .catch((error) => live && setState({ loading: false, error: error.message, data: null }));
    return () => { live = false; };
  }, [path]);

  const { loading, error, data } = state;
  const meeting = data?.meeting;
  const prep = meeting?.prep;

  return (
    <section>
      <h1 className="view__title">Prep</h1>
      <p className="view__lede">What’s next, and what you need for it.</p>

      {loading && <Lit tone="statement">Checking your calendar…</Lit>}
      {/* The one FAULT here. An empty diary and an unread one are both
          statements; only a dead backend gets the alarm. */}
      {error && <Lit className="mp__fault err">Couldn’t reach the brain: {error}</Lit>}

      {/* ⚠ NO CELEBRATION. `saim-voice` rejects the "celebrate this small win"
          register outright, and CLAUDE.md records the two 🎉 empty states in
          this app being removed — this was a third, and it survived because it
          is a FALLBACK: it only renders when the server sent no message, so it
          is absent from the common case and from anyone reading the payload.
          An empty diary is a fact, said plainly. */}
      {data && !meeting && (
        <Lit tone="statement" className="mp__none">{data.message || 'Nothing else in the diary.'}</Lit>
      )}

      {/* The one thing this screen is about — the meeting he is walking into.
          MANIFESTATION's named exception: a screen with ONE answer. */}
      {meeting && (
        <Lit tone="lead" className="mp__meeting">
          <div className="mp__when">
            {meeting.startFormatted}{meeting.endFormatted ? `–${meeting.endFormatted}` : ''} · {meeting.inProgress ? 'on now' : fromNow(meeting.minutesAway)}
          </div>
          <div className="mp__subject">{meeting.subject}</div>
          {meeting.location && <div className="mp__loc">📍 {meeting.location}</div>}

          {prep?.attendees?.length > 0 && (
            <div className="mp__block">
              <LitLabel className="mp__h">Attendees</LitLabel>
              {/* ⚠ Leave, from People HR — not Graph's accepted/declined, which
                  is usually weeks stale. Three facts kept apart: booked off,
                  checked and nothing booked (silent), and COULD NOT CHECK. The
                  last must never render like the second, or someone on a beach
                  reads as someone who will be in the room. */}
              {prep.someoneAway?.length > 0 && (
                <div className="mp__away-sum">
                  Off that day: {prep.someoneAway.join(', ')}
                </div>
              )}
              {(() => {
                const unknown = prep.attendees.filter((a) => a.awayUnknown).length;
                return unknown > 0 ? (
                  <div className="mp__away-unknown-sum">
                    Couldn&rsquo;t check leave for {unknown} of {prep.attendees.length}
                    {' '}— don&rsquo;t read that as them being in.
                  </div>
                ) : null;
              })()}
              {prep.attendees.map((a, i) => (
                <div className="mp__person" key={i}>
                  <div className="mp__person-name">
                    {a.name}{a.role ? <span className="mp__role"> · {a.role}</span> : ''}
                    {a.away && <span className="mp__away"> Off · {awayWords(a.away)}</span>}
                    {!a.away && a.awayUnknown && <span className="mp__away-unknown"> leave not checked</span>}
                  </div>
                  {a.recentNotes && <div className="mp__person-notes">{a.recentNotes}</div>}
                  {/* ⚠ "Noted as outstanding", NOT "Owes you".
                      These rows were extracted automatically from 232 meeting
                      notes and some are misparses. "Owes you" states as fact
                      that a named colleague failed to do something, seconds
                      before Nick sits down opposite them — on the strength of a
                      parse he cannot see. This reports what a note recorded and
                      shows which note, so he can weigh it himself.

                      Chase and Done in place (7 Nov 2026): Chase drafts the email
                      and shows it here with Send — one press, then Sent Items is
                      checked. Nothing on the kiosk. */}
                  {a.waitingOn?.length > 0 && (
                    <div className="mp__owes">
                      <div className="mp__owes-h">Noted as outstanding ({a.waitingOn.length})</div>
                      {a.waitingOn.map((w, j) => (
                        <div className="mp__owes-item" key={j}>
                          <span className="mp__owes-text">{w.text}</span>
                          <span className={`mp__owes-age${w.stale ? ' stale' : ''}`}>
                            {w.ageDays}d{w.chaseCount > 0 ? ` · chased ${w.chaseCount}×` : ''}
                          </span>
                          {/* The evidence. An unattributed row SAYS it is
                              unattributed rather than looking like the others. */}
                          <span className="mp__owes-src">
                            {w.sourcePath
                              ? `from ${String(w.sourcePath).split('/').pop().replace(/\.md$/, '')}${w.sourceDate ? ` · ${w.sourceDate}` : ''}`
                              : 'no source recorded — worth checking before raising'}
                          </span>
                          {w.key && <OwedActions call={owedCall} waitingKey={w.key} only={['chase', 'done']} compact />}
                        </div>
                      ))}
                    </div>
                  )}

                  {/* What they took on in their LAST 1-2-1 (item 20).
                      A different population to the block above and worth
                      keeping apart: these are actions the person accepted in a
                      recorded conversation, written onto their People card, and
                      the moment they matter is the next 1-2-1 — which is this
                      screen. Read-only, and each one names the card it is on. */}
                  {a.agreedLastTime?.length > 0 && (
                    <div className="mp__owes">
                      <div className="mp__owes-h">
                        Agreed in your last 1-2-1 ({a.agreedLastTimeTotal ?? a.agreedLastTime.length})
                      </div>
                      {a.agreedLastTime.map((w, j) => (
                        <div className="mp__owes-item" key={j}>
                          <span className="mp__owes-text">{w.text}</span>
                          {w.dueDate && <span className="mp__owes-age">due {w.dueDate}</span>}
                          <span className="mp__owes-src">
                            {w.sourcePath
                              ? `from ${String(w.sourcePath).split('/').pop().replace(/\.md$/, '')}`
                              : 'no source recorded — worth checking before raising'}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {prep?.suggestedTopics?.length > 0 && (
            <div className="mp__block">
              <LitLabel className="mp__h">Topics</LitLabel>
              <ul className="mp__list">{prep.suggestedTopics.map((t, i) => <li key={i}>{t}</li>)}</ul>
            </div>
          )}

          {prep?.agendaOffer && <PrepAgenda key={prep.agendaOffer.key} offer={prep.agendaOffer} />}

          {/* Task context (22 Oct 2026): open tasks this meeting touches, with what is
              pinned to them — only items the sheet does not already show. */}
          {prep?.taskContext?.length > 0 && (
            <div className="mp__block mp__block--context">
              <LitLabel className="mp__h">Context for related tasks</LitLabel>
              {prep.taskContext.map((t) => (
                <div className="mp__ctx" key={t.taskId}>
                  <div className="mp__ctx-task">{t.text}</div>
                  <ul className="tctx__list">{t.items.map((it) => <ContextItem key={it.id} item={it} compact />)}</ul>
                </div>
              ))}
            </div>
          )}

          {/* ⚠ What could NOT be read. "Nothing outstanding" and "I couldn't
              check what is outstanding" are opposite facts about a colleague,
              and a prep sheet that renders the second as the first is how Nick
              walks in believing everything is clear. */}
          {prep?.gaps?.length > 0 && (
            <div className="mp__block mp__block--gaps">
              <LitLabel className="mp__h">Couldn&rsquo;t check</LitLabel>
              <ul className="mp__list">
                {prep.gaps.map((g, i) => <li key={i}>{g.input}{g.why ? ` — ${g.why}` : ''}</li>)}
              </ul>
              <div className="mp__gapnote">Treat the sections above as incomplete, not clear.</div>
            </div>
          )}

          {prep?.checklist?.length > 0 && (
            <div className="mp__block">
              <LitLabel className="mp__h">Checklist</LitLabel>
              <ul className="mp__list">{prep.checklist.map((t, i) => <li key={i}>{t}</li>)}</ul>
            </div>
          )}

          {prep?.recentDecisions?.length > 0 && (
            <div className="mp__block">
              <LitLabel className="mp__h">Recent decisions</LitLabel>
              {prep.recentDecisions.map((d, i) => (
                <div className="mp__decision" key={i}>{d.text}</div>
              ))}
            </div>
          )}
        </Lit>
      )}

      {data?.laterToday?.length > 0 && (
        <div className="mp__later">
          <LitLabel className="mp__h">Later today</LitLabel>
          {data.laterToday.map((m, i) => (
            <Lit tone="row" className="mp__later-item" key={i}>
              <span className="mp__later-time">{new Date(m.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
              <span className="mp__later-subject">{m.subject}</span>
            </Lit>
          ))}
        </div>
      )}
    </section>
  );
}
