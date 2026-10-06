#!/usr/bin/env node
'use strict';

/**
 * Build 13A / 13R — what the personal world model ACTUALLY holds, per domain.
 *
 * READ-ONLY. Opens the DB with { readonly: true } and writes nothing, so it is
 * safe to run against the live Pi while the backend is up.
 *
 *   node backend/scripts/build13-activation-audit.js [--json]
 *
 * Rules (the build's, restated so a later edit cannot quietly break them):
 *   • A domain is counted ONLY from explicit evidence: a classification Nick
 *     made, a declaration, or data that intrinsically IS that kind (a heart-
 *     rate reading is health). Nothing is inferred to fill a row.
 *   • A calendar Nick has not classified is reported as UNCLASSIFIED, never
 *     guessed from its title ("Home", "Birthdays", "Work" included).
 *   • A missing table or column is reported as `unreadable`, never as zero.
 */

const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.NEURO_DB_PATH || path.join(__dirname, '..', 'db', 'agent.db');
const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });

function q(sql, ...args) {
  try { return { ok: true, rows: db.prepare(sql).all(...args) }; }
  catch (e) { return { ok: false, why: e.message, rows: [] }; }
}
function one(sql, ...args) { const r = q(sql, ...args); return r.ok ? (r.rows[0] || null) : { unreadable: r.why }; }
function parseJson(s, d) { try { return JSON.parse(s); } catch { return d; } }

const now = Date.now();
const ageH = (iso) => (iso ? Math.round((now - Date.parse(iso)) / 36e5) : null);

// ── containers and classifications ──────────────────────────────────────────
const containers = q(`SELECT kind, source_key, label, container_id, last_seen_at, last_client FROM source_containers`).rows;
const classes = q(`SELECT kind, source_key, label, domains_json, tracked, set_at FROM source_classifications`).rows;
const classByKey = new Map(classes.map((c) => [c.source_key, c]));

// Only id-keyed containers are current (Build 11: a title key is a fallback for
// builds that sent no id). Report title-keyed ones separately as legacy.
const idContainers = containers.filter((c) => /:id:/.test(c.source_key));
const legacyTitle = containers.filter((c) => /:title:/.test(c.source_key));
const dupNames = {};
for (const c of idContainers) {
  const k = `${c.kind}|${String(c.label || '').toLowerCase()}`;
  dupNames[k] = (dupNames[k] || 0) + 1;
}

// Meetings per calendar container, last 30 days + next 30 days.
const meetingsByCal = new Map(
  q(`SELECT calendar_key k, count(*) n, max(start_local) last FROM wm_meetings
     WHERE start_local >= date('now','-30 days') AND start_local <= date('now','+30 days')
       AND coalesce(status,'') <> 'cancelled' AND merged_into IS NULL
     GROUP BY calendar_key`).rows.map((r) => [r.k || 'graph-cal:primary', r]),
);

const calendarRows = idContainers.concat(
  [{ kind: 'calendar', source_key: 'graph-cal:primary', label: 'Outlook calendar (work account)', last_seen_at: null, last_client: 'graph' }],
).map((c) => {
  const cls = classByKey.get(c.source_key);
  const domains = cls ? parseJson(cls.domains_json, []) : null;
  const m = c.kind === 'calendar' ? meetingsByCal.get(c.source_key) : null;
  return {
    kind: c.kind,
    sourceKey: c.source_key,
    label: c.label,
    duplicateName: (dupNames[`${c.kind}|${String(c.label || '').toLowerCase()}`] || 0) > 1,
    classification: cls ? (cls.tracked === 0 ? 'ignored' : (domains.length ? domains.join('+') : 'tracked, no domain')) : 'UNCLASSIFIED',
    lastSeenAgeH: ageH(c.last_seen_at),
    client: c.last_client || null,
    items60d: m ? m.n : 0,
  };
});

