'use strict';

// Where the SAiM desktop window points (21 Oct 2026 cutover). PURE.
//
// There is ONE SAiM: https://sara.nickward.co.uk — the same responsive app on
// phone, desktop and kiosk. Alt v1/v2/v3 and the legacy control desktop are
// retired, and so is the old local shell this window used to default to
// (saim/backend on localhost:3005). A shortcut or environment that still names
// one of them is sent to the canonical app instead, keeping its path and query,
// so an old SAiM.lnk cannot reopen a retired interface.

const CANONICAL = 'https://sara.nickward.co.uk/';

const RETIRED_HOSTS = new Set([
  'saim.nickward.co.uk',                // Alt v3 (site saim-alt-nickward)
  'saim-alt.nickward.co.uk',            // the legacy control desktop
  'saim-alt-v1.nickward.co.uk',         // Alt v1
  'saim-alt-nickward.netlify.app',
  'saim-legacy-nickward.netlify.app',
  'saim-alt-v1-nickward.netlify.app',
  'localhost:3005',                     // the old local shell (saim/backend)
  '127.0.0.1:3005',
]);

/** → { url, reason, from? } — reason: default | explicit | retired | unreadable */
function resolveTarget(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return { url: CANONICAL, reason: 'default' };
  let u;
  try { u = new URL(s); } catch { return { url: CANONICAL, reason: 'unreadable', from: s }; }
  if (!/^https?:$/.test(u.protocol)) return { url: CANONICAL, reason: 'unreadable', from: s };
  if (RETIRED_HOSTS.has(u.host.toLowerCase())) {
    return { url: `${CANONICAL.replace(/\/$/, '')}${u.pathname}${u.search}${u.hash}`, reason: 'retired', from: u.host };
  }
  return { url: u.toString(), reason: 'explicit' };
}

module.exports = { CANONICAL, RETIRED_HOSTS, resolveTarget };
