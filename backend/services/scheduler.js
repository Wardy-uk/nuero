const cron = require('node-cron');
const nudges = require('./nudges');
const jira = require('./jira');
const imports = require('./imports');

function start() {
  // Fire nudges immediately if server starts after 9am on a weekday
  nudges.startupCheck();

  // Check 1-2-1s on startup too
  nudges.check121Nudges();

  // Check plan milestone on startup too (in case server was restarted on the milestone day)
  nudges.checkPlanMilestoneNudge();

  // Start Jira polling (fetches on startup + every 5 min)
  jira.startPolling();

  // 9am weekdays — trigger standup and todo nudges
  cron.schedule('0 9 * * 1-5', () => {
    console.log('[Scheduler] 9am — triggering standup + todo nudges');
    nudges.triggerStandupNudge();
    nudges.triggerTodoNudge();
  });

  // 9:10am weekdays — check 1-2-1 due dates
  cron.schedule('10 9 * * 1-5', () => { nudges.check121Nudges(); });

  // Every 15 minutes between 9am-5pm weekdays — nag if not done
  cron.schedule('*/15 9-17 * * 1-5', () => {
    nudges.nagCheck();
  });

  // Daily at 9:05am — check plan milestone (75% reminder)
  cron.schedule('5 9 * * 1-5', () => {
    nudges.checkPlanMilestoneNudge();
  });

  // 5pm weekdays — trigger EOD nudge
  cron.schedule('0 17 * * 1-5', () => {
    console.log('[Scheduler] 5pm — triggering EOD nudge');
    nudges.triggerEodNudge();
  });

  // Friday 4:30pm — generate weekly review
  cron.schedule('30 16 * * 5', () => {
    try {
      const obsidian = require('./obsidian');
      const result = obsidian.generateWeeklyReview();
      if (result && !result.skipped) {
        require('./webpush').sendToAll('NEURO — Weekly Review',
          `Your ${result.weekStr} review is ready in Reflections. Take 5 minutes to fill in wins, challenges, and how you're feeling.`,
          { type: 'weekly_review', url: '/vault' }).catch(() => {});
      }
    } catch (e) { console.error('[Scheduler] Weekly review failed:', e.message); }
  });

  // 10pm nightly — build daily activity summary
  cron.schedule('0 22 * * *', () => {
    console.log('[Scheduler] Running nightly activity rollup...');
    try {
      require('./activity').runNightlyRollup();
    } catch (e) {
      console.error('[Scheduler] Activity rollup failed:', e.message);
    }
  });

  // Every night at 23:30 — classify all pending imports
  cron.schedule('30 23 * * *', () => {
    console.log('[Scheduler] Running nightly imports sweep...');
    imports.autoClassify().catch(e => {
      console.error('[Scheduler] Imports sweep failed:', e.message);
    });
  });

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

  // Every 30 minutes 8am-6pm — sweep PLAUD folder specifically (time-sensitive imports)
  cron.schedule('*/30 8-18 * * *', () => {
    const importsService = require('./imports');
    const plaudPending = importsService.getPending().filter(f =>
      f.subdir === 'PLAUD' && f.status !== 'needs-review'
    );
    if (plaudPending.length > 0) {
      console.log(`[Scheduler] ${plaudPending.length} PLAUD imports pending — sweeping`);
      importsService.autoClassify().catch(e => {
        console.error('[Scheduler] PLAUD sweep failed:', e.message);
      });
    }
  });

  console.log('[Scheduler] Started — standup 9am, 1-2-1 9:10am, nag 15m, EOD 5pm, weekly review Fri 4:30pm, plan milestone 9:05am, Jira 5m, imports 23:30, PLAUD 30m');
}

module.exports = { start };
