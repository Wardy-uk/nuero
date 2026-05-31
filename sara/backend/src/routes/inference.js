// GET /api/inference — the context-inference block on its own (WS5-WP1).
//
// Operator/evidence surface only. The shared state model already folds inference into
// /api/state; this route exposes just that block so operators and the evaluator can see
// what SARA inferred — activity, recommended view, confidence, reasons — without parsing
// the full model. It is read-only and advisory: it derives from the same buildModel()
// output and takes no action. The recommendation never drives the UI here or anywhere.
const express = require('express');
const { buildModel } = require('../state/stateEngine');

const router = express.Router();

router.get('/', (req, res) => {
  const model = buildModel();
  res.json({ ...model.inference, modelValid: model.meta.valid, checkedAt: new Date().toISOString() });
});

module.exports = router;
