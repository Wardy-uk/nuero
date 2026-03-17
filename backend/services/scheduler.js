const cron = require('node-cron');
const jira = require('./jira');
const nudges = require('./nudges');

function start() {
  // Fetch Jira tickets on startup
  jira.fetchAndCacheTickets();

  // Fire nudges immediately if server starts after 9am on a weekday
  nudges.startupCheck();

  // Poll Jira every 5 minutes
  cron.schedule('*/5 * * * *', () => {
    console.log('[Scheduler] Running Jira poll...');
    jira.fetchAndCacheTickets();
  });

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

  console.log('[Scheduler] Started — Jira every 5m, standup nudge at 9am, nag every 15m');
}

module.exports = { start };
