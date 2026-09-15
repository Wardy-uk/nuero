// PM2 ecosystem for the SAiM runtime (WS0-WP1).
//
// The Pi 5 already runs PM2 under systemd (pm2-nickw.service), so registering
// SAiM here + `pm2 save` makes it start automatically on boot — no manual app
// launch after a reboot.
//
// One-time bring-up on the Pi 5:
//   cd /mnt/data/nuero/saim
//   (cd frontend && npm install && npm run build)   # emits frontend/dist
//   (cd backend && npm install)
//   pm2 start runtime/ecosystem.config.js
//   pm2 save                                          # persist across reboots
//
// The backend serves the built frontend, so this is a single process on one port.

module.exports = {
  apps: [
    {
      name: 'saim-backend',
      cwd: '/mnt/data/nuero/saim/backend',
      script: 'server.js',
      // Load backend/.env if present (Node 20.6+ built-in; the *-if-exists variant,
      // Node 20.12+, won't fail boot when there is no .env). This is how the WS3
      // Home Assistant telemetry config (SAIM_HA_* in .env) actually reaches the
      // process — no dotenv dependency. With no .env the bridge stays idle and SAiM
      // falls back honestly, exactly as designed.
      node_args: '--env-file-if-exists=.env',
      env: {
        SAIM_PORT: 3005,
      },
      autorestart: true,
      max_restarts: 10,
      time: true,
    },
  ],
};
