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
  { id: 'watch', label: 'Apple Watch' },
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
  return { status: 'attention', stale: true, evidence: `Set up, but ${String(src.verdictLabel || v).toLowerCase()} — last heard ${last.slice(0, 16).replace('T', ' ')}.` };
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
    // A phone sense that WAS set up and has gone quiet does not need permission
    // again — the first-time step ("Allow Full Access") reads as an instruction
    // with nothing to do. Say what actually moves it: open the app.
    if (it.status === 'attention' && it.stale && it.fix && it.fix.where === 'iphone') {
      const app = /\(([^)]+)\)/.exec(it.title || '');
      const label = app ? app[1].replace(/ app$/, '') : 'the app';
      it = { ...it, fix: { ...it.fix, steps: [
        `Open ${label} on the phone — it sends on every open, and this clears once it does.`,
        `Still stale after that? Check Settings → ${label} still has access; if it was turned off: ${it.fix.steps[0]}`,
      ] } };
    }
    delete it.stale;
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
    fix: { where: 'desktop', open: 'admin', steps: ['Settings → Approval code → set it (at least 6 characters).', 'Changing it later needs the current code; a forgotten one is reset on the Pi: cd ~/nuero/backend && node scripts/set-approval-code.js'] } });
  add({ id: 'server.sending', surface: 'server', need: 'optional', title: 'Decide whether approved emails may send',
    why: 'Off by design. Turning it on lets an approved draft leave the building; it is never needed for setup.',
    ...(s.sendingEnabled ? { status: 'done', evidence: '"Send approved emails" is on.' } : { status: 'todo', evidence: 'Off (the default).' }),
    fix: { where: 'desktop', open: 'admin', steps: ['Settings → Switches → "Send approved emails". Leave it off until you want it.'] } });

  // Build 13G: presence from the house itself, on the event spine.
  add({ id: 'server.ha-presence', surface: 'server', need: 'recommended', title: 'Home Assistant presence',
    why: 'Whether you are home and whether anyone else is in — read from the house, not guessed from the phone.',
    ...fromSource(src('homeassistant.presence')),
    fix: { where: 'pi', steps: ['Check HA_URL / HA_TOKEN in backend/.env and that Home Assistant is up; NEURO polls it every 2 minutes.'] } });
  // Build 13I: has the governed path actually been proven, end to end?
  add({ id: 'server.governed-proof', surface: 'server', need: 'optional', title: 'Prove an approved calendar change end to end',
    why: 'Email is proven when one approved send is verified in Sent Items; a calendar change only when one approved invite is read back from Outlook.',
    ...(s.proven && s.proven.calendar > 0 ? { status: 'done', evidence: `${s.proven.calendar} calendar change(s) verified; ${s.proven.email} email(s) verified.` }
      : { status: 'todo', evidence: `${s.proven ? s.proven.email : 0} approved email(s) verified; no approved calendar change verified yet.` }),
    fix: { where: 'desktop', open: 'actions', steps: ['Actions → Drafted by NEURO → approve the prepared test invite with your approval code; it is verified by reading it back.'] } });
  // Build 13K: an external write whose outcome is unknown waits for Nick.
  add({ id: 'server.unknown-writes', surface: 'server', need: 'recommended', title: 'External changes with an unknown outcome',
    why: 'A ticket escalation that timed out may or may not have landed; NEURO will not repeat it until you say.',
    ...(s.unknownWrites == null ? { status: 'unknown', evidence: 'The ledger could not be read.' }
      : s.unknownWrites === 0 ? { status: 'done', evidence: 'Nothing waiting.' }
        : { status: 'attention', evidence: `${s.unknownWrites} waiting for you to check.` }),
    fix: { where: 'desktop', steps: ['Check the ticket, then POST /api/escalation/ledger/resolve with { key, applied }.'] } });

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
  // Build 18U: a sense that reports from a build DEFINITELY missing what it
  // needs is not healthy — "reporting" is not "doing what Build 16/17 promised".
  // An UNKNOWN build is said once, on the build item, not on every sense.
  const nativeApp = (client) => ((s.native && s.native.apps) || []).find((a) => a.client === client) || null;
  const withBuild = (sourceId, client, judged) => {
    const a = nativeApp(client);
    const assess = a && (a.sources || []).find((x) => x.sourceId === sourceId);
    if (!assess || assess.state !== 'old' || judged.status !== 'done') return judged;
    return { status: 'attention', evidence: `${judged.evidence} ${assess.line}` };
  };
  const phone = (app, label) => {
    const sfx = `${app}-ios`;
    // Build 18D/Y: which build is installed — the answer to "was it deployed?".
    const na = nativeApp(sfx);
    const old = na ? (na.sources || []).filter((x) => x.state === 'old') : [];
    add({ id: `iphone-${app}.build`, surface: `iphone-${app}`, need: 'recommended', title: `Current ${label} build installed`,
      why: 'NEURO can only trust what a build can do once the build says which one it is.',
      ...(na && na.build
        ? (old.length ? { status: 'attention', evidence: `${na.line} ${old.map((x) => x.line).join(' ')}` } : { status: 'done', evidence: na.line })
        : { status: na && na.lastHeardAt ? 'todo' : 'unknown', evidence: na ? na.line : `${label} has never reported a build.` }),
      fix: { where: 'mac', steps: [`On the Mac: pull nuero-ios, run the tests, then bash reinstall.sh ${app}.`, `Open ${label} once — it reports its build on its first request.`] } });
    // Anything this app has ever delivered proves it holds the PIN.
    const delivered = (s.sources || []).find((x) => String(x.sourceId || '').endsWith(`.${sfx}`) && x.transport && x.transport.lastSuccessAt);
    add({ id: `iphone-${app}.signed-in`, surface: `iphone-${app}`, need: 'required', title: `Sign the ${label} app in`,
      why: 'Nothing on the phone reaches NEURO without its PIN.',
      ...(delivered ? { status: 'done', evidence: `${label} app has delivered data (${delivered.label || delivered.sourceId}).` }
        : s.clients && s.clients[app] ? { status: 'done', evidence: `${label} app has called NEURO (${s.clients[app].slice(0, 10)}).` }
          : local(iosReport(app), 'signed-in', 'Open the app — its Setup screen checks this.')),
      fix: { where: 'iphone', steps: [`Open ${label} → enter the PIN.`] } });
    add({ id: `iphone-${app}.health`, surface: `iphone-${app}`, need: app === 'neuro' ? 'required' : 'recommended', title: `Health access (${label})`,
      why: 'Sleep, heart rate and readiness come only from here.', ...withBuild(`healthkit.${sfx}`, sfx, fromSource(src(`healthkit.${sfx}`))),
      fix: { where: 'iphone', steps: [`${label} → Setup → Health → Allow.`, 'If you said no once: Settings → Health → Data Access & Devices → ' + label + ' → Turn On All.'] } });
    add({ id: `iphone-${app}.calendar`, surface: `iphone-${app}`, need: 'recommended', title: `Calendar access (${label})`,
      why: 'Your personal diary lives only on the phone; NEURO cannot reach iCloud.', ...withBuild(`eventkit.${sfx}`, sfx, fromSource(src(`eventkit.${sfx}`))),
      fix: { where: 'iphone', steps: [`${label} → Setup → Calendars → Allow Full Access.`] } });
    add({ id: `iphone-${app}.reminders`, surface: `iphone-${app}`, need: 'optional', title: `Reminders access (${label})`,
      why: 'Reminders become canonical tasks.', ...fromSource(src(`reminders.${sfx}`)),
      fix: { where: 'iphone', steps: [`${label} → Setup → Reminders → Allow Full Access.`] } });
    add({ id: `iphone-${app}.push`, surface: `iphone-${app}`, need: 'recommended', title: `Notifications (${label})`,
      why: 'How SAiM comes to you rather than waiting to be opened.',
      ...(s.apnsApps && s.apnsApps.includes(app) ? { status: 'done', evidence: 'A push token is registered.' }
        : { status: 'todo', evidence: s.apns ? 'No push token from this app.' : 'No push token — and the Pi has no APNs key yet, so set that up first.' }),
      fix: { where: 'iphone', steps: [`${label} → Setup → Notifications → Allow.`] } });
    // Build 18J: workout ROUTES are a separate HealthKit type, and iOS never
    // says whether READ access was granted — only whether it was ever asked.
    // So "allowed" is earned by a route arriving, nothing else.
    const rep = fromReport(iosReport(app), 'workout-routes', now);
    const repCheck = rep && ((iosReport(app).checks || []).find((c) => c.id === 'workout-routes') || {});
    const routeState = repCheck && repCheck.state ? repCheck.state : null;
    add({ id: `iphone-${app}.workout-routes`, surface: `iphone-${app}`, need: 'optional', title: `Workout routes (${label})`,
      why: 'A hike is confirmed by its GPS route — workout access alone does not include routes.',
      ...(s.routesReceived > 0 ? { status: 'done', evidence: `Proven: ${s.routesReceived} workout route summary(ies) have arrived.` }
        : routeState === 'unavailable' ? { status: 'attention', evidence: 'Health data is unavailable on this device.' }
          : routeState === 'not-asked' ? { status: 'todo', evidence: 'Never asked for — the app has not requested workout-route access.' }
            : routeState === 'asked' ? { status: 'unknown', evidence: 'Asked for. iOS hides whether reading was allowed, so it is unproven until a route arrives with a hike or long walk.' }
              : { status: 'unknown', evidence: 'This build does not report route permission, and no route has arrived.' }),
      fix: { where: 'iphone', steps: [`Settings → Health → Data Access & Devices → ${label} → turn on Workout Routes.`, 'Record a Hiking workout (or a walk of an hour or more) on the Watch; the route summary arrives on the next sync.'] } });
  };
  phone('neuro', 'NEURO');
  add({ id: 'iphone-neuro.location', surface: 'iphone-neuro', need: 'recommended', title: 'Location (NEURO app)',
    why: 'Home, work and out — and the weather where you are.', ...withBuild('location.neuro-ios', 'neuro-ios', fromSource(src('location.neuro-ios'))),
    fix: { where: 'iphone', steps: ['NEURO → Setup → Location → Allow While Using, then Change to Always.'] } });
  // Build 18T: visits and geofences are CAPABILITIES of the location source,
  // never stale for being quiet — only proven, unproven or unavailable.
  const capStatus = { proven: 'done', 'proven-quiet': 'done', unproven: 'unknown', unavailable: 'attention', 'parent-stale': 'attention' };
  for (const [key, title, why] of [['visits', 'Visits (NEURO app)', 'Arrivals and departures, so a stay is known while you are still there.'],
    ['geofence', 'Saved-place geofences (NEURO app)', 'Enter/exit at home and work, the strongest "where am I" answer.']]) {
    const c = s.placeCaps && s.placeCaps[key];
    add({ id: `iphone-neuro.${key}`, surface: 'iphone-neuro', need: 'optional', title, why,
      ...(c ? { status: capStatus[c.state] || 'unknown', evidence: c.line } : { status: 'unknown', evidence: 'Could not read place events.' }),
      fix: { where: 'iphone', steps: ['Install the current NEURO build, allow Location → Always, and save Home/Work places on Life → Places.'] } });
  }
  add({ id: 'iphone-neuro.device', surface: 'iphone-neuro', need: 'optional', title: 'Phone self-report (NEURO app)',
    why: 'Battery, focus mode and motion for the ambient read.', ...withBuild('device.neuro-ios', 'neuro-ios', fromSource(src('device.neuro-ios'))),
    fix: { where: 'iphone', steps: ['Open the NEURO app once after signing in; it reports on every wake.'] } });
  phone('saim', 'SAiM');
  // Build 18I: SAiM's phone self-report had never been seen before the build
  // carrying it. Optional until that build is installed (native-sources).
  add({ id: 'iphone-saim.device', surface: 'iphone-saim', need: 'optional', title: 'Phone self-report (SAiM app)',
    why: 'SAiM is the app you open most; when she reports the phone too, the ambient read is fresher.',
    ...withBuild('device.saim-ios', 'saim-ios', fromSource(src('device.saim-ios'))),
    fix: { where: 'iphone', steps: ['Install the current SAiM build and open SAiM; it reports on every wake.'] } });

  // ── Apple Watch (Build 12.3U) ──
  // ⚠ Every item here is judged from something OBSERVED: the watch's own report
  //   (it is the only thing that can see whether the complication is on a face)
  //   or the notification ledger. Unknown is never done.
  const watchReport = (s.reports || []).find((r) => r.platform === 'watchos') || null;
  add({ id: 'watch.app', surface: 'watch', need: 'recommended', title: 'SAiM on the Watch',
    why: 'The Needs You view and the complication live in the watch app.',
    ...(watchReport && fromReport(watchReport, 'signed-in', now) ? fromReport(watchReport, 'signed-in', now)
      : { status: 'unknown', evidence: 'The watch app has never reported. As of 4 Oct 2026 it cannot be installed: watchOS refuses a free-profile app arriving from the phone, and this Mac cannot install to watchOS 27 directly.' }),
    // ⚠ Until the app installs, urgent alerts still reach the wrist by iOS
    //   MIRRORING the phone's local notification — no watch app needed.
    fix: { where: 'mac', steps: ['Needs either a paid Apple Developer account (companion install allowed) or a Mac running Xcode 27 (direct install) — see nuero-ios WATCH-WITHOUT-XCODE.md.', 'Then: bash reinstall.sh saim, and open SAiM on the watch once so it reports.'] } });
  add({ id: 'watch.complication', surface: 'watch', need: 'recommended', title: 'Put the SAiM complication on a face',
    why: 'The Needs You count is only glanceable if it is on the face you wear.',
    ...local(watchReport, 'complication-on-face', 'Only the watch can see its faces — open SAiM on the watch.'),
    fix: { where: 'watch', steps: ['Long-press the watch face → Edit → Complications → SAiM.'] } });
  add({ id: 'watch.attention-sync', surface: 'watch', need: 'recommended', title: 'Watch reads Needs You',
    why: 'The complication shows the last read; a watch that never reads shows an old one.',
    ...local(watchReport, 'presentation-read', 'The watch has not reported a read.'),
    fix: { where: 'watch', steps: ['Open SAiM on the watch while the phone or Wi-Fi is in reach.'] } });
  add({ id: 'iphone-saim.local-alerts', surface: 'iphone-saim', need: 'recommended', title: 'Local alerts can be seen (SAiM)',
    why: 'With no APNs key the phone posts urgent alerts itself; iOS mirrors them to the watch only if they can be shown at all.',
    ...local(iosReport('saim'), 'local-notifications', 'Open SAiM → Setup; it checks banner style, Scheduled Summary and permission.'),
    fix: { where: 'iphone', steps: ['Settings → SAiM → Notifications → Allow, Banners, Immediate Delivery.', 'Watch app on the phone → Notifications → SAiM → Mirror iPhone Alerts.'] } });
  const proof = s.watchProof || null;
  const attempt = s.watchLastSynthetic || null;
  add({ id: 'watch.alerts-proven', surface: 'watch', need: 'recommended', title: 'Prove an urgent alert end to end',
    why: s.apns
      ? 'An urgent item should reach your wrist; only a tapped test proves it does.'
      : 'Remote push is unavailable (no APNs key), so alerts are LOCAL: posted by the phone when iOS wakes SAiM — minutes to hours, not seconds — and on the watch only by iOS mirroring a phone alert (phone locked, watch on the wrist). Only a tapped test proves the path.',
    ...(proof && now - Date.parse(proof.openedAt) <= REPORT_STALE_MS
      ? { status: 'done', evidence: `Synthetic alert ${proof.dedupeKey} opened on ${proof.deviceId} at ${String(proof.openedAt).slice(0, 16).replace('T', ' ')}.` }
      : attempt
        ? { status: 'attention', evidence: `Last synthetic test ${attempt.outcome}${attempt.acceptedAt ? ' (iOS accepted it)' : ''} but was never opened — not proven.` }
        : { status: 'todo', evidence: 'No device has posted a synthetic alert yet (the phone posts it when SAiM next wakes or is opened).' }),
    fix: { where: 'desktop', steps: ['POST /api/canonical/needs-you/synthetic {"kind":"escalation"} with the PIN.', 'Lock the phone, wait for SAiM to wake (or open it), tap the alert on the watch, then DELETE /api/canonical/needs-you/synthetic.'] } });

  // ── Mac ──
  const macHost = (s.desktopHosts || []).find((h) => /mac/i.test(h.host)) || null;
  add({ id: 'mac.agent', surface: 'mac', need: 'optional', title: 'Desktop agent on the Mac',
    why: 'Counts time on the Mac too (it is invisible to the Windows agent and to RescueTime).',
    ...(macHost ? { status: 'done', evidence: `${macHost.host} reporting.` } : { status: 'todo', evidence: 'No Mac has reported.' }),
    fix: { where: 'mac', command: 'bash desktop-agent/install.sh', steps: ['From the nuero checkout on the Mac.'] } });

  // ── Life model ──
  // Build 13B/S: counted by STABLE ID only — title-keyed rows are what builds
  // before Build 11 sent, and counting them made the job look twice its size.
  const dupNote = (s.duplicateNames || []).length
    ? ` Same name twice: ${s.duplicateNames.join(', ')} — classify each one, the name alone cannot tell them apart.` : '';
  add({ id: 'life.calendars', surface: 'life', need: 'recommended', title: 'Say what your calendars and lists are',
    why: 'A phone calendar or reminder list says nothing about your life until you classify it — so it never counts as family, health or home.',
    ...(s.containers === 0 ? { status: 'unknown', evidence: 'No calendars or lists have arrived yet — set up phone calendar access first.' }
      : s.unclassified === 0 ? { status: 'done', evidence: `All ${s.containers} classified.` }
        : { status: 'todo', evidence: `${s.unclassifiedCalendars || 0} calendar(s) and ${s.unclassifiedLists || 0} reminder list(s) not classified.${dupNote}` }),
    fix: { where: 'desktop', open: 'life', steps: ['Life → Calendars & lists → pick a domain (or Ignore) for each.'] } });
  add({ id: 'life.relationships', surface: 'life', need: 'optional', title: 'Say who your family is',
    why: 'NEURO never infers family from sharing a house or a calendar — only a People note that says so counts.',
    ...(s.relationships > 0 ? { status: 'done', evidence: `${s.relationships} People note(s) state a relationship or household.` }
      : { status: 'todo', evidence: 'No People note states `relationship:` or `household:`.' }),
    fix: { where: 'desktop', steps: ["In each family member's People note, add `relationship: partner` (or son, daughter…) and `household: true` to the frontmatter."] } });
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
  // Stable ids only: a `:title:` row is a pre-Build-11 fallback, not a container.
  const live = "source_key NOT LIKE '%:title:%'";
  const unc = `NOT EXISTS (SELECT 1 FROM source_classifications k WHERE k.kind = c.kind AND k.source_key = c.source_key)`;
  s.containers = _count(`SELECT COUNT(*) AS n FROM source_containers c WHERE ${live}`);
  s.unclassified = _count(`SELECT COUNT(*) AS n FROM source_containers c WHERE ${live} AND ${unc}`);
  s.unclassifiedCalendars = _count(`SELECT COUNT(*) AS n FROM source_containers c WHERE ${live} AND kind = 'calendar' AND ${unc}`);
  s.unclassifiedLists = _count(`SELECT COUNT(*) AS n FROM source_containers c WHERE ${live} AND kind = 'reminder-list' AND ${unc}`);
  try {
    s.duplicateNames = _db().all(`SELECT label FROM source_containers c WHERE ${live} AND ${unc}
      GROUP BY kind, lower(label) HAVING COUNT(*) > 1`).map((r) => r.label);
  } catch { s.duplicateNames = []; }
  s.relationships = _count('SELECT COUNT(*) AS n FROM wm_people WHERE relationship IS NOT NULL OR household IS NOT NULL');
  s.proven = {
    email: _count("SELECT COUNT(*) AS n FROM prepared_actions WHERE status = 'verified' AND action_type IN ('chase_commitment','reply_email','chase_agenda','send_weekly_risk_report')"),
    calendar: _count("SELECT COUNT(*) AS n FROM prepared_actions WHERE status = 'verified' AND action_type IN ('create_calendar_event','reschedule_calendar_event','cancel_calendar_event')"),
  };
  try { s.unknownWrites = require('./external-writes').unresolved().length; } catch { s.unknownWrites = null; }
  s.goals = _count("SELECT COUNT(*) AS n FROM goals WHERE status = 'active'");
  s.companions = _count('SELECT COUNT(*) AS n FROM wm_companions');
  s.reports = Object.values(_json(REPORT_KEY, {}));
  try {
    const an = require('./attention-notifications');
    s.watchProof = an.lastProvenSynthetic();
    s.watchLastSynthetic = an.recent({ limit: 50 }).find((r) => r.synthetic) || null;
  } catch { s.watchProof = null; s.watchLastSynthetic = null; }
  for (const r of s.reports) if (r.platform === 'ios' && r.app && r.at) s.clients[r.app] = r.at;
  // Build 18: which native build is installed, and the place capabilities.
  try { s.native = require('./native-build').status({ sources: s.sources }); } catch { s.native = null; }
  try {
    const loc = (s.sources || []).find((x) => x.sourceId === 'location.neuro-ios');
    const nb = s.native && (s.native.apps || []).find((a) => a.client === 'neuro-ios');
    s.placeCaps = require('./place-sensing').placeCapabilities({ build: nb ? nb.build : null, parentVerdict: loc ? loc.verdict : null });
  } catch { s.placeCaps = null; }
  s.routesReceived = _count("SELECT COUNT(*) AS n FROM health_workouts WHERE json_extract(payload, '$.route.pointCount') IS NOT NULL");
  return s;
}