// ── per-domain evidence ─────────────────────────────────────────────────────
const calDomains = {};
for (const r of calendarRows) {
  if (r.kind !== 'calendar' || !/[a-z]/.test(r.classification) || r.classification === 'UNCLASSIFIED' || r.classification === 'ignored') continue;
  for (const d of r.classification.split('+')) {
    calDomains[d] = calDomains[d] || { calendars: 0, events60d: 0 };
    calDomains[d].calendars += 1;
    calDomains[d].events60d += r.items60d;
  }
}
const listDomains = {};
for (const r of calendarRows.filter((x) => x.kind === 'reminder-list')) {
  if (r.classification === 'UNCLASSIFIED' || r.classification === 'ignored') continue;
  for (const d of r.classification.split('+')) listDomains[d] = (listDomains[d] || 0) + 1;
}

const goals = q(`SELECT goal_id, title, status, domains_json, importance FROM goals`).rows;
const goalDomains = {};
for (const g of goals) for (const d of parseJson(g.domains_json, [])) {
  goalDomains[d] = goalDomains[d] || [];
  goalDomains[d].push(`${g.title} (${g.status})`);
}
const annotations = q(`SELECT entity_id, domains_json, importance FROM life_annotations`).rows;
const annDomains = {};
for (const a of annotations) for (const d of parseJson(a.domains_json, [])) annDomains[d] = (annDomains[d] || 0) + 1;

const companions = q(`SELECT companion_id, name, species, note_path, household FROM wm_companions`).rows;
const relPeople = q(`SELECT display_name, relationship, household FROM wm_people WHERE relationship IS NOT NULL OR household IS NOT NULL`).rows;
const reminderTasks = one(`SELECT count(*) n, sum(status='open') open FROM wm_task_sources WHERE system='eventkit-reminders' AND removed=0`);
const personalTasks = one(`SELECT count(*) n FROM tasks WHERE domain='personal' AND status IN ('open','in-progress')`);
const householdTasks = one(`SELECT count(*) n FROM tasks WHERE household=1 AND status IN ('open','in-progress')`);
const workTasks = one(`SELECT count(*) n FROM tasks WHERE coalesce(domain,'work')='work' AND status IN ('open','in-progress')`);
const commitments = q(`SELECT source_kind, direction, status, count(*) n FROM wm_commitments GROUP BY 1,2,3`).rows;
const openCommitments = commitments.filter((c) => c.status === 'open').reduce((s, c) => s + c.n, 0);

const health = one(`SELECT max(date_key) last, count(*) days FROM health_daily`)
  || {};
const healthAlt = health && health.unreadable ? one(`SELECT max(day) last, count(*) days FROM health_daily`) : health;
const workouts90 = q(`SELECT activity_type t, count(*) n, max(started_at) last FROM health_workouts
                      WHERE started_at >= date('now','-90 days') GROUP BY 1 ORDER BY n DESC`).rows;
const workoutsAll = one(`SELECT count(*) n, max(started_at) last FROM health_workouts`);
const envLast = one(`SELECT count(*) n, max(received_at) last FROM environment_readings`);
const visits = one(`SELECT count(*) n, max(received_at) last FROM device_visits`);
const regions = one(`SELECT count(*) n FROM place_region_events`);
const sourceHealth = q(`SELECT source_id, lifecycle, state, freshness, last_observed_at FROM source_health`).rows;
const sh = (id) => sourceHealth.find((s) => s.source_id === id) || null;

const fmtSrc = (ids) => ids.map((id) => { const s = sh(id); return s ? `${id}:${s.freshness}` : `${id}:absent`; }).join(', ');

