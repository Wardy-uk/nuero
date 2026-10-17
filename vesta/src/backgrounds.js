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
 * Selection, fixed and never random: (1) an image tagged with this slot AND this
 * weather; (2) for weather you can see (cloudy, rain, fog, snow) the DAYTIME
 * image of that weather, darkened at night; (3) the slot's default image.
 * `gaps()` lists every slot x weather pair with no exact image.
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

// One fixed photograph per combination. `default` = the slot's fallback;
// `nightPhoto` = genuinely taken at night (never darkened further).
const BUNDLED_IMAGES = [
  { id: 'peak-sunrise', src: '/backgrounds/morning.v1.jpg', place: 'Sunrise, Peak District', credit: 'Mark Richards', licence: 'CC BY-SA 2.0',
    slots: ['morning'], weather: ['clear', 'partly'], default: ['morning'] },
  { id: 'morning-mist', src: '/backgrounds/morning-fog.v1.jpg', place: 'Misty morning, Derbyshire', credit: 'Neil Theasby', licence: 'CC BY-SA 2.0',
    slots: ['morning'], weather: ['fog'] },
  { id: 'vale-of-edale', src: '/backgrounds/day-clear.v1.jpg', place: 'The Vale of Edale', credit: 'Jeff Buck', licence: 'CC BY-SA 2.0',
    slots: ['day'], weather: ['clear'] },
  { id: 'mam-tor', src: '/backgrounds/day.v1.jpg', place: 'Mam Tor, Peak District', credit: 'mendhak', licence: 'CC BY-SA 2.0',
    slots: ['day'], weather: ['partly'], default: ['day'] },
  { id: 'edale-overcast', src: '/backgrounds/day-cloudy.v1.jpg', place: 'Edale, Peak District', credit: 'Peter McDermott', licence: 'CC BY-SA 2.0',
    slots: ['day'], weather: ['cloudy'] },
  { id: 'kinder-showers', src: '/backgrounds/day-rain.v1.jpg', place: 'Summer showers, Kinder Scout', credit: 'Stephen Burton', licence: 'CC BY-SA 2.0',
    slots: ['day'], weather: ['rain'] },
  { id: 'roaches-mist', src: '/backgrounds/day-fog.v1.jpg', place: 'Mist at the Roaches', credit: 'Mark Rickaby', licence: 'CC BY 2.0',
    slots: ['day'], weather: ['fog'] },
  { id: 'kinder-snow', src: '/backgrounds/day-snow.v1.jpg', place: 'Kinder Scout in snow', credit: 'Stephen Burton', licence: 'CC BY-SA 2.0',
    slots: ['day'], weather: ['snow'] },
  { id: 'curbar-snow', src: '/backgrounds/snow-golden.v1.jpg', place: 'Curbar Edge in snow', credit: 'Hansheap', licence: 'CC BY-SA 4.0',
    slots: ['morning', 'evening'], weather: ['snow'] },
  { id: 'bakewell-sunset', src: '/backgrounds/evening.v1.jpg', place: 'Sunset near Bakewell', credit: 'Brian Toward', licence: 'CC0',
    slots: ['evening'], weather: ['clear', 'partly'], default: ['evening', 'night'] },
  { id: 'surprise-view', src: '/backgrounds/evening-cloudy.v1.jpg', place: 'The Hope Valley from Surprise View', credit: 'Neil Theasby', licence: 'CC BY-SA 2.0',
    slots: ['evening'], weather: ['cloudy'] },
  { id: 'dartmoor-night', src: '/backgrounds/night-clear.v1.jpg', place: 'The Milky Way over Dartmoor', credit: 'Charlie Marshall', licence: 'CC BY 2.0',
    slots: ['night'], weather: ['clear', 'partly'], nightPhoto: true },
];

const VISIBLE_WEATHER = new Set(['cloudy', 'rain', 'fog', 'snow']);