async function check({ now = Date.now() } = {}) {
  const s = await snapshot();
  return { ok: true, ...assess(s, { now, skipped: _json(SKIP_KEY, {}) }), reports: s.reports };
}

/** A device's own local checks (setup.ps1, the iOS Setup screen). Bounded. */
function report({ platform, app = null, host, checks }, { now = Date.now() } = {}) {
  if (!['windows', 'ios', 'mac', 'watchos'].includes(platform)) throw Object.assign(new Error('platform must be windows, ios, mac or watchos'), { status: 400 });
  if (typeof host !== 'string' || !host.trim()) throw Object.assign(new Error('host is required'), { status: 400 });
  if (!Array.isArray(checks)) throw Object.assign(new Error('checks must be an array'), { status: 400 });
  const clean = checks.slice(0, 40).filter((c) => c && typeof c.id === 'string')
    .map((c) => ({ id: c.id.slice(0, 40), ok: c.ok === true, detail: typeof c.detail === 'string' ? c.detail.slice(0, 160) : null,
      // Build 18J: some permissions have more than two honest answers (iOS
      // hides HealthKit READ grants), so a check may carry a bounded state word.
      ...(typeof c.state === 'string' && /^[a-z][a-z-]{0,23}$/.test(c.state) ? { state: c.state } : {}) }));
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
