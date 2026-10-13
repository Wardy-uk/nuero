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

// A date key shown as "Sat 21 Nov" — built from its parts, never parsed as UTC.
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function dayLabel(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ''));
  if (!m) return key;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return `${DOW[d.getDay()]} ${Number(m[3])} ${MON[Number(m[2]) - 1]}`;
}

// One thing in progress, as a tile: what it is, by whom, and one short fact.
// The full reason rides on hover; a reason every tile shares is said once in
// the heading instead (13 Oct 2026 — the card was a wall of repeated sentences).
function ContinueTile({ it, act, busy }) {
  const phone = it.basis === 'listening';
  return (
    <li className="cn-tile" data-testid="leisure-item" title={it.why || it.stateWhy || ''}>
      <span className="cn-tile-title">{it.title}</span>
      {it.creator && <span className="cn-tile-sub">{it.creator}</span>}
      <span className="cn-tile-foot">
        <span className="cn-chip">{KIND[it.kind] || it.kind}</span>
        {phone && it.daysThisWeek != null ? <span>{it.daysThisWeek} of 7 days</span>
          : it.state && <span className="cn-chip">{STATE[it.state] || it.state}</span>}
        {it.progress && <span>{it.progress}</span>}
        {(it.preference === 'liked' || it.preference === 'loved') && <span className="cn-chip">{it.preference}</span>}
      </span>
      {!phone && <ItemActions it={it} act={act} busy={busy} />}
    </li>
  );
}

// Nick's rating of what he listens to (13 Oct 2026): what he LOVES versus what
// is just playing. Love counts most when NEURO looks for new music; background
// never counts. The chosen rating stays lit; pressing it again clears it.
const RATINGS = [
  { id: 'love', action: 'loved', label: '♥ Love', title: 'Really love it — suggestions lean on this most' },
  { id: 'like', action: 'liked', label: 'Like', title: 'You like it' },
  { id: 'background', action: 'neutral', label: 'Just background', title: 'It was just playing — never used for suggestions' },
  { id: 'not-for-me', action: 'not-for-me', label: 'Not for me', title: 'Never suggest more like it' },
];
const RATING_CHIP = { love: '♥ love', like: 'you like this', background: 'background', 'not-for-me': 'not for you' };

