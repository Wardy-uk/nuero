const cron = require('node-cron');
const nudges = require('./nudges');
const jira = require('./jira');
const imports = require('./imports');

function start() {
  // Fire nudges immediately if server starts after 9am on a weekday
  nudges.startupCheck();

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

  // Every 15 minutes between 9am-5pm weekdays — nag if not done
  cron.schedule('*/15 9-17 * * 1-5', () => {
    nudges.nagCheck();
  });

  // Daily at 9:05am — check plan milestone (75% reminder)
  cron.schedule('5 9 * * 1-5', () => {
    nudges.checkPlanMilestoneNudge();
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

  console.log('[Scheduler] Started — standup nudge at 9am, nag every 15m, plan milestone at 9:05am, Jira poll every 5m, imports sweep at 23:30');
}

module.exports = { start };
