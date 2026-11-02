import React, { useEffect, useMemo, useState } from 'react';
import { apiFetch } from '../../api';
import { useCanonical, postCanonical, Headline, Pill } from '../canonical/canonicalUi';
import WorkoutMap from './WorkoutMap';
import { ProfileChart, HeartRateChart } from './WorkoutCharts';
import { km, metres, hm, mmss, pace, clock, longDay, shortDay, compass, whereWords, pointAt } from './workoutFormat';
import './WorkoutPage.css';

/**
 * A workout, looked at properly (2 Nov 2026). Nick: "a proper view card —
 * all stats and the GPS track on a map", then "absolutely everything you can".
 *
 *   WorkoutPage   view `workout` (?view=workout&id=N); without an id, the index
 *                 of every tracked workout.
 *   LastHikeCard  the newest hike, leading Life → Outdoor.
 *
 * Every number is the server's (`workout-view-v1`); this file lays it out and
 * decides nothing. An unread source is said, never drawn as zero.
 */

// ── photos (fetched as blobs: an <img> cannot send the PIN) ─────────────────

const blobCache = new Map();
export function usePhoto(id, size = 'thumb') {
  const key = `${id}:${size}`;
  const [url, setUrl] = useState(blobCache.get(key) || null);
  useEffect(() => {
    if (!id || blobCache.has(key)) { setUrl(blobCache.get(key) || null); return undefined; }
    let live = true;
    apiFetch(`/api/workouts/photos/${encodeURIComponent(id)}${size === 'thumb' ? '?size=thumb' : ''}`)
      .then((r) => (r.ok ? r.blob() : null))
      .then((b) => { if (!b) return; const u = URL.createObjectURL(b); blobCache.set(key, u); if (live) setUrl(u); })
      .catch(() => {});
    return () => { live = false; };
  }, [key]);
  return url;
}

function Thumb({ id, onOpen, label }) {
  const url = usePhoto(id, 'thumb');
  return (
    <button type="button" className="wk-thumb" onClick={() => onOpen(id)} aria-label={label}>
      {url ? <img src={url} alt="" loading="lazy" /> : <span className="wk-thumb-wait" />}
    </button>
  );
}