function Listening({ rows, act, busy }) {
  if (!rows.length) return <p className="cn-muted cn-small">Nothing heard on the phone's Music app since NEURO started keeping count.</p>;
  return (
    <ul className="cn-list">
      {rows.map((o) => {
        const rated = o.rating || null;
        return (
        <li key={o.ref} data-testid="leisure-listening">
          <strong>{o.title}</strong>{o.creator && <span className="cn-muted"> — {o.creator}</span>}
          <span className={`cn-chip${rated === 'love' ? ' cn-chip--love' : ''}`}>{rated ? RATING_CHIP[rated] : (AFF[o.affinity] || o.affinity)}</span>
          {!rated && o.onRepeat
            ? <div className="cn-small cn-repeat">You keep coming back to this — love it?</div>
            : !rated && <div className="cn-muted cn-small">{o.why}</div>}
          {act && (
            <div className="cn-row-actions cn-rate" role="group" aria-label={`Rate ${o.title}`}>
              {RATINGS.map((r) => (
                <button key={r.id} type="button" disabled={busy} title={r.title} aria-pressed={rated === r.id}
                  className={`cn-btn cn-btn--tiny cn-rate-btn${rated === r.id ? ' cn-rate-btn--on' : ''}${r.id === 'love' ? ' cn-rate-btn--love' : ''}${r.id === 'love' && !rated && o.onRepeat ? ' cn-rate-btn--ask' : ''}`}
                  onClick={() => act('/api/leisure/correct', { ref: o.ref, action: rated === r.id ? 'clear-preference' : r.action })}>
                  {r.label}
                </button>
              ))}
              <Btn busy={busy} onClick={() => act('/api/leisure/correct', { ref: o.ref, action: 'not-mine' })} title="Someone else was playing it">Not mine</Btn>
            </div>
          )}
        </li>
        );
      })}
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

/**
 * "You might like" — new artists Deezer relates to the ones Nick plays. Each
 * says which of his it came from, offers one song (with Deezer's 30 s
 * preview), and two answers: save it, or not for me (which also stops it
 * being suggested again). The server never re-ranks here; neither does this.
 */
// One shared player for every preview: starting one stops the other, and
// leaving the page stops it (React unmounts the button, the effect pauses it).
let _player = null;
let _current = null; // the setter of the button that is playing now
function Preview({ src }) {
  const [on, setOn] = React.useState(false);
  React.useEffect(() => () => { if (_current === setOn && _player) { _player.pause(); _current = null; } }, []);
  const toggle = () => {
    if (!_player) _player = new Audio();
    if (on) { _player.pause(); _current = null; setOn(false); return; }
    if (_current) _current(false);
    _player.pause();
    _player.src = src;
    _current = setOn;
    _player.onended = () => { if (_current === setOn) { _current = null; setOn(false); } };
    setOn(true);
    _player.play().catch(() => { if (_current === setOn) { _current = null; setOn(false); } });
  };
  return (
    <button type="button" className={`cn-preview${on ? ' cn-preview--on' : ''}`} onClick={toggle} title="30-second preview from Deezer">
      {on ? '❚❚ playing' : '▶ preview'}
    </button>
  );
}

// Keep first-seen order; group items that share a reason so it is said once.
function groupBy(xs, key) {
  const m = new Map();
  for (const x of xs) { const k = key(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); }
  return [...m.entries()];
}

function Discovery({ d, act, busy }) {
  if (!d) return null;
  const save = (x) => act && act('/api/leisure/items', { kind: 'artist', title: x.name, state: 'saved', notes: x.why || null });
  const nope = (x) => act && act('/api/leisure/items', { kind: 'artist', title: x.name, preference: 'not-for-me' });
  const again = () => act && act('/api/leisure/discovery/refresh', {});
  const meta = d.known && d.asOf ? `from ${d.seeds.length} artist${d.seeds.length === 1 ? '' : 's'} you play` : '';
  return (
    <>
      <h4>You might like <span className="cn-muted cn-small">{meta}</span></h4>
      {!d.known && <p className="cn-muted cn-small">{d.why}</p>}
      {d.known && !d.seeds.length && (
        <p className="cn-muted cn-small">Nothing to go on yet. Say you like a song or artist below, or play one on a few days across two weeks.</p>
      )}
      {d.known && d.seeds.length > 0 && !d.items.length && !d.lastError && (
        <p className="cn-muted cn-small">No new artists right now — everything Deezer relates to yours you have already heard or answered.</p>
      )}
      {d.lastError && <p className="cn-error cn-small">Couldn’t ask Deezer last time ({d.lastError}){d.items.length ? ' — this is the last list it gave.' : '.'}</p>}
      {d.items.length > 0 && groupBy(d.items, (x) => x.why || '').map(([why, xs]) => (
        <React.Fragment key={why || '-'}>
          {why && <div className="cn-group-why">{why.charAt(0).toUpperCase() + why.slice(1)}</div>}
          <ul className="cn-tiles">
            {xs.map((x) => (
              <li key={x.name} data-testid="leisure-discovery" className="cn-tile">
                <span className="cn-tile-title">{x.link ? <a href={x.link} target="_blank" rel="noreferrer">{x.name}</a> : x.name}</span>
                {x.track && (
                  <span className="cn-tile-sub">
                    try {x.track.link ? <a href={x.track.link} target="_blank" rel="noreferrer">“{x.track.title}”</a> : `“${x.track.title}”`}
                  </span>
                )}
                <span className="cn-tile-foot">
                  {x.track && x.track.preview && <Preview src={x.track.preview} />}
                  {act && <Btn busy={busy} onClick={() => save(x)} title="Keep it in Saved for later">Save</Btn>}
                  {act && <Btn busy={busy} onClick={() => nope(x)} title="Never suggest this artist again">Not for me</Btn>}
                </span>
              </li>
            ))}
          </ul>
        </React.Fragment>
      ))}
      {d.known && (
        <p className="cn-muted cn-small">
          From {d.source}{d.ageHours != null ? `, ${d.ageHours < 1 ? 'just now' : `${d.ageHours} h ago`}` : ''}.
          {d.unmatched && d.unmatched.length > 0 && ` Deezer didn’t recognise ${d.unmatched.join(', ')}.`}
          {act && <> <Btn busy={busy} onClick={again}>Ask again</Btn></>}
        </p>
      )}
    </>
  );
}

export function LeisureView({ data, act = null, busy = false, msg = null }) {
  if (!data) return null;
  const { now, comingUp = [], continue: cont = [], recentlyEnjoyed = [], hobbies = [], saved = [], quiet = [], listening = { artists: [], albums: [], tracks: [] },
    household = [], preferences = { liked: [], disliked: [] }, profile = { interests: [] }, suggestions = [], discovery = null, sources = [] } = data;
  return (
    <section className="cn-section" data-testid="leisure-card">
      <h3>Leisure</h3>
      {msg && <p className="cn-error cn-small">{msg}</p>}

      {now && ((now.playing) || (now.tv || []).length > 0) && (
        <div className="cn-nowstrip">
          {now.playing && (
            <span data-testid="leisure-now">Playing <strong>{now.playing.title}</strong>{now.playing.artist ? ` — ${now.playing.artist}` : ''}
              <span className="cn-muted cn-small"> · on your phone{now.playing.ageMinutes ? `, ${now.playing.ageMinutes} min ago` : ''}</span></span>
          )}
          {(now.tv || []).length > 0 && (
            <span className="cn-muted cn-small">{now.tv.map((t) => `${t.name} is ${t.state}${t.title ? ` (${t.title})` : ''}`).join(' · ')} — household, not counted as yours.</span>
          )}
        </div>
      )}

      {comingUp.length > 0 && (
        <>
          <h4>Coming up</h4>
          <ul className="cn-tiles">{comingUp.map((c) => (
            <li key={`${c.ref}|${c.date}`} className="cn-tile cn-tile--next" title={c.why}>
              <span className="cn-tile-big">{dayLabel(c.date)}{c.time ? ` · ${c.time}` : ''}</span>
              <span className="cn-tile-sub">{c.title}</span>
            </li>))}
          </ul>
        </>
      )}

      <h4>Continue{cont.some((it) => it.basis === 'listening') && <span className="cn-muted cn-small"> · albums are what the phone played this week</span>}</h4>
      {cont.length ? <ul className="cn-tiles">{cont.map((it) => <ContinueTile key={it.ref} it={it} act={it.basis === 'you' ? act : null} busy={busy} />)}</ul>
        : <p className="cn-muted cn-small">Nothing in progress that NEURO knows of. Add what you're watching, reading or playing below — NEURO can't see your TV or books.</p>}

      {suggestions.length > 0 && (
        <>
          <h4>Next, if you want it</h4>
          <ul className="cn-list">{suggestions.map((s) => <li key={`${s.ref}|${s.type}`} data-testid="leisure-suggestion">{s.line} <span className="cn-muted cn-small">— {s.why} ({s.confidence} confidence)</span></li>)}</ul>
        </>
      )}

      <Discovery d={discovery} act={act} busy={busy} />

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
        <p className="cn-muted cn-small">Days each song, artist or album was playing on the iPhone Music app. Rate them: what you <strong>love</strong> counts most when NEURO looks for new music, and “just background” never counts. Listening alone never becomes “you like it”.</p>
        <h5>Songs{listening.tracksSince && <span className="cn-muted cn-small"> · kept since {listening.tracksSince}</span>}</h5>
        <Listening rows={listening.tracks || []} act={act} busy={busy} />
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
