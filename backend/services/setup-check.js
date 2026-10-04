'use strict';

/**
 * Setup check — what has not been set up that NEURO needs, per device, and how
 * to set it up.
 *
 * Nick, 4 Oct 2026: "before I build — I want a set-up wizard: it should check
 * what hasn't been set up that is needed, and help me set up." The facts were
 * already scattered across six screens (Sources, NEURO Health, Settings, Life,
 * Actions) and four handoffs; a step nobody is told about is a step that does
 * not happen, and his difficulty is initiation, not knowledge.
 *
 * ⚠ EVIDENCE, NEVER A CHECKLIST HE TICKS. Every item is judged from something
 *   NEURO observed: a sense that has reported (SourceHealth), a push token that
 *   registered, a key that is set, a row that exists. "Done" is earned by the
 *   thing working, not by pressing a button. The one human input is "not
 *   needed", which SKIPS an item (persisted, reversible) and never marks it done.
 * ⚠ NOT KNOWING IS NOT DONE. Where NEURO cannot see a fact from here (a
 *   permission on the phone, a shortcut on the laptop), the item is `unknown`
 *   and says which device can check it: the iOS Setup screen and
 *   `desktop-agent/setup.ps1` check locally and report back (`report()`).
 * ⚠ A SWITCH THAT IS OFF BY DESIGN IS NOT UNFINISHED SETUP. "Send approved
 *   emails" defaults OFF on purpose (Build 7/8); it appears as `optional`, never
 *   as a red item nagging him to turn on autonomy.
 *
 * Split like pi-health: `snapshot()` reads, `assess()` (PURE) judges.
 */

const SURFACES = [
  { id: 'server', label: 'NEURO on the Pi' },
  { id: 'windows', label: 'Windows laptop' },
  { id: 'iphone-neuro', label: 'iPhone — NEURO app' },
  { id: 'iphone-saim', label: 'iPhone — SAiM app' },
  { id: 'mac', label: 'Mac' },
  { id: 'life', label: 'Your life model' },
  { id: 'home', label: 'Home screens (Pi panel, tablet)' },
];
const NEEDS = ['required', 'recommended', 'optional'];
const REPORT_KEY = 'setup_reports';
const SKIP_KEY = 'setup_skipped';
// A report older than this is not evidence about the machine as it is now.
const REPORT_STALE_MS = 14 * 86400000;

// ── pure helpers ────────────────────────────────────────────────────────────

/** A SourceHealth row → done / attention / todo. Never seen is todo. PURE. */
function fromSource(src) {
  if (!src) return { status: 'todo', evidence: 'NEURO has never heard from it.' };
  const v = src.verdict;
  const last = src.transport && src.transport.lastSuccessAt;
  if (v === 'seeing' || v === 'quiet') return { status: 'done', evidence: `Reporting (${src.verdictLabel || v}).` };
  if (!last) return { status: 'todo', evidence: 'NEURO has never heard from it.' };
  return { status: 'attention', evidence: `Set up, but ${String(src.verdictLabel || v).toLowerCase()} — last heard ${last.slice(0, 16).replace('T', ' ')}.` };
}

function fromReport(report, checkId, now) {
  if (!report || !report.at) return null;
  if (now - Date.parse(report.at) > REPORT_STALE_MS) return null;
  const c = (report.checks || []).find((x) => x && x.id === checkId);
  if (!c) return null;
  return { status: c.ok ? 'done' : 'todo', evidence: `${c.ok ? 'Checked' : 'Not set up'} on ${report.host} ${report.at.slice(0, 10)}${c.detail ? ` — ${c.detail}` : ''}.` };
}

/**
 * Judge every item. PURE: a plain snapshot and the clock in, the list out.
 */
