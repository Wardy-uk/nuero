// GET /api/cognition/graph — the live vault backbone (real related/backlinks) + knowledge
// gaps that the Cognitive Convergence Graph renders as Nick's memory substrate and void wells.
// Read-only echo of the bounded vaultGraph snapshot; honest empty graph when NEURO is absent.
const express = require('express');
const vaultGraph = require('../integrations/vaultGraph');

const router = express.Router();

router.get('/', (req, res) => {
  res.json(vaultGraph.getGraph());
});

module.exports = router;
