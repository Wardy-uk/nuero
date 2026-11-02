#!/bin/bash
# Off-site copy of the things that cannot be regenerated (#59).
#
# Deployed to /usr/local/bin/backup-offsite.sh on pi5.
#
# WHY THIS EXISTS
#   backup-data.sh makes excellent local backups — consistent SQLite copies,
#   hardlinked snapshots, 56 generations. All of them live on a USB stick
#   plugged into the same Pi as the data. That covers disk failure and fat
#   fingers and nothing else: one fire, theft or power event takes the vault,
#   the Home Assistant history and the NEURO database together.
#
# WHAT IT COPIES, AND WHAT IT DELIBERATELY DOES NOT
#   Source is the LATEST LOCAL SNAPSHOT, not /mnt/data. That snapshot already
#   contains a `sqlite3 .backup` taken before the rsync, so the database copy is
#   consistent — reading the live DB here would risk a torn file and re-solve a
#   problem that is already solved one layer down.
#
#   Measured on 16 Aug, the snapshot is ~5GB, and 2.1GB of that is `backups/` —
#   28 rotated copies of agent.db. That is DERIVED data: pushing 28 historical
#   copies of the same database off-site would more than double the payload to
#   protect nothing, and it grows every day the health backfill runs. So the
#   off-site set is the irreplaceable half only:
#
#     nuero-vault/    ~910M  the vault. The one thing with no other copy that
#                            isn't also in this house.
#     homeassistant/  ~965M  years of history, not reconstructable.
#     agent.db        ~250M  ONE current copy, pulled from the snapshot's
#                            rotation — the newest, integrity already checked.
#     syncthing/       ~11M  config, so a rebuild doesn't start from nothing.
#
#   Excluded and why: `nuero/` is a git checkout (GitHub has it, and most of the
#   689M is node_modules); `backups/` is derived; ollama models are a download;
#   quest/, freereps-eval/ and vault-dedup-quarantine/ are working scratch.
#
#   That comes to ~2.15GB against Backblaze B2's 10GB free tier, which is what
#   makes the retention below affordable rather than a compromise.
#
# ENCRYPTION IS NOT OPTIONAL
#   The vault is 1-2-1 notes, performance conversations and personal data about
#   named colleagues. It goes through an rclone `crypt` remote with filename
#   encryption on — a filename is as disclosive as a body here ("Nathan Rutland
#   career progression" needs no opening).
#
# FAILURE DIRECTION
#   The classic off-site failure is silent: it stops in March and is discovered
#   in November. So every run writes a status file that NEURO's watchdog reads,
#   a failure is recorded rather than swallowed, and "never configured" is a
#   DISTINCT state from "ran and failed" — an unconfigured remote is a normal
#   state on day one and must not look like a broken job.

set -uo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

SNAPSHOT=/mnt/backup/snapshots/latest
REMOTE="${OFFSITE_REMOTE:-b2crypt:pi5}"
STATUS=/mnt/data/backups/offsite-status.json
LOG=/mnt/backup/offsite.log
STAGE=/mnt/backup/.offsite-stage

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG"; }

# Status is written on EVERY exit path, success or not — a run that dies without
# leaving a trace is exactly the silence this is built to prevent.
write_status() {
  local state="$1" detail="$2" bytes="${3:-0}"
  mkdir -p "$(dirname "$STATUS")"
  cat > "$STATUS" <<JSON
{
  "state": "$state",
  "detail": "$(echo "$detail" | sed 's/"/\\"/g' | tr -d '\n')",
  "bytes": $bytes,
  "remote": "$REMOTE",
  "finishedAt": "$(date -Iseconds)"
}
JSON
}

fail() { log "FAILED: $*"; write_status "failed" "$*"; exit 1; }

log "=== offsite start ==="

# Off-site push switched OFF on purpose (Nick, 23 Oct 2026). Checked FIRST, before
# any rclone call, so a stray cron line or a manual run cannot reach Backblaze.
# The status is `disabled`, never `ok`: a run that pushed nothing must not
# report an off-site success. Re-enable: remove the flag file and restore the
# root crontab line (see the Stage 1 deployment record in the vault).
OFFSITE_DISABLED_FLAG=/etc/neuro/offsite-disabled
if [ -e "$OFFSITE_DISABLED_FLAG" ]; then
  log "off-site push disabled ($OFFSITE_DISABLED_FLAG) — no Backblaze request made"
  write_status "disabled" "Local backups active; off-site Backblaze backup intentionally disabled by Nick on 23 Oct 2026."
  exit 0
fi

# Setup-not-finished is NOT failure. Both of the checks below are states this
# job legitimately sits in between being deployed and the B2 key existing, and
# reporting them as failures would light a critical alert on day one — which is
# how an alert gets muted before it ever means anything.
if ! command -v rclone >/dev/null 2>&1; then
  log "rclone is not installed — nothing to do yet"
  write_status "unconfigured" "rclone is not installed"
  exit 0
fi

REMOTE_NAME="${REMOTE%%:*}"
if ! rclone listremotes 2>/dev/null | grep -q "^${REMOTE_NAME}:"; then
  log "remote '$REMOTE_NAME' is not configured — nothing to do yet"
  write_status "unconfigured" "rclone remote '$REMOTE_NAME' does not exist; run rclone config"
  exit 0