function Lightbox({ photos, id, onClose, onMove, onRemove, busy }) {
  const i = photos.findIndex((p) => p.id === id);
  const p = photos[i];
  const url = usePhoto(id, 'full');
  const [confirm, setConfirm] = useState(false);
  useEffect(() => { setConfirm(false); }, [id]);
  useEffect(() => {
    const key = (e) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowRight' && i < photos.length - 1) onMove(photos[i + 1].id);
      if (e.key === 'ArrowLeft' && i > 0) onMove(photos[i - 1].id);
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [i, photos.length]);
  if (!p) return null;
  return (
    <div className="wk-lightbox" role="dialog" aria-label="Photo" onClick={onClose}>
      <div className="wk-lightbox-inner" onClick={(e) => e.stopPropagation()}>
        {url ? <img src={url} alt="" /> : <div className="wk-lightbox-wait">Loading…</div>}
        <div className="wk-lightbox-bar">
          <span>{i + 1} of {photos.length}{p.takenLocal ? ` · ${clock(p.takenLocal)}` : ''}{p.placedBy === 'time' ? ' · placed on the map by time' : p.placedBy === 'none' ? ' · not on the map' : ''}</span>
          <span className="wk-lightbox-acts">
            <button type="button" className="cn-btn cn-btn--tiny" disabled={i <= 0} onClick={() => onMove(photos[i - 1].id)}>‹ Previous</button>
            <button type="button" className="cn-btn cn-btn--tiny" disabled={i >= photos.length - 1} onClick={() => onMove(photos[i + 1].id)}>Next ›</button>
            {onRemove && (confirm
              ? <><span className="wk-warn">Remove it from NEURO? The phone won’t send it again.</span>
                <button type="button" className="cn-btn cn-btn--tiny wk-danger" disabled={busy} onClick={() => onRemove(p.id)}>Remove</button>
                <button type="button" className="cn-btn cn-btn--tiny" onClick={() => setConfirm(false)}>Keep</button></>
              : <button type="button" className="cn-btn cn-btn--tiny" onClick={() => setConfirm(true)}>Remove photo…</button>)}
            <button type="button" className="cn-btn cn-btn--tiny" onClick={onClose}>Close</button>
          </span>
        </div>
      </div>
    </div>
  );
}

// ── pieces of the page ─────────────────────────────────────────────────────

function Stat({ label, value, sub, title }) {
  return (
    <div className="wk-stat" title={title}>
      <div className="wk-stat-v">{value}</div>
      <div className="wk-stat-l">{label}</div>
      {sub && <div className="wk-stat-s">{sub}</div>}
    </div>
  );
}

function Panel({ title, meta, children, wide = false, testid }) {
  return (
    <section className={`wk-panel${wide ? ' wk-panel--wide' : ''}`} data-testid={testid}>
      <header className="wk-panel-h"><h3>{title}</h3>{meta && <span className="wk-panel-meta">{meta}</span>}</header>
      {children}
    </section>
  );
}

const Gap = ({ children }) => <div className="wk-gap">{children}</div>;

function KeyStats({ v }) {
  const w = v.watch; const t = v.track && v.track.known !== false ? v.track : null;
  const both = (a, b) => (a != null && b != null && Math.abs(a - b) / Math.max(a, b) > 0.03);
  return (
    <div className="wk-stats" data-testid="workout-stats">
      <Stat label="Distance" value={km(w.distanceM ?? t?.distanceM)} sub={t && both(w.distanceM, t.distanceM) ? `${km(t.distanceM)} by the track` : null} title="What the watch measured; the GPS track's own figure beside it when they differ." />
      <Stat label="Time" value={hm(w.durationSeconds ?? t?.totalSeconds)} sub={t ? `moving ${hm(t.movingSeconds)}` : null} />
      <Stat label="Moving pace" value={pace(t?.movingPaceSecPerKm)} sub={t?.avgMovingSpeedKmh != null ? `${t.avgMovingSpeedKmh} km/h` : null} />
      <Stat label="Ascent" value={metres(w.ascentM ?? t?.ascentM)} sub={t ? `${t.descentM} m down${both(w.ascentM, t.ascentM) ? ` · track ${t.ascentM} m up` : ''}` : null} title="The watch's ascent uses its barometer; the track's is from GPS elevation, smoothed." />
      <Stat label="Highest point" value={t?.highest ? metres(t.highest.eleM) : '—'} sub={t?.highest ? `at ${t.highest.km.toFixed(1)} km${t.lowest ? ` · lowest ${Math.round(t.lowest.eleM)} m` : ''}` : null} />
      <Stat label="Heart rate" value={w.avgHr != null ? `${w.avgHr} bpm` : v.heartRate?.known ? `${v.heartRate.avg} bpm` : '—'} sub={w.maxHr != null ? `max ${w.maxHr}` : v.heartRate?.known ? `max ${v.heartRate.max}` : null} />
      <Stat label="Active energy" value={w.activeKcal != null ? `${w.activeKcal} kcal` : '—'} />
      <Stat label="Steps" value={v.body?.steps != null ? v.body.steps.toLocaleString('en-GB') : '—'} sub={v.body?.flightsClimbed != null ? `${v.body.flightsClimbed} flights` : null} />
    </div>
  );
}

function Splits({ splits }) {
  if (!splits || !splits.length) return <Gap>No splits — the track is too short or missing.</Gap>;
  const fastest = Math.min(...splits.filter((s) => !s.partial).map((s) => s.paceSecPerKm));
  return (
    <table className="wk-table" data-testid="workout-splits">
      <thead><tr><th>km</th><th>Time</th><th>Pace</th><th>Up</th><th>Down</th><th>HR</th></tr></thead>
      <tbody>
        {splits.map((s) => (
          <tr key={s.km} className={s.paceSecPerKm === fastest ? 'wk-row--best' : ''}>
            <td>{s.km}{s.partial ? <span className="wk-muted"> ({s.lengthM} m)</span> : ''}</td>
            <td>{mmss(s.seconds)}</td><td>{pace(s.paceSecPerKm)}</td><td>{s.ascentM} m</td><td>{s.descentM} m</td><td>{s.avgHr ?? '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function HrBands({ hr }) {
  if (!hr || !hr.known) return <Gap>{hr?.why || 'No heart rate.'}</Gap>;
  if (!hr.bands) return <Gap>Your max heart rate isn’t known yet, so there are no bands.</Gap>;
  const total = hr.bands.rows.reduce((a, r) => a + r.minutes, 0) || 1;
  return (
    <div className="wk-bands" data-testid="workout-hr-bands">
      {hr.bands.rows.map((r, i) => (
        <div key={r.label} className="wk-band-row">
          <span className="wk-band-l">{r.label}<span className="wk-muted"> {r.fromBpm ? `${r.fromBpm}` : ''}{r.fromBpm && r.toBpm ? '–' : r.fromBpm ? '+' : '<'}{r.toBpm ?? ''}</span></span>
          <span className="wk-band-bar"><span className={`wk-band-fill wk-band--${i}`} style={{ width: `${(r.minutes / total) * 100}%` }} /></span>
          <span className="wk-band-m">{hm(r.minutes * 60)}</span>
        </div>
      ))}
      <div className="wk-muted wk-small">By {hr.bands.basis}{hr.maxSource ? ` — ${hr.maxSource}` : ''}. Lowest {hr.min}, highest {hr.max} bpm.</div>
    </div>
  );
}

function Weather({ wx }) {
  if (!wx || wx.state !== 'ok') return <Gap>{wx?.why || 'No weather yet.'}</Gap>;
  const s = wx.summary;
  return (
    <div data-testid="workout-weather">
      <div className="wk-wx-sum">
        <strong>{s.words || '—'}</strong> · {s.tempMinC}–{s.tempMaxC} °C (felt like {s.feelsLikeMinC ?? '—'} °C) · rain {s.rainMm} mm · wind to {s.windMaxMph ?? '—'} mph, gusts {s.gustMaxMph ?? '—'} mph
        {wx.sun && <span className="wk-muted"> · sunrise {wx.sun.sunrise}, sunset {wx.sun.sunset}</span>}
      </div>
      <table className="wk-table wk-table--compact">
        <thead><tr><th>Hour</th><th>Sky</th><th>Temp</th><th>Feels</th><th>Rain</th><th>Wind</th><th>Gusts</th></tr></thead>
        <tbody>
          {wx.hours.map((h) => (
            <tr key={h.at}><td>{h.at}</td><td>{h.words || '—'}</td><td>{h.tempC} °C</td><td>{h.feelsLikeC} °C</td><td>{h.rainMm} mm</td><td>{h.windMph != null ? `${Math.round(h.windMph)} mph ${compass(h.windFromDeg)}` : '—'}</td><td>{h.gustMph != null ? `${Math.round(h.gustMph)} mph` : '—'}</td></tr>
          ))}
        </tbody>
      </table>
      <div className="wk-muted wk-small">{wx.source}, {wx.where}.</div>
    </div>
  );
}

function Context({ v }) {
  const rows = [];
  const h = v.home;
  rows.push(['At home', h && h.known ? `${h.tempMinC}–${h.tempMaxC} °C, ${h.humidityPct}% humidity, ${h.pressureMinHpa}–${h.pressureMaxHpa} hPa (the outdoor station)` : (h?.why || 'not read')]);
  const l = v.logger;
  rows.push(['Logger', l && l.carried ? `${l.tempMinC}–${l.tempMaxC} °C, ${l.humidityMeanPct}% humidity${l.baroAscentM != null ? `, ${l.baroAscentM} m of climb by pressure` : ''} — ${l.why}` : `not carried — ${l?.why || 'no readings'}`]);
  rows.push(['Ember', v.companions.length ? `${v.companions.map((c) => c.name).join(', ')} came` : 'not marked — say so on Outdoor if she came']);
  rows.push(['Route plan', v.routePlan ? `${v.routePlan.name}${v.routePlan.distanceKm ? ` · planned ${v.routePlan.distanceKm} km` : ''}${v.routePlan.elevationGainM ? `, ${v.routePlan.elevationGainM} m up` : ''} (dashed on the map)` : 'none linked']);
  rows.push(['Hike weekly', v.verdict.day ? `${v.verdict.counts ? 'Counted' : 'Not counted'} — ${v.verdict.why}` : v.verdict.counts ? `Would count — ${v.verdict.why}` : `Doesn’t count — ${v.verdict.why}`]);
  return (
    <dl className="wk-dl" data-testid="workout-context">
      {rows.map(([k, val]) => <React.Fragment key={k}><dt>{k}</dt><dd>{val}</dd></React.Fragment>)}
    </dl>
  );
}

function Body({ b }) {
  if (!b) return <Gap>Couldn’t read the watch’s other measurements.</Gap>;
  return (
    <div className="wk-stats wk-stats--small" data-testid="workout-body">
      <Stat label="Steps" value={b.steps != null ? b.steps.toLocaleString('en-GB') : '—'} />
      <Stat label="Flights climbed" value={b.flightsClimbed ?? '—'} />
      <Stat label="Daylight" value={b.daylightMinutes != null ? hm(b.daylightMinutes * 60) : '—'} />
      <Stat label="Walking speed" value={b.walkingSpeedKmh != null ? `${b.walkingSpeedKmh} km/h` : '—'} />
      <Stat label="Step length" value={b.stepLengthCm != null ? `${b.stepLengthCm} cm` : '—'} />
      <Stat label="Asymmetry" value={b.asymmetryPct != null ? `${b.asymmetryPct}%` : '—'} sub={b.doubleSupportPct != null ? `double support ${b.doubleSupportPct}%` : null} />
      <Stat label="Sound" value={b.soundDb != null ? `${b.soundDb} dB` : '—'} title="Average environmental sound level the watch heard" />
    </div>
  );
}

function Comparison({ c, onOpen }) {
  if (!c || !c.others.length) return <Gap>{c?.why || 'Nothing to compare.'}</Gap>;
  return (
    <table className="wk-table" data-testid="workout-comparison">
      <thead><tr><th>Day</th><th>Distance</th><th>Time</th><th>Moving</th><th>Pace</th><th>Up</th><th>HR</th><th /></tr></thead>
      <tbody>
        {c.others.map((o) => (
          <tr key={o.id}><td>{shortDay(o.day)}</td><td>{km(o.distanceM)}</td><td>{hm(o.durationSeconds)}</td><td>{hm(o.movingSeconds)}</td><td>{pace(o.paceSecPerKm)}</td><td>{metres(o.ascentM)}</td><td>{o.avgHr ?? '—'}</td>
            <td>{onOpen && <button type="button" className="cn-btn cn-btn--tiny" onClick={() => onOpen(o.id)}>Open</button>}</td></tr>
        ))}
      </tbody>
    </table>
  );
}

// ── the whole page ─────────────────────────────────────────────────────────

/**
 * Walking with Ember (2 Nov 2026): what happened the last time this walk was
 * sent to the public site. The server records every attempt; this only says it.
 */
function siteDay(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Europe/London' });
}
function SiteLine({ site }) {
  if (!site) return null;
  const { last, lastOk } = site;
  const failedLast = last && last.status === 'failed';
  return (
    <>
      {lastOk && (
        <div className="wk-site" data-testid="wwe-status">
          Sent to Walking with Ember as a draft · {siteDay(lastOk.at)}
          {lastOk.previewUrl && <> · <a href={lastOk.previewUrl} target="_blank" rel="noreferrer">Open the preview</a></>}
        </div>
      )}
      {failedLast && <div className="wk-site wk-site--failed" data-testid="wwe-failed">Not sent to Walking with Ember — {last.error || 'no reason recorded'}.</div>}
    </>
  );
}

export function WorkoutView({ data: v, onOpen = null, onIndex = null, onRemovePhoto = null, busy = false, onSendToSite = null, sending = false }) {
  const [cursorT, setCursorT] = useState(null);
  const [photoId, setPhotoId] = useState(null);
  const cursor = useMemo(() => pointAt(v.profile, cursorT), [cursorT, v.profile]);
  const w = v.watch;
  const where = whereWords(v.places);
  const head = `${km(w.distanceM ?? v.track?.distanceM)} in ${hm(w.durationSeconds)}${w.ascentM != null ? `, ${w.ascentM} m up` : ''}${where ? `, ${where}` : ''}.`;
  return (
    <div className="wk-page" data-testid="workout-page">
      <header className="wk-head">
        <div>
          <h2 className="wk-title">{v.workout.title}</h2>
          <div className="wk-sub">{longDay(v.workout.day)} · {clock(v.workout.startLocal)}–{clock(v.workout.endLocal)} · {v.workout.type}</div>
        </div>
        <div className="wk-nav">
          {onOpen && v.nav.newer && <button type="button" className="cn-btn cn-btn--tiny" onClick={() => onOpen(v.nav.newer)}>‹ Newer</button>}
          {onOpen && v.nav.older && <button type="button" className="cn-btn cn-btn--tiny" onClick={() => onOpen(v.nav.older)}>Older ›</button>}
          {onIndex && <button type="button" className="cn-btn cn-btn--tiny" onClick={onIndex}>All walks</button>}
          {v.note && <a className="cn-btn cn-btn--tiny" href={v.note.obsidianUrl}>Open note in Obsidian</a>}
          {onSendToSite && v.site && v.site.eligible && (
            <button type="button" className="cn-btn cn-btn--tiny" disabled={sending} onClick={onSendToSite}
              title="Sends this walk to the public site as a DRAFT page: home trimmed 400 m, photos stripped of metadata. Nothing goes public until you publish it in the site's editor.">
              {sending ? 'Sending…' : (v.site.lastOk ? 'Send to Walking with Ember again' : 'Send to Walking with Ember')}
            </button>
          )}
        </div>
      </header>
      <Headline tone={v.verdict.counts ? 'good' : 'neutral'} pill={v.workout.hike ? (v.verdict.counts ? 'Hike · counted' : 'Hike') : v.workout.type}>{head}</Headline>
      <SiteLine site={v.site} />
      {v.gaps.length > 0 && <Gap>Couldn’t read: {v.gaps.map((g) => `${g.input} (${g.why})`).join('; ')}.</Gap>}

      <div className="wk-top">
        <div className="wk-map-wrap">
          {v.map.line.length > 1
            ? <WorkoutMap line={v.map.line} plan={v.map.plan} start={v.map.start} end={v.map.end} highest={v.map.highest} photos={v.map.photos} cursor={cursor} onPhoto={setPhotoId} height={480} />
            : <Gap>No GPS track came with this workout — {v.track?.why || 'nothing to draw'}.</Gap>}
        </div>
        <KeyStats v={v} />
      </div>

      <div className="wk-grid">
        <Panel title="Elevation" meta={v.track?.highest ? `highest ${Math.round(v.track.highest.eleM)} m` : null} wide><ProfileChart profile={v.profile} cursorT={cursorT} onCursor={setCursorT} /></Panel>
        <Panel title="Heart rate" meta={v.heartRate.known ? `avg ${v.heartRate.avg} · max ${v.heartRate.max} bpm` : null} wide>
          {v.heartRate.known ? <HeartRateChart series={v.heartRate.series} bands={v.heartRate.bands} cursorT={cursorT} onCursor={setCursorT} /> : <Gap>{v.heartRate.why}</Gap>}
        </Panel>
        <Panel title="Photos" meta={v.photos.length ? `${v.photos.length}` : null} wide testid="workout-photos">
          {v.photos.length
            ? <div className="wk-thumbs">{v.photos.map((p, i) => <Thumb key={p.id} id={p.id} onOpen={setPhotoId} label={`Photo ${i + 1}`} />)}</div>
            : <Gap>No photos yet. The NEURO iPhone app adds every photo you took during the walk once you let it read your photo library.</Gap>}
        </Panel>
        <Panel title="Splits" meta={v.splits.length ? `${v.splits.length} km` : null}><Splits splits={v.splits} /></Panel>
        <Panel title="Heart-rate bands"><HrBands hr={v.heartRate} /></Panel>
        <Panel title="Weather where you walked" wide><Weather wx={v.weather} /></Panel>
        <Panel title="On the day"><Context v={v} /></Panel>
        <Panel title="The watch also measured"><Body b={v.body} /></Panel>
        <Panel title="Same route before" meta={v.comparison.others.length ? `${v.comparison.others.length}` : null} wide><Comparison c={v.comparison} onOpen={onOpen} /></Panel>
      </div>

      {photoId && <Lightbox photos={v.photos} id={photoId} onClose={() => setPhotoId(null)} onMove={setPhotoId}
        onRemove={onRemovePhoto ? async (id) => { const ok = await onRemovePhoto(id); if (ok) setPhotoId(null); } : null} busy={busy} />}
    </div>
  );
}

/** A thin polyline in an SVG — the index's thumbnail map (no tiles, no network). */
function MiniLine({ line }) {
  if (!line || line.length < 2) return <div className="wk-mini wk-mini--empty" />;
  const lats = line.map((p) => p[0]); const lons = line.map((p) => p[1]);
  const [a, b, c, d] = [Math.min(...lats), Math.max(...lats), Math.min(...lons), Math.max(...lons)];
  const k = Math.cos(((a + b) / 2) * Math.PI / 180);
  const sx = (d - c) * k || 1e-6; const sy = (b - a) || 1e-6; const s = Math.max(sx, sy);
  const pts = line.map((p) => `${(((p[1] - c) * k) / s * 90 + 5 + (90 - (sx / s) * 90) / 2).toFixed(1)},${((1 - (p[0] - a) / s) * 90 + 5 - (90 - (sy / s) * 90) / 2).toFixed(1)}`).join(' ');
  return <svg className="wk-mini" viewBox="0 0 100 100" aria-hidden="true"><polyline points={pts} /></svg>;
}

export function WorkoutIndex({ data, onOpen }) {
  const list = data.workouts || [];
  if (!list.length) return <Gap>No workout with a GPS track yet.</Gap>;
  return (
    <div className="wk-page" data-testid="workout-index">
      <Headline tone="neutral" pill={`${list.length}`}>Every workout the watch recorded a GPS track for.</Headline>
      <div className="wk-index">
        {list.map((w) => (
          <button key={w.id} type="button" className="wk-index-tile" onClick={() => onOpen(w.id)}>
            <MiniLine line={w.line} />
            <span className="wk-index-t">{shortDay(w.day)} · {/hik/i.test(w.type) ? 'Hike' : w.type}</span>
            <span className="wk-index-s">{km(w.distanceM, 1)} · {hm(w.durationSeconds)}{w.ascentM != null ? ` · ${w.ascentM} m up` : ''}{w.photos ? ` · ${w.photos} 📷` : ''}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

export default function WorkoutPage({ context, onNavigate }) {
  const id = context && context.workoutId ? String(context.workoutId) : null;
  const open = (wid) => onNavigate && onNavigate('workout', { workoutId: String(wid) });
  if (!id) return <IndexLoader onOpen={open} />;
  return <PageLoader key={id} id={id} onOpen={open} onIndex={() => onNavigate && onNavigate('workout', null)} />;
}

function IndexLoader({ onOpen }) {
  const { data, error } = useCanonical('/api/workouts');
  if (error && !data) return <div className="cn-error">Couldn’t read the walks — {error}.</div>;
  if (!data) return <div className="cn-muted">Reading the walks…</div>;
  return <WorkoutIndex data={data} onOpen={onOpen} />;
}

function PageLoader({ id, onOpen, onIndex }) {
  const { data, error, reload } = useCanonical(`/api/workouts/${encodeURIComponent(id)}`);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [sending, setSending] = useState(false);
  const [siteMsg, setSiteMsg] = useState(null);
  if (error && !data) return <div className="cn-error">Couldn’t read this workout — {error}.</div>;
  if (!data) return <div className="cn-muted">Reading the workout…</div>;
  const remove = async (photoId) => {
    setBusy(true); setMsg(null);
    try { await postCanonical(`/api/workouts/photos/${encodeURIComponent(photoId)}/remove`, {}); await reload(); return true; } catch (e) { setMsg(e.message); return false; } finally { setBusy(false); }
  };
  const sendToSite = async () => {
    setSending(true); setSiteMsg(null);
    try { await postCanonical(`/api/workouts/${encodeURIComponent(id)}/send-to-site`, {}); } catch (e) { setSiteMsg(e.message); } finally { setSending(false); await reload(); }
  };
  return (
    <>
      <WorkoutView data={data} onOpen={onOpen} onIndex={onIndex} onRemovePhoto={remove} busy={busy} onSendToSite={sendToSite} sending={sending} />
      {msg && <div className="cn-error">Not removed — {msg}</div>}
      {siteMsg && <div className="cn-error">Not sent to Walking with Ember — {siteMsg}</div>}
    </>
  );
}

// ── the Outdoor lead card ──────────────────────────────────────────────────

export function LastHikeView({ data: v, onOpen }) {
  if (!v.workout) return null;
  const w = v.watch;
  return (
    <section className="wk-last" data-testid="last-hike">
      <div className="wk-last-map">
        {v.map.line.length > 1 && <WorkoutMap line={v.map.line} plan={v.map.plan} start={v.map.start} end={v.map.end} highest={v.map.highest} photos={v.map.photos} height={300} interactive={false} onPhoto={() => onOpen && onOpen(v.workout.id)} />}
      </div>
      <div className="wk-last-body">
        <div className="wk-last-kicker">Last hike · {longDay(v.workout.day)}</div>
        <h3 className="wk-last-title">{v.workout.title}</h3>
        <div className="wk-stats wk-stats--small">
          <Stat label="Distance" value={km(w.distanceM ?? v.track?.distanceM)} />
          <Stat label="Time" value={hm(w.durationSeconds)} sub={v.track?.movingSeconds != null ? `moving ${hm(v.track.movingSeconds)}` : null} />
          <Stat label="Ascent" value={metres(w.ascentM ?? v.track?.ascentM)} sub={v.track?.highest ? `top ${Math.round(v.track.highest.eleM)} m` : null} />
          <Stat label="Heart rate" value={w.avgHr != null ? `${w.avgHr} bpm` : '—'} sub={w.maxHr != null ? `max ${w.maxHr}` : null} />
        </div>
        {v.weather.state === 'ok' && <div className="wk-small wk-muted">{v.weather.summary.words}, {v.weather.summary.tempMinC}–{v.weather.summary.tempMaxC} °C, wind to {v.weather.summary.windMaxMph} mph</div>}
        {v.photos.length > 0 && <div className="wk-thumbs wk-thumbs--strip">{v.photos.slice(0, 6).map((p, i) => <Thumb key={p.id} id={p.id} onOpen={() => onOpen && onOpen(v.workout.id)} label={`Photo ${i + 1}`} />)}</div>}
        {onOpen && <button type="button" className="cn-btn" onClick={() => onOpen(v.workout.id)}>Open the full page</button>}
      </div>
    </section>
  );
}

export function LastHikeCard({ onNavigate }) {
  const { data, error } = useCanonical('/api/workouts/last-hike');
  if (error && !data) return <div className="cn-error">Couldn’t read the last hike — {error}.</div>;
  if (!data) return null;
  if (!data.workout) return null;
  return <LastHikeView data={data} onOpen={onNavigate ? (id) => onNavigate('workout', { workoutId: String(id) }) : null} />;
}
