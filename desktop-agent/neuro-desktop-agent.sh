#!/bin/bash
#
# NEURO desktop agent — macOS.
#
# The sibling of neuro-desktop-agent.ps1, posting the SAME sample to the SAME
# route, so the Mac simply becomes a second host:
#
#     { at, app, idleSeconds, locked, host, canOpen }
#
# WHY IT EXISTS
# -------------
# `desktop_daily` had exactly one host, so a day worked on the Mac was invisible
# to NEURO: the day planner's estimate multiplier learned nothing from it, and
# the RescueTime audit could only ever answer `unknown`. Worse, once RescueTime
# went onto the Mac (13 Sep 2026) its account-wide total started being compared
# against a single machine's measurement, which inflates the ratio past a floor
# that only fires BELOW it — so RescueTime could go blind on the laptop and pass.
# This agent is what restores a like-for-like comparison.
#
# WHAT IT SENDS, AND WHAT IT DELIBERATELY DOES NOT
# ------------------------------------------------
# The FOREGROUND APPLICATION NAME and nothing else. Never a window title, never
# a file path, never a URL, never keystrokes.
#
# ⚠ macOS makes this EASIER than Windows, and the difference is worth knowing.
# `GetForegroundWindow` on Windows hands back the whole caption — which on this
# estate means Outlook subject lines, customer names and the contents of a
# disciplinary folder — so the PowerShell agent has to actively strip it.
# `lsappinfo` returns the application's NAME. The title never enters the
# picture, so there is nothing to leak.
#
# ⚠ One small fidelity loss to know about: the SERVER's `sanitiseApp` splits on
# a hyphen (it exists to collapse a leaked Windows title like "file.ts - project
# - Visual Studio Code" to its first token). Mac app names are user-facing and so
# likelier to contain one, and "Microsoft To-Do" would store as "Microsoft To".
# Checked against the real names this machine reports — Google Chrome, Visual
# Studio Code, Microsoft Outlook, iTerm2, zoom.us, Xcode — and every one survives
# whole. Left alone deliberately: loosening a sanitiser to gain a hyphen is a
# poor trade when its whole job is defence, and a truncated name is still safe.
#
# A LOCKED session reports `locked` and NO app at all — what was open before
# walking away is not something to keep a record of.
#
# Nothing is stored locally. If NEURO is unreachable the sample is DROPPED, not
# queued: this answers "what is he doing NOW", and a sample delivered an hour
# late answers a question nobody is asking.
#
# Usage:
#   neuro-desktop-agent.sh --once     take one sample, print it, post it, exit
#   neuro-desktop-agent.sh            run forever (what launchd does)

set -u

CONFIG_DIR="$HOME/.config/neuro-agent"
CONFIG="$CONFIG_DIR/config.json"
APPS_OVERRIDE="$CONFIG_DIR/apps.json"

ONCE=0
[ "${1:-}" = "--once" ] && ONCE=1

# ── Python, for JSON only ────────────────────────────────────────────────────
#
# ⚠ Checked HERE rather than assumed. Building JSON with printf is possible and
# PARSING it with grep is not — the activity response carries both `intents[].app`
# and `sample.app`, so a naive `grep '"app"'` pairs an intent with the sample's
# own field and launches the wrong thing. A wrong launch is worse than no launch.
PY=/usr/bin/python3
if ! "$PY" -c 'import json' >/dev/null 2>&1; then
  echo "neuro-agent: $PY is not usable (needs Command Line Tools)." >&2
  exit 1
fi

if [ ! -f "$CONFIG" ]; then
  echo "neuro-agent: no config at $CONFIG — run install.sh first." >&2
  exit 1
fi

BASE_URL=$("$PY" -c 'import json,sys;print(json.load(open(sys.argv[1])).get("baseUrl","").rstrip("/"))' "$CONFIG")
TOKEN=$("$PY" -c 'import json,sys;print(json.load(open(sys.argv[1])).get("token",""))' "$CONFIG")
INTERVAL=$("$PY" -c 'import json,sys;print(int(json.load(open(sys.argv[1])).get("intervalSeconds",120)))' "$CONFIG")

# ⚠ NOT the sample interval, and it must not be folded into it. Sampling answers
# "what is he doing", which does not need asking often. A launch button answers
# "do this NOW" — at the sample cadence it measured 111 seconds to open a
# browser, with the next press expiring unfired. The claim call stores nothing
# and carries no sample, so asking often is cheap.
CLAIM_SECONDS=5

if [ -z "$BASE_URL" ] || [ -z "$TOKEN" ]; then
  echo "neuro-agent: config is missing baseUrl or token." >&2
  exit 1
fi

