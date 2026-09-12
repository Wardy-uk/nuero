#!/bin/bash
# Put SARA back in front on the Android kiosks, when something else took the screen.
#
# ⚠ WHY THIS EXISTS. Nick, 12 Sep 2026: "restart Sara on the p30 — its back to
# the sensor page again." The P30 runs BOTH the room sensor app and Fully Kiosk
# showing SARA, and the sensor's persistent notification opens its own
# MainActivity when tapped. Nothing brings Fully back afterwards, because Fully
# is NOT the default launcher — so any excursion (a notification tap, a settings
# visit, an app update) leaves SARA hidden until someone drives ADB by hand.
#
# ⚠ THE PROPER FIX IS BLOCKED, not skipped. Making Fully the launcher is the
# thing that would cover every cause at once, and it cannot be done here:
# `cmd package set-home-activity` refuses for all three of Fully's HOME
# components, and the system's own "Default home app" screen lists only Huawei
# Home — Fully never registers as a launcher, which is consistent with its
# launcher/kiosk mode being a Plus-licensed feature. Parked on 12 Sep. This is
# the compensating control, and it should be deleted the day Fully is the
# launcher.
#
# ⚠ IT NEVER FIGHTS HIM. If the phone has been touched in the last IDLE_MIN
# minutes it stands DOWN and records that it did — someone reading the sensor's
# fault screen must not have it yanked away every five minutes, which is the
# behaviour that gets a watchdog deleted. An UNREADABLE idle signal also stands
# down rather than acting blind: a visible "I could not tell" gets the problem
# fixed, where a watchdog quietly wrestling the user does not.
#
# ⚠ IT ONLY EVER STARTS THINGS. No kill, no force-stop, no settings written. The
# worst it can do is bring a foreground app forward.
#
# ⚠ AND IT CANNOT SURVIVE A PHONE REBOOT. Checked, not assumed:
# `service.adb.tcp.port` is 5555 but `persist.adb.tcp.port` is EMPTY, and
# setting it fails without root. So adb-over-TCP is live for THIS boot only —
# after the P30 restarts, nothing here can reach it until adb over TCP is
# re-enabled from USB. That is recorded in the status file as `unreachable`
# rather than looking like a quiet, healthy device.
#
# Shape borrowed from `~/bin/pi4-watch.sh` on pi5 (cron + a status JSON under
# /mnt/data/logs), because that is the house convention for a Pi-local watcher.
# ⚠ It lives in the REPO rather than in ~/bin, deliberately: those scripts are
# unversioned and this one encodes decisions worth reviewing. Cron calls it at
# its repo path, so `git pull` is the whole deployment and there is no second
# copy to drift.

set -uo pipefail

# serial|label — the tablet is listed because it has the identical arrangement
# (Fully in front, sensor app behind) and therefore the identical failure.
DEVICES=(
  "192.168.1.119:5555|p30-bedroom"
  "192.168.1.201:5555|tab-study"
)

KIOSK_PKG="de.ozerov.fully"
KIOSK_ACT="de.ozerov.fully/.FullyActivity"
IDLE_MIN="${IDLE_MIN:-10}"
OUT="${OUT:-/mnt/data/logs/kiosk-watchdog.json}"

mkdir -p "$(dirname "$OUT")"

ADB=$(command -v adb || true)
if [ -z "$ADB" ]; then
  printf '{"checkedAt":"%s","ok":false,"why":"adb not on PATH"}\n' "$(date -Is)" > "$OUT"
  exit 1
fi

# `adb shell` inherits stdin from cron, which can be a closed pipe — every call
# gets </dev/null for the same reason the existing tab.sh does it.
sh_() { "$ADB" -s "$1" shell "${@:2}" </dev/null 2>/dev/null; }

entries=()
acted=0
stood_down=0
unreachable=0

