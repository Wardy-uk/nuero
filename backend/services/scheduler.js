const nodeCron = require('node-cron');
const nudges = require('./nudges');

// ── node-cron, with in-process recovery on every job (Build 3A) ─────────────
//
// node-cron 3.0.3 fires a task only if its one-second timer lands INSIDE the
// matching second. Dozens of jobs below share :00 / :20 / :40, several do
// seconds of synchronous SQLite or vault work, and on those minutes the later
// timers wake late and the tick is silently dropped. Measured on pi5 overnight
// 2–3 Oct 2026: 9 of 50 calendar syncs never ran, all on shared minutes.
//
// `recoverMissedExecutions` makes a late timer run the missed second once the
// loop is free — the job runs a few seconds late instead of not at all. That is
// strictly better for every job here: none of them is harmed by a few seconds'
// lateness. ⚠ node-cron does NOT fire a matched second at most once with this
// on — it double-fired the 9am and 1pm briefs on 7 Oct 2026 — so the wrapper
// in cron-once.js holds each task to one run per matched second. It is NOT
// restart catch-up — a tick missed because the process was
// down is still gone. Jobs where that matters run on the durable runtime
// instead (services/runtime-jobs.js, registered at the end of start()).
//
// It was already on for the MS Tasks sync after the same failure was found
// there on 23 Sep 2026; this makes it the default rather than the exception.
const cron = require('./cron-once').createCron(nodeCron);
const jira = require('./jira');
const imports = require('./imports');
const db = require('../db/database');

// ── Missed-run catch-up ─────────────────────────────────────────────────────
//
// `node-cron` is in-process and has NO catch-up: if the process is not running
// at 02:30, that night's job simply never happens and nothing says so. Measured
// on the Pi: the nightly sweep ran 9 times in 45 nights and the weekly hygiene
// pass 4 times in 7 Fridays, while the 22:00 rollup showed 111 runs and the Pi
// itself had 34 days of uptime. So it was never downtime — it was `neuro-backend`
// restarting (49 restarts, mostly deploys; two or three Claude sessions deploy a
// day) and each restart silently eating whatever was due while it was gone.
//
// Every job that IS reliable already has a startup fallback — capture drain,
// embeddings, imports, Plaud, MS Tasks, calendar. Every 02:30 and Friday job
// lacked one. This is that pattern, generalised: stamp the run date into
// `agent_state`, and on boot run anything whose slot has already passed today
// and whose stamp is not today's.
//
// Deliberately: a job missed YESTERDAY is not run today. Catch-up means "this
// slot has passed and was missed", not "replay history" — a week of missed
// sweeps firing at once on a Monday boot is a worse failure than the one being
// fixed.
const JOB_STATE_PREFIX = 'scheduler_last_run:';