# ── What this machine is called ──────────────────────────────────────────────
#
# ⚠ `scutil --get ComputerName`, NOT `hostname`. The latter picks up a `.local`
# suffix and shifts between networks, and `MAX_HOSTS` on the server is 4 — a
# rolling hostname would quietly eat every bucket and make the per-host history
# meaningless.
HOSTNAME_NEURO=$(scutil --get ComputerName 2>/dev/null || hostname)

# ── The apps this machine will open ──────────────────────────────────────────
#
# ⚠ THE SERVER SENDS AN ID, NEVER A COMMAND. The mapping from id to a real
# application lives HERE. The Pi cannot name an app, cannot pass arguments and
# cannot invent one by sending a different string: an id that is not a key below
# is refused locally, before anything runs, and reported as refused.
#
# ⚠ The argument to `open -a` comes from THIS table, never from the response.
# The moment a caller can supply one, an allowlist of programs stops being a
# boundary — "browser" plus an arbitrary URL is arbitrary execution wearing an
# allowlist's clothes.
#
# ⚠ Defaults are a GUESS about this machine and are meant to be overridden. On
# Windows the built-ins (iTunes, msedge) were never edited and both launch
# buttons opened the wrong thing — the override file exists precisely so real
# paths stay out of a public repo, and nothing says it has not been written.
app_command() {
  case "$1" in
    music)    echo "Music" ;;
    code)     echo "Visual Studio Code" ;;
    terminal) echo "Terminal" ;;
    browser)  echo "Safari" ;;
    *)        echo "" ;;
  esac
}

app_override() {
  [ -f "$APPS_OVERRIDE" ] || { echo ""; return; }
  "$PY" -c 'import json,sys
try:
    print(json.load(open(sys.argv[1])).get(sys.argv[2], "") or "")
except Exception:
    print("")' "$APPS_OVERRIDE" "$1" 2>/dev/null
}

resolve_app() {
  local id="$1" over
  over=$(app_override "$id")
  if [ -n "$over" ]; then echo "$over"; else app_command "$id"; fi
}

CAN_OPEN='["browser","code","music","terminal"]'

# ── Reading the machine ──────────────────────────────────────────────────────

# Seconds since the last keyboard or mouse input.
#
# ⚠ Keyboard and mouse ONLY — reading a long document counts as idle, which is
# why the server's away threshold tolerates a long think rather than treating
# every quiet stretch as absence.
idle_seconds() {
  ioreg -c IOHIDSystem 2>/dev/null \
    | awk '/HIDIdleTime/ { printf "%d\n", $NF / 1000000000; exit }'
}

# Is the screen locked, or the screensaver up?
#
# ⚠ Two conditions, because they are genuinely different states that mean the
# same thing here: an explicit lock, and a screensaver that has taken over.
session_locked() {
  # ⚠ `>/dev/null`, not `pgrep -q`. BSD pgrep's flag set differs from
  # Linux's and this has to work on a stock Mac with nothing installed.
  if pgrep -x ScreenSaverEngine >/dev/null 2>&1; then echo 1; return; fi
  if ioreg -n Root -d1 -a 2>/dev/null \
      | grep -A1 CGSSessionScreenIsLocked \
      | grep -q '<true/>'; then echo 1; return; fi
  echo 0
}

# The frontmost application's NAME.
#
# ⚠ `lsappinfo` first, because it needs no permission. The AppleScript fallback
# goes through System Events, which raises a one-off Automation prompt — useful
# as a backstop, but it must not be the primary or the agent silently reports
# nothing until somebody happens to click Allow.
foreground_app() {
  local asn name
  asn=$(lsappinfo front 2>/dev/null)
  if [ -n "$asn" ]; then
    name=$(lsappinfo info -only name "$asn" 2>/dev/null \
           | sed -n 's/.*"LSDisplayName"="\(.*\)".*/\1/p')
    if [ -n "$name" ]; then echo "$name"; return; fi
  fi
  osascript -e 'tell application "System Events" to get name of first application process whose frontmost is true' 2>/dev/null
}

# ── The sample ───────────────────────────────────────────────────────────────

build_sample() {
  local locked app idle at
  locked=$(session_locked)
  # ⚠ A locked session sends no app at all, not even a stripped one.
  if [ "$locked" = "1" ]; then app=""; else app=$(foreground_app); fi
  idle=$(idle_seconds)
  [ -z "$idle" ] && idle=0
  at=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)

  APP="$app" IDLE="$idle" LOCKED="$locked" HOSTN="$HOSTNAME_NEURO" CANOPEN="$CAN_OPEN" AT="$at" \
  "$PY" -c 'import json,os
app = os.environ["APP"].strip()
print(json.dumps({
    "at": os.environ["AT"],
    "app": app or None,
    "idleSeconds": int(os.environ["IDLE"] or 0),
    "locked": os.environ["LOCKED"] == "1",
    "host": os.environ["HOSTN"],
    # ⚠ THE AGENT DECLARES WHAT IT UNDERSTANDS. Claiming an intent is a
    # SERVER-side act, so an agent that knew nothing about intents would still
    # cause one to be claimed and would then discard it with the response —
    # Nick would press a button and nothing would ever happen. The server only
    # hands intents to an agent that says it can act on them.
    "canOpen": json.loads(os.environ["CANOPEN"]),
}, separators=(",", ":")))'
}

