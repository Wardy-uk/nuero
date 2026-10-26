import React, { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../api';
import { executeDirect, directOutcome } from '../directAction';
import './UatVolunteers.css';

/**
 * UAT volunteers (26 Oct 2026) — services/uat-volunteers.js.
 *
 * One card per UAT request NEURO found: who it picked from each team and why,
 * one press to send their invites, their answers, and one press to send the
 * names to Dan. Every send goes through the governed path (directAction) — the
 * press IS the approval. The rota sits below, folded.
 *
 * UatVolunteersView is PURE (props only) so a render test can drive it.
 */

const STATUS = {
  proposed: 'Picked — not asked yet',
  invited: 'Invite drafted — not sent',
  sent: 'Asked',
  confirmed: 'Confirmed',
  accepted: 'No reply — counts as yes',
  declined: 'Declined',
};

function when(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function PoolRow({ round, pool, rota, busy, onSwap }) {
  const cur = pool.current;
  const members = (rota.find((r) => r.id === pool.id) || { members: [] }).members;
  const canSwap = cur && (cur.status === 'proposed' || cur.status === 'invited');
  return (
    <div className="uat__pool">
      <div className="uat__pool-label">{pool.label}</div>
      {cur ? (
        <div className="uat__pick">
          <span className="uat__name">{cur.person}</span>
          <span className={`uat__chip uat__chip--${cur.status}`}>
            {STATUS[cur.status] || cur.status}
            {cur.status === 'sent' && cur.deadlineAt ? ` — reply by ${when(cur.deadlineAt)}` : ''}
          </span>
          {cur.why && <span className="uat__why">{cur.why}</span>}
          {canSwap && (
            <select
              className="uat__swap"
              value=""
              disabled={busy}
              onChange={(e) => onSwap(round.id, cur.id, e.target.value === '__next' ? null : e.target.value)}
              aria-label={`Swap ${cur.person}`}
            >
              <option value="">Swap…</option>
              <option value="__next">Next in the rota</option>
              {members.filter((m) => m.name !== cur.person && m.hasEmail).map((m) => (
                <option key={m.name} value={m.name}>{m.name}{m.last ? ` (last ${m.last.slice(0, 10)})` : ' (never)'}</option>
              ))}
            </select>
          )}
        </div>
      ) : (
        <div className="uat__pick uat__pick--empty">No one eligible — everyone is off or has been asked.</div>
      )}
      {pool.earlier.length > 0 && (
        <div className="uat__earlier">
          {pool.earlier.map((e, i) => <span key={i}>{e.person} ({e.status === 'replaced' ? 'swapped' : e.status})</span>)}
        </div>
      )}
    </div>
  );
}

function Round({ round, rota, busy, note, onInvite, onSendReply, onSwap, onDismiss, onRetry }) {
  const s = round.session;
  const time = s ? (s.end ? `${s.start}–${s.end}` : s.start) : '';
  const replyAction = round.reply && round.reply.action;
  return (
    <div className={`uat__round uat__round--${round.status}`}>
      <div className="uat__head">
        <div>
          <div className="uat__title">{s ? `UAT ${s.dayWords}, ${time}` : 'UAT request'}</div>
          <div className="uat__sub">
            {s && s.feature ? `${s.feature} · ` : ''}from {round.from.name || round.from.email || 'unknown'}
            {s && s.location ? ` · ${s.location}` : ''}
          </div>
        </div>
        {round.status !== 'done' && (
          <button className="uat__quiet" disabled={busy} onClick={() => onDismiss(round.id)}>
            {round.status === 'unclear' ? 'Not a volunteer request' : 'Not needed'}
          </button>
        )}
      </div>

      {round.status === 'unclear' ? (
        <div className="uat__unclear">
          <p>NEURO found “{round.subject}” but could not read it: {round.unclearWhy || 'unknown reason'}.</p>
          <button disabled={busy} onClick={() => onRetry(round.id)}>Try again</button>
        </div>
      ) : (
        <>
          {round.pools.map((p) => <PoolRow key={p.id} round={round} pool={p} rota={rota} busy={busy} onSwap={onSwap} />)}
          {round.toInvite > 0 && (
            <div className="uat__actions">
              <button className="uat__primary" disabled={busy} onClick={() => onInvite(round.id)}>
                Send {round.toInvite === 1 ? 'the invite' : `${round.toInvite} invites`}
              </button>
              <span className="uat__hint">Each gets a Confirm / Decline link. No reply by the deadline counts as yes.</span>
            </div>
          )}
          {replyAction && (
            <div className="uat__reply">
              <div className="uat__reply-label">Reply to {round.from.name || 'Dan'}</div>
              <pre className="uat__reply-body">{replyAction.draft && replyAction.draft.body}</pre>
              <button className="uat__primary" disabled={busy} onClick={() => onSendReply(round.id, replyAction)}>Send reply</button>
            </div>
          )}
          {round.status === 'done' && <div className="uat__done">Done — {round.from.name || 'Dan'} has the names.{round.unclearWhy ? ` (${round.unclearWhy})` : ''}</div>}
          {round.status !== 'done' && round.unclearWhy && <div className="uat__warn">{round.unclearWhy}</div>}
        </>
      )}
      {note && <div className={`uat__note uat__note--${note.tone}`}>{note.text}</div>}
    </div>
  );
}

export function UatVolunteersView({ data, error, busy = false, notes = {}, onInvite, onSendReply, onSwap, onDismiss, onRetry }) {
  if (error) return <section className="uat"><h3 className="uat__h">UAT volunteers</h3><div className="uat__warn">Couldn't read UAT rounds — {error}</div></section>;
  if (!data) return null;
  const live = (data.rounds || []).filter((r) => r.status !== 'done');
  const done = (data.rounds || []).filter((r) => r.status === 'done').slice(0, 3);
  return (
    <section className="uat">
      <h3 className="uat__h">UAT volunteers</h3>
      {live.length === 0 && <p className="uat__empty">No UAT request waiting. NEURO watches your inbox for the next one.</p>}
      {live.map((r) => (
        <Round key={r.id} round={r} rota={data.rota || []} busy={busy} note={notes[r.id]}
          onInvite={onInvite} onSendReply={onSendReply} onSwap={onSwap} onDismiss={onDismiss} onRetry={onRetry} />
      ))}
      {done.map((r) => (
        <Round key={r.id} round={r} rota={data.rota || []} busy={busy} note={notes[r.id]}
          onInvite={onInvite} onSendReply={onSendReply} onSwap={onSwap} onDismiss={onDismiss} onRetry={onRetry} />
      ))}
      <details className="uat__rota">
        <summary>Rota — who's next</summary>
        <div className="uat__rota-grid">
          {(data.rota || []).map((p) => (
            <div key={p.id}>
              <div className="uat__pool-label">{p.label}</div>
              <ol>
                {p.members.map((m) => (
                  <li key={m.name}>
                    {m.name}
                    <span className="uat__why">{m.last ? ` — last ${m.last.slice(0, 10)}, ${m.times}×` : ' — never'}{m.hasEmail ? '' : ' · no email in People note'}</span>
                  </li>
                ))}
              </ol>
            </div>
          ))}
        </div>
      </details>
    </section>
  );
}

export default function UatVolunteers() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [notes, setNotes] = useState({});

  const load = useCallback(async () => {
    try {
      const r = await apiFetch('/api/uat');
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setData(j); setError(null);
    } catch (e) { setError(e.message); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const post = async (path, body) => {
    const r = await apiFetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    let j = null;
    try { j = await r.json(); } catch { j = null; }
    return j || { ok: false, error: `HTTP ${r.status}` };
  };

  const run = async (roundId, fn) => {
    setBusy(true);
    try { const note = await fn(); if (note) setNotes((n) => ({ ...n, [roundId]: note })); } finally { setBusy(false); await load(); }
  };

  const onInvite = (roundId) => run(roundId, async () => {
    const prep = await post(`/api/uat/rounds/${roundId}/invites`);
    if (!prep.ok) return { tone: 'bad', text: prep.error || 'Could not prepare the invites.' };
    const outcomes = [];
    for (const a of prep.actions || []) {
      const r = await executeDirect(a);
      const to = (a.draft && a.draft.to && a.draft.to[0] && (a.draft.to[0].name || a.draft.to[0].email)) || 'invite';
      outcomes.push(`${to}: ${directOutcome(r).text}`);
    }
    for (const f of prep.failed || []) outcomes.push(`${f.person}: not prepared — ${f.error}`);
    await post('/api/uat/tick');
    return { tone: outcomes.some((o) => /Could not|not prepared/.test(o)) ? 'warn' : 'ok', text: outcomes.join(' · ') || 'Nothing to send.' };
  });

  const onSendReply = (roundId, action) => run(roundId, async () => {
    const r = await executeDirect(action);
    await post('/api/uat/tick');
    return directOutcome(r);
  });

  const onSwap = (roundId, selectionId, person) => run(roundId, async () => {
    const r = await post(`/api/uat/rounds/${roundId}/selections/${selectionId}/swap`, { person });
    return r.ok ? null : { tone: 'bad', text: r.error || 'Could not swap.' };
  });

  const onDismiss = (roundId) => run(roundId, async () => {
    const r = await post(`/api/uat/rounds/${roundId}/dismiss`);
    return r.ok ? null : { tone: 'bad', text: r.error || 'Could not dismiss.' };
  });

  const onRetry = (roundId) => run(roundId, async () => {
    const r = await post(`/api/uat/rounds/${roundId}/retry`);
    return r.ok ? null : { tone: 'bad', text: r.error || 'Still could not read it.' };
  });

  return <UatVolunteersView data={data} error={error} busy={busy} notes={notes}
    onInvite={onInvite} onSendReply={onSendReply} onSwap={onSwap} onDismiss={onDismiss} onRetry={onRetry} />;
}
