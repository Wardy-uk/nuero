// SARA runtime backend — WS0-WP1 foundation.
//
// Responsibilities in WS0 (deliberately small):
//   1. Boot cleanly under PM2 on the Pi 5.
//   2. Expose the shared state model over /api (the defined runtime path).
//   3. In production, serve the built frontend so the whole runtime is one
//      process on one port (clean for PM2 + "one SARA").
//
// CommonJS only — matches the NEURO backend convention (no ESM).

const path = require('path');
const fs = require('fs');
const express = require('express');

const healthRoute = require('./src/routes/health');
const stateRoute = require('./src/routes/state');
const { RUNTIME_LABEL } = require('./src/state/stateEngine');

const app = express();
const PORT = process.env.SARA_PORT || 3005;

app.use(express.json());

// --- API (the defined frontend <-> backend runtime path) ---
app.use('/api/health', healthRoute);
app.use('/api/state', stateRoute);

// --- Static frontend (production) ---
// Vite builds to ../frontend/dist. If it exists, serve it with SPA fallback so
// the runtime is a single process. In dev the Vite server handles the frontend
// and proxies /api here instead (see frontend/vite.config.js).
const distDir = path.join(__dirname, '..', 'frontend', 'dist');
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(distDir, 'index.html'));
  });
} else {
  app.get('/', (req, res) => {
    res.type('text').send(
      `SARA backend (${RUNTIME_LABEL}) is up on port ${PORT}.\n` +
        `Frontend build not found at ${distDir}.\n` +
        `Run the frontend dev server, or build it for production.\n` +
        `API: GET /api/health , GET /api/state\n`
    );
  });
}

app.listen(PORT, () => {
  console.log(`[SARA ${RUNTIME_LABEL}] backend listening on http://0.0.0.0:${PORT}`);
});