fi

[ -d "$SNAPSHOT" ] || fail "$SNAPSHOT does not exist — has backup-data.sh ever run?"

# --- Stage the one DB copy we want ------------------------------------------
# Take the newest integrity-checked copy backup-data.sh wrote and give it a
# stable name, so the off-site copy is "the database" rather than a dated pile
# that would accumulate in the bucket forever.
#
# 23 Oct 2026: read from where backup-data.sh WRITES the copies, not from the
# snapshot. backup-data.sh has excluded /backups/ from snapshots since 18 Sep,
# so "$SNAPSHOT/backups/nuero-db" no longer exists and every run from 19 Sep
# went off-site WITHOUT the database while reporting "ok".
DB_COPIES=/mnt/data/backups/nuero-db
rm -rf "$STAGE"; mkdir -p "$STAGE"; chmod 700 "$STAGE"
DB_STAGED=0
NEWEST_DB=$(ls -t "$DB_COPIES"/agent-*.db 2>/dev/null | head -1)
if [ -n "$NEWEST_DB" ] && [ -s "$NEWEST_DB" ]; then
  if (umask 077; cp "$NEWEST_DB" "$STAGE/agent.db" && basename "$NEWEST_DB" > "$STAGE/agent.db.source"); then
    chmod 600 "$STAGE/agent.db" "$STAGE/agent.db.source"
    DB_STAGED=1
    log "staged database: $(basename "$NEWEST_DB") ($(du -h "$STAGE/agent.db" | cut -f1))"
  else
    log "WARNING: copying $(basename "$NEWEST_DB") into the stage failed"
  fi
fi
if [ "$DB_STAGED" -ne 1 ]; then
  # The vault is the irreplaceable part and must still go, so carry on — but
  # the run is reported FAILED at the end, never ok.
  log "WARNING: no usable agent-*.db in $DB_COPIES — continuing WITHOUT the database"
fi

# --- Push --------------------------------------------------------------------
# `sync` mirrors, so a deletion here is a deletion there. That is the intent —
# the off-site copy tracks the current state, and the 56 local generations are
# what covers "I deleted it last week". Bucket lifecycle keeps one prior version
# as a backstop against a corrupted push; see the setup notes.
RC_TOTAL=0
push() {
  local src="$1" dest="$2"
  [ -e "$src" ] || { log "skip $dest — not in the snapshot"; return 0; }
  log "pushing $dest"
  rclone sync "$src" "$REMOTE/$dest" \
    --transfers 4 --checkers 8 \
    --b2-hard-delete \
    --stats-one-line --stats 5m \
    --log-file "$LOG" --log-level INFO
  local rc=$?
  [ $rc -ne 0 ] && { log "  $dest FAILED (rc=$rc)"; RC_TOTAL=$((RC_TOTAL + 1)); }
  return 0
}

# The database goes FIRST (23 Oct 2026): it is two files and costs a handful
# of B2 transactions, while the vault walk costs thousands — and on 22 Oct the
# daily transaction cap cut the run off part-way, after the vault, before the
# database. The path that was missing must not be the one most likely to be
# cut off.
# Never sync an EMPTY stage: `sync --b2-hard-delete` would delete the last
# good off-site database to match it.
if [ "$DB_STAGED" -eq 1 ]; then
  push "$STAGE"                "neuro-db"
else
  log "skip neuro-db — nothing staged, leaving the remote copy untouched"
fi
push "$SNAPSHOT/nuero-vault"   "nuero-vault"
push "$SNAPSHOT/homeassistant" "homeassistant"
push "$SNAPSHOT/syncthing"     "syncthing"
# Workout photos (2 Nov 2026): the resized copies the iPhone sends for each
# tracked walk. Not regenerable once the phone's library is pruned.
push "$SNAPSHOT/neuro-workout-photos" "neuro-workout-photos"

rm -rf "$STAGE"

if [ "$RC_TOTAL" -ne 0 ]; then
  fail "$RC_TOTAL of 5 paths failed to sync"
fi
if [ "$DB_STAGED" -ne 1 ]; then
  fail "the other paths synced, but no database copy was staged — off-site holds no current agent.db"
fi

# --- Verify, rather than assume ----------------------------------------------
# `rclone size` reads the REMOTE. A push that reports success but leaves an
# empty bucket is the failure worth catching, and it costs one API call.
SIZE_JSON=$(rclone size "$REMOTE" --json 2>>"$LOG")
BYTES=$(echo "$SIZE_JSON" | sed -n 's/.*"bytes":\([0-9]*\).*/\1/p')
BYTES=${BYTES:-0}

if [ "$BYTES" -lt 100000000 ]; then
  fail "remote holds only $BYTES bytes — expected ~2GB, treating as a failed push"
fi

HUMAN=$(echo "$BYTES" | awk '{printf "%.2fGB", $1/1073741824}')
log "=== offsite done — remote holds $HUMAN ==="
write_status "ok" "synced to $REMOTE" "$BYTES"
