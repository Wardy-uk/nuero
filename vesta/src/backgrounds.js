/**
 * Wall backgrounds — a provider, so the source can change without the UI.
 *
 * A provider answers `pick(slot, weather)` with
 *   { src, place, credit, licence, night, matched }
 * for a time-of-day slot (morning | day | evening | night) and, optionally, a
 * weather category (clear | partly | cloudy | rain | fog | snow — see
 * `weatherCategory`). Each image is TAGGED with the slots and weather it
 * genuinely shows; a pick prefers an image matching both, then falls back to
 * time of day alone (`matched: false`). Weather comes only from NEURO/Home
 * Assistant's observation — never inferred from a photograph.
 *
 * Today there is one provider, `bundled`: Creative Commons photographs shipped
 * with VESTA under /backgrounds/ (credits in /backgrounds/CREDITS.txt, shown on
 * screen). When NEURO has its own photo store, add a provider with the same
 * `pick`/`all` shape; the views do not change.
 *
 * ⚠ Gaps in the bundled set (17 Oct 2026): no cloudy-day, rain, fog, snow or
 * true night photograph. Those conditions fall back to the time-of-day image.
 * `gaps()` lists them so the report stays honest.
 */

/** Home Assistant's condition id → a weather category, or null (no preference). PURE. */
export function weatherCategory(condition) {
  const c = String(condition || '').toLowerCase();
  if (c === 'sunny' || c === 'clear-night') return 'clear';
  if (c === 'partlycloudy') return 'partly';
  if (c === 'cloudy') return 'cloudy';
  if (c === 'rainy' || c === 'pouring' || c === 'lightning' || c === 'lightning-rainy') return 'rain';
  if (c === 'fog') return 'fog';
  if (c === 'snowy' || c === 'snowy-rainy' || c === 'hail') return 'snow';
  return null; // windy, exceptional, unknown: no weather preference
}

export const SLOTS = ['morning', 'day', 'evening', 'night'];
export const WEATHER = ['clear', 'partly', 'cloudy', 'rain', 'fog', 'snow'];

const BUNDLED_IMAGES = [
  { id: 'peak-sunrise', src: '/backgrounds/morning.v1.jpg', place: 'Sunrise, Peak District', credit: 'Mark Richards', licence: 'CC BY-SA 2.0',
    slots: ['morning'], weather: ['clear', 'partly'] },
  { id: 'mam-tor', src: '/backgrounds/day.v1.jpg', place: 'Mam Tor, Peak District', credit: 'mendhak', licence: 'CC BY-SA 2.0',
    slots: ['day'], weather: ['clear', 'partly'] },
  { id: 'bakewell-sunset', src: '/backgrounds/evening.v1.jpg', place: 'Sunset near Bakewell', credit: 'Brian Toward', licence: 'CC0',
    slots: ['evening', 'night'], weather: ['partly', 'cloudy'] },
];

/** A provider over a tagged image list. Exported so a future source can reuse it. */
export function makeProvider(name, images) {
  return {
    name,
    images,
    pick(slot, weather = null) {
      const forSlot = images.filter((i) => i.slots.includes(slot));
      const pool = forSlot.length ? forSlot : images.filter((i) => i.slots.includes('day'));
      if (!pool.length) return null;
      const exact = weather ? pool.find((i) => i.weather.includes(weather)) : null;
      const img = exact || pool[0];
      // Night reuses an evening photograph, darkened by the view.
      return { ...img, night: slot === 'night', matched: Boolean(exact) };
    },
    all() { return images.map((i) => i.src); },
    /** Every slot × weather pair with no image that shows it. */
    gaps() {
      const out = [];
      for (const s of SLOTS) for (const w of WEATHER) {
        if (!images.some((i) => i.slots.includes(s) && i.weather.includes(w))) out.push(`${s}/${w}`);
      }
      return out;
    },
  };
}

const BUNDLED = makeProvider('bundled', BUNDLED_IMAGES);
export const providers = { bundled: BUNDLED };

/** The background for a slot (+ optional weather category) from a provider. */
export function backgroundFor(slot, weather = null, provider = BUNDLED) {
  try { return provider.pick(slot, weather) || null; } catch { return null; }
}

/**
 * Keep the shown photograph steady. PURE. A new time-of-day slot switches at
 * once; a weather-only change waits until the current photo has been up for
 * `holdMs` (30 min), so a passing shower does not flick the background.
 */
export const HOLD_MS = 30 * 60 * 1000;
export function steadyChoice(shown, wanted, nowMs, holdMs = HOLD_MS) {
  if (!wanted) return shown;
  if (!shown || !shown.bg) return { bg: wanted, slot: wanted.slot, at: nowMs };
  if (shown.bg.src === wanted.src && shown.bg.night === wanted.night) return shown;
  if (shown.slot !== wanted.slot) return { bg: wanted, slot: wanted.slot, at: nowMs };
  return nowMs - shown.at >= holdMs ? { bg: wanted, slot: wanted.slot, at: nowMs } : shown;
}

const CACHE = 'vesta-backgrounds-v1';

/**
 * A URL for the image that keeps working offline: kept in the browser's Cache
 * Storage once fetched, handed back as a blob URL. Falls back to the plain URL
 * wherever Cache Storage is missing or refuses.
 */
export async function cachedUrl(src) {
  try {
    if (typeof caches === 'undefined') return src;
    const c = await caches.open(CACHE);
    let res = await c.match(src);
    if (!res) { await c.add(src); res = await c.match(src); }
    if (!res) return src;
    return URL.createObjectURL(await res.blob());
  } catch { return src; }
}

/** Fetch every photo of a provider into the cache, so a later slot works offline. */
export async function warmCache(provider = BUNDLED) {
  try {
    if (typeof caches === 'undefined') return;
    const c = await caches.open(CACHE);
    for (const src of provider.all()) { if (!(await c.match(src))) await c.add(src); }
  } catch { /* offline or refused: the next attempt will try again */ }
}
