import React, { useState } from 'react';
import { useCanonical, postCanonical, Fold, HowItWorks } from './canonicalUi';

/**
 * Life → Leisure (Build 30). Compact on purpose: now playing, coming up, what
 * Nick is partway through, what he recently finished or liked, hobbies, and —
 * folded away — the listening evidence, household viewing, dislikes, profile
 * lines and sources.
 *
 * NOT a media app and NOT a feed: no posters, no history wall, no scores, no
 * streaks. Every state is the server's (`leisure-v1`) and every line says why.
 * Suggestions appear only when the server has a reason; listening is shown as
 * evidence ("heard on 3 days"), never as "you love it".
 */

const KIND = { tv_series: 'Series', film: 'Film', music_track: 'Track', album: 'Album', artist: 'Artist', playlist: 'Playlist', podcast: 'Podcast', audiobook: 'Audiobook', game: 'Game', book: 'Book', hobby: 'Hobby', other: 'Other' };
const STATE = { active: 'into it', paused: 'paused', completed: 'finished', abandoned: 'dropped', saved: 'saved for later', unknown: 'no state', current: 'playing' };
const AFF = { strong_interest: 'you like this', interest: 'listening a lot', unknown: 'not enough to say', disliked: 'not for you', excluded: 'not yours' };
const SRC = { seeing: 'reporting', quiet: 'quiet (normal)', never: 'never reported', identity: 'identifies episodes', 'context-only': 'power/context only', none: 'none found', unreadable: 'not read', unavailable: 'no source', ok: 'read', 'not-needed': 'not needed' };
const ADD_KINDS = ['tv_series', 'film', 'book', 'audiobook', 'podcast', 'game', 'album', 'artist', 'hobby', 'other'];

function Btn({ children, onClick, busy, title }) {
  return <button type="button" className="cn-btn cn-btn--tiny" disabled={busy} onClick={onClick} title={title}>{children}</button>;
}

function ItemActions({ it, act, busy }) {
  if (!act) return null;
  const c = (action) => act('/api/leisure/correct', { ref: it.ref, action });
  const episodic = it.kind === 'tv_series' || it.kind === 'podcast';
  return (
    <div className="cn-row-actions">
      {episodic && it.state === 'active' && <Btn busy={busy} onClick={() => c('next-episode')}>Watched next episode</Btn>}
      {it.state !== 'completed' && it.kind !== 'artist' && it.kind !== 'hobby' && <Btn busy={busy} onClick={() => c('completed')}>Finished</Btn>}
      {it.state === 'active' && it.kind !== 'artist' && <Btn busy={busy} onClick={() => c('paused')}>Pause</Btn>}
      {(it.state === 'paused' || it.state === 'saved' || it.state === 'unknown') && it.kind !== 'artist' && <Btn busy={busy} onClick={() => c('resume')}>Into it again</Btn>}
      {it.state !== 'abandoned' && it.kind !== 'artist' && <Btn busy={busy} onClick={() => c('dropped')}>Dropped</Btn>}
      <Btn busy={busy} onClick={() => c(it.preference === 'liked' || it.preference === 'loved' ? 'clear-preference' : 'liked')}>{it.preference === 'liked' || it.preference === 'loved' ? 'Clear like' : 'Liked'}</Btn>
      <Btn busy={busy} onClick={() => c('not-for-me')}>Not for me</Btn>
    </div>
  );
}

function ItemRow({ it, act, busy, extra = null }) {
  return (
    <li data-testid="leisure-item">
      <strong>{it.title}</strong>{it.creator && <span className="cn-muted"> — {it.creator}</span>}
      <span className="cn-chip">{KIND[it.kind] || it.kind}</span>
      {it.state && <span className="cn-chip">{STATE[it.state] || it.state}</span>}
      {it.progress && <span className="cn-chip">{it.progress}</span>}
      {(it.preference === 'liked' || it.preference === 'loved') && <span className="cn-chip">{it.preference}</span>}
      <div className="cn-muted cn-small">{it.why || it.stateWhy}</div>
      {extra}
      <ItemActions it={it} act={act} busy={busy} />
    </li>
  );
}

