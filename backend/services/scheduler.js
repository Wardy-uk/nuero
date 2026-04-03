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

  // 8:55am weekdays — pre-warm standup (loads Ollama model + generates Phase 1)
  cron.schedule('55 8 * * 1-5', () => {
    console.log('[Scheduler] 8:55am — pre-warming standup');
    try {
      const standupRouter = require('../routes/standup');
      if (standupRouter.preWarmStandup) standupRouter.preWarmStandup();
    } catch (e) { console.error('[Scheduler] Pre-warm error:', e.message); }
  });

  // 9am weekdays — trigger standup and todo nudges
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

  // 10pm nightly — build daily activity summary + entity extraction
  cron.schedule('0 22 * * *', () => {
    console.log('[Scheduler] Running nightly activity rollup...');
    try {
      require('./activity').runNightlyRollup();
    } catch (e) {
      console.error('[Scheduler] Activity rollup failed:', e.message);
    }
    try {
      const result = require('./entities').processRecentNotes(7);
      console.log(`[Scheduler] Entity extraction: ${result.processed} notes processed`);
    } catch (e) {
      console.error('[Scheduler] Entity extraction failed:', e.message);
    }
  });

  // Evening journal nudge — time configurable via agent_state 'journal_nudge_time' (default '21:00')
  cron.schedule('* 20-22 * * *', () => {
    try {
      const db = require('../db/database');
      const configuredTime = db.getState('journal_nudge_time') || '21:00';
      const [targetHour, targetMin] = configuredTime.split(':').map(Number);
      const now = new Date();
      if (now.getHours() === targetHour && now.getMinutes() === targetMin) {
        nudges.triggerJournalNudge();
      }
    } catch (e) {
      console.error('[Scheduler] Journal nudge check failed:', e.message);
    }
  });

  // 2am nightly — rebuild vault embeddings for changed files
  cron.schedule('0 2 * * *', () => {
    console.log('[Scheduler] Rebuilding vault embeddings...');
    try {
      require('./embeddings').rebuildEmbeddings().catch(e => {
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
          'NEURO — System Alert',
          `Capture is broken: ${issues.join(', ')}. Notes will not save.`,
          { type: 'system_alert' }
        ).catch(() => {});
      } catch {}
    } else {
      console.log('[Health] Capture system OK — vault writable');
    }
  }, 15000);

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

  // Every 30 minutes 8am-6pm weekdays — sync Microsoft Tasks (Planner + ToDo) to vault
  cron.schedule('15,45 8-18 * * 1-5', () => {
    console.log('[Scheduler] Syncing Microsoft Tasks...');
    require('./obsidian').syncMicrosoftTasks().catch(e => {
      console.error('[Scheduler] MS Tasks sync failed:', e.message);
    });
  });

  // Startup MS Tasks sync — 30s after start
  setTimeout(() => {
    console.log('[Scheduler] Startup MS Tasks sync...');
    require('./obsidian').syncMicrosoftTasks().catch(e => {
      console.error('[Scheduler] Startup MS Tasks sync failed:', e.message);
    });
  }, 30 * 1000);

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

  // Flagged ticket sync — every 5 minutes during work hours
  cron.schedule('*/5 8-18 * * 1-5', () => {
    jira.syncFlaggedTickets().catch(e => {
      console.error('[Scheduler] Flagged ticket sync failed:', e.message);
    });
  });

  // Startup flagged ticket sync
  setTimeout(() => {
    jira.syncFlaggedTickets().catch(e => {
      console.error('[Scheduler] Startup flagged sync failed:', e.message);
    });
  }, 35000);

  // Email triage — run at 8am, 12pm, 5pm weekdays
  cron.schedule('0 8,12,17 * * 1-5', () => {
    require('./email-triage').runTriage().catch(e => {
      console.error('[Scheduler] Email triage failed:', e.message);
    });
  });

  // Startup triage after 60s
  setTimeout(() => {
    require('./email-triage').runTriage().catch(() => {});
  }, 60000);

  // Meeting prep push — check every 5 minutes 8am-6pm weekdays
  cron.schedule('*/5 8-18 * * 1-5', async () => {
    try {
      await require('./meeting-prep').checkUpcomingMeetings();
    } catch (e) {
      console.error('[Scheduler] Meeting prep check failed:', e.message);
    }
  });

  console.log('[Scheduler] Started — pre-warm 8:55am, standup 9am, 1-2-1 9:10am, nag 15m, EOD 5pm, weekly review Fri 4:30pm, plan milestone 9:05am, Jira 5m, escalations 5m, flagged 5m, email triage 8/12/17, meeting prep 5m, imports 23:30, PLAUD 30m, MS Tasks 30m');
}

module.exports = { start };
