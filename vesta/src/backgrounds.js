/**
 * Wall backgrounds — a provider, so the source can change without the UI.
 *
 * A provider answers `pick(slot)` with { src, credit, licence, place, night }
 * for one of four slots: morning, day, evening, night. Today there is one
 * provider, `bundled`: photographs shipped with VESTA under /backgrounds/.
 * When NEURO has its own photo store, add a provider here that returns its
 * URLs and pass it to `backgroundFor`; nothing in the views needs to change.
 *
 * ⚠ The photos are Creative Commons; the credit is shown on screen and must
 * travel with any replacement.
 */

const BUNDLED = {
  name: 'bundled',
  images: {
    morning: { src: '/backgrounds/morning.v1.jpg', place: 'Sunrise, Peak District', credit: 'Mark Richards', licence: 'CC BY-SA 2.0' },
    day: { src: '/backgrounds/day.v1.jpg', place: 'Mam Tor, Peak District', credit: 'mendhak', licence: 'CC BY-SA 2.0' },
    evening: { src: '/backgrounds/evening.v1.jpg', place: 'Sunset near Bakewell', credit: 'Brian Toward', licence: 'CC0' },
  },
  pick(slot) {
    // Night reuses the evening photo, darkened by the view (`night: true`).
    if (slot === 'night') return { ...this.images.evening, night: true };
    return this.images[slot] || this.images.day;
  },
  all() { return Object.values(this.images).map((i) => i.src); },
};

export const providers = { bundled: BUNDLED };

/** The background for a slot from a provider (default: the bundled photos). */
export function backgroundFor(slot, provider = BUNDLED) {
  try { return provider.pick(slot) || null; } catch { return null; }
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