/** A provider over a tagged image list. Exported so a future source can reuse it. */
export function makeProvider(name, images) {
  return {
    name,
    images,
    pick(slot, weather = null) {
      const dark = (img) => slot === 'night' && !img.nightPhoto;
      const exact = weather ? images.find((i) => i.slots.includes(slot) && i.weather.includes(weather)) : null;
      if (exact) return { ...exact, night: dark(exact), matched: 'exact' };
      // Weather you can see outranks the hour: rain at dusk shows rain.
      const seen = weather && VISIBLE_WEATHER.has(weather) ? images.find((i) => i.slots.includes('day') && i.weather.includes(weather)) : null;
      if (seen) return { ...seen, night: dark(seen), matched: 'weather' };
      const def = images.find((i) => (i.default || []).includes(slot)) || images.find((i) => i.slots.includes(slot)) || images[0];
      if (!def) return null;
      return { ...def, night: dark(def), matched: 'time' };
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

/** A bundled image's details by its src (for crediting whatever is on screen). */
export function imageBySrc(src, provider = BUNDLED) {
  return provider.images.find((i) => i.src === src) || null;
}

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
  // A photo chosen with no weather reading (before the first data, or while the
  // reading was unavailable) is provisional: the first real observation replaces
  // it at once instead of waiting out the 30-minute hold.
  if (shown.bg.provisional && !wanted.provisional) return { bg: wanted, slot: wanted.slot, at: nowMs };
  if (shown.slot !== wanted.slot) return { bg: wanted, slot: wanted.slot, at: nowMs };
  return nowMs - shown.at >= holdMs ? { bg: wanted, slot: wanted.slot, at: nowMs } : shown;
}

// v2 (17 Oct 2026): a new name drops anything the v1 cache held.
const CACHE = 'vesta-backgrounds-v2';
const OLD_CACHES = ['vesta-backgrounds-v1'];

/** The last-resort photograph: the sunset that displayed in every build. */
export const FALLBACK_SRC = '/backgrounds/evening.v1.jpg';

const isImage = (res) => Boolean(res && res.ok && /^image\//i.test(res.headers.get('content-type') || ''));

/**
 * A URL for the image that keeps working offline: kept in the browser's Cache
 * Storage once fetched, handed back as a blob URL. ⚠ Only a real image (200 and
 * image/*) is ever cached or handed back — a stored error page would otherwise
 * be shown, for ever, as a black photograph. Falls back to the plain URL
 * wherever Cache Storage is missing or refuses.
 */
export async function cachedUrl(src) {
  try {
    if (typeof caches === 'undefined') return src;
    for (const old of OLD_CACHES) caches.delete(old).catch(() => {});
    const c = await caches.open(CACHE);
    let res = await c.match(src);
    if (res && !isImage(res)) { await c.delete(src); res = null; }
    if (!res) {
      const got = await fetch(src, { cache: 'no-cache' });
      if (!isImage(got)) throw new Error(`not an image (${got.status} ${got.headers.get('content-type') || 'no type'})`);
      await c.put(src, got.clone());
      res = got;
    }
    return URL.createObjectURL(await res.blob());
  } catch (e) {
    logBackground('cache', src, e);
    return src;
  }
}

/** Load and DECODE an image before it is shown. Resolves with the url; rejects on any failure. */
export function decodeImage(url) {
  return new Promise((resolve, reject) => {
    if (typeof Image === 'undefined') { resolve(url); return; }
    const img = new Image();
    img.onload = () => {
      if (!img.naturalWidth) { reject(new Error('decoded to an empty image')); return; }
      if (typeof img.decode === 'function') img.decode().then(() => resolve(url), () => resolve(url));
      else resolve(url);
    };
    img.onerror = () => reject(new Error('the image would not load'));
    img.src = url;
  });
}

/**
 * What the wall is showing, for its regular check-in to NEURO (so a black
 * screen can be diagnosed from the Pi) and for the console.
 */
export const backgroundReport = { id: null, state: 'none' };
export function logBackground(stage, src, err, fallback = null) {
  try {
    // eslint-disable-next-line no-console
    console.warn('[wall background]', { stage, src, error: err && err.message, fallback });
  } catch { /* no console */ }
}

/**
 * Fetch these photos into the cache ahead of need (the next time of day), so a
 * change is instant and works offline. Only what is asked for, never the whole
 * set, to keep the iPad's network and memory use small.
 */
export async function warmCache(srcs = []) {
  try {
    if (typeof caches === 'undefined') return;
    const c = await caches.open(CACHE);
    for (const src of srcs) { if (src && !(await c.match(src))) await c.add(src); }
  } catch { /* offline or refused: the next attempt will try again */ }
}

/** The slot that follows this one: what to preload. PURE. */
export function nextSlot(slot) {
  return { morning: 'day', day: 'evening', evening: 'night', night: 'morning' }[slot] || 'day';
}