for spec in "${DEVICES[@]}"; do
  serial="${spec%%|*}"
  label="${spec##*|}"

  # adb-over-TCP drops silently; a reconnect is cheap and a no-op when attached.
  if ! "$ADB" devices 2>/dev/null | grep -q "^${serial}[[:space:]]*device"; then
    "$ADB" connect "$serial" >/dev/null 2>&1
  fi
  if ! "$ADB" devices 2>/dev/null | grep -q "^${serial}[[:space:]]*device"; then
    unreachable=$((unreachable + 1))
    entries+=("{\"device\":\"$label\",\"state\":\"unreachable\",\"action\":\"none\"}")
    continue
  fi

  fg=$(sh_ "$serial" dumpsys activity activities | grep -m1 "mResumedActivity" || true)
  if [ -z "$fg" ]; then
    entries+=("{\"device\":\"$label\",\"state\":\"unknown\",\"action\":\"none\",\"why\":\"no mResumedActivity\"}")
    continue
  fi

  if printf '%s' "$fg" | grep -q "$KIOSK_PKG"; then
    # The normal case, and it says nothing further. A watchdog that logs a line
    # every five minutes to report that nothing happened is one nobody reads.
    entries+=("{\"device\":\"$label\",\"state\":\"ok\",\"action\":\"none\"}")
    continue
  fi

  # Something else has the screen. Is he using it?
  #
  # ⚠ `mLastUserActivityTime=` with the EQUALS SIGN. `dumpsys power` also prints
  # `mLastUserActivityTimeNoChangeLights=` and
  # `mLastUserActivityTime(excludingAttention)=`, and a looser match picks up the
  # wrong one — which would read a different clock and stand down or act for the
  # wrong reason.
  idle_ms=$(sh_ "$serial" dumpsys power \
    | sed -n 's/.*mLastUserActivityTime=[0-9]* (\([0-9]*\) ms ago).*/\1/p' \
    | head -1)

  if ! printf '%s' "$idle_ms" | grep -qE '^[0-9]+$'; then
    stood_down=$((stood_down + 1))
    entries+=("{\"device\":\"$label\",\"state\":\"not-kiosk\",\"action\":\"stood-down\",\"why\":\"idle-unreadable\"}")
    continue
  fi

  if [ "$idle_ms" -lt $((IDLE_MIN * 60000)) ]; then
    stood_down=$((stood_down + 1))
    entries+=("{\"device\":\"$label\",\"state\":\"not-kiosk\",\"action\":\"stood-down\",\"why\":\"in-use\",\"idleMs\":$idle_ms}")
    continue
  fi

  sh_ "$serial" am start -n "$KIOSK_ACT" >/dev/null
  sleep 3
  after=$(sh_ "$serial" dumpsys activity activities | grep -m1 "mResumedActivity" || true)
  if printf '%s' "$after" | grep -q "$KIOSK_PKG"; then
    acted=$((acted + 1))
    entries+=("{\"device\":\"$label\",\"state\":\"restored\",\"action\":\"fronted\",\"idleMs\":$idle_ms}")
  else
    # ⚠ Reported as a FAILED restore rather than a successful one. `am start`
    # answering cleanly is not the same as the screen having changed, and this
    # is the only place that can tell the difference.
    entries+=("{\"device\":\"$label\",\"state\":\"not-kiosk\",\"action\":\"front-failed\",\"idleMs\":$idle_ms}")
  fi
done

printf '{"checkedAt":"%s","ok":true,"idleMin":%s,"restored":%s,"stoodDown":%s,"unreachable":%s,"devices":[%s]}\n' \
  "$(date -Is)" "$IDLE_MIN" "$acted" "$stood_down" "$unreachable" \
  "$(IFS=,; echo "${entries[*]}")" > "$OUT"

# Quiet when healthy; a line in the cron log only when something was done or
# deliberately not done.
if [ "$acted" -gt 0 ] || [ "$stood_down" -gt 0 ] || [ "$unreachable" -gt 0 ]; then
  echo "kiosk-watchdog: restored=$acted stood-down=$stood_down unreachable=$unreachable"
fi
