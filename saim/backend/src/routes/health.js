// GET /api/health — runtime liveness for the Pi 5 / PM2 / operators, and the
// start scripts' probe (scripts/start-saim*.sh curl it).
//
// Build 10I: this used to build the whole retired state model to answer
// "is SAiM up?". It now says only what this process KNOWS: that it is running,
// and whether it has been told where NEURO is and how to authenticate. It never
// claims NEURO is reachable — that is a fact about the network, read by the
// kiosk banner through /api/attention/context.
const express = require('express');
const neuroConfig = require('../integrations/neuroConfig');
const { RUNTIME_LABEL } = require('../runtime');

const router = express.Router();

router.get('/', (req, res) => {
  const r = neuroConfig.readiness();
  res.json({
    status: r.ready ? 'ok' : 'degraded',
    runtime: RUNTIME_LABEL,
    neuro: {
      configured: r.baseUrlConfigured,
      ready: r.ready,
      baseUrl: r.baseUrl,
      credentialConfigured: r.credentialConfigured,
      credentialKind: r.credentialKind,
      problems: r.problems,
    },
  });
});

module.exports = router;