function Listening({ rows, act, busy }) {
  if (!rows.length) return <p className="cn-muted cn-small">Nothing heard on the phone's Music app since NEURO started keeping count.</p>;
  return (
    <ul className="cn-list">
      {rows.map((o) => (
        <li key={o.ref} data-testid="leisure-listening">
          <strong>{o.title}</strong>{o.creator && <span className="cn-muted"> — {o.creator}</span>}
          <span className="cn-chip">{AFF[o.affinity] || o.affinity}</span>
          <div className="cn-muted cn-small">{o.why}</div>
          {act && (
            <div className="cn-row-actions">
              <Btn busy={busy} onClick={() => act('/api/leisure/correct', { ref: o.ref, action: 'liked' })}>I like this</Btn>
              <Btn busy={busy} onClick={() => act('/api/leisure/correct', { ref: o.ref, action: 'not-for-me' })}>Not for me</Btn>
              <Btn busy={busy} onClick={() => act('/api/leisure/correct', { ref: o.ref, action: 'not-mine' })} title="Someone else was playing it">Not mine</Btn>
              <Btn busy={busy} onClick={() => act('/api/leisure/correct', { ref: o.ref, action: 'remove-basis' })} title="Keep it, but never base a suggestion on it">Don’t use for suggestions</Btn>
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

function AddForm({ act, busy }) {
  const [kind, setKind] = useState('tv_series');
  const [title, setTitle] = useState('');
  const [creator, setCreator] = useState('');
  const [state, setState] = useState('active');
  const [season, setSeason] = useState('');
  const [episode, setEpisode] = useState('');
  const [eventDate, setEventDate] = useState('');
  const [eventKind, setEventKind] = useState('booked');
  const submit = async () => {
    const body = { kind, title, state };
    if (creator.trim()) body.creator = creator;
    if (kind === 'tv_series' && season && episode) body.progress = { season: Number(season), episode: Number(episode) };
    if (eventDate) { body.eventDate = eventDate; body.eventKind = eventKind; }
    if (await act('/api/leisure/items', body)) { setTitle(''); setCreator(''); setSeason(''); setEpisode(''); setEventDate(''); }
  };
  return (
    <div className="cn-form" data-testid="leisure-add">
      <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="What it is">
        {ADD_KINDS.map((k) => <option key={k} value={k}>{KIND[k]}</option>)}
      </select>
      <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" aria-label="Title" />
      <input value={creator} onChange={(e) => setCreator(e.target.value)} placeholder="By (optional)" aria-label="Creator" />
      <select value={state} onChange={(e) => setState(e.target.value)} aria-label="State">
        {['active', 'paused', 'saved', 'completed'].map((s) => <option key={s} value={s}>{STATE[s]}</option>)}
      </select>
      {kind === 'tv_series' && (
        <span>
          <input value={season} onChange={(e) => setSeason(e.target.value.replace(/\D/g, ''))} placeholder="Season" aria-label="Season" size={4} />
          <input value={episode} onChange={(e) => setEpisode(e.target.value.replace(/\D/g, ''))} placeholder="Last watched ep." aria-label="Episode" size={6} />
        </span>
      )}
      <input type="date" value={eventDate} onChange={(e) => setEventDate(e.target.value)} aria-label="Date (booking, release or session)" />
      {eventDate && (
        <select value={eventKind} onChange={(e) => setEventKind(e.target.value)} aria-label="What the date is">
          <option value="booked">booked</option><option value="release">release</option><option value="session">session</option>
        </select>
      )}
      <button type="button" className="cn-btn" disabled={busy || !title.trim()} onClick={submit}>Add</button>
    </div>
  );
}

export function LeisureView({ data, act = null, busy = false, msg = null }) {
  if (!data) return null;
  const { now, comingUp = [], continue: cont = [], recentlyEnjoyed = [], hobbies = [], saved = [], quiet = [], listening = { artists: [], albums: [] },
    household = [], preferences = { liked: [], disliked: [] }, profile = { interests: [] }, suggestions = [], sources = [] } = data;
  return (
    <section className="cn-section" data-testid="leisure-card">
      <h3>Leisure</h3>
      {msg && <p className="cn-error cn-small">{msg}</p>}

      {now && now.playing && (
        <p data-testid="leisure-now">Playing <strong>{now.playing.title}</strong>{now.playing.artist ? ` — ${now.playing.artist}` : ''}
          <span className="cn-muted cn-small"> · on your phone{now.playing.ageMinutes ? `, reported ${now.playing.ageMinutes} min ago` : ''}</span></p>
      )}
      {now && (now.tv || []).length > 0 && (
        <p className="cn-muted cn-small">{now.tv.map((t) => `${t.name} is ${t.state}${t.title ? ` (${t.title})` : ''}`).join(' · ')} — household, not counted as yours.</p>
      )}

      {comingUp.length > 0 && (
        <>
          <h4>Coming up</h4>
          <ul className="cn-list">{comingUp.map((c) => <li key={`${c.ref}|${c.date}`}><strong>{c.date}</strong>{c.time ? ` ${c.time}` : ''} {c.title} <span className="cn-muted cn-small">— {c.why}</span></li>)}</ul>
        </>
      )}

      <h4>Continue</h4>
      {cont.length ? <ul className="cn-list">{cont.map((it) => <ItemRow key={it.ref} it={it} act={it.basis === 'you' ? act : null} busy={busy} />)}</ul>
        : <p className="cn-muted cn-small">Nothing in progress that NEURO knows of. Add what you're watching, reading or playing below — NEURO can't see your TV or books.</p>}

      {suggestions.length > 0 && (
        <>
          <h4>Next, if you want it</h4>
          <ul className="cn-list">{suggestions.map((s) => <li key={`${s.ref}|${s.type}`} data-testid="leisure-suggestion">{s.line} <span className="cn-muted cn-small">— {s.why} ({s.confidence} confidence)</span></li>)}</ul>
        </>
      )}

      {recentlyEnjoyed.length > 0 && (
        <>
          <h4>Recently enjoyed</h4>
          <ul className="cn-list">{recentlyEnjoyed.map((it) => <li key={it.ref}><strong>{it.title}</strong>{it.creator ? ` — ${it.creator}` : ''} <span className="cn-muted cn-small">— {it.why}</span></li>)}</ul>
        </>
      )}

      <h4>Hobbies</h4>
      {hobbies.length ? <ul className="cn-list">{hobbies.map((h) => <ItemRow key={h.ref} it={h} act={act} busy={busy} extra={h.project ? <div className="cn-muted cn-small">Linked project: {h.project.name}</div> : null} />)}</ul>
        : <p className="cn-muted cn-small">No hobbies tracked. NEURO won't turn a line in your profile into one — add it below if you want it here.</p>}

      {(saved.length > 0 || quiet.length > 0) && (
        <Fold title="Saved for later and gone quiet" meta={`${saved.length + quiet.length}`}>
          <ul className="cn-list">{[...saved, ...quiet].map((it) => <ItemRow key={it.ref} it={it} act={act} busy={busy} />)}</ul>
        </Fold>
      )}

      <Fold title="What the phone has heard" meta={listening.since ? `since ${listening.since}` : 'nothing yet'}>
        <p className="cn-muted cn-small">Days each artist or album was playing on the iPhone Music app. One play is never interest; listening alone never becomes "you like it".</p>
        <h5>Artists</h5>
        <Listening rows={listening.artists} act={act} busy={busy} />
        <h5>Albums</h5>
        <Listening rows={listening.albums} act={act} busy={busy} />
      </Fold>

      {household.length > 0 && (
        <Fold title="Household viewing" meta={`${household.length}`}>
          <ul className="cn-list">{household.map((h) => (
            <li key={h.ref}><strong>{h.title}</strong> <span className="cn-muted cn-small">— {h.why}</span>
              {act && <div className="cn-row-actions"><Btn busy={busy} onClick={() => act('/api/leisure/correct', { ref: h.ref, action: 'this-was-me' })}>This was me</Btn></div>}
            </li>))}
          </ul>
        </Fold>
      )}

      {(preferences.disliked.length > 0 || preferences.liked.length > 0) && (
        <Fold title="What you've said you like and don't" meta={`${preferences.liked.length} liked · ${preferences.disliked.length} not for you`}>
          <ul className="cn-list">
            {preferences.liked.map((p) => <li key={p.ref}>Liked: {p.title}{p.creator ? ` — ${p.creator}` : ''}{p.wantMore ? ' (more like this)' : ''}</li>)}
            {preferences.disliked.map((p) => <li key={p.ref}>Not for you: {p.title} <span className="cn-muted cn-small">— {p.scope}</span></li>)}
          </ul>
        </Fold>
      )}

      {profile.interests && profile.interests.length > 0 && (
        <Fold title="From your profile" meta={`${profile.interests.length}`}>
          <p className="cn-muted cn-small">Shown as written in Me/About Nick.md. NEURO does not turn these into tracked items or tastes.</p>
          <ul className="cn-list">{profile.interests.map((i) => <li key={i.text}>{i.text}</li>)}</ul>
        </Fold>
      )}

      {act && <Fold title="Add something"><AddForm act={act} busy={busy} /></Fold>}

      <Fold title="Sources" meta={`${sources.filter((s) => ['seeing', 'quiet', 'ok', 'identity', 'context-only'].includes(s.state)).length} of ${sources.length} readable`}>
        <ul className="cn-list">{sources.map((s) => <li key={s.id} data-testid="leisure-source"><strong>{s.label}</strong>: {SRC[s.state] || s.state} <span className="cn-muted cn-small">— {s.detail}</span></li>)}</ul>
      </Fold>

      <HowItWorks>
        Playing on your phone is evidence that something was playing, not that you chose or like it. Listening across several days and weeks reads as
        interest; only you can say you like something. Shared TVs and speakers are household, never your taste. Nothing is marked finished because it
        started, and nothing is dropped because it went quiet. Suggestions only come from what you've saved or are partway through; ask SAiM for anything wider.
        Nothing here interrupts you.
      </HowItWorks>
    </section>
  );
}

export default function LeisureCard() {
  const { data, error, reload } = useCanonical('/api/leisure');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const act = async (path, body) => {
    setBusy(true); setMsg(null);
    try { await postCanonical(path, body); reload(); return true; } catch (e) { setMsg(e.message); return false; } finally { setBusy(false); }
  };
  if (!data && error) return <section className="cn-section" data-testid="leisure-card"><h3>Leisure</h3><p className="cn-error">Couldn’t read Leisure: {error}. This is not "nothing going on".</p></section>;
  return <LeisureView data={data} act={act} busy={busy} msg={msg} />;
}
