#!/usr/bin/env bash
# SARA runtime bring-up (WS0-WP1). Idempotent enough to re-run after a pull.
# Target: Pi 5 (/mnt/data/nuero/sara). Run from anywhere.
set -euo pipefail

SARA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$SARA_DIR"

echo "[sara] installing backend deps"
(cd backend && npm install --no-audit --no-fund)

echo "[sara] installing + building frontend"
(cd frontend && npm install --no-audit --no-fund && npm run build)

# PM2 lives under nvm and is not on the non-interactive PATH by default.
if ! command -v pm2 >/dev/null 2>&1; then
  export PATH="$HOME/.nvm/versions/node/v20.20.2/bin:$PATH"
fi

echo "[sara] (re)starting under PM2"
pm2 start runtime/ecosystem.config.js --update-env || pm2 restart sara-backend --update-env
pm2 save

echo "[sara] up. health: curl http://localhost:3005/api/health"
