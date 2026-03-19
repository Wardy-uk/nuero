const cron = require('node-cron');
const jira = require('./jira');
const nudges = require('./nudges');
const inboxScanner = require('./inbox-scanner');

function start() {
  // Jira polling disabled — EPIPE errors on Pi crash the event loop
  // TODO: re-enable once root cause is fixed (likely Pi network/TLS issue)
  // setTimeout(() => {
  //   jira.fetchAndCacheTickets().catch(err => {
  //     console.error('[Scheduler] Initial Jira fetch failed (non-fatal):', err.message);
  //   });
  // }, 10000);

  // Fire nudges immediately if server starts after 9am on a weekday
  nudges.startupCheck();

  // Inbox scanner disabled until Microsoft auth is configured
  // inboxScanner.start();

  // Jira polling disabled — EPIPE errors on Pi crash the event loop
  // cron.schedule('*/5 * * * *', () => {
  //   console.log('[Scheduler] Running Jira poll...');
  //   jira.fetchAndCacheTickets().catch(err => {
  //     console.error('[Scheduler] Jira poll failed (non-fatal):', err.message);
  //   });
  // });

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
