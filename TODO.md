# NEURO Snag List — Task Tracker

## SNAG 001 — Vault sync is stale

- [x] SSH into Pi, add cron job for vault pull every 60s
- [x] Verify vault-pull.log shows successful pulls after ~2 minutes
- [x] Fixed: cron also auto-commits Pi-side writes (decision log, task toggles) + pushes back
- [ ] Confirm NEURO context picks up fresh vault data (needs a fresh daily note pushed from laptop)

## SNAG 002 — No capture feature

### Backend
- [x] Install multer dependency
- [x] Create routes/capture.js with POST /note, /photo, /file
- [x] Wire capture routes into server.js
- [x] Ensure Imports/ and Imports/Files/ directories exist on Pi vault
- [x] Test note capture endpoint on Pi — working, creates file with frontmatter
- [x] Imports/pending endpoint picks up captured files

### Frontend
- [x] Create CapturePanel.jsx component with Note/Photo/File tabs
- [x] Create CapturePanel.css (matches existing design system)
- [x] Add Capture to sidebar nav (second item, after Dashboard)
- [x] Set Capture as mobile default landing view
- [x] Frontend builds clean (npm run build)

### Deploy & verify
- [x] Deploy backend to Pi (capture.js, server.js, multer installed)
- [ ] Deploy frontend (push to main → Netlify) — NEEDS GIT PUSH
- [ ] Test note capture end-to-end from UI
- [ ] Test photo capture from iPhone PWA
- [ ] Test file upload from UI
