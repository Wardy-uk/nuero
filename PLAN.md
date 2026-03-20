# NEURO Snag List — Implementation Plan

**Source:** `Documents\Nicks knowledge base\Projects\Second Brain\NEURO - Snag List.md`
**Date:** 2026-03-20

---

## SNAG 001 — Vault sync is stale (Critical)

**Problem:** Pi vault at `/home/nickw/nuero-vault` last updated 2026-03-15. No active sync.

**Fix:** Reinstate cron job on Pi to `git pull --rebase origin main` every 60 seconds.

**Steps:**
1. SSH into Pi
2. Add cron entry: `* * * * * cd /home/nickw/nuero-vault && git pull --rebase origin main >> /home/nickw/vault-pull.log 2>&1`
3. Wait ~2 minutes, check `vault-pull.log` for successful pulls
4. Confirm NEURO context picks up fresh vault data

**No code changes required** — backend already reads from `OBSIDIAN_VAULT_PATH`.

---

## SNAG 002 — No capture feature (High)

**Problem:** No way to capture notes/photos/files from NEURO. Everything scattered.

**Solution:** New Capture tab with three modes: Note / Photo / File. All land in `Imports/` for standup sorter.

### Backend (new route file: `routes/capture.js`)
- `POST /api/capture/note` — `{ title, content }` → `Imports/YYYY-MM-DD-HH-MM-SS-note.md` with frontmatter
- `POST /api/capture/photo` — multipart upload → `Imports/Files/YYYY-MM-DD-HH-MM-SS-[filename]`
- `POST /api/capture/file` — multipart upload → `Imports/Files/`
- Frontmatter on all: `date`, `source: neuro-capture`, `status: unprocessed`
- Return `{ success: true, path, filename }`
- SSE broadcast to increment Imports badge
- 10MB file size limit (multer config)
- New dep: `multer` for multipart uploads

### Frontend (new component: `CapturePanel.jsx`)
- Three mode tabs: Note / Photo / File
- Note: optional title + textarea, clears on success, shows "Captured ✓"
- Photo: `<input accept="image/*" capture="environment">` with preview thumbnail
- File: standard file picker, shows name + size
- 10MB frontend check before submit

### Sidebar integration
- New nav item: `{ id: 'capture', label: 'Capture', icon: '+' }`
- Second in list (after Dashboard)
- Mobile default landing view

### Constraints
- No auto-classification — files sorted at standup
- Images saved as-is, not compressed
- CommonJS, `multer` is only new dep
- Must work from iPhone Safari PWA with camera

### Key paths
- Vault Imports dir on Pi: `/home/nickw/nuero-vault/Imports/`
- Vault Imports/Files on Pi: `/home/nickw/nuero-vault/Imports/Files/`
