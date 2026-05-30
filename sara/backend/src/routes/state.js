// GET /api/state — the single shared state model (placeholder in WS0).
// This is the connectivity path the frontend reads to prove the runtime loop.
const express = require('express');
const { getState } = require('../state/stateEngine');

const router = express.Router();

router.get('/', (req, res) => {
  res.json(getState());
});

module.exports = router;
