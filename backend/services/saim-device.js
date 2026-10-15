'use strict';

/**
 * The device report the SAiM hand-off resolver reads (`saim-device-v1`, 15 Oct
 * 2026), built from what the laptop agent has ALREADY said — desktop-activity's
 * samples and the apps it declared it can open (apps.json). Nothing is guessed:
 *
 *   available   the app is in the machine's declared list
 *   foreground  true when the newest sample's process IS this app; false when a
 *               fresh sample shows another app in front; null when no fresh sample
 *   running     always null — the agent reports what is in front, not what is open
 *   observedAt  the newest sample, so the resolver can judge freshness itself
 *
 * `pure` is exported for tests: build(samples, canOpenByHost, now).
 */

const DI = require('./desk-intents');

/** What each declarable app can do — the capabilities the resolver matches on. */
const CAPABILITIES = Object.freeze({
  claude: ['ai'], chatgpt: ['ai'], music: ['music'], word: ['docs'], excel: ['sheets'], outlook: ['mail'],
  code: ['code'], browser: ['browser'], obsidian: ['notes'], teams: ['meeting:teams'],
});

/** Laptop process name (desktop-activity's sanitised `app`, lowercased, no .exe) → declared app id. */
const PROCESS_APP = Object.freeze({
  code: 'code', chrome: 'browser', msedge: 'browser', firefox: 'browser', windowsterminal: 'terminal', pwsh: 'terminal',
  powershell: 'terminal', claude: 'claude', chatgpt: 'chatgpt', olk: 'outlook', outlook: 'outlook', 'ms-teams': 'teams',
  msteams: 'teams', obsidian: 'obsidian', excel: 'excel', winword: 'word', plaud: 'plaud', ssms: 'ssms', postman: 'postman',
});

function build(samples, canOpenByHost, now = Date.now(), { freshMinutes = 8 } = {}) {
  const newest = (samples || []).filter((s) => s && Number.isFinite(Date.parse(s.at))).sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0] || null;
  if (!newest) return { contract: 'saim-device-v1', known: false, observedAt: null, apps: [] };
  const host = newest.host || null;
  const declared = Array.isArray((canOpenByHost || {})[host]) ? canOpenByHost[host] : [];
  const fresh = now - Date.parse(newest.at) <= freshMinutes * 60000;
  const inFront = newest.app && !newest.locked ? PROCESS_APP[String(newest.app).toLowerCase().replace(/\.exe$/, '')] || null : null;
  const apps = declared
    .map((id) => String(id || '').trim().toLowerCase())
    .filter((id, i, all) => id && all.indexOf(id) === i && Object.prototype.hasOwnProperty.call(DI.APPS, id))
    .map((id) => ({
      id,
      label: DI.BUTTON_LABELS[id] || DI.APPS[id],
      capabilities: CAPABILITIES[id] || [],
      available: true,
      running: null,
      foreground: fresh ? inFront === id : null,
    }));
  return { contract: 'saim-device-v1', known: true, observedAt: new Date(Date.parse(newest.at)).toISOString(), apps };
}

/** The live report, from desktop-activity's stored state. Never throws. */
function report(now = Date.now()) {
  try {
    const da = require('./desktop-activity');
    return build(da.samples(), da.capabilities(), now, { freshMinutes: da.FRESH_MINUTES });
  } catch {
    return { contract: 'saim-device-v1', known: false, observedAt: null, apps: [] };
  }
}

module.exports = { build, report, CAPABILITIES, PROCESS_APP };
