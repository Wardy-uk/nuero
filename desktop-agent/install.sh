#!/bin/bash
#
# Install the NEURO desktop agent on macOS.
#
#   ./install.sh --base-url http://100.100.28.58:3001 --token <NEURO_API_TOKEN>
#
# What this does, in order — and the ORDER is the point:
#
#   1. writes the config (token included) to a file only this account can read
#   2. takes ONE sample and PRINTS it, so the privacy claim is checkable
#   3. posts it, and only continues if NEURO actually stored it
#   4. installs the LaunchAgent
#   5. VERIFIES the LaunchAgent is really loaded before saying so
#
# ⚠ STEPS 3 AND 5 EXIST BECAUSE THE WINDOWS INSTALLER LIED. It printed
# "Installed and started" immediately after `Register-ScheduledTask` had failed:
# the CIM cmdlets report failure as a NON-terminating error, so the script sailed
# on. An installer that misreports what it installed is worse than none, because
# nothing else will ever tell you.

set -u

LABEL="com.nickward.neuro-agent"
CONFIG_DIR="$HOME/.config/neuro-agent"
CONFIG="$CONFIG_DIR/config.json"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs"
SCRIPT_SRC="$(cd "$(dirname "$0")" && pwd)/neuro-desktop-agent.sh"
SCRIPT_DST="$CONFIG_DIR/neuro-desktop-agent.sh"

BASE_URL=""
TOKEN=""
INTERVAL=120

while [ $# -gt 0 ]; do
  case "$1" in
    --base-url) BASE_URL="$2"; shift 2 ;;
    --token)    TOKEN="$2";    shift 2 ;;
    --interval) INTERVAL="$2"; shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

[ -z "$BASE_URL" ] && { echo "--base-url is required" >&2; exit 2; }
[ -z "$TOKEN" ]    && { echo "--token is required (NEURO_API_TOKEN — machine clients use the token, not the PIN)" >&2; exit 2; }
[ -f "$SCRIPT_SRC" ] || { echo "cannot find $SCRIPT_SRC" >&2; exit 1; }

PY=/usr/bin/python3
"$PY" -c 'import json' >/dev/null 2>&1 || {
  echo "$PY is not usable — install the Command Line Tools (xcode-select --install)." >&2
  exit 1
}

# ── 1. Config ────────────────────────────────────────────────────────────────
#
# ⚠ THE TOKEN GOES IN A FILE, NEVER IN THE PLIST. A LaunchAgent's arguments are
# readable by anything that can list jobs; this file is 0600 and owned by this
# account. Same reasoning as the Windows agent keeping it out of the scheduled
# task's arguments.
mkdir -p "$CONFIG_DIR"
BASE_URL="$BASE_URL" TOKEN="$TOKEN" INTERVAL="$INTERVAL" "$PY" -c 'import json,os,sys
json.dump({"baseUrl": os.environ["BASE_URL"].rstrip("/"),
           "token": os.environ["TOKEN"],
           "intervalSeconds": int(os.environ["INTERVAL"])},
          open(sys.argv[1], "w"), indent=2)' "$CONFIG"
chmod 600 "$CONFIG"

cp "$SCRIPT_SRC" "$SCRIPT_DST"
chmod 755 "$SCRIPT_DST"

echo "Config written to $CONFIG (readable only by $(whoami))."
echo

# ── 2 & 3. Prove the whole path BEFORE scheduling anything ───────────────────
echo "Taking one sample and sending it..."
if ! "$SCRIPT_DST" --once; then
  echo
  echo "That did not work, so NOTHING has been scheduled." >&2
  echo "Fix the above and re-run. The config file is already written." >&2
  exit 1
fi
echo
echo "  ...that worked. Note what was sent: an application NAME, an idle time,"
echo "  a locked flag and this machine's name. No window titles, no paths,"
echo "  no URLs. That is the whole payload."
echo

# ── 4. The LaunchAgent ───────────────────────────────────────────────────────
#
# ⚠ A LaunchAgent, NOT a LaunchDaemon. It must run as Nick, in his GUI session:
# a daemon runs as root outside any session and can read neither this session's
# idle time nor its frontmost application. Same constraint the Windows task has,
# where a SYSTEM-level task cannot see the interactive desktop.
#
# ⚠ `KeepAlive` IS the watchdog, and it replaces the whole two-trigger dance the
# Windows installer needs (a logon trigger plus a 15-minute repeat with
# IgnoreNew, because Task Scheduler rejects `TimeSpan::MaxValue` as a repetition
# duration). launchd simply restarts it if it dies. Nothing extra to write.
mkdir -p "$(dirname "$PLIST")" "$LOG_DIR"
cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$SCRIPT_DST</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOG_DIR/neuro-agent.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/neuro-agent.err</string>
</dict>
</plist>
PLISTEOF

# Replace any previous copy rather than stacking a second one.
launchctl bootout "gui/$UID/$LABEL" >/dev/null 2>&1
if ! launchctl bootstrap "gui/$UID" "$PLIST" 2>/dev/null; then
  # Older macOS, or a system that prefers the legacy verb.
  launchctl load -w "$PLIST" >/dev/null 2>&1
fi

# ── 5. Verify, rather than claim ─────────────────────────────────────────────
if launchctl print "gui/$UID/$LABEL" >/dev/null 2>&1 \
   || launchctl list | grep -q "$LABEL"; then
  echo "Installed and running as $LABEL."
  echo "  agent:  $SCRIPT_DST"
  echo "  config: $CONFIG"
  echo "  log:    $LOG_DIR/neuro-agent.log"
  echo
  echo "⚠ Set your real apps in $CONFIG_DIR/apps.json, e.g."
  echo '    { "browser": "Google Chrome", "music": "Music", "code": "Visual Studio Code" }'
  echo "  The built-in defaults are a guess. On Windows they were never edited"
  echo "  and both launch buttons opened the wrong application for weeks."
else
  echo "The LaunchAgent did NOT load. Nothing is running." >&2
  echo "  plist: $PLIST" >&2
  echo "  try:   launchctl bootstrap gui/$UID $PLIST" >&2
  exit 1
fi