post_json() {
  # $1 path, $2 body. Prints the response body, or nothing on failure.
  curl -sS -m 10 -X POST "$BASE_URL$1" \
    -H "Content-Type: application/json" \
    -H "X-NEURO-API-TOKEN: $TOKEN" \
    -d "$2" 2>/dev/null
}

# ── Opening something, when NEURO is asked to ────────────────────────────────
#
# ⚠ THIS AGENT STAYS OUTBOUND-ONLY. Nothing listens on this Mac and nothing on
# the network can reach it. Anything to be done arrives on the RESPONSE to a
# connection this script opened itself.

report_intent() {
  local id="$1" ok="$2" detail="$3" body
  body=$(OK="$ok" DETAIL="$detail" "$PY" -c 'import json,os
print(json.dumps({"ok": os.environ["OK"] == "1", "detail": os.environ["DETAIL"]},
                 separators=(",", ":")))')
  # Best effort. A lost receipt leaves the request reading "claimed", which is
  # honest — it says the Mac took it, not that it worked.
  post_json "/api/desktop/intents/$id/done" "$body" >/dev/null
}

run_intents() {
  local resp="$1" pairs id app cmd
  [ -z "$resp" ] && return
  # ⚠ Parsed out of the `intents` array SPECIFICALLY. The activity response
  # also carries `sample.app`, so anything matching on `"app"` across the whole
  # body pairs an intent with the sample's own field and opens the wrong thing.
  pairs=$(printf '%s' "$resp" | "$PY" -c 'import json,sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
for i in (d.get("intents") or []):
    if i.get("id") and i.get("app"):
        print("%s\t%s" % (i["id"], i["app"]))' 2>/dev/null)
  [ -z "$pairs" ] && return

  printf '%s\n' "$pairs" | while IFS=$(printf '\t') read -r id app; do
    [ -z "$id" ] && continue
    cmd=$(resolve_app "$app")
    if [ -z "$cmd" ]; then
      # Refused HERE, independently of the server's own refusal. Two locks.
      echo "neuro-agent: refused unknown app id '$app'" >&2
      report_intent "$id" 0 "this machine has no '$app'"
      continue
    fi
    if open -a "$cmd" >/dev/null 2>&1; then
      echo "neuro-agent: opened $app ($cmd)"
      report_intent "$id" 1 "$cmd"
    else
      echo "neuro-agent: could not open $app ($cmd)" >&2
      report_intent "$id" 0 "could not open $cmd"
    fi
  done
}

claim_intents() {
  local body
  body=$(HOSTN="$HOSTNAME_NEURO" CANOPEN="$CAN_OPEN" "$PY" -c 'import json,os
print(json.dumps({"host": os.environ["HOSTN"],
                  "canOpen": json.loads(os.environ["CANOPEN"])},
                 separators=(",", ":")))')
  # ⚠ `canOpen` travels here TOO. The server refuses to hand an intent to an
  # agent that has not said what it understands, and this route is no exception
  # — a claim without it would be a way round the guard.
  post_json "/api/desktop/intents/claim" "$body"
}

# ── Once, for the installer ──────────────────────────────────────────────────

if [ "$ONCE" = "1" ]; then
  SAMPLE=$(build_sample)
  # Printed BEFORE it is sent, so the privacy claim in the header is checkable
  # rather than taken on trust.
  echo "Sample: $SAMPLE"
  RESP=$(post_json "/api/desktop/activity" "$SAMPLE")
  if [ -z "$RESP" ]; then
    echo "neuro-agent: NEURO did not answer." >&2
    exit 1
  fi
  echo "NEURO stored: $RESP"
  # ⚠ --once runs intents too. A check mode that skips the interesting half is
  # a check that proves the boring half.
  run_intents "$RESP"
  exit 0
fi

echo "NEURO desktop agent -> $BASE_URL. Sampling every ${INTERVAL}s, checking for launches every ${CLAIM_SECONDS}s."

NEXT_SAMPLE=0
while true; do
  NOW=$(date +%s)
  if [ "$NOW" -ge "$NEXT_SAMPLE" ]; then
    # The response is still read: a sample post can also carry an intent, so a
    # press is never lost even when the claim poll is failing.
    RESP=$(post_json "/api/desktop/activity" "$(build_sample)")
    run_intents "$RESP"
    NEXT_SAMPLE=$((NOW + INTERVAL))
  fi

  # The CLAIM, on its own fast clock.
  run_intents "$(claim_intents)"
  sleep "$CLAIM_SECONDS"
done
