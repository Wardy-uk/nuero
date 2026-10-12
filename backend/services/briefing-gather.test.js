'use strict';

/**
 * Fixes found by reading the FIRST LIVE briefing (12 Oct 2026). Fixtures are the
 * live shapes, not invented ones.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

test('a NEURO task carried by the Radar is NOT proposed twice (the tasks gatherer owns it)', () => {
  const radarPath = require.resolve('./future-radar');
  const saved = require.cache[radarPath];
  require.cache[radarPath] = {
    id: radarPath, filename: radarPath, loaded: true,
    exports: {
      read: () => ({
        gaps: [],
        items: [
          { id: 'task:neuro:383', title: 'Fill in the Captur basics in NEURO', date: '2026-10-08', actionState: 'needs_you', sphere: 'personal', kind: 'admin' },
          { id: 'pd:helen:birthday', title: 'Helen’s birthday is on Friday', date: '2026-10-16', actionState: 'needs_you', sphere: 'personal', kind: 'birthday' },
        ],
      }),
    },
  };
  try {
    const { radar } = require('./briefing-gather');
    const out = radar(new Date(2026, 9, 12, 8), '2026-10-12', []);
    assert.deepEqual(out.map((c) => c.key), ['radar:pd:helen:birthday']);
  } finally {
    if (saved) require.cache[radarPath] = saved; else delete require.cache[radarPath];
  }
});

test('weekly push carries the whole-desk SLA rows under NOVA\'s live names', () => {
  const { weeklyPush } = require('./briefings');
  const p = weeklyPush({
    weeks: { report: { to: '2026-10-11' } },
    csatRows: [{ key: 'csat-score', now: '3.7 / 5', delta: '▲ +0.7' }],
    sla: [
      { kpi: 'FRT compliance % (Customer Care)', measured: true, now: 95.9 },
      { kpi: 'FRT compliance %', measured: true, now: 95.67 },
      { kpi: 'Resolution compliance %', measured: true, now: 91.88 },
    ],
    volumes: [{ name: 'raised', now: 729 }, { name: 'closed', now: 786 }],
    leaderboard: null,
  });
  assert.match(p.body, /FRT 96% · Resolution 92%/);
  assert.doesNotMatch(p.body, /Customer Care/);
});

void path;
