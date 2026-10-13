import React, { useState } from 'react';
import { useCanonical, postCanonical, Fold, HowItWorks, Headline, Stat, StatTiles, Tile, TileGrid, Group, PrimaryAction, dayLabel } from './canonicalUi';

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

// One item as a tile: what it is, by whom, and one short fact. The full reason
// rides on hover; a reason every tile shares is said once in its Group instead
// (13 Oct 2026 — the card was a wall of repeated sentences). A phone-heard
// album shows how many days it played and carries no corrections (it is
// evidence, not something Nick added).
function ItemTile({ it, act, busy, sub = null }) {
  const phone = it.basis === 'listening';
  return (
    <Tile testid="leisure-item" why={it.why || it.stateWhy || undefined} title={it.title} sub={sub || it.creator || null}
      foot={<>
        <span className="cn-chip">{KIND[it.kind] || it.kind}</span>
        {phone && it.daysThisWeek != null ? <span>{it.daysThisWeek} of 7 days</span>
          : it.state && <span className="cn-chip">{STATE[it.state] || it.state}</span>}
        {it.progress && <span>{it.progress}</span>}
        {(it.preference === 'liked' || it.preference === 'loved') && <span className="cn-chip">{it.preference}</span>}
      </>}>
      {!phone && <ItemActions it={it} act={act} busy={busy} />}
    </Tile>
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
  if (!rows.length) return <div className="cn-group-why">Nothing heard on the phone's Music app since counting began.</div>;
  return (
    <ul className="cn-list">
      {rows.map((o) => {
        const rated = o.rating || null;
        return (
        <li key={o.ref} data-testid="leisure-listening" title={o.why || undefined}>
          <strong>{o.title}</strong>{o.creator && <span className="cn-muted"> — {o.creator}</span>}
          <span className={`cn-chip${rated === 'love' ? ' cn-chip--love' : ''}`} title={o.why || undefined}>{rated ? RATING_CHIP[rated] : (AFF[o.affinity] || o.affinity)}</span>
          {!rated && o.onRepeat && <div className="cn-small cn-repeat">You keep coming back to this — love it?</div>}
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
  const meta = d.known
    ? [d.asOf ? `from ${d.seeds.length} artist${d.seeds.length === 1 ? '' : 's'} you play` : null,
      `${d.source}${d.ageHours != null ? `, ${d.ageHours < 1 ? 'just now' : `${d.ageHours} h ago`}` : ''}`].filter(Boolean).join(' · ')
    : null;
  // The state of the list, said once as the group's line — never a paragraph per case.
  const state = !d.known ? d.why
    : !d.seeds.length ? 'Nothing to go on yet. Rate a song or artist below, or play one on a few days across two weeks.'
      : !d.items.length && !d.lastError ? 'No new artists right now — everything Deezer relates to yours you have already heard or answered.'
        : null;
  return (
    <Group label="You might like" meta={meta} why={state}>
      {d.lastError && <div className="cn-error cn-small">Couldn’t ask Deezer last time ({d.lastError}){d.items.length ? ' — this is the last list it gave.' : '.'}</div>}
      {d.items.length > 0 && groupBy(d.items, (x) => x.why || '').map(([why, xs]) => (
        <React.Fragment key={why || '-'}>
          {why && <div className="cn-group-why">{why.charAt(0).toUpperCase() + why.slice(1)}</div>}
          <TileGrid>
            {xs.map((x) => (
              <Tile key={x.name} testid="leisure-discovery"
                title={x.link ? <a href={x.link} target="_blank" rel="noreferrer">{x.name}</a> : x.name}
                sub={x.track ? <>try {x.track.link ? <a href={x.track.link} target="_blank" rel="noreferrer">“{x.track.title}”</a> : `“${x.track.title}”`}</> : null}
                foot={<>
                  {x.track && x.track.preview && <Preview src={x.track.preview} />}
                  {act && <Btn busy={busy} onClick={() => save(x)} title="Keep it in Saved for later">Save</Btn>}
                  {act && <Btn busy={busy} onClick={() => nope(x)} title="Never suggest this artist again">Not for me</Btn>}
                </>} />
            ))}
          </TileGrid>
        </React.Fragment>
      ))}
      {d.known && (act || (d.unmatched && d.unmatched.length > 0)) && (
        <div className="cn-actions">
          {act && <Btn busy={busy} onClick={again}>Ask again</Btn>}
          {d.unmatched && d.unmatched.length > 0 && <span className="cn-small">Deezer didn’t recognise {d.unmatched.join(', ')}.</span>}
        </div>
      )}
    </Group>
  );
}

// The card's answer: what is playing now, else what is coming up, else what is
// on the go — taken from the server's lists in that order, nothing judged here.
function leisureHeadline({ now, comingUp, cont }) {
  if (now && now.playing) {
    return {
      tone: 'good', pill: 'Playing',
      text: <span data-testid="leisure-now">Playing <strong>{now.playing.title}</strong>{now.playing.artist ? ` — ${now.playing.artist}` : ''}
        <span className="cn-small"> · on your phone{now.playing.ageMinutes ? `, ${now.playing.ageMinutes} min ago` : ''}</span></span>,
    };
  }
  if (comingUp.length) {
    const c = comingUp[0];
    return { tone: 'plan', pill: 'Coming up', text: <>{c.title} · {dayLabel(c.date)}{c.time ? ` ${c.time}` : ''}</> };
  }
  if (cont.length) return { tone: null, pill: 'On the go', text: `${cont.length} thing${cont.length === 1 ? '' : 's'} in progress.` };
  return { tone: null, pill: 'Quiet', text: 'Nothing in progress that you’ve told NEURO about.' };
}

export function LeisureView({ data, act = null, busy = false, msg = null }) {
  const [adding, setAdding] = useState(false);
  if (!data) return null;
  const { now, comingUp = [], continue: cont = [], recentlyEnjoyed = [], hobbies = [], saved = [], quiet = [], listening = { artists: [], albums: [], tracks: [] },
    household = [], preferences = { liked: [], disliked: [] }, profile = { interests: [] }, suggestions = [], discovery = null, sources = [] } = data;
  const h = leisureHeadline({ now, comingUp, cont });
  const tv = now && (now.tv || []).length > 0
    ? <>{now.tv.map((t) => `${t.name} is ${t.state}${t.title ? ` (${t.title})` : ''}`).join(' · ')} — household, not counted as yours.</>
    : null;
  return (
    <section className="cn-section" data-testid="leisure-card">
      <h3>Leisure</h3>
      {msg && <p className="cn-error cn-small">{msg}</p>}

      <Headline tone={h.tone} pill={h.pill} detail={tv}>{h.text}</Headline>

      <StatTiles>
        <Stat v={cont.length} l="on the go" />
        <Stat v={comingUp.length} l="coming up" />
        <Stat v={hobbies.length} l={`hobb${hobbies.length === 1 ? 'y' : 'ies'}`} />
        <Stat v={saved.length} l="saved for later" />
      </StatTiles>

      {act && (
        <div className="cn-actions">
          <PrimaryAction onClick={() => setAdding((v) => !v)}>{adding ? 'Close' : 'Add something'}</PrimaryAction>
        </div>
      )}
      {act && adding && <AddForm act={act} busy={busy} />}

      {comingUp.length > 0 && (
        <Group label="Coming up">
          <TileGrid>{comingUp.map((c) => (
            <Tile key={`${c.ref}|${c.date}`} accent why={c.why} title={`${dayLabel(c.date)}${c.time ? ` · ${c.time}` : ''}`} sub={c.title} />))}
          </TileGrid>
        </Group>
      )}

      <Group label="Continue" why={cont.some((it) => it.basis === 'listening') ? 'Albums are what the phone played this week.' : (!cont.length ? 'Nothing in progress you’ve told NEURO about — Add something puts it here.' : null)}>
        {cont.length > 0 && <TileGrid>{cont.map((it) => <ItemTile key={it.ref} it={it} act={it.basis === 'you' ? act : null} busy={busy} />)}</TileGrid>}
      </Group>

      {suggestions.length > 0 && (
        <Group label="Next, if you want it">
          <TileGrid>{suggestions.map((s) => <Tile key={`${s.ref}|${s.type}`} testid="leisure-suggestion" title={s.line} sub={`${s.confidence} confidence`} why={s.why} />)}</TileGrid>
        </Group>
      )}

      <Discovery d={discovery} act={act} busy={busy} />

      {recentlyEnjoyed.length > 0 && (
        <Group label="Recently enjoyed">
          <TileGrid>{recentlyEnjoyed.map((it) => <Tile key={it.ref} title={it.title} sub={it.creator || null} why={it.why} />)}</TileGrid>
        </Group>
      )}

      <Group label="Hobbies" why={hobbies.length ? null : 'None tracked — Add something puts one here.'}>
        {hobbies.length > 0 && <TileGrid>{hobbies.map((hb) => <ItemTile key={hb.ref} it={hb} act={act} busy={busy} sub={hb.project ? `Linked project: ${hb.project.name}` : null} />)}</TileGrid>}
      </Group>

      {(saved.length > 0 || quiet.length > 0) && (
        <Fold title="Saved for later and gone quiet" meta={`${saved.length + quiet.length}`}>
          <TileGrid>{[...saved, ...quiet].map((it) => <ItemTile key={it.ref} it={it} act={act} busy={busy} />)}</TileGrid>
        </Fold>
      )}

      <Fold title="What the phone has heard" meta={listening.since ? `since ${listening.since}` : 'nothing yet'}>
        <div className="cn-group-why">Days each song, artist or album was playing on the iPhone Music app. What you <strong>love</strong> counts most when NEURO looks for new music; “just background” never counts. Hover a row for what was heard.</div>
        <h5>Songs{listening.tracksSince && <span className="cn-muted cn-small"> · kept since {listening.tracksSince}</span>}</h5>
        <Listening rows={listening.tracks || []} act={act} busy={busy} />
        <h5>Artists</h5>
        <Listening rows={listening.artists} act={act} busy={busy} />
        <h5>Albums</h5>
        <Listening rows={listening.albums} act={act} busy={busy} />
      </Fold>

      {household.length > 0 && (
        <Fold title="Household viewing" meta={`${household.length}`}>
          <TileGrid>{household.map((hh) => (
            <Tile key={hh.ref} title={hh.title} why={hh.why}
              foot={act ? <Btn busy={busy} onClick={() => act('/api/leisure/correct', { ref: hh.ref, action: 'this-was-me' })}>This was me</Btn> : null} />))}
          </TileGrid>
        </Fold>
      )}

      {(preferences.disliked.length > 0 || preferences.liked.length > 0) && (
        <Fold title="What you've said you like and don't" meta={`${preferences.liked.length} liked · ${preferences.disliked.length} not for you`}>
          <TileGrid>
            {preferences.liked.map((p) => <Tile key={p.ref} title={p.title} sub={p.creator || null} foot={<><span className="cn-chip">liked</span>{p.wantMore && <span>more like this</span>}</>} />)}
            {preferences.disliked.map((p) => <Tile key={p.ref} title={p.title} sub={p.scope} foot={<span className="cn-chip">not for you</span>} />)}
          </TileGrid>
        </Fold>
      )}

      {profile.interests && profile.interests.length > 0 && (
        <Fold title="From your profile" meta={`${profile.interests.length} · as written in Me/About Nick.md`}>
          <ul className="cn-list">{profile.interests.map((i) => <li key={i.text}>{i.text}</li>)}</ul>
        </Fold>
      )}

      <Fold title="Sources" meta={`${sources.filter((s) => ['seeing', 'quiet', 'ok', 'identity', 'context-only'].includes(s.state)).length} of ${sources.length} readable`}>
        <ul className="cn-list">{sources.map((s) => <li key={s.id} data-testid="leisure-source" title={s.detail}><strong>{s.label}</strong>: {SRC[s.state] || s.state} <span className="cn-small">— {s.detail}</span></li>)}</ul>
      </Fold>

      <HowItWorks>
        Playing on your phone is evidence that something was playing, not that you chose or like it. Listening across several days and weeks reads as
        interest; only you can say you like something. Shared TVs and speakers are household, never your taste. Nothing is marked finished because it
        started, and nothing is dropped because it went quiet. NEURO can’t see your TV or books, so what you watch and read is only what you add; it never
        turns a line in your profile into a tracked item, taste or hobby. Suggestions only come from what you've saved or are partway through; ask SAiM for
        anything wider. Nothing here interrupts you.
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
