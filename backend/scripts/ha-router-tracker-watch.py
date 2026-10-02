#!/usr/bin/env python3
"""Reload Home Assistant's ASUS router integration when it has silently frozen.

Found 2 Oct 2026: every router-based device tracker (Nick's, Helen's, Isaac's,
the tablets) had not changed for ~16 days while the integration reported
"loaded" and logged nothing. Home Assistant trusts a router tracker saying
"home" over GPS, so `person.nick` sat at home while he was at the office in
Derby — and everything reading HA's home/away for him was wrong with it.
Reloading the config entry revived it instantly.

⚠ A tracker's `last_updated` is NOT a liveness signal: it only moves when the
state or an attribute changes, so a healthy tracker for a phone sitting at home
looks exactly as old as a dead one. The integration's own load/speed sensors
are disabled. So this uses a CONTRADICTION instead, which needs nothing new:

  the router says Nick's phone is HOME, and BOTH GPS sources (the iPhone app
  and Life360) have said somewhere else for longer than STALE_MINUTES.

A healthy router integration drops a departed phone to not_home within its
consider_home window (minutes), so that state only persists when it is frozen.
The reverse disagreement is NOT acted on — a phone's Wi-Fi napping makes the
router briefly say not_home while he is in the house, and that is normal.

Runs from cron on pi5 (*/10). Reads the HA token from ~/hatoken. Logs one line
per action to stdout; quiet when there is nothing to do.
"""

import datetime
import json
import os
import urllib.request

HA = os.environ.get("HA_URL", "http://localhost:8123")
TOKEN = open(os.path.expanduser(os.environ.get("HA_TOKEN_FILE", "~/hatoken"))).read().strip()
ROUTER_TRACKER = os.environ.get("ROUTER_TRACKER", "device_tracker.nicks_iphone")
GPS_TRACKERS = os.environ.get("GPS_TRACKERS", "device_tracker.nicks_iphone_2,device_tracker.life360_nick").split(",")
STALE_MINUTES = int(os.environ.get("STALE_MINUTES", "20"))


def call(path, method="GET"):
    req = urllib.request.Request(HA + path, method=method, headers={"Authorization": "Bearer " + TOKEN})
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.load(r)


def minutes_since(iso):
    t = datetime.datetime.fromisoformat(iso.replace("Z", "+00:00"))
    return (datetime.datetime.now(datetime.timezone.utc) - t).total_seconds() / 60


def main():
    router = call("/api/states/" + ROUTER_TRACKER)
    if router.get("state") != "home":
        return
    gps = [call("/api/states/" + e.strip()) for e in GPS_TRACKERS if e.strip()]
    # Every GPS source must positively say elsewhere, and have said so for a while.
    # An unknown or unavailable GPS reading is not evidence of anything.
    away = [g for g in gps if g.get("state") not in ("home", "unknown", "unavailable", None)]
    if len(away) != len(gps) or not gps:
        return
    if min(minutes_since(g["last_changed"]) for g in away) < STALE_MINUTES:
        return
    entries = [e for e in call("/api/config/config_entries/entry") if e.get("domain") == "asuswrt"]
    for e in entries:
        call("/api/config/config_entries/entry/%s/reload" % e["entry_id"], method="POST")
        print("%s reloaded asuswrt %s: router said home, GPS said %s" % (
            datetime.datetime.now().isoformat(timespec="seconds"), e["entry_id"],
            ", ".join(g["state"] for g in away)), flush=True)


if __name__ == "__main__":
    main()