function assess(s, { now = Date.now(), skipped = {} } = {}) {
  const src = (id) => (s.sources || []).find((x) => x.sourceId === id) || null;
  const items = [];
  const add = (it) => {
    const skip = skipped[it.id];
    items.push({ ...it, status: skip && it.status !== 'done' ? 'skipped' : it.status, skippedAt: skip ? skip.at || null : null });
  };
  const winReport = (s.reports || []).find((r) => r.platform === 'windows') || null;
  const iosReport = (app) => (s.reports || []).find((r) => r.platform === 'ios' && r.app === app) || null;
  const local = (report, checkId, fallbackWhy) => fromReport(report, checkId, now)
    || { status: 'unknown', evidence: fallbackWhy };

  // ── NEURO on the Pi ──
  add({ id: 'server.microsoft', surface: 'server', need: 'required', title: 'Sign NEURO in to Microsoft 365',
    why: 'Calendar, mail triage, To Do and Planner all read through it.',
    ...(s.microsoft.authenticated ? { status: 'done', evidence: 'Signed in.' } : { status: 'todo', evidence: s.microsoft.configured ? 'Configured but not signed in.' : 'Not configured.' }),
    fix: { where: 'desktop', open: 'admin', steps: ['Settings → Integrations → Microsoft → Sign in.', 'Type the device code at microsoft.com/devicelogin (a fresh code is issued if the last one expired).'] } });
  add({ id: 'server.vault', surface: 'server', need: 'required', title: 'Point NEURO at the vault',
    why: 'Notes, people, meetings and the task export live there.',
    ...(s.vault ? { status: 'done', evidence: 'Vault readable.' } : { status: 'todo', evidence: 'OBSIDIAN_VAULT_PATH unset or unreadable.' }),
    fix: { where: 'pi', steps: ['Set OBSIDIAN_VAULT_PATH in ~/nuero/backend/.env to /mnt/data/nuero-vault.', 'pm2 restart neuro-backend'] } });
  add({ id: 'server.ai', surface: 'server', need: 'required', title: 'Give NEURO a cloud AI key',
    why: 'Chat and the standup cannot hold a conversation on the Pi’s local models.',
    ...(s.ai ? { status: 'done', evidence: 'A cloud provider is configured.' } : { status: 'todo', evidence: 'No cloud provider configured.' }),
    fix: { where: 'desktop', open: 'admin', steps: ['Settings → Integrations → paste an OpenRouter key.'] } });
  add({ id: 'server.webpush', surface: 'server', need: 'recommended', title: 'Web push keys',
    why: 'Without them the PWAs can never be notified.',
    ...(s.vapid ? { status: 'done', evidence: 'VAPID keys set.' } : { status: 'todo', evidence: 'VAPID keys missing.' }),
    fix: { where: 'pi', command: 'npx web-push generate-vapid-keys', steps: ['Run the command on the Pi.', 'Put the two keys in backend/.env as VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY, then pm2 restart neuro-backend.'] } });
  add({ id: 'server.apns', surface: 'server', need: 'recommended', title: 'Apple push (APNs) key',
    why: 'The native apps get notifications only through this.',
    ...(s.apns ? { status: 'done', evidence: 'APNs key configured.' } : { status: 'todo', evidence: 'APNS_KEY_ID / APNS_TEAM_ID / APNS_KEY_PATH not all set.' }),
    fix: { where: 'pi', steps: ['Copy the .p8 key to the Pi.', 'Set APNS_KEY_ID, APNS_TEAM_ID and APNS_KEY_PATH in backend/.env, then pm2 restart neuro-backend.'] } });
  add({ id: 'server.approval-code', surface: 'server', need: 'recommended', title: 'Set your approval code',
    why: 'Nothing drafted by NEURO can be approved without it — even with sending switched on.',
    ...(s.approvalCode ? { status: 'done', evidence: 'An approval code is set.' } : { status: 'todo', evidence: 'No approval code.' }),
    fix: { where: 'pi', command: 'cd ~/nuero/backend && node scripts/set-approval-code.js', steps: ['Only from a shell on the Pi — no route can set it, on purpose.'] } });
  add({ id: 'server.sending', surface: 'server', need: 'optional', title: 'Decide whether approved emails may send',
    why: 'Off by design. Turning it on lets an approved draft leave the building; it is never needed for setup.',
    ...(s.sendingEnabled ? { status: 'done', evidence: '"Send approved emails" is on.' } : { status: 'todo', evidence: 'Off (the default).' }),
    fix: { where: 'desktop', open: 'admin', steps: ['Settings → Switches → "Send approved emails". Leave it off until you want it.'] } });

  // ── Windows laptop ──
  const winHost = (s.desktopHosts || []).find((h) => !/mac/i.test(h.host)) || null;
  add({ id: 'windows.agent', surface: 'windows', need: 'recommended', title: 'Install the desktop activity agent',
    why: 'Lets SAiM see you are at the laptop, and lets the phone open apps on it.',
    ...(winHost ? { status: 'done', evidence: `${winHost.host} last reported ${String(winHost.lastAt || '').slice(0, 16).replace('T', ' ')}.` } : { status: 'todo', evidence: 'No Windows machine has reported.' }),
    fix: { where: 'windows', command: 'powershell -ExecutionPolicy Bypass -File desktop-agent\\setup.ps1', steps: ['From the nuero checkout on the laptop. The setup script installs the agent if it is missing.'] } });
  add({ id: 'windows.apps', surface: 'windows', need: 'optional', title: 'Tell the agent which apps it may open',
    why: 'The "open on the laptop" buttons only offer apps listed in apps.json.',
    ...(winHost && winHost.canOpen && winHost.canOpen.length ? { status: 'done', evidence: `Can open: ${winHost.canOpen.join(', ')}.` }
      : local(winReport, 'apps', 'Checked on the laptop by setup.ps1.')),
    fix: { where: 'windows', command: 'powershell -ExecutionPolicy Bypass -File desktop-agent\\setup.ps1', steps: ['setup.ps1 writes %LOCALAPPDATA%\\neuro-agent\\apps.json from the browser, VS Code and music apps it finds.'] } });
  add({ id: 'windows.saim', surface: 'windows', need: 'recommended', title: 'SAiM desktop window',
    why: 'Her presence on the laptop, and the Watch lock.',
    ...local(winReport, 'saim-electron', 'Only the laptop can see this — run setup.ps1 there.'),
    fix: { where: 'windows', command: 'powershell -ExecutionPolicy Bypass -File desktop-agent\\setup.ps1', steps: ['Installs saim/desktop-electron dependencies and puts a SAiM shortcut on the Desktop.'] } });
  add({ id: 'windows.mcp', surface: 'windows', need: 'optional', title: 'NEURO tools in Claude on the laptop',
    why: 'Lets Claude Code and Claude Desktop read and write NEURO (tasks, vault, capture).',
    ...local(winReport, 'mcp', 'Only the laptop can see this — run setup.ps1 there.'),
    fix: { where: 'windows', steps: ['setup.ps1 reports whether a NEURO MCP server is configured; add it with: claude mcp add neuro -- node <nuero>\\mcp-server\\index.js'] } });

  // ── iPhone apps ──
  const phone = (app, label) => {
    const sfx = `${app}-ios`;
    // Anything this app has ever delivered proves it holds the PIN.
    const delivered = (s.sources || []).find((x) => String(x.sourceId || '').endsWith(`.${sfx}`) && x.transport && x.transport.lastSuccessAt);
    add({ id: `iphone-${app}.signed-in`, surface: `iphone-${app}`, need: 'required', title: `Sign the ${label} app in`,
      why: 'Nothing on the phone reaches NEURO without its PIN.',
      ...(delivered ? { status: 'done', evidence: `${label} app has delivered data (${delivered.label || delivered.sourceId}).` }
        : s.clients && s.clients[app] ? { status: 'done', evidence: `${label} app has called NEURO (${s.clients[app].slice(0, 10)}).` }
          : local(iosReport(app), 'signed-in', 'Open the app — its Setup screen checks this.')),
      fix: { where: 'iphone', steps: [`Open ${label} → enter the PIN.`] } });
    add({ id: `iphone-${app}.health`, surface: `iphone-${app}`, need: app === 'neuro' ? 'required' : 'recommended', title: `Health access (${label})`,
      why: 'Sleep, heart rate and readiness come only from here.', ...fromSource(src(`healthkit.${sfx}`)),
      fix: { where: 'iphone', steps: [`${label} → Setup → Health → Allow.`, 'If you said no once: Settings → Health → Data Access & Devices → ' + label + ' → Turn On All.'] } });
    add({ id: `iphone-${app}.calendar`, surface: `iphone-${app}`, need: 'recommended', title: `Calendar access (${label})`,
      why: 'Your personal diary lives only on the phone; NEURO cannot reach iCloud.', ...fromSource(src(`eventkit.${sfx}`)),
      fix: { where: 'iphone', steps: [`${label} → Setup → Calendars → Allow Full Access.`] } });
    add({ id: `iphone-${app}.reminders`, surface: `iphone-${app}`, need: 'optional', title: `Reminders access (${label})`,
      why: 'Reminders become canonical tasks.', ...fromSource(src(`reminders.${sfx}`)),
      fix: { where: 'iphone', steps: [`${label} → Setup → Reminders → Allow Full Access.`] } });
    add({ id: `iphone-${app}.push`, surface: `iphone-${app}`, need: 'recommended', title: `Notifications (${label})`,
      why: 'How SAiM comes to you rather than waiting to be opened.',
      ...(s.apnsApps && s.apnsApps.includes(app) ? { status: 'done', evidence: 'A push token is registered.' }
        : { status: 'todo', evidence: s.apns ? 'No push token from this app.' : 'No push token — and the Pi has no APNs key yet, so set that up first.' }),
      fix: { where: 'iphone', steps: [`${label} → Setup → Notifications → Allow.`] } });
  };
  phone('neuro', 'NEURO');
  add({ id: 'iphone-neuro.location', surface: 'iphone-neuro', need: 'recommended', title: 'Location (NEURO app)',
    why: 'Home, work and out — and the weather where you are.', ...fromSource(src('location.neuro-ios')),
    fix: { where: 'iphone', steps: ['NEURO → Setup → Location → Allow While Using, then Change to Always.'] } });
  add({ id: 'iphone-neuro.device', surface: 'iphone-neuro', need: 'optional', title: 'Phone self-report (NEURO app)',
    why: 'Battery, focus mode and motion for the ambient read.', ...fromSource(src('device.neuro-ios')),
    fix: { where: 'iphone', steps: ['Open the NEURO app once after signing in; it reports on every wake.'] } });
  phone('saim', 'SAiM');

  // ── Mac ──
  const macHost = (s.desktopHosts || []).find((h) => /mac/i.test(h.host)) || null;
  add({ id: 'mac.agent', surface: 'mac', need: 'optional', title: 'Desktop agent on the Mac',
    why: 'Counts time on the Mac too (it is invisible to the Windows agent and to RescueTime).',
    ...(macHost ? { status: 'done', evidence: `${macHost.host} reporting.` } : { status: 'todo', evidence: 'No Mac has reported.' }),
    fix: { where: 'mac', command: 'bash desktop-agent/install.sh', steps: ['From the nuero checkout on the Mac.'] } });

  // ── Life model ──
  add({ id: 'life.calendars', surface: 'life', need: 'recommended', title: 'Say what your calendars and lists are',
    why: 'A phone calendar says nothing about your life until you classify it — so it never counts as family, health or home.',
    ...(s.containers === 0 ? { status: 'unknown', evidence: 'No calendars or lists have arrived yet — set up phone calendar access first.' }
      : s.unclassified === 0 ? { status: 'done', evidence: `All ${s.containers} classified.` }
        : { status: 'todo', evidence: `${s.unclassified} of ${s.containers} not classified.` }),
    fix: { where: 'desktop', open: 'life', steps: ['Life → Calendars & lists → pick a domain for each.'] } });
  add({ id: 'life.goals', surface: 'life', need: 'optional', title: 'Write down a goal or two',
    why: 'Personal importance can only be inherited from a goal you stated.',
    ...(s.goals > 0 ? { status: 'done', evidence: `${s.goals} active.` } : { status: 'todo', evidence: 'No goals.' }),
    fix: { where: 'desktop', open: 'life', steps: ['Life → Goals → Add.'] } });
  add({ id: 'life.ember', surface: 'life', need: 'optional', title: 'Add Ember',
    why: 'So a vet booking is about Ember, not about "a person".',
    ...(s.companions > 0 ? { status: 'done', evidence: `${s.companions} companion note(s).` } : { status: 'todo', evidence: 'No companion notes.' }),
    fix: { where: 'desktop', steps: ['Create Companions/Ember.md in the vault with `type: pet` in its frontmatter.'] } });

  // ── Home screens ──
  add({ id: 'home.tablet-mic', surface: 'home', need: 'optional', title: 'Study tablet: allow the mic',
    why: 'On a wall the mic only appears with ?mic=1 (the Pi panel has none).',
    status: 'unknown', evidence: 'NEURO cannot see the tablet’s start address.',
    fix: { where: 'tablet', steps: ['Fully Kiosk → Settings → Web Content → Start URL → add ?mic=1.'] } });

  const counts = { done: 0, todo: 0, attention: 0, unknown: 0, skipped: 0 };
  for (const it of items) counts[it.status] = (counts[it.status] || 0) + 1;
  const rank = { required: 0, recommended: 1, optional: 2 };
  // The next step: what is needed most, broken before missing, in surface order.
  const nextStep = items
    .filter((i) => i.status === 'attention' || i.status === 'todo')
    .filter((i) => !(i.need === 'optional' && i.id === 'server.sending'))
    .sort((a, b) => (rank[a.need] - rank[b.need]) || ((a.status === 'attention' ? 0 : 1) - (b.status === 'attention' ? 0 : 1)))[0] || null;
  return {
    surfaces: SURFACES.map((sf) => {
      const mine = items.filter((i) => i.surface === sf.id);
      return { ...sf, total: mine.length, done: mine.filter((i) => i.status === 'done').length,
        open: mine.filter((i) => i.status === 'todo' || i.status === 'attention').length };
    }),
    items,
    counts,
    nextStep: nextStep ? nextStep.id : null,
    // ⚠ Unknown counts as NOT complete: "I could not see it" is never "set up".
    complete: !items.some((i) => i.need !== 'optional' && i.status !== 'done' && i.status !== 'skipped'),
  };
}