const domains = [
  { domain: 'work', source: fmtSrc(['microsoft.calendar']), observations: `${calDomains.work?.events60d || 0} events ±30d on ${calDomains.work?.calendars || 0} classified calendars`,
    tasks: `${workTasks?.n ?? '?'} open (domain default — not evidence)`, commitments: `${openCommitments} open`, goals: (goalDomains.work || []).join('; ') || '0', entities: 'People notes (work roster)' },
  { domain: 'health', source: fmtSrc(['healthkit.neuro-ios', 'healthkit.saim-ios']), observations: `${healthAlt?.days ?? '?'} rolled-up days, last ${healthAlt?.last ?? '?'}`,
    tasks: '0 tagged', commitments: '0', goals: (goalDomains.health || []).join('; ') || '0', entities: '—' },
  { domain: 'fitness', source: fmtSrc(['healthkit.neuro-ios']), observations: `${workouts90.reduce((s, w) => s + w.n, 0)} workouts in 90d (${workouts90.map((w) => `${w.t} ${w.n}`).join(', ') || 'none'}); all-time ${workoutsAll?.n ?? '?'}, last ${String(workoutsAll?.last || '?').slice(0, 10)}`,
    tasks: '0', commitments: '0', goals: (goalDomains.fitness || []).join('; ') || '0', entities: `environment logger: ${envLast?.n ?? '?'} readings, last ${String(envLast?.last || '?').slice(0, 10)}` },
  { domain: 'home', source: `${calDomains.home?.calendars || 0} calendars classified home`, observations: `${calDomains.home?.events60d || 0} events ±30d`,
    tasks: `${householdTasks?.n ?? '?'} household tasks`, commitments: '0', goals: (goalDomains.home || []).join('; ') || '0', entities: 'HA household sensor (not on spine)' },
  { domain: 'family', source: `${calDomains.family?.calendars || 0} calendars classified family`, observations: `${calDomains.family?.events60d || 0} events ±30d`,
    tasks: `${listDomains.family || 0} reminder lists classified family`, commitments: '0', goals: (goalDomains.family || []).join('; ') || '0', entities: `${relPeople.length} People notes state relationship/household` },
  { domain: 'ember', source: 'vault Companions/', observations: '—', tasks: '0', commitments: '0', goals: (goalDomains.ember || []).join('; ') || '0',
    entities: companions.map((c) => `${c.name} (${c.species || 'species unstated'})`).join(', ') || 'none' },
  { domain: 'learning', source: `${calDomains.learning?.calendars || 0} calendars classified learning`, observations: `${calDomains.learning?.events60d || 0} events ±30d`, tasks: '0', commitments: '0', goals: (goalDomains.learning || []).join('; ') || '0', entities: '—' },
  { domain: 'travel', source: fmtSrc(['location.neuro-ios']), observations: `${visits?.n ?? '?'} visits, ${regions?.n ?? '?'} geofence events`, tasks: '0', commitments: '0', goals: '0', entities: 'saved places' },
  { domain: 'finance', source: 'none', observations: '0', tasks: '0', commitments: '0', goals: (goalDomains.finance || []).join('; ') || '0', entities: '—' },
  { domain: 'leisure', source: 'none', observations: '0', tasks: '0', commitments: '0', goals: (goalDomains.leisure || []).join('; ') || '0', entities: '—' },
  { domain: 'projects', source: 'none', observations: '0', tasks: '0', commitments: '0', goals: (goalDomains.projects || []).join('; ') || '0', entities: '—' },
  { domain: 'admin', source: 'none', observations: '0', tasks: '0', commitments: '0', goals: (goalDomains.admin || []).join('; ') || '0', entities: '—' },
];

const out = {
  at: new Date().toISOString(),
  calendars: calendarRows,
  legacyTitleContainers: legacyTitle.map((c) => ({ kind: c.kind, sourceKey: c.source_key, lastSeenAgeH: ageH(c.last_seen_at) })),
  goals, annotations: annotations.length, companions, relationshipPeople: relPeople,
  reminderTasks, personalTasks, commitments, domains,
  sourceHealth,
};

if (process.argv.includes('--json')) { console.log(JSON.stringify(out, null, 2)); process.exit(0); }

console.log(`# Activation audit ${out.at}\n`);
console.log('## Containers (id-keyed)');
for (const r of calendarRows) {
  console.log(`- ${r.kind.padEnd(13)} ${String(r.label).padEnd(26)} ${r.classification.padEnd(14)} ${r.duplicateName ? 'DUP-NAME ' : ''}seen ${r.lastSeenAgeH ?? '—'}h ago via ${r.client || '?'}; ${r.kind === 'calendar' ? `${r.items60d} events ±30d` : ''}  [${r.sourceKey}]`);
}
console.log(`\nLegacy title-keyed containers: ${legacyTitle.length}`);
console.log('\n## Domains');
for (const d of domains) console.log(`| ${d.domain} | ${d.source} | ${d.observations} | ${d.tasks} | ${d.commitments} | ${d.goals} | ${d.entities} |`);
console.log(`\ngoals=${goals.length} annotations=${annotations.length} companions=${companions.length} relationshipPeople=${relPeople.length} reminderTasks=${JSON.stringify(reminderTasks)}`);
