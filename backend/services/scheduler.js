const cron = require('node-cron');
const nudges = require('./nudges');
const jira = require('./jira');

function start() {
  // Fire nudges immediately if server starts after 9am on a weekday
  nudges.startupCheck();

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

  console.log('[Scheduler] Started — standup nudge at 9am, nag every 15m, Jira poll every 5m');
}

module.exports = { start };