// ── readers ─────────────────────────────────────────────────────────────────

function _db() { return require('../db/database'); }
function _count(sql) { try { const r = _db().get(sql); return r ? Number(Object.values(r)[0]) || 0 : 0; } catch { return 0; } }
function _json(key, fallback) { try { const v = _db().getState(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; } }

async function snapshot() {
  const s = { sources: [], desktopHosts: [], reports: [], clients: {} };
  try {
    const ms = require('./microsoft');
    const configured = ms.isConfigured ? ms.isConfigured() : true;
    s.microsoft = { configured, authenticated: configured ? await ms.isAuthenticated() : false };
  } catch { s.microsoft = { configured: false, authenticated: false }; }
  try { s.vault = require('./obsidian').isConfigured(); } catch { s.vault = false; }
  try { const st = require('./ai-routing').getStatus(); s.ai = !!(st && ((st.openrouter && st.openrouter.configured) || (st.anthropic && st.anthropic.configured) || (st.openai && st.openai.configured))); } catch { s.ai = false; }
  s.vapid = !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
  s.apns = !!(process.env.APNS_KEY_ID && process.env.APNS_TEAM_ID && process.env.APNS_KEY_PATH);
  try { s.approvalCode = !!_db().getState('approval_code'); } catch { s.approvalCode = false; }
  try { s.sendingEnabled = !!require('./feature-flags').isEnabled('governed_execution'); } catch { s.sendingEnabled = false; }
  try { s.sources = require('./canonical-read').sources({}).spine || []; } catch { s.sources = []; }
  try {
    const da = require('./desktop-activity');
    const caps = typeof da.capabilities === 'function' ? da.capabilities() : {};
    s.desktopHosts = da.hosts().map((h) => ({ ...h, canOpen: (caps && caps[h.host]) || null }));
  } catch { s.desktopHosts = []; }
  try { s.apnsApps = _db().all('SELECT DISTINCT app FROM apns_tokens').map((r) => r.app); } catch { s.apnsApps = []; }
  s.containers = _count('SELECT COUNT(*) AS n FROM source_containers');
  s.unclassified = _count(`SELECT COUNT(*) AS n FROM source_containers c WHERE NOT EXISTS
    (SELECT 1 FROM source_classifications k WHERE k.kind = c.kind AND k.source_key = c.source_key)`);
  s.goals = _count("SELECT COUNT(*) AS n FROM goals WHERE status = 'active'");
  s.companions = _count('SELECT COUNT(*) AS n FROM wm_companions');
  s.reports = Object.values(_json(REPORT_KEY, {}));
  for (const r of s.reports) if (r.platform === 'ios' && r.app && r.at) s.clients[r.app] = r.at;
  return s;
}

async function check({ now = Date.now() } = {}) {
  const s = await snapshot();
  return { ok: true, ...assess(s, { now, skipped: _json(SKIP_KEY, {}) }), reports: s.reports };
}

/** A device's own local checks (setup.ps1, the iOS Setup screen). Bounded. */
function report({ platform, app = null, host, checks }, { now = Date.now() } = {}) {
  if (!['windows', 'ios', 'mac'].includes(platform)) throw Object.assign(new Error('platform must be windows, ios or mac'), { status: 400 });
  if (typeof host !== 'string' || !host.trim()) throw Object.assign(new Error('host is required'), { status: 400 });
  if (!Array.isArray(checks)) throw Object.assign(new Error('checks must be an array'), { status: 400 });
  const clean = checks.slice(0, 40).filter((c) => c && typeof c.id === 'string')
    .map((c) => ({ id: c.id.slice(0, 40), ok: c.ok === true, detail: typeof c.detail === 'string' ? c.detail.slice(0, 160) : null }));
  const all = _json(REPORT_KEY, {});
  const key = `${platform}:${app || ''}:${host.trim().slice(0, 60)}`;
  all[key] = { platform, app, host: host.trim().slice(0, 60), at: new Date(now).toISOString(), checks: clean };
  _db().setState(REPORT_KEY, JSON.stringify(all));
  return all[key];
}

function skip(id, { now = Date.now() } = {}) {
  const all = _json(SKIP_KEY, {});
  all[id] = { at: new Date(now).toISOString() };
  _db().setState(SKIP_KEY, JSON.stringify(all));
  return all;
}
function unskip(id) {
  const all = _json(SKIP_KEY, {});
  delete all[id];
  _db().setState(SKIP_KEY, JSON.stringify(all));
  return all;
}

module.exports = { SURFACES, NEEDS, REPORT_STALE_MS, assess, fromSource, snapshot, check, report, skip, unskip };
