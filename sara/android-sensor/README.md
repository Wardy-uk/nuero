# SARA room sensor — Android

The study's room sensor, running on the old Galaxy Tab A 10.1 (2016, SM-T585, Android
8.1) that is also the study's SARA screen. It is the Android twin of
[`sara/sensor/sara-room-sensor.py`](../sensor/sara-room-sensor.py): same IRK match,
same window rules, same `POST /api/presence/sensor` contract. The backend needs no
change, and **the study's own sensor decides the study's screen** exactly as the
Pis decide theirs.

## Why a tablet app and not the browser

The Watch's Bluetooth address rotates every few minutes and only the IRK can match
it back (a Resolvable Private Address). A web page can neither scan Bluetooth in the
background nor run that check, and beacon apps (HA Companion included) only follow
fixed iBeacons. So it has to be native.

## Why the study needed a sensor at all (11 Sep 2026)

The study is on the ground floor between the kitchen/diner (pi5) and the living room
(pi-dev). Read live with Nick in the house and the bedroom sensor silent, the
fingerprint came back `kitchen / unsure — kitchen and bedroom are close (1.46 vs
1.80)`. Two sensors either side of a room cannot place someone inside it.

## Android traps it is built around

- **Android 8.1+ delivers nothing to an unfiltered scan while the screen is off.**
  Screen on: unfiltered, so the background health signal is every device, as on the
  Pis. Screen off (SARA's locked state): narrowed to Apple adverts, and the reading
  says `scanScope: "apple"`, because the health signal then means something narrower.
- **Location OFF means zero scan results and no error** on Android 6–11. Reported as a
  fault (`status: unknown`, with the reason), never as an empty room.
- **More than 5 scan starts in 30s is silently throttled**, so restarts are spaced
  7s; a long-running scan can be demoted, so it is refreshed every 25 minutes.
- **Android 10–11 withholds scan results from an app that is not in front** unless it
  holds BACKGROUND location — and the sensor always sits behind the kiosk browser.
  Declared for API 29–30, granted over ADB (`pm grant … ACCESS_BACKGROUND_LOCATION`),
  and reported as a named fault when missing. Matters for the bedroom Huawei P30.
- **The CPU sleeps with the screen off even on a charger**, so the service holds a
  partial wake lock and a Wi-Fi lock. It is a wall-powered tablet.

## Install

1. **Download** on the tablet, in Chrome:
   `https://github.com/Wardy-uk/nuero/releases/download/android-sensor-latest/sara-sensor.apk`
   Allow Chrome to install unknown apps when prompted.
2. **Open SARA Sensor** and fill in:
   - Room: `study`
   - Push URL: `http://192.168.1.16:3005/api/presence/sensor` (pi5 on the LAN — no
     Tailscale needed. Worth a DHCP reservation for pi5 so this never moves.)
   - Sensor token: blank (the backend has none set)
   - Watch IRK: the 32 hex characters from `/etc/sara-watch.env` on pi5
     (`sudo cat /etc/sara-watch.env`). Typed in once; never shown again.
   - In-room RSSI: `-80` to start (tuned below)
3. **Save & start**, allow Location, and make sure system Location is **on**.
4. **Battery:** tap "Don't battery-optimise this app", and in Samsung's Device care /
   Battery settings add SARA Sensor to the apps that are never put to sleep.

It restarts itself after a reboot once it has been started.

## Prove it works

The status block on the app's screen is the check:

- `healthy true` with a plausible `backgroundDevices` — a sensor reporting `absent`
  with `backgroundDevices 0` is broken, not lonely.
- `Last push: accepted (200)`.
- Sit at the desk: `status present`, `adverts` climbing, `rssiMedian` in the -50s/-60s.
  Walk to the kitchen: `rssiMedian` drops.

From anywhere on the tailnet:

```bash
curl -s 'http://100.100.28.58:3005/api/presence/display?room=study'
```

## Tune and teach the room

1. **Threshold.** Note `rssiMedian` sat at the desk and stood in the kitchen and living
   room; set In-room RSSI between them (the Pis landed on -70 to -80).
2. **Fingerprint.** ⚠ A `sure` fingerprint OVERRIDES a room's own sensor, and no
   profile yet includes this sensor — so teach the study, then re-teach the other
   rooms so their profiles include it too. Stand in each room ~2 minutes, turning:

   ```bash
   curl -X POST http://100.100.28.58:3005/api/presence/calibrate/start \
        -H 'Content-Type: application/json' -d '{"room":"study"}'
   # ... move about, turn, sit, stand ...
   curl -X POST http://100.100.28.58:3005/api/presence/calibrate/finish
   ```

## The screen

Fully Kiosk Browser, start URL `http://192.168.1.16:3005/?room=study`. The `?room=`
is remembered by the SARA frontend, so the screen asks
`/api/presence/display?room=study` and shows SARA / clock / locked for the study.

## Build

GitHub Actions (`.github/workflows/android-sensor.yml`) runs the unit tests and builds
on every push to `sara/android-sensor/**`, then replaces `sara-sensor.apk` on the
`android-sensor-latest` pre-release. The APK contains no secrets.

Signing uses a stable key from two repo secrets, `SARA_SENSOR_KEYSTORE_B64` and
`SARA_SENSOR_KEYSTORE_PASSWORD`. A stable key is what lets an update install over the
old build and **keep the settings** (the IRK included). Without the secrets the build
falls back to a throwaway key: fine once, but every update then needs an uninstall.
Never commit the keystore — the repo is public.

The logic that matters is pure Kotlin and pinned on the JVM: `Rpa` (the IRK match,
against a synthetic vector generated with the same Python construction the Pis use),
`Presence` (the window rules, ported line by line) and `Json`.
