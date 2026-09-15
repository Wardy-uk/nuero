// GET /api/health — runtime liveness for the Pi 5 / PM2 / operators.
const express = require('express');
const { getHealth } = require('../state/stateEngine');

const router = express.Router();

router.get('/', (req, res) => {
  res.json(getHealth());
});

module.exports = router;
