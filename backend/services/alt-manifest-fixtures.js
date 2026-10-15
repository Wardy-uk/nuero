'use strict';

/**
 * The four APPROVED desktop states as real payloads (15 Oct 2026): each is the
 * REAL composer + policy (saim-policy-scenarios) + NEURO's hand-off data + the
 * REAL resolver over a fixed, fresh device report — the exact three contracts
 * /api/canonical/now carries. Used by the adapter's golden tests and written as
 * fixtures for the local preview's screenshots. Test fixture only — nothing
 * here is read at runtime.
 */

const SC = require('./saim-policy-scenarios');
const NH = require('./neuro-handoff');
const TA = require('../../shared/task-activity.cjs');
const POL = require('../../saim/policy/attention-policy.cjs');
const H = require('../../saim/policy/handoff.cjs');
const DEV = require('./saim-device');

const clone = (x) => JSON.parse(JSON.stringify(x));
const DECLARED = ['claude', 'chatgpt', 'music', 'word', 'excel', 'outlook', 'teams', 'code', 'browser', 'obsidian'];

/** A fresh device report two minutes before `now`, nothing in front (unknown running state). */
function device(now, foreground = null) {
  const sample = { at: new Date(now - 2 * 60000).toISOString(), app: foreground, host: 'LAPTOP', idleSeconds: 0, locked: false };
  return DEV.build([sample], { LAPTOP: DECLARED }, now);
}

function payload(id, { mutate = null, taskActivity = null, foreground = null } = {}) {
  const s = SC.SCENARIOS.find((x) => x.id === id).build();
  const candidates = clone(s.candidates);
  if (mutate) mutate(candidates);
  for (const c of candidates.candidates) Object.assign(c, NH.handoffFor(c, null, { taskActivity }));
  const now = Date.parse(s.decision.decidedAt);
  const saim = POL.decide(candidates, { surface: 'work-desktop', now });
  const handoff = H.resolveHandoff({ decision: saim, candidates, device: device(now, foreground), now });
  return { candidates, saim, handoff };
}

const STATES = {
  // S5: the approved working block — Nick said this task is a "draft" step; judgement before 18:00; two held, one with stale wording.
  's05-protected-block': () => {
    const p = payload('2a', {
      taskActivity: new Map([[600, TA.resolveActivity({ choice: 'draft' })]]),
    });
    return p;
  },
  // S3: a running meeting with an unclassified possible risk held. A real-shaped diary id gives the
  // exact prep link; NEURO has no join link or meeting app, and the screen says so.
  's03-meeting': () => payload('9a', {
    mutate: (c) => { const m = c.candidates.find((x) => x.kind === 'meeting'); m.eventId = 'AAMkAGI2THVSAAA='; },
  }),
  // S1: blind — the only hand-off is where NEURO shows which feed stopped.
  's01-blind': () => payload('6a'),
  // S2u: an unclassified "critical" type leads as possible risk; NEURO gives no link for it.
  's02u-possible-risk': () => payload('8'),
};

module.exports = { STATES, payload, device, DECLARED };
