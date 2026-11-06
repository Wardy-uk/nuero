// NEURO moved from nuero.nickward.co.uk to neuro.nickward.co.uk (6 Nov 2026 —
// the old host was a misspelling). Netlify still serves the app on the old host
// as an alias, so this page decides when to leave it.
//
// ⚠ Browser storage belongs to the ORIGIN. Captures made offline wait in this
//   origin's localStorage ('neuro_offline_queue'), and the new host cannot see
//   them. So the old host sends anything waiting FIRST, and only moves once
//   nothing is left. Offline, it stays put and the app runs as before; the next
//   load tries again. The PIN is not carried across (a URL is the wrong place
//   for it) — the new address asks for it once.

export const OLD_HOST = 'nuero.nickward.co.uk';
export const NEW_ORIGIN = 'https://neuro.nickward.co.uk';
const QUEUE_KEY = 'neuro_offline_queue';

function readQueue() {
  try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]') || []; } catch { return []; }
}

async function sendWaiting() {
  const q = readQueue();
  if (!q.length) return 0;
  const remaining = [];
  for (const item of q) {
    try {
      const res = await fetch(item.url, { method: 'POST', headers: item.headers || { 'Content-Type': 'application/json' }, body: item.body });
      if (!res.ok) remaining.push(item);
    } catch { remaining.push(item); }
  }
  try { localStorage.setItem(QUEUE_KEY, JSON.stringify(remaining)); } catch { /* keep going: nothing was lost */ }
  return remaining.length;
}

/** PURE. Where this page should go, or null to stay. */
export function movedUrl(loc) {
  if (!loc || loc.hostname !== OLD_HOST) return null;
  return `${NEW_ORIGIN}${loc.pathname || '/'}${loc.search || ''}${loc.hash || ''}`;
}

/** Resolves true when the page is leaving (do not render), false to carry on. */
export async function moveHostIfNeeded() {
  const target = movedUrl(typeof window !== 'undefined' ? window.location : null);
  if (!target) return false;
  const left = await sendWaiting();
  if (left > 0) return false; // something is still waiting: stay where it can be sent from
  window.location.replace(target);
  return true;
}
