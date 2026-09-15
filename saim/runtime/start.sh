#!/usr/bin/env bash
# SAiM runtime bring-up (WS0-WP1). Idempotent enough to re-run after a pull.
# Target: Pi 5 (/mnt/data/nuero/saim). Run from anywhere.
set -euo pipefail

SAIM_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$SAIM_DIR"

echo "[saim] installing backend deps"
(cd backend && npm install --no-audit --no-fund)

echo "[saim] installing + building frontend"
(cd frontend && npm install --no-audit --no-fund && npm run build)

# PM2 lives under nvm and is not on the non-interactive PATH by default.
if ! command -v pm2 >/dev/null 2>&1; then
  export PATH="$HOME/.nvm/versions/node/v20.20.2/bin:$PATH"
fi

echo "[saim] (re)starting under PM2"
pm2 start runtime/ecosystem.config.js --update-env || pm2 restart saim-backend --update-env
pm2 save

echo "[saim] up. health: curl http://localhost:3005/api/health"