function _dateStr(d = new Date()) {
  // Local date, deliberately not toISOString() — the Pi may run in UTC and a
  // 02:30 job stamped with a UTC date would roll over at the wrong moment.
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function lastRunOf(name) {
  try { return db.getState(`${JOB_STATE_PREFIX}${name}`) || null; }
  catch { return null; }
}

function _markRan(name, when = new Date()) {
  try { db.setState(`${JOB_STATE_PREFIX}${name}`, _dateStr(when)); }
  catch (e) { console.error(`[Scheduler] Could not stamp ${name}:`, e.message); }
}

// Wrap a job so every run — cron or catch-up — records itself.
function _tracked(name, fn) {
  return async (via = 'cron') => {
    const started = Date.now();
    try {
      await fn();
    } catch (e) {
      // Jobs catch their own errors; this is the backstop so one throw cannot
      // take down the catch-up sequence behind it.
      console.error(`[Scheduler] ${name} threw (${via}):`, e.message);
    }
    // Stamped either way. A job that fails every night should not re-run on
    // every deploy as well — the failure belongs in the log, not in a retry loop.
    _markRan(name);
    if (via !== 'cron') console.log(`[Scheduler] ${name} ran via ${via} (${Date.now() - started}ms)`);
  };
}

// The two predicates, pure and exported — they are the only part of this with
// real logic in it, and the only part worth pinning.

/** Has today's hour:minute slot passed without a run today? */
function isDailyDue(lastRun, hour, minute, now = new Date()) {
  if (lastRun === _dateStr(now)) return false;
  return now.getHours() > hour || (now.getHours() === hour && now.getMinutes() >= minute);
}

/** Has the most recent weekly slot passed without a run in it? */
function isWeeklyDue(lastRun, weekday, hour, minute, now = new Date()) {
  // Wind back to the last time this slot came round — earlier today, or up to
  // six days ago. Missed means the stamp predates that moment.
  const slot = new Date(now);
  slot.setHours(hour, minute, 0, 0);
  let back = (now.getDay() - weekday + 7) % 7;
  if (back === 0 && now < slot) back = 7; // today IS the day, but before the time
  slot.setDate(slot.getDate() - back);
  return !lastRun || lastRun < _dateStr(slot);
}

const _catchUp = [];

/** Register a job that should run once a day at hour:minute. */
function scheduleDaily(name, cronExpr, hour, minute, fn) {
  const run = _tracked(name, fn);
  cron.schedule(cronExpr, () => run('cron'));
  _catchUp.push({ name, run, kind: 'daily', due: (now) => isDailyDue(lastRunOf(name), hour, minute, now) });
}

/** Register a job that should run once a week on `weekday` (0=Sun) at hour:minute. */
function scheduleWeekly(name, cronExpr, weekday, hour, minute, fn) {
  const run = _tracked(name, fn);
  cron.schedule(cronExpr, () => run('cron'));
  _catchUp.push({ name, run, kind: 'weekly', due: (now) => isWeeklyDue(lastRunOf(name), weekday, hour, minute, now) });
}

/**
 * Run anything whose slot has passed and which has not run in it.
 *
 * Staggered, because several of these walk the whole vault and firing them
 * together on boot would make every deploy cost a load spike on a Pi that is
 * also serving Focus and chat.
 */
function runCatchUp({ delayMs = 45000, gapMs = 60000 } = {}) {
  const now = new Date();
  const due = _catchUp.filter(j => { try { return j.due(now); } catch { return false; } });
  if (!due.length) return [];
  console.log(`[Scheduler] Catch-up: ${due.length} missed job(s) — ${due.map(j => j.name).join(', ')}`);
  due.forEach((job, i) => {
    const t = setTimeout(() => { job.run('catch-up'); }, delayMs + i * gapMs);
    // Never hold the process open for a catch-up.
    if (t.unref) t.unref();
  });
  return due.map(j => j.name);
}

/** What ran, and when — so a job that has quietly stopped is answerable. */
function jobRunStatus() {
  return _catchUp.map(j => ({ name: j.name, kind: j.kind, lastRun: lastRunOf(j.name) }));
}

function start() {
  // Fire nudges immediately if server starts after 9am on a weekday
  nudges.startupCheck();

  // Check 1-2-1s on startup too
  nudges.check121Nudges();

  // Check plan milestone on startup too (in case server was restarted on the milestone day)
  nudges.checkPlanMilestoneNudge();

  // Start Jira polling (fetches on startup + every 5 min)
  jira.startPolling();

  // Make sure the capture drop-box exists, and drain anything written while the
  // backend was down — that is the whole point of the file surviving an outage.
  //
  // Gated on a real vault. Unguarded, `ensureCaptureFile()` resolved
  // `Tasks/Capture.md` against the process working directory and created
  // `backend/Tasks/Capture.md` inside the repository, then logged nothing, so a
  // drop-box wired to nowhere looked exactly like a working one. One warning
  // naming the reason beats a cheerful setup message over a file Obsidian
  // cannot see.
  try {
    const captureDrain = require('./task-capture-drain');
    const vault = captureDrain.resolveVault();
    if (!vault.ok) {
      console.warn(`[Scheduler] Obsidian capture drop-box NOT set up - ${vault.error}. Offline capture via Tasks/Capture.md is unavailable until OBSIDIAN_VAULT_PATH points at the vault.`);
    } else {
      captureDrain.ensureCaptureFile();
      captureDrain.drainCaptureFile({ force: true });
    }
  } catch (e) {
    console.error('[Scheduler] Capture drain on startup failed:', e.message);
  }

  // Run anything today's restart caused us to miss. Registered below, so this
  // is deferred to the end of start() — see the runCatchUp() call there.

  // 8:55am weekdays — pre-warm standup questions
  cron.schedule('55 8 * * 1-5', () => {
    console.log('[Scheduler] 8:55am — pre-warming standup');
    try {
      const standupRouter = require('../routes/standup');
      if (standupRouter.preWarmStandup) standupRouter.preWarmStandup();
      if (standupRouter.preWarmStandupQuestions) standupRouter.preWarmStandupQuestions();
    } catch (e) { console.error('[Scheduler] Pre-warm error:', e.message); }
  });

  // 4:55pm weekdays — pre-warm EOD questions
  cron.schedule('55 16 * * 1-5', () => {
    console.log('[Scheduler] 4:55pm — pre-warming EOD');
    try {
      const standupRouter = require('../routes/standup');
      if (standupRouter.preWarmEod) standupRouter.preWarmEod();
      if (standupRouter.preWarmEodQuestions) standupRouter.preWarmEodQuestions();
    } catch (e) { console.error('[Scheduler] EOD pre-warm error:', e.message); }
  });

  // 9am weekdays — trigger standup and todo nudges
  // Every 40 minutes — the ambient push pass.
  //
  // ⚠ The CADENCE is not the frequency. Almost every pass decides to say
  // nothing: `ambient-push` refuses on an unconfident read, in a meeting, in
  // Focus mode, driving, in a focus session, or when the brain has called the
  // moment quiet — and then sends AT MOST ONE, through the governor's quiet
  // hours, 30-minute dedupe and hourly cap, and through the attention lifecycle
  // which will not let the same observation interrupt twice. Checking often is
  // what lets it catch the right moment; the gates are what stop it being a
  // pest. 40 rather than 30 so it does not beat in step with the half-hourly
  // syncs.
  //
  // Deliberately NOT a TRACKED_JOBS catch-up job: replaying "you have been
  // sitting for two hours" an hour later is a statement about a moment that has
  // gone.
  // Hourly at :35 — judge whether yesterday's prompts made any difference, and
  // quieten anything that has earned it. Idempotent over pending deliveries, so
  // deliberately NOT a TRACKED_JOBS catch-up job: a missed hour self-corrects.
  cron.schedule('35 * * * *', () => {
    try {
      const result = require('./attention-learning').sweep();
      if (result.muted.length) {
        console.log(`[Scheduler] SAiM quietened: ${result.muted.map(m => m.kind).join(', ')}`);
      }
    } catch (e) {
      console.warn('[Scheduler] Attention learning sweep failed:', e.message);
    }
  });

  // (The */40 ambient push pass itself is a DURABLE job — see
  // registerDurableJobs() below.)

  cron.schedule('0 9 * * 1-5', () => {
    console.log('[Scheduler] 9am — triggering standup + todo nudges');
    nudges.triggerStandupNudge();
    nudges.triggerTodoNudge();
  });

  // 8:45am weekdays — early standup nudge if configured via insights suggestion
  cron.schedule('45 8 * * 1-5', () => {
    try {
      const db = require('../db/database');
      const customHour = db.getState('standup_nudge_hour');
      if (customHour && parseInt(customHour, 10) < 9) {
        console.log('[Scheduler] Early standup nudge (custom time)');
        nudges.triggerStandupNudge();
      }
    } catch {}
  });

  // 9:10am weekdays — check 1-2-1 due dates
  cron.schedule('10 9 * * 1-5', () => { nudges.check121Nudges(); });

  // Every 15 min — keep the mapped Notion folders and the vault in step.
  //
  // Deliberately NOT a TRACKED_JOBS catch-up job: the sync compares live state on
  // both sides every pass, so a missed run self-corrects on the next one and
  // there is nothing to replay (the `wins` and `bank-holidays` call). Defaults
  // OFF — this writes to a real external workspace, so switching it on is a
  // decision, not a default.
  //
  // ⚠ The cron is registered UNCONDITIONALLY and the switch is checked INSIDE
  // the tick. Reading the flag out here meant turning the sync on required an
  // .env edit and a pm2 restart — six steps of SSH for a boolean, on the system
  // whose stated premise is that Nick's bottleneck is initiation. The toggle now
  // lives in the DB beside the token and takes effect at the next quarter hour.
  cron.schedule('*/15 * * * *', async () => {
    try {
      if (!require('./notion-sync/config').autoSyncEnabled()) return;
      const r = await require('./notion-sync').run({ dryRun: false });
      const c = r.counts;
      if (c.pulled || c.pushed || c.created || c.conflicts) {
        console.log(`[Scheduler] Notion sync: ${c.pulled} pulled, ${c.pushed} pushed, `
          + `${c.created} created, ${c.conflicts} conflict(s)`);
      }
      // A gap is logged loudly whatever else happened — a sync reporting zero
      // because it could not read a side is the bug, not a quiet day.
      for (const gap of r.gaps) console.warn(`[Scheduler] Notion sync gap: ${gap}`);
    } catch (e) {
      console.error(`[Scheduler] Notion sync failed: ${e.message}`);
    }
  });

  // Every 20 min in working hours — offer NOVA any 1-2-1 transcript that has landed in
  // the vault. Frequent because Nick processes a recording and then goes looking for it
  // in NOVA; a nightly sweep would mean the test he just ran shows nothing for hours.
  // It only ever PROPOSES — NOVA holds each one until he approves it.
  cron.schedule('*/20 7-19 * * *', async () => {
    try {
      const r = await require('./nova-121-transcripts').offerTranscripts({ apply: true });
      if (!r.ok) { console.warn(`[Scheduler] 1-2-1 transcript offer failed: ${r.error}`); return; }
      if (r.offered.length || r.skipped.length) {
        console.log(`[Scheduler] 1-2-1 transcripts: ${r.offered.length} offered to NOVA, ${r.skipped.length} failed`);
        for (const f of r.skipped) console.warn(`[Scheduler] transcript offer failed — ${f}`);
      }
      // Notes plaud-sync filed as a 1-2-1 that nobody could be attributed to. Not
      // failures, but the only place a mis-detection is visible — without this, a 1-2-1
      // whose participants Plaud never identified vanishes with no trace anywhere.
      for (const i of (r.ignored || [])) console.log(`[Scheduler] 1-2-1 not offered — ${i}`);
    } catch (e) {
      console.warn('[Scheduler] 1-2-1 transcript offer threw:', e.message);
    }
  });

  // 6:20am daily — push bookings + cadence into NOVA, ahead of its 07:00 prep job.
  //
  // DAILY, not weekdays: a 1-2-1 booked on a Friday for the Monday has to reach NOVA
  // over the weekend, or Monday's prep never goes out. The inline push in book() is the
  // fast path; this is the guarantee, because that push runs after the calendar event
  // has already been created and so cannot fail loudly enough to stop anything.
  cron.schedule('20 6 * * *', async () => {
    try {
      const sync = require('./nova-121-sync');
      const r = await sync.reconcile({ apply: true });
      if (!r.ok) { console.warn(`[Scheduler] NOVA 1-2-1 sync failed: ${r.error}`); return; }
      if (r.pushed?.length || r.failed?.length || r.cadenceSet?.length) {
        console.log(`[Scheduler] NOVA 1-2-1 sync: ${r.pushed.length} pushed, ${r.cadenceSet.length} cadence, ${r.failed.length} failed`);
      }
      const d = r.drift || {};
      if (d.notInNova?.length || d.notInVault?.length || d.unknownCadence?.length) {
        console.warn('[Scheduler] 1-2-1 roster drift —' +
          ` not in NOVA: [${(d.notInNova || []).join(', ')}];` +
          ` not in vault: [${(d.notInVault || []).join(', ')}];` +
          ` unknown cadence: [${(d.unknownCadence || []).map(x => `${x.person}=${x.cadence}`).join(', ')}]`);
      }
    } catch (e) {
      console.warn('[Scheduler] NOVA 1-2-1 sync threw:', e.message);
    }
  });


  // Retiring yesterday's banner is a DAILY job, not a weekday one — nagCheck
  // below runs Mon-Fri only, so a Saturday nudge survived the rollover and
  // Sunday raised a second row for the same fact (see clearStaleNudges).
  cron.schedule('5 0 * * *', () => {
    const n = nudges.clearStaleNudges();
    if (n) console.log(`[Scheduler] Cleared ${n} stale nudge(s) from previous days`);
  });

  // Every 15 minutes between 9am-5pm weekdays — nag if not done
  cron.schedule('*/15 9-17 * * 1-5', () => {
    nudges.nagCheck();
  });

  // Daily at 9:05am — check plan milestone (75% reminder)
  cron.schedule('5 9 * * 1-5', () => {
    nudges.checkPlanMilestoneNudge();
  });

  // 8pm, EVERY day — SAiM opens the EOD.
  //
  // Moved from 5pm weekdays (Nick, 31 Aug 2026). Both halves of that follow from
  // what the EOD became earlier the same day: a reflection rather than a status
  // report. Five o'clock is the end of the WORKING day and the wrong moment to
  // ask how the day was; and a Saturday is still a day worth closing, so the
  // working-day suppression is deliberately not applied to this one nudge.
  cron.schedule('0 20 * * *', async () => {
    console.log('[Scheduler] 8pm — SAiM opens the EOD');
    // Awaited and caught: it starts a session and makes an AI call, so an
    // unhandled rejection here would be a silent evening with no notification
    // and nothing in the log to say why.
    try {
      await nudges.triggerEodNudge();
    } catch (e) {
      console.error('[Scheduler] EOD nudge failed:', e.message);
    }
  });

  // 9pm — the snooze landing. Fires ONLY if he actually pressed "ask me at
  // nine": `triggerEodNudge({retry:true})` returns immediately otherwise, so
  // this is never a second unasked-for interruption.
  //
  // ⚠ There is no third ask. Nine is the last one — quiet hours start at 22:00,
  // and a prompt at ten that the governor swallows is worse than no prompt,
  // because nothing on screen would say it had been suppressed.
  cron.schedule('0 21 * * *', async () => {
    try {
      await nudges.triggerEodNudge({ retry: true });
    } catch (e) {
      console.error('[Scheduler] EOD retry failed:', e.message);
    }
  });

  // Training matrix sync is owned by n8n ("Training Matrix Sync" workflow) —
  // it fetches NOVA /api/public/training-export and POSTs to NEURO
  // /api/training/apply-matrix. No NEURO-side cron needed.

  // Monday 6:05am — refresh the gov.uk bank-holiday list (#25). Deliberately NOT
  // in state-of-play's TRACKED_JOBS: the feed is a static publication covering
  // years ahead and the service carries a compiled-in floor, so a missed week is
  // harmless — and a board that warns about a benign lapse is one nobody reads.
  // A failed fetch is loud in the log and visible on GET /api/time/working-days.
  scheduleWeekly('bank-holidays', '5 6 * * 1', 1, 6, 5, () => {
    require('./working-days').refresh().catch(e =>
      console.error('[Scheduler] Bank-holiday refresh failed:', e.message));
  });

  // Friday 4:30pm — snapshot the week's outcomes, then generate the review.
  // Snapshot FIRST so the review can read a stored week rather than recomputing
  // one, and so the number is fixed at the moment it was taken.
  scheduleWeekly('weekly-review', '30 16 * * 5', 5, 16, 30, () => {
    try {
      require('./outcomes').snapshot();
    } catch (e) { console.error('[Scheduler] Outcomes snapshot failed:', e.message); }
    try {
      const obsidian = require('./obsidian');
      const result = obsidian.generateWeeklyReview();
      if (result && !result.skipped) {
        require('./webpush').sendToAll('SAiM — Weekly review',
          `Your ${result.weekStr} review is ready in Reflections. Take 5 minutes to fill in wins, challenges, and how you're feeling.`,
          { type: 'weekly_review', url: '/vault' }).catch(() => {});
      }
    } catch (e) { console.error('[Scheduler] Weekly review failed:', e.message); }
  });

  // Friday 4:35pm — weekly vault-hygiene pass (READ-ONLY): refresh the lint audit
  // and contextual-link cards so they're ready to review/approve. Never applies.
  scheduleWeekly('weekly-hygiene', '35 16 * * 5', 5, 16, 35, () => {
    try {
      const vaultRoot = process.env.OBSIDIAN_VAULT_PATH;
      if (!vaultRoot) return;
      const hygiene = require('./vault-hygiene');
      const lintRes = hygiene.lint(vaultRoot);
      const planRes = hygiene.contextualLinkPlan(vaultRoot);
      // Archived-target count is logged but deliberately kept OUT of the push: it is
      // informational, and a second number on the banner is nudge noise (#17).
      console.log(`[Scheduler] Weekly hygiene: ${lintRes.broken.length} broken, ${lintRes.archivedTargets.length} into Archive, ${lintRes.orphans.length} orphans; ${planRes.total} link cards across ${planRes.notesTouched} notes.`);
      if (planRes.total > 0 || lintRes.broken.length > 0) {
        require('./webpush').sendToAll('SAiM — Vault hygiene',
          `${lintRes.broken.length} broken links, ${lintRes.orphans.length} orphans, ${planRes.total} link cards to review in Vault Audit.`,
          { type: 'vault_hygiene', url: '/vault' }).catch(() => {});
      }
    } catch (e) { console.error('[Scheduler] Weekly hygiene failed:', e.message); }
  });

  // Every 5 min — move host metrics from the cron CSVs into SQL, sample the
  // Pi 5 straight in, and prune anything past retention. The CSVs stay as the
  // collection layer because they keep working when this process does not.
  cron.schedule('*/5 * * * *', async () => {
    try {
      const r = await require('./metrics-store').run();
      const imported = r.results.reduce((a, x) => a + (x.imported || 0), 0);
      if (imported || r.pruned) {
        console.log(`[Scheduler] Metrics: ${imported} imported, ${r.pi5Rows} pi5 samples, ${r.pruned} pruned`);
      }
    } catch (e) { console.error('[Scheduler] Metrics store failed:', e.message); }
  });

  // Every 30 min — watchdog. Pairs with the healthchecks.io dead man's switch:
  // that one catches a Pi that cannot speak, this one catches a healthy Pi with
  // something broken on it (dead worker, stopped backups, failing AI provider).
  // Alerts fire on transition only, so a persistent fault is not a repeat page.
  cron.schedule('*/30 * * * *', async () => {
    try {
      const r = await require('./watchdog').run();
      if (r.alerted.length || r.resolved.length) {
        console.log(`[Scheduler] Watchdog: ${r.alerted.length} new alert(s)${r.alerted.length ? ` — ${r.alerted.join('; ')}` : ''}${r.resolved.length ? ` | resolved: ${r.resolved.join('; ')}` : ''}`);
      }
    } catch (e) { console.error('[Scheduler] Watchdog failed:', e.message); }
  });

  // Nightly 2:30am — hygiene sweep (APPLY): content-safe Summary-N dedup, collect
  // unnamed "Speaker N" recordings into the Orphan hub, archive empty stragglers.
  // All mutations are reversible (archive + backups) and reported to Vault Audit.
  scheduleDaily('nightly-sweep', '30 2 * * *', 2, 30, () => {
    try {
      const vaultRoot = process.env.OBSIDIAN_VAULT_PATH;
      if (!vaultRoot) return;
      const r = require('./vault-hygiene').nightlySweep(vaultRoot, { apply: true });
      console.log(`[Scheduler] Nightly sweep: ${r.dedup.dropped.length} duplicate summaries archived, ${r.orphans.collected.length} unnamed recordings collected, ${r.empties.archived.length} empty recordings archived. Report: ${r.reportPath}`);
    } catch (e) { console.error('[Scheduler] Nightly sweep failed:', e.message); }
  });

  // Monday 8:10am — generate a knowledge reflection brief for the week ahead
  scheduleWeekly('knowledge-reflection', '10 8 * * 1', 1, 8, 10, () => {
    try {
      const result = require('./knowledge-memory').generateReflection({ write: true });
      if (result?.path) {
        require('./webpush').sendToAll(
          'SAiM — Knowledge reflection',
          'Your latest knowledge reflection is ready. Review what to promote before the week drifts.',
          { type: 'knowledge_reflection', url: '/insights' }
        ).catch(() => {});
      }
    } catch (e) {
      console.error('[Scheduler] Knowledge reflection failed:', e.message);
    }
  });

  // Monday 7:30am — build the Weekly Risk & Anomaly Summary.
  //
  // Nick owes this to Chris by MIDDAY every Monday (agreed at the 1-2-1 on
  // 12 Aug 2026, PIP competency 2), so it is built early enough to leave a
  // working morning for the manual sections. It BUILDS and notifies; it never
  // publishes or sends. Overtime, the escalation list and the data-quality
  // judgements are Nick's to state, and a report that auto-sent itself with
  // those blank would be a false all-clear to the person assessing the PIP.
  scheduleWeekly('weekly-risk-report', '30 7 * * 1', 1, 7, 30, async () => {
    try {
      const weeklyRisk = require('./weekly-risk');
      const report = await weeklyRisk.build();
      const parts = [];
      if (report.escalateCount) parts.push(`${report.escalateCount} to escalate`);
      if (report.blockers.length) parts.push(`${report.blockers.length} section${report.blockers.length === 1 ? '' : 's'} need you`);
      const failed = report.sources.filter(s => !s.ok).length;
      if (failed) parts.push(`${failed} data source${failed === 1 ? '' : 's'} down`);
      await require('./webpush').sendToAll(
        'SAiM — Weekly risk report',
        parts.length
          ? `Draft ready for Chris by midday: ${parts.join(', ')}.`
          : 'Draft ready for Chris by midday. Nothing flagged for escalation — confirm and send.',
        // `?view=` — App.jsx reads the query param, never the pathname, so a
        // bare '/weekly-risk' silently lands on Briefing.
        { type: 'weekly_risk', url: '/?view=weekly-risk' },
      ).catch(() => {});
      console.log(`[Scheduler] Weekly risk report built: ${report.escalateCount} escalations, ${report.blockers.length} blockers.`);
    } catch (e) {
      console.error('[Scheduler] Weekly risk report failed:', e.message);
    }
  });

  // Weekdays 10 minutes after the main intake cycles — consolidate raw intake into working notes
  cron.schedule('40 * * * 1-5', () => {
    require('./knowledge-memory').consolidateAllImports({ limit: 30 }).catch((e) => {
      console.error('[Scheduler] Import consolidation failed:', e.message);
    });
  });

  // Every hour — fold finished work into the wins ledger.
  //
  // Deliberately NOT a scheduleDaily/TRACKED_JOBS job. sync() is idempotent and
  // reads a trailing window, so a missed hour is corrected by the next one and
  // by the sync-on-read in the route — there is nothing for catch-up to replay
  // and nothing for state-of-play to warn about. Same call as bank-holidays:
  // a board that warns about a benign lapse is one nobody reads.
  cron.schedule('20 * * * *', () => {
    try {
      const { added, gaps } = require('./wins').sync();
      if (added) console.log(`[Scheduler] Wins: +${added}`);
      // A source that could not be read is logged, never silently treated as a
      // day with no wins — that silence is the bug this feature exists to fix.
      for (const g of gaps) console.warn(`[Scheduler] Wins gap — ${g}`);
    } catch (e) {
      console.error('[Scheduler] Wins sync failed:', e.message);
    }
  });

  // Every hour — roll the raw Apple Health samples into one row per day.
  //
  // Hourly rather than nightly because the phone syncs when iOS feels like it
  // (BGProcessingTask is a request, not a schedule), so "last night's sleep" can
  // land at 11:00. The planner reads this at 07:15, so a stale rollup means a
  // day planned against the day before yesterday.
  //
  // Deliberately NOT a scheduleDaily/TRACKED_JOBS job, for the same reason as
  // wins: sync() is idempotent over a trailing 10-day window, so a missed hour
  // is corrected by the next one and there is nothing to replay.
  cron.schedule('25 * * * *', () => {
    try {
      const { written, gaps } = require('./health-daily').sync();
      // Gaps are logged loudly. A rollup that quietly writes nothing because the
      // table was unreachable looks exactly like a quiet day — which is the
      // failure this whole area was just dug out of.
      for (const g of gaps) console.warn(`[Scheduler] Health rollup gap — ${g.input}: ${g.why}`);
      if (written) console.log(`[Scheduler] Health rollup: ${written} day(s)`);
    } catch (e) {
      console.error('[Scheduler] Health rollup failed:', e.message);
    }
  });

  // Hourly at :07 — snapshot the forecast the Weather screen overlays. Every
  // snapshot is kept, so a past hour can be compared with the forecast that was
  // standing at the time. Skips itself if one was taken in the last 45 minutes.
  cron.schedule('7 * * * *', async () => {
    try {
      const r = await require('./weather-forecast').snapshot();
      if (!r.ok) console.warn(`[Scheduler] Weather forecast: ${r.why}`);
    } catch (e) {
      console.warn('[Scheduler] Weather forecast failed:', e.message);
    }
  });
  // And once shortly after boot, so a fresh install has an overlay within a minute.
  setTimeout(() => {
    require('./weather-forecast').snapshot().then((r) => {
      if (!r.ok) console.warn(`[Scheduler] Weather forecast (startup): ${r.why}`);
    }).catch(() => {});
  }, 50 * 1000).unref?.();

  // Hourly at :29 — copy the bedroom radiator's hourly temperature from Home
  // Assistant's long-term statistics. Three days each pass, so an HA outage of a
  // day or two heals itself; the first run after deploy is a manual full copy.
  cron.schedule('29 * * * *', async () => {
    try {
      const r = await require('./bedroom-climate').sync({ days: 3 });
      if (!r.ok) console.warn(`[Scheduler] Bedroom climate: ${r.why}`);
    } catch (e) {
      console.warn('[Scheduler] Bedroom climate failed:', e.message);
    }
  });

  // Hourly at :27 — exertion from heart rate, just after the health rollup at :25
  // (it reads that rollup's resting heart rate). Idempotent over 10 days, so not
  // a catch-up job, the same call as the rollup itself.
  cron.schedule('27 * * * *', () => {
    try {
      const { written, gaps } = require('./exertion').sync();
      for (const g of gaps) console.warn(`[Scheduler] Exertion gap — ${g.input}: ${g.why}`);
      if (written) console.log(`[Scheduler] Exertion: ${written} day(s)`);
    } catch (e) {
      console.error('[Scheduler] Exertion failed:', e.message);
    }
  });

  // Hourly at :50 — roll the desktop agent's samples into desktop_daily.
  //
  // ⚠ The cadence is not cosmetic. The live buffer is a ring of MAX_SAMPLES
  // (~13 hours at the agent's two-minute cadence), so anything not rolled up
  // within that window is GONE — unlike the health rollup, which reads a table
  // that keeps its own history and can be re-derived at any time. Hourly leaves
  // an order of magnitude of headroom; a boot run below covers a restart landing
  // mid-hour.
  //
  // Deliberately NOT a scheduleDaily/TRACKED_JOBS job, same call as wins and the
  // health rollup: sync() recomputes a trailing window and refuses to overwrite
  // a fuller row with a thinner one, so a missed hour is corrected by the next
  // and there is nothing to replay.
  const rollDesktop = where => {
    try {
      const { written, skipped, gaps } = require('./desktop-daily').sync();
      // Gaps and refusals are both logged. A rollup that quietly writes nothing
      // because the buffer was unreadable looks exactly like a quiet day, and
      // that conflation is the entire reason this feature exists.
      for (const g of gaps) console.warn(`[Scheduler] Desktop rollup gap — ${g.input}: ${g.why}`);
      for (const s of skipped) console.warn(`[Scheduler] Desktop rollup kept the stored ${s.day} (${s.host}): ${s.why}`);
      if (written) console.log(`[Scheduler] Desktop rollup (${where}): ${written} day/host row(s)`);
    } catch (e) {
      console.error('[Scheduler] Desktop rollup failed:', e.message);
    }
  };
  cron.schedule('50 * * * *', () => rollDesktop('hourly'));
  setTimeout(() => rollDesktop('startup'), 40000);

  // Every 3 hours at :05 — pull RescueTime's view of the same days.
  //
  // ⚠ Deliberately NO startup run, unlike the desktop rollup beside it. That one
  // reads a local ring buffer that loses data if it is not drained; this is a
  // network call to a third party, and the backend restarts several times a day
  // on deploys — a boot fetch would mean dozens of pointless calls a week to
  // re-read days that have not changed.
  //
  // Not a TRACKED_JOBS job: it re-reads a trailing 14-day window and refuses to
  // overwrite a day that had hours with an empty one, so a missed run corrects
  // itself. Silent when no key is configured — that is a choice, not a fault.
  cron.schedule('5 */3 * * *', async () => {
    try {
      const rt = require('./rescuetime');
      if (!rt.isConfigured()) return;
      const { written, skipped, gaps } = await rt.sync();
      for (const g of gaps) console.warn(`[Scheduler] RescueTime gap — ${g.input}: ${g.why}`);
      for (const s of skipped) console.warn(`[Scheduler] RescueTime kept the stored ${s.day}: ${s.why}`);
      if (written) console.log(`[Scheduler] RescueTime: ${written} day(s)`);
    } catch (e) {
      console.error('[Scheduler] RescueTime sync failed:', e.message);
    }
  });

  // 03:10 nightly — re-roll a WIDE window of health days.
  //
  // The hourly job re-reads 10 trailing days, which is right for steady state:
  // measured live, no sample in the last week arrived stamped more than 10 days
  // earlier. But the worst arrival lag in the last month is 730 DAYS, because
  // the phone app backfills history forward chronologically and has delivered
  // two years in one go. A sample landing today stamped last March would never
  // reach health_daily otherwise — the row computed when that day was empty
  // would stand for ever.
  //
  // Bounded at 120 days: anything older is a full re-backfill and belongs to
  // scripts/health-backfill.js, run by hand. Chunked inside syncRange, because a
  // single wide read hits the 20,000-row cap and silently rolls up a partial
  // history. Idempotent, so like the hourly job it is deliberately not tracked.
  cron.schedule('10 3 * * *', () => {
    try {
      const { written, gaps } = require('./health-daily').syncRange({ days: 120 });
      for (const g of gaps) console.warn(`[Scheduler] Health wide rollup gap — ${g.input}: ${g.why}`);
      console.log(`[Scheduler] Health wide rollup: ${written} day(s) re-rolled`);
    } catch (e) {
      console.error('[Scheduler] Health wide rollup failed:', e.message);
    }
  });

  // 10pm nightly — build daily activity summary + entity extraction + write observations
  // async because the meeting-action scan now asks NOVA which 1-2-1s it already owns
  // before scanning. `_tracked` awaits the callback, so this is safe.
  scheduleDaily('nightly-rollup', '0 22 * * *', 22, 0, async () => {
    console.log('[Scheduler] Running nightly activity rollup...');
    try {
      require('./activity').runNightlyRollup();
    } catch (e) {
      console.error('[Scheduler] Activity rollup failed:', e.message);
    }
    // Meeting-action extraction. Embeddings (2am) and entity extraction (below)
    // both had nightly jobs; action extraction never did — it only ran from
    // vault-hooks.onVaultWrite(), which never fires for notes Syncthing delivers
    // from Obsidian. So nothing was ever proposed from Nick's own meeting notes.
    // Scoped to Meetings/ and review-only: nothing reaches Master Todo without
    // being approved from the suggestions queue.
    try {
      // Excludes 1-2-1s NOVA has already extracted — one LLM pass over a recording, not
      // two. Their actions come back over the bridge in the nightly write-back instead.
      const scan = await require('./action-candidates').scanRecentNotesExcludingNova({ days: 7, dryRun: false, scope: 'meetings', limit: 500 });
      console.log(`[Scheduler] Meeting actions: scanned ${scan.scanned}, created ${scan.created}, pending ${scan.pending}, superseded ${scan.superseded}` +
        (scan.novaOwned ? `, ${scan.novaOwned} left to NOVA` : ''));
      if (scan.pending > 0) {
        require('./webpush').sendToAll('SAiM — Actions to review',
          `${scan.pending} new action${scan.pending === 1 ? '' : 's'} from your meetings need a yes/no.`,
          { type: 'todo', url: '/todos' }).catch(() => {});
      }
    } catch (e) {
      console.error('[Scheduler] Meeting action scan failed:', e.message);
    }
    try {
      const result = require('./entities').processRecentNotes(7);
      console.log(`[Scheduler] Entity extraction: ${result.processed} notes processed`);
    } catch (e) {
      console.error('[Scheduler] Entity extraction failed:', e.message);
    }
    // Re-detect 1-2-1s from the meeting notes Syncthing delivered today and stamp
    // People frontmatter. Before this, `last-1-2-1` was hand-maintained and froze
    // in March while 1-2-1s carried on happening, so the Team board showed people
    // 100+ days overdue who had been seen in July.
    try {
      const sync = require('./one-to-one-detect').syncPeopleNotes({ apply: true });
      const updated = (sync.changes || []).filter(c => c.action === 'updated');
      if (updated.length) {
        console.log(`[Scheduler] 1-2-1 sync: ${updated.length} person note(s) updated — ` +
          updated.map(c => `${c.person} → ${c.to}`).join(', '));
      }
    } catch (e) {
      console.error('[Scheduler] 1-2-1 sync failed:', e.message);
    }
    // Then pull the 1-2-1s NOVA has RUN back into the same cards — actions agreed in
    // the click-through, plus `last-1-2-1` from its `completed_at`.
    //
    // Hung off the rollup rather than given its own cron for the same reason the tracker
    // hangs off syncPeopleNotes: both write `last-1-2-1`, from different evidence, and a
    // separate schedule only HOPES the detector has finished. Here the order is a fact.
    // It runs after the detector on purpose — a written-up note is the stronger claim.
    (async () => {
      try {
        const wb = await require('./nova-121-writeback').writeBack({ apply: true });
        if (!wb.ok) { console.warn(`[Scheduler] NOVA 1-2-1 write-back failed: ${wb.error}`); return; }
        if (wb.people.length || wb.failed.length || wb.skipped.length) {
          const actions = wb.people.reduce((n, p) => n + p.newActions, 0);
          console.log(`[Scheduler] NOVA 1-2-1 write-back: ${wb.people.length} card(s), ${actions} new action(s), ${wb.skipped.length} skipped, ${wb.failed.length} failed`);
          for (const s of wb.skipped) console.warn(`[Scheduler] 1-2-1 write-back skipped ${s.person}: ${s.reason}`);
          for (const f of wb.failed) console.warn(`[Scheduler] 1-2-1 write-back failed ${f.person}: ${f.error}`);
        }
      } catch (e) {
        console.warn('[Scheduler] NOVA 1-2-1 write-back threw:', e.message);
      }
    })();
    // People gap — nothing else in NEURO ever proposed a People note, so the
    // roster only grew when Nick typed one in and every consumer keyed off it
    // stayed capped. READ-ONLY: reports to Vault Audit, creation is an explicit
    // POST /api/people-gap/apply.
    try {
      const gap = require('./people-gap').runNightlyScan({ days: 90 });
      if (gap.status === 'ok') {
        const fresh = gap.newCandidates || [];
        console.log(`[Scheduler] People gap: ${gap.candidates.length} candidates (${fresh.length} new), ${gap.belowThreshold.length} seen once`);
        // ⚠ ONLY WHEN SOMEBODY NEW TURNS UP. It used to fire on the whole list,
        // so four names Nick had deliberately left alone interrupted him every
        // night — and a notification that is always there is one nobody reads,
        // which costs the night a genuinely new colleague appears. The list
        // itself lives on the People page now; the push is only ever news.
        if (fresh.length > 0) {
          const names = fresh.slice(0, 3).map(c => c.name).join(', ');
          require('./webpush').sendToAll('SAiM — People notes',
            `${names}${fresh.length > 3 ? ` and ${fresh.length - 3} more` : ''} — no People note yet. Review on the People page.`,
            { type: 'vault_hygiene', url: '/people' }).catch(() => {});
        }
      }
    } catch (e) {
      console.error('[Scheduler] People gap scan failed:', e.message);
    }
    // Write working memory observations to daily note
    try {
      require('./working-memory').writeObservationsToDaily();
    } catch (e) {
      console.error('[Scheduler] Observation write failed:', e.message);
    }
    // Record today's location dwells to history
    try {
      require('./location-history').recordTodaysDwells();
    } catch (e) {
      console.error('[Scheduler] Location recording failed:', e.message);
    }
  });

  // (The */10 capture drain is a DURABLE job since Build 4 — see registerDurableJobs().)

  // Every 10 minutes — release any task block whose outcome note has been
  // written. This is the mechanism, not a backstop: Nick writes the note in
  // Obsidian and nothing in that act touches NEURO, and vault-hooks deliberately
  // do not fire for Syncthing-delivered files (the same reason one-to-one-detect
  // runs on a TTL). Without the sweep, a task written up this morning stays held
  // until something else happens to look.
  //
  // Deliberately NOT a scheduleDaily/TRACKED_JOBS job: the sweep reads current
  // state and is idempotent, so a missed run self-corrects on the next one and
  // there is nothing to replay — the same call bank-holidays and wins made.
  cron.schedule('*/10 * * * *', () => {
    try {
      const result = require('./task-blocks').sweep();
      // A gap is logged even when nothing completed. A sweep reporting zero
      // because the vault was unreachable is precisely the silent failure this
      // feature exists to stop, so it must not look like a quiet success.
      if (result.gaps.length) {
        console.warn(`[Scheduler] Task block sweep gaps: ${result.gaps.join('; ')}`);
      }
    } catch (e) {
      console.error('[Scheduler] Task block sweep failed:', e.message);
    }
  });

  // Who is off, from NOVA's People HR sync. Every 30 minutes and once shortly
  // after boot, because `nudgeSuppression()` is synchronous and reads only the
  // cache — nothing on the nudge path may wait on NOVA.
  //
  // Deliberately NOT a TRACKED_JOBS/catch-up job: it overwrites a cache from a
  // trailing window, so a missed run self-corrects on the next one and there is
  // nothing to replay — the same call bank-holidays and wins made. A failed
  // refresh keeps the previous copy rather than emptying it.
  const refreshAvailability = (why) => {
    require('./team-availability').refresh()
      .then(r => { if (!r.ok) console.warn(`[Scheduler] Availability refresh (${why}) failed`); })
      .catch(e => console.error(`[Scheduler] Availability refresh (${why}) error:`, e.message));
  };
  setTimeout(() => refreshAvailability('startup'), 20000);
  cron.schedule('*/30 * * * *', () => refreshAvailability('cron'));

  // ── The half-day planner ───────────────────────────────────────────────────
  //
  // 07:15 plans the morning, 12:30 plans the afternoon, and both CREATE the
  // blocks rather than proposing them (Nick's call, 27 Aug). The half-day
  // horizon is the point: his diary moves under him, so an afternoon planned at
  // dawn is planned against a calendar that no longer exists by lunchtime.
  //
  // Both are no-ops unless DAY_PLANNER_ENABLED=true, and `run()` takes its own
  // lock — these two can overlap a manual apply from the route, which is the
  // case that turned 27 Plaud blocks into 52 real calendar events.
  //
  // Deliberately NOT a TRACKED_JOBS/catch-up job. Catch-up exists to replay a
  // missed slot, and replaying this one is exactly wrong: a morning plan fired
  // at 14:00 because the Pi was rebooting would block time that has already
  // gone. A missed half-day should stay missed.
  const planHalf = (windowKey) => async () => {
    try {
      const result = await require('./day-planner').run(windowKey, { apply: true });
      if (result.skipped) {
        console.log(`[Scheduler] Day plan (${windowKey}) skipped: ${result.skipped}`);
      } else if (result.created?.length) {
        console.log(`[Scheduler] Day plan (${windowKey}): ${result.created.length} block(s) created`);
      } else {
        console.log(`[Scheduler] Day plan (${windowKey}): nothing blocked — ${result.reason || result.error || 'no reason given'}`);
      }
      if (result.failed?.length) {
        console.warn(`[Scheduler] Day plan (${windowKey}) had ${result.failed.length} failure(s): `
          + result.failed.map(f => `${f.startTime} ${f.error}`).join('; '));
      }
    } catch (e) {
      console.error(`[Scheduler] Day plan (${windowKey}) failed:`, e.message);
    }
  };
  cron.schedule('15 7 * * 1-5', planHalf('morning'));
  cron.schedule('30 12 * * 1-5', planHalf('afternoon'));

  // Hourly — regenerate the read-only task export note. Writes already trigger an
  // export; this is the belt-and-braces pass so the "last exported" stamp in the vault
  // stays current, which is what tells Nick whether the offline copy can be trusted.
  cron.schedule('20 * * * *', () => {
    try {
      require('./task-export').writeExport();
    } catch (e) {
      console.error('[Scheduler] Task export failed:', e.message);
    }
  });

  // Record location dwells every 30 min during active hours (9am-9pm)
  cron.schedule('*/30 9-21 * * *', () => {
    try {
      require('./location-history').recordTodaysDwells();
    } catch {}
  });

  // Evening journal nudge — time configurable via agent_state 'journal_nudge_time' (default '21:00')
  // Pre-warm fires 5 minutes before the configured journal time
  cron.schedule('* 20-22 * * *', () => {
    try {
      const db = require('../db/database');
      const configuredTime = db.getState('journal_nudge_time') || '21:00';
      const [targetHour, targetMin] = configuredTime.split(':').map(Number);
      const now = new Date();

      // Pre-warm journal prompts 5 min before nudge
      let preWarmHour = targetHour, preWarmMin = targetMin - 5;
      if (preWarmMin < 0) { preWarmMin += 60; preWarmHour -= 1; }
      if (now.getHours() === preWarmHour && now.getMinutes() === preWarmMin) {
        console.log('[Scheduler] Pre-warming journal prompts');
        try {
          const journalRouter = require('../routes/journal');
          if (journalRouter.preWarmJournal) journalRouter.preWarmJournal();
        } catch (e) { console.error('[Scheduler] Journal pre-warm error:', e.message); }
      }

      if (now.getHours() === targetHour && now.getMinutes() === targetMin) {
        nudges.triggerJournalNudge();
      }
    } catch (e) {
      console.error('[Scheduler] Journal nudge check failed:', e.message);
    }
  });

  // 2am nightly — rebuild vault embeddings for changed files
  scheduleDaily('embeddings-rebuild', '0 2 * * *', 2, 0, () => {
    console.log('[Scheduler] Rebuilding vault embeddings...');
    try {
      // Returned, not fire-and-forget, so the run is stamped on COMPLETION.
      // A full re-index is hours on Voyage's free tier; if the backend restarts
      // part-way there is no stamp, catch-up re-triggers it, and it resumes from
      // the content hashes rather than starting over.
      return require('./embeddings').rebuildEmbeddings().catch(e => {
        console.error('[Scheduler] Embedding rebuild failed:', e.message);
      });
    } catch (e) {
      console.error('[Scheduler] Failed to start embedding rebuild:', e.message);
    }
  });

  // Hourly imports sweep — classify and auto-route pending imports
  cron.schedule('30 * * * *', () => {
    console.log('[Scheduler] Running hourly imports sweep...');
    imports.autoClassify().catch(e => {
      console.error('[Scheduler] Imports sweep failed:', e.message);
    });
  });

  // 6:10pm daily — write a human-readable import activity report into the vault
  cron.schedule('10 18 * * *', () => {
    try {
      require('./knowledge-memory').writeDailyImportReport();
    } catch (e) {
      console.error('[Scheduler] Daily import report failed:', e.message);
    }
  });

  // ── Semantic index coverage ──────────────────────────────────────────────
  // Measured, not assumed. `getCoverage()` is what the search path reads to
  // decide whether "the index answered" also means "the index holds your
  // vault", and it is a cheap KV read precisely because this pass does the
  // walking. Durable, so `known:false` is only ever seen on a brand-new install.
  //
  // Deliberately NOT a TRACKED_JOBS catch-up job: it is idempotent, reads live
  // state every time, and a missed run self-corrects on the next one.
  setTimeout(() => {
    try {
      const cov = require('./embeddings').refreshCoverage();
      if (cov.known && !cov.complete) {
        console.warn(`[Embeddings] Coverage INCOMPLETE at startup — ${cov.reasons.join('; ')}`);
      } else if (cov.known) {
        console.log(`[Embeddings] Coverage OK — ${cov.indexed}/${cov.eligible} notes indexed`);
      }
    } catch (e) { console.error('[Scheduler] Coverage refresh failed:', e.message); }
  }, 25000);

  cron.schedule('35 * * * *', () => {
    try { require('./embeddings').refreshCoverage(); }
    catch (e) { console.error('[Scheduler] Coverage refresh failed:', e.message); }
  });

  // ── Trusted knowledge ────────────────────────────────────────────────────
  // The lookup set the chat path reads (`scope: 'trusted'` in retrieval), plus the
  // generated index Nick reads in Obsidian. Rebuilt from the VAULT, because the
  // truth is a frontmatter line he can type by hand — the vault-hooks patch
  // catches that promptly and this is what guarantees it.
  //
  // ⚠ A PARTIAL WALK IS NEVER STORED and never renders (see knowledge-trust):
  // a half-read vault written over a good set silently un-trusts whatever it
  // could not reach, and an un-trusted note looks exactly like one Nick never
  // marked.
  //
  // Deliberately NOT a TRACKED_JOBS catch-up job — idempotent, reads live state,
  // and a missed run self-corrects on the next one.
  const refreshTrustedKnowledge = (when) => {
    try {
      const knowledgeTrust = require('./knowledge-trust');
      const refreshed = knowledgeTrust.refreshTrust();
      if (!refreshed.known) {
        console.warn(`[Knowledge] Trust set NOT refreshed (${when}) — ${(refreshed.reasons || []).join('; ')}`);
        return;
      }
      if (refreshed.changed) {
        const index = knowledgeTrust.renderIndex({ apply: true });
        console.log(`[Knowledge] ${refreshed.count} trusted note(s) (${when}); index ${index.changed ? 'rewritten' : 'unchanged'}`);
      }
      try { require('./knowledge-candidates').invalidate(); } catch { /* cache only */ }
    } catch (e) { console.error('[Scheduler] Trusted-knowledge refresh failed:', e.message); }
  };

  setTimeout(() => refreshTrustedKnowledge('startup'), 30000);
  cron.schedule('40 * * * *', () => refreshTrustedKnowledge('hourly'));

  // Startup health check — verify capture system is working
  setTimeout(() => {
    const fs = require('fs');
    const path = require('path');
    const vaultPath = process.env.OBSIDIAN_VAULT_PATH || '';
    const importsDir = path.join(vaultPath, 'Imports');
    const issues = [];
    if (!vaultPath) issues.push('OBSIDIAN_VAULT_PATH not set');
    else if (!fs.existsSync(vaultPath)) issues.push('Vault path does not exist');
    if (!fs.existsSync(importsDir)) issues.push('Imports/ directory missing');
    else {
      try {
        const testFile = path.join(importsDir, '.neuro-health-check');
        fs.writeFileSync(testFile, 'ok');
        fs.unlinkSync(testFile);
      } catch (e) { issues.push('Imports/ not writable: ' + e.message); }
    }
    if (issues.length > 0) {
      console.error('[Health] Capture system BROKEN:', issues.join(', '));
      try {
        require('./webpush').sendToAll(
          'SAiM — System alert',
          `Capture is broken: ${issues.join(', ')}. Notes will not save.`,
          { type: 'system_alert' }
        ).catch(() => {});
      } catch {}
    } else {
      console.log('[Health] Capture system OK — vault writable');
    }
  }, 15000);

  // ── Agent Loop — Phase 6A ──
  // Every 10 minutes during work hours: evaluate state, run safe auto-actions, pre-compute next action
  cron.schedule('*/10 8-18 * * 1-5', () => {
    const agentLoop = require('./agent-loop');
    agentLoop.runCycle().catch(e => {
      console.error('[Scheduler] Agent loop failed:', e.message);
    });
  });

  // Startup agent loop — run 45s after start to let other services init first
  setTimeout(() => {
    const agentLoop = require('./agent-loop');
    agentLoop.runCycle().catch(e => {
      console.error('[Scheduler] Startup agent loop failed:', e.message);
    });
  }, 45000);

  // Startup embedding check — rebuild 2 min after start
  setTimeout(() => {
    console.log('[Scheduler] Startup embedding check...');
    require('./embeddings').rebuildEmbeddings().catch(e => {
      console.error('[Scheduler] Startup embedding failed:', e.message);
    });
  }, 2 * 60 * 1000);

  // Startup sweep — classify pending imports after 60s delay
  setTimeout(() => {
    const pending = imports.getPending().filter(f => f.status !== 'needs-review');
    if (pending.length > 0) {
      console.log(`[Scheduler] ${pending.length} pending imports — running startup sweep...`);
      imports.autoClassify().catch(e => {
        console.error('[Scheduler] Startup imports sweep failed:', e.message);
      });
    }
  }, 60 * 1000);

  // Startup consolidation + operating model doc — after intake has settled
  setTimeout(() => {
    require('./knowledge-memory').ensureVaultOperatingModelDoc();
    require('./knowledge-memory').consolidateAllImports({ limit: 30 }).catch((e) => {
      console.error('[Scheduler] Startup import consolidation failed:', e.message);
    });
  }, 90 * 1000);

  // Every 15 minutes 8am-6pm — sync Plaud via official MCP.
  // 15 rather than 30 because of the speaker-naming hold: a recording held waiting
  // for PLAUD to name its voices is re-checked on this tick, and the hold is bounded
  // at an hour, so a 30-minute tick would give it only two chances to catch the
  // names. A tick with nothing pending costs ONE list_files call — already-synced
  // recordings are skipped before any per-recording fetch.
  cron.schedule('*/15 8-18 * * *', () => {
    console.log('[Scheduler] Syncing Plaud via MCP...');
    require('./plaud-sync').syncPlaudRecordings({ incremental: true }).catch(e => {
      console.error('[Scheduler] Plaud MCP sync failed:', e.message);
    });
  });

  // Startup Plaud sync — after 45s delay
  setTimeout(() => {
    console.log('[Scheduler] Startup Plaud MCP sync...');
    require('./plaud-sync').syncPlaudRecordings({ incremental: true }).catch(e => {
      console.error('[Scheduler] Startup Plaud MCP sync failed:', e.message);
    });
  }, 45 * 1000);

  // (The 15,45 8-18 Mon-Fri Microsoft Tasks sync is a DURABLE job since Build 4
  // — see registerDurableJobs(). The 23 Sep note about node-cron dropping its
  // ticks is why: recovery fixed the late timer, not the restart.)

  // Startup MS Tasks sync — 30s after start
  setTimeout(() => {
    console.log('[Scheduler] Startup MS Tasks sync...');
    require('./obsidian').syncMicrosoftTasks().catch(e => {
      console.error('[Scheduler] Startup MS Tasks sync failed:', e.message);
    });
  }, 30 * 1000);

  // Retry completions Microsoft would not take. Every 10 minutes, ALL the time
  // rather than in work hours — the thing being waited on is Graph auth coming
  // back, and that is fixed whenever Nick happens to reconnect 365.
  //
  // Deliberately NOT a TRACKED_JOBS catch-up job: the queue is durable and each
  // pass reads live state, so a missed run self-corrects on the next one and
  // there is nothing to replay. The `wins` and `bank-holidays` call.
  //
  // ⚠ Runs BEFORE the mirror sync on the shared 15/45 minutes purely by being
  // registered here; order does not matter, because a completion that lands
  // mid-sync is simply picked up by the next one. What matters is that both read
  // the same queue.
  cron.schedule('*/10 * * * *', () => {
    require('./ms-push-queue').drain()
      .then(r => {
        if (r.attempted) {
          console.log(`[Scheduler] MS push queue: ${r.completed} completed, ${r.stillPending} still held, ${r.failed} given up`);
        }
      })
      .catch(e => console.error('[Scheduler] MS push queue drain failed:', e.message));
  });

  // Escalation queue watcher — check every 5 minutes during work hours
  cron.schedule('*/5 8-18 * * 1-5', () => {
    jira.syncEscalations().catch(e => {
      console.error('[Scheduler] Escalation sync failed:', e.message);
    });
  });

  // Startup escalation check — after 30s delay
  setTimeout(() => {
    jira.syncEscalations().catch(e => {
      console.error('[Scheduler] Startup escalation sync failed:', e.message);
    });
  }, 30000);

  // Email triage — every 30 minutes, 8am-6pm weekdays (26 Aug 2026).
  //
  // Was 8am/12pm/5pm, which left a 5-hour hole in the afternoon and a 15-hour
  // one overnight; in practice the only reason it felt fresher than that is
  // that the backend restarts several times a day. Measured before changing
  // it: 120ms of CPU and ~2,250 tokens per run, 6.9s of it waiting on Graph
  // and OpenRouter. CPU was never the constraint — the shared daily cloud
  // budget is, which is why `runTriage` skips the model call when the mail is
  // unchanged. Deliberately NOT overnight: mail arriving at 3am is not worth a
  // token, and the 8am run covers it.
  cron.schedule('*/30 8-18 * * 1-5', () => {
    require('./email-triage').runTriage().catch(e => {
      console.error('[Scheduler] Email triage failed:', e.message);
    });
  });

  // Startup triage after 60s
  setTimeout(() => {
    require('./email-triage').runTriage().catch(() => {});
  }, 60000);

  // Jira tickets assigned to Nick — hourly on the half hour, weekdays.
  //
  // Two jobs in one pass: new assignments become tasks, and a task whose ticket
  // has been resolved is closed. The second is why the cadence matters at all —
  // a task Jira has already finished with, still sitting in the list Nick uses
  // to decide what to do next, is the failure this feature would otherwise
  // introduce. Hourly rather than every 30 minutes: it is two cheap JQL reads,
  // but nothing here is time-critical and a ticket resolved at 14:05 does not
  // need to leave his list at 14:06.
  //
  // Deliberately NOT a TRACKED_JOBS catch-up job: it compares live state on
  // every pass, so a missed run self-corrects on the next one and there is
  // nothing to replay. Off unless JIRA_ASSIGNED_SYNC_ENABLED — the sync itself
  // checks, so the schedule is registered either way and the switch needs no
  // restart to be read.
  cron.schedule('30 8-18 * * 1-5', () => {
    require('./jira-tasks').sync({ apply: true }).catch(e => {
      console.error('[Scheduler] Jira assigned-task sync failed:', e.message);
    });
  });

  // (The */20 calendar sync is a DURABLE job — see registerDurableJobs().)

  // Startup sync — 20s in, so the cache is warm before the first agent loop.
  setTimeout(() => {
    require('./calendar-sync').sync({ days: 14 }).catch(e =>
      console.error('[Scheduler] Startup calendar sync failed:', e.message));
  }, 20 * 1000);

  // The nervous system (Build 1): durable event consumers. Hosted here rather
  // than in a process of its own — the bus pumps on publish, and its interval
  // is the recovery path that resumes consumers after a restart and retries
  // failures once their back-off has passed. Never allowed to stop startup.
  try {
    require('./event-bus').start();
  } catch (e) { console.error('[Scheduler] Event bus failed to start:', e.message); }

  // (The */5 source-staleness check is a DURABLE job — see registerDurableJobs().)

  // Build 13G: Home Assistant presence onto the event spine, every 2 minutes.
  // Deliberately NOT durable: a missed poll is corrected by the next one, and
  // a slot row every 2 minutes is 720 rows a day for nothing.
  cron.schedule('*/2 * * * *', () => {
    require('./ha-presence').poll().catch((e) => console.warn('[HaPresence] poll failed:', e.message));
  });

  // 8:20am weekdays — safety net, not the main path. Invites are caught on
  // arrival: the calendar sync reports which events are new and checks those
  // immediately, and email triage triggers a sync because an invite arrives as
  // an email. This sweep exists for what slipped through — a failed sync, a
  // restart mid-delivery, a meeting whose body was filled in after it was sent.
  cron.schedule('20 8 * * 1-5', async () => {
    try {
      const result = await require('./meeting-triage').scanUpcoming({ days: 7 });
      if (result.queued > 0) {
        console.log(`[Scheduler] Agenda chasers queued: ${result.queued}`);
      }
    } catch (e) { console.error('[Scheduler] Agenda check failed:', e.message); }
  });

  // Meeting prep push — check every 5 minutes 8am-6pm weekdays
  cron.schedule('*/5 8-18 * * 1-5', async () => {
    try {
      await require('./meeting-prep').checkUpcomingMeetings();
    } catch (e) {
      console.error('[Scheduler] Meeting prep check failed:', e.message);
    }
  });

  // ── Proactive briefings ──────────────────────────────────────────────────

  // 9am Mon-Fri — morning brief
  cron.schedule('0 9 * * 1-5', async () => {
    console.log('[Scheduler] 9am — morning brief');
    try {
      await require('./briefing').buildAndDeliver({ label: 'morning' });
    } catch (e) { console.error('[Scheduler] Morning brief failed:', e.message); }
  });

  // 1pm Mon-Fri — midday brief
  cron.schedule('0 13 * * 1-5', async () => {
    console.log('[Scheduler] 1pm — midday brief');
    try {
      await require('./briefing').buildAndDeliver({ label: 'midday' });
    } catch (e) { console.error('[Scheduler] Midday brief failed:', e.message); }
  });

  // Every 5 min 8am-6pm weekdays — alert checks (escalations, Teams mentions, meetings)
  cron.schedule('*/5 8-18 * * 1-5', async () => {
    try {
      await require('./briefing').runAlertChecks();
    } catch (e) { console.error('[Scheduler] Alert checks failed:', e.message); }
  });

  console.log('[Scheduler] Started — pre-warm 8:55am, standup 9am, 1-2-1 9:10am, nag 15m, EOD pre-warm 4:55pm, EOD 5pm, weekly review Fri 4:30pm, knowledge reflection Mon 8:10am, import consolidation hourly, import report 18:10, plan milestone 9:05am, escalations 5m, email triage 8/12/17, meeting prep 5m, Plaud MCP 15m, MS Tasks 30m');

  // Last, so every tracked job is registered. Staggered — several of these walk
  // the whole vault, and a deploy should not cost a load spike on a Pi that is
  // also serving Focus and chat.
  runCatchUp();

  // The durable runtime (Build 3A). Never allowed to stop startup.
  try {
    registerDurableJobs();
    // External weather (EA rain gauge, WU) registers its own jobs, kept out of
    // registerDurableJobs() so runtime tests that register it make no network calls.
    require('./weather-jobs').register();
    require('./runtime-jobs').start();
  } catch (e) { console.error('[Scheduler] Durable runtime failed to start:', e.message); }
}

/**
 * The jobs whose runs must not silently disappear. Each slot is a row in
 * runtime_job_runs before it runs (services/runtime-jobs.js); a missed timer, a
 * busy loop or a restart leaves the row pending and the next tick runs it.
 *
 * The policies are per job and deliberately different — see the Build 3 vault
 * note for the full audit:
 *
 *   calendar-sync      replace-by-window and idempotent, so a late run is
 *                      exactly as good as an on-time one: newest slot only,
 *                      never too late, one retry two minutes on (the stale
 *                      threshold is 60 min and the cadence 20, so a single
 *                      failure must not cost a whole period).
 *   source-staleness   judges the projection against NOW, so only the newest
 *                      slot is worth running and it is never too late; the
 *                      verdict is recorded with the time it was made.
 *   ambient-pass       a judgement about THIS moment. Late by minutes it still
 *                      reads the moment correctly (deliver() uses the real
 *                      clock), but a pass due 40 minutes ago is a different
 *                      decision from the one that was due — skipped as stale
 *                      past 15 minutes, never retried, never replayed.
 */
function registerDurableJobs() {
  const runtime = require('./runtime-jobs');

  runtime.defineJob({
    name: 'calendar-sync',
    cron: '*/20 * * * *',
    class: 'correctness-critical',
    catchUp: 'latest',
    maxLagMs: null,
    maxAttempts: 2,
    backoffMs: [2 * 60 * 1000],
    timeoutMs: 5 * 60 * 1000,
    why: 'Focus, meeting alerts, life-state and the world model read calendar_cache; source health calls it stale after 60 min.',
    run: async () => {
      const r = await require('./calendar-sync').sync({ days: 14 });
      // calendar-sync reports failure as a value, not a throw (its callers
      // must never crash). Here a failure must count as one, or it is never
      // retried — so a zero-event result WITH a reason is raised.
      if (r && !r.synced && r.reason) throw new Error(`calendar sync did not refresh the cache: ${r.reason}`);
      return { synced: r ? r.synced : null, newEvents: r && r.newEventIds ? r.newEventIds.length : 0 };
    },
  });

  runtime.defineJob({
    name: 'source-staleness',
    cron: '*/5 * * * *',
    class: 'correctness-critical',
    catchUp: 'latest',
    maxLagMs: null,
    maxAttempts: 2,
    backoffMs: [30 * 1000],
    timeoutMs: 2 * 60 * 1000,
    why: 'Source health and source-blindness only learn a source has gone stale from the event this check records.',
    run: async () => {
      // Build 1: has any source's last success gone stale? Recorded as an event
      // so the projection can be rebuilt from the log without re-judging it.
      const stale = await require('./source-health').checkStaleness();
      // Build 2B: expected sources NEURO has never heard from.
      const neverSeen = await require('./source-blindness').checkExpected();
      return { stale, neverSeen };
    },
  });

  runtime.defineJob({
    name: 'world-people-sync',
    cron: '7 * * * *',
    class: 'best-effort',
    catchUp: 'latest',
    maxLagMs: null,
    maxAttempts: 1,
    timeoutMs: 2 * 60 * 1000,
    why: 'Build 3C: People notes into the world model. Build 11E/F: also pet notes (Ember) and Nick\'s declared goals. Idempotent (content-keyed), so only the newest slot matters.',
    run: async () => {
      const r = require('./world-sources').publishPeople();
      if (r.error) throw new Error(r.error);
      // The personal entities ride the same pass. Their failure is reported in
      // the result, never allowed to fail the People sync that already landed.
      const pw = require('./personal-world');
      r.companions = pw.publishCompanions();
      r.goals = pw.publishGoals();
      return r;
    },
  });

  runtime.defineJob({
    name: 'source-blind-investigation',
    cron: '2-59/5 * * * *',
    class: 'best-effort',
    catchUp: 'latest',
    maxLagMs: 10 * 60 * 1000,
    maxAttempts: 1,
    timeoutMs: 60 * 1000,
    why: 'Build 14H: a LIVE source-blind finding gets one bounded investigation (fixed probes, fixed hypotheses, counted confidence); recovery closes it. It prepares recommendations and never executes or notifies.',
    run: async () => require('./investigations').runSourceBlindInvestigations(),
  });

  runtime.defineJob({
    name: 'source-degradation-investigation',
    cron: '17,47 * * * *',
    class: 'best-effort',
    catchUp: 'latest',
    maxLagMs: 30 * 60 * 1000,
    maxAttempts: 1,
    timeoutMs: 60 * 1000,
    why: 'Build 17E: an expected source that keeps dropping out and recovering (3 counted episodes, the last 3 within 7 days — chosen by replay) gets ONE bounded investigation per cluster. IGNORE | MONITOR | PREPARE a manual step; never executes, never notifies.',
    run: async () => require('./degradation-investigations').run(),
  });

  runtime.defineJob({
    name: 'selftest-sync',
    cron: '11 * * * *',
    class: 'best-effort',
    catchUp: 'latest',
    maxLagMs: null,
    maxAttempts: 1,
    timeoutMs: 30 * 1000,
    why: 'Build 15L: the canary source neuro.selftest. Hourly; it only ever fails when a script on the Pi arms its fault, which is how self-healing is proven without breaking a real sense.',
    run: async () => require('./selftest-source').sync(),
  });

  runtime.defineJob({
    name: 'personal-loops',
    cron: '23,53 * * * *',
    class: 'best-effort',
    catchUp: 'latest',
    maxLagMs: null,
    maxAttempts: 1,
    timeoutMs: 60 * 1000,
    why: 'Build 15S: the "hike weekly" loop records what CHANGED (a plan appearing, the week done, the week uncertain, a prompt prepared) for Activity. Idempotent; nothing is sent.',
    run: async () => require('./hiking-loop').refresh(),
  });

  runtime.defineJob({
    name: 'personal-dates',
    cron: '8,38 * * * *',
    class: 'best-effort',
    catchUp: 'latest',
    maxLagMs: null,
    maxAttempts: 1,
    timeoutMs: 60 * 1000,
    why: 'Build 17L: birthdays and anniversaries NEURO is explicitly told about. Records prep linked/completed and the action window once each, and asks the attention policy (shadow) only when linked prep is still open ≤2 days out. Never creates a task, never sends.',
    run: async () => require('./personal-dates').refresh(),
  });

  runtime.defineJob({
    name: 'personal-ops',
    cron: '13,43 * * * *',
    class: 'best-effort',
    catchUp: 'latest',
    maxLagMs: null,
    maxAttempts: 1,
    timeoutMs: 60 * 1000,
    why: 'Build 19W: records what CHANGED in personal operations for Activity — a personal obligation opened or completed, a Future Radar item that started needing Nick. The first run is a baseline. Never creates a task. The ONLY send is a date nag Nick set himself (date-nags: e.g. his anniversary at 10/5/1 days out), once per offset, from 09:00.',
    run: async () => {
      const radar = require('./future-radar').refresh();
      let nags = null;
      try { nags = await require('./date-nags').run(); } catch (e) { nags = { ok: false, error: e.message }; }
      return { ...radar, nags };
    },
  });

  runtime.defineJob({
    name: 'personal-deadline',
    cron: '*/15 * * * *',
    class: 'freshness-sensitive',
    catchUp: 'latest',
    maxLagMs: 15 * 60 * 1000,
    maxAttempts: 1,
    timeoutMs: 2 * 60 * 1000,
    why: 'Build 11H: the first non-work evaluator — a personal deadline (explicitly dated, evidenced non-work) about to matter and still open. SHADOW — findings and recorded verdicts only, nothing is ever sent.',
    run: async () => {
      const r = await require('./personal-deadline').evaluate();
      return { mode: r.mode, considered: r.considered, created: r.created, escalated: r.escalated, updated: r.updated,
        resolved: r.resolved, decided: r.decided, excluded: r.excluded };
    },
  });

  // Build 5A: the meeting-context job is SUPERSEDED by meeting-intelligence —
  // one finding per meeting that carries meeting-context's evidence AND the
  // meeting-only commitment risk, asked about once. meeting-context.evaluate is
  // no longer scheduled (its gatherer is what this runs); running both would be
  // the two shadow findings per meeting this build removes.
  runtime.defineJob({
    name: 'meeting-intelligence',
    cron: '*/5 * * * *',
    class: 'freshness-sensitive',
    catchUp: 'latest',
    maxLagMs: 10 * 60 * 1000,
    maxAttempts: 1,
    timeoutMs: 2 * 60 * 1000,
    why: 'Build 5A: one semantic finding per upcoming real meeting (prior actions, items owed, linked commitment risk, related urgent email, progress). SHADOW — recorded verdicts only, nothing is ever sent.',
    run: async () => {
      const r = await require('./meeting-intelligence').evaluate();
      return { mode: r.mode, considered: r.considered, created: r.created, updated: r.updated,
        withdrawn: r.withdrawn, expired: r.expired, decided: r.decided, compared: r.compared };
    },
  });

  // ── Build 4 ───────────────────────────────────────────────────────────────
  //
  // Migrated because a silently missed run changes what NEURO believes about
  // obligations or attention, not for consistency:
  //   ms-tasks-sync   Microsoft completions/new cards reach the world model and
  //                   the vault mirror only through this. 23 Sep: seven ticks
  //                   lost in one afternoon on node-cron.
  //   capture-drain   a capture waiting in Tasks/Capture.md is a commitment
  //                   NEURO does not know about yet.
  // NOT migrated: escalations. jira.startPolling() already runs syncEscalations
  // on a 5-minute setInterval, all day — a late interval runs late, it is never
  // dropped, so node-cron's failure cannot reach it (the cron entry is a second
  // caller of the same idempotent sync).
  // NOT migrated: the weekly risk report. It already has restart catch-up across
  // the whole week (scheduleWeekly), its state-of-play freshness reads that
  // stamp, and the durable runtime's 24h lookback would make a weekend outage
  // WORSE (a gap record instead of a Monday-afternoon build).
  runtime.defineJob({
    name: 'ms-tasks-sync',
    cron: '15,45 8-18 * * 1-5',
    class: 'freshness-sensitive',
    catchUp: 'latest',
    maxLagMs: null,
    maxAttempts: 2,
    backoffMs: [2 * 60 * 1000],
    timeoutMs: 5 * 60 * 1000,
    why: 'Planner/To Do into the vault mirror and the world model. Replace-by-fetch: a late run is as good as an on-time one.',
    run: async () => {
      const r = await require('./obsidian').syncMicrosoftTasks();
      // 'refusing-to-empty' is a correct decision, not a failure; Graph not
      // answering IS one, and must be visible (and retried once).
      if (r && r.ok === false && r.reason === 'graph-unavailable') throw new Error('Graph did not answer (auth expired?) — mirror kept as it was');
      return r;
    },
  });

  runtime.defineJob({
    name: 'capture-drain',
    cron: '*/10 * * * *',
    class: 'correctness-critical',
    catchUp: 'latest',
    maxLagMs: null,
    maxAttempts: 1,
    timeoutMs: 60 * 1000,
    why: 'Tasks/Capture.md into the task store. Idempotent; only the newest slot matters.',
    run: async () => {
      const result = require('./task-capture-drain').drainCaptureFile();
      if (result && (result.created || result.folded)) {
        console.log(`[Scheduler] Capture drained: ${result.created} new, ${result.folded} folded`);
      }
      return result;
    },
  });

  runtime.defineJob({
    name: 'world-obligations-sync',
    cron: '*/10 * * * *',
    class: 'best-effort',
    catchUp: 'latest',
    maxLagMs: null,
    maxAttempts: 1,
    timeoutMs: 2 * 60 * 1000,
    why: 'Build 4B: NEURO tasks and waiting-on into the world model. Content-keyed, so an unchanged store publishes nothing; the backstop behind the write hooks.',
    run: async () => {
      const r = require('./obligation-sources').reconcile();
      if (r.tasks && r.tasks.error) throw new Error(`tasks: ${r.tasks.error}`);
      if (r.waitingOn && r.waitingOn.error) throw new Error(`waiting-on: ${r.waitingOn.error}`);
      return r;
    },
  });

  runtime.defineJob({
    name: 'commitment-risk',
    cron: '*/15 * * * *',
    class: 'freshness-sensitive',
    catchUp: 'latest',
    maxLagMs: 15 * 60 * 1000,
    maxAttempts: 1,
    timeoutMs: 2 * 60 * 1000,
    why: 'Build 4D: which promises are about to matter and still look open? SHADOW — findings and recorded verdicts only, nothing is ever sent.',
    run: async () => {
      const r = await require('./commitment-risk').evaluate();
      return { mode: r.mode, considered: r.considered, created: r.created, escalated: r.escalated, updated: r.updated,
        resolved: r.resolved, held: r.held, decided: r.decided };
    },
  });

  runtime.defineJob({
    name: 'action-executor',
    cron: '*/2 * * * *',
    class: 'correctness-critical',
    catchUp: 'latest',
    maxAttempts: 1,
    timeoutMs: 3 * 60 * 1000,
    why: 'Build 6: the durable half of approval-gated execution. Expires stale approvals, recovers a send interrupted by a restart FROM THE LEDGER (verify, never resend), executes an approval whose trigger was missed, and verifies executed/uncertain sends against Sent Items. It never sends anything Nick has not approved.',
    run: async () => {
      const r = await require('./action-executor').reconcile();
      return { swept: r.swept, recovered: r.recovered.length, executed: r.executed.length, checked: r.checked,
        outcomes: r.verified.map((v) => v.outcome) };
    },
  });

  runtime.defineJob({
    name: 'ambient-pass',
    cron: '*/40 * * * *',
    class: 'freshness-sensitive',
    catchUp: 'latest',
    maxLagMs: 15 * 60 * 1000,
    maxAttempts: 1,
    timeoutMs: 3 * 60 * 1000,
    why: 'The one route by which SAiM comes to Nick unasked. Almost every pass decides to say nothing; the gates live in ambient-push.',
    run: async () => {
      // Every 40 minutes. ⚠ The CADENCE is not the frequency: almost every pass
      // refuses (unconfident read, meeting, Focus, driving, a session, a quiet
      // moment) and then sends AT MOST ONE through the governor and the
      // attention lifecycle. 40 rather than 30 so it does not beat in step with
      // the half-hourly syncs.
      const result = await require('./ambient-push').deliver();
      if (result.sent) console.log(`[Scheduler] Ambient push: ${result.chosen}`);
      return { sent: result.sent || 0, chosen: result.chosen || null, skipped: result.skipped || null,
        considered: Array.isArray(result.considered) ? result.considered.length : null };
    },
  });
}

module.exports = {
  start, runCatchUp, jobRunStatus, lastRunOf,
  scheduleDaily, scheduleWeekly, registerDurableJobs,
  // exported for tests
  isDailyDue, isWeeklyDue, _dateStr,
};
