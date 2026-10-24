# Hume Band V1 capture (24 Oct 2026)

Foreground Bluetooth capture of the Hume Band V1 (a rebadged J-Style 2208) by the
NEURO iOS app, stored in NEURO with provenance. **Every BP value is an experimental
Hume estimate**: it is never written to Apple Health, never joins HiLo/cuff readings,
`health_samples`, `health_daily` or any summary, alert or recommendation, and is
never corrected (no +12/+8, no clamping).

## Pieces

| Where | What |
|---|---|
| `nuero-ios` `NeuroKit/Sources/NeuroKit/HumeV1.swift` | Command whitelist (`HumeV1Command`, private init) + `HumeV1Safety.isAllowed`, decoder, `HumeV1Runner` (sync / live over a `HumeV1Link`), `HumeV1CaptureBundle` (DurableItem), display summary. Foundation only. |
| `nuero-ios` `Neuro/Sensors/HumeBandService.swift` | CoreBluetooth adapter (`HumeCBLink`), remembered peripheral, one connection per operation, `DurableQueue` (`hume-v1-captures.json`), uploader. |
| `nuero-ios` `Neuro/Features/HumeDeviceScreen.swift` | Feeds → Hume band → **Hume band** (device, latest experimental BP, sync, live, upload, Diagnostics). The old survey lab stays beside it. |
| `backend/services/hume-band-decode.js` | PURE decoder (authoritative), `hume-v1-decoder@1`. |
| `backend/services/hume-band.js` | Validation, idempotent ingest, reads. The only reader/writer of `hume_*` tables. |
| `backend/routes/hume.js` | `/api/health/hume/*`, mounted in `server.js` ahead of `/api/health`. |
| `backend/db/schema.sql` | `hume_devices`, `hume_capture_bundles`, `hume_packets`, `hume_sync_runs`, `hume_history_records`, `hume_live_sessions`, `hume_live_updates`, `hume_calibrations` (CREATE IF NOT EXISTS — no migration step). |

## Commands the app may send (nothing else)

Read-only: `22` address, `27` firmware, `41` clock, `88` calibration, `56 00` history
start, `56 02` history continue, `28 01 01 00 <secs LE>` live start (120 s),
`28 01 00` live stop. `HumeV1Safety.isAllowed` re-checks every frame at the write
site; `0x99` in byte 0 or 1 is refused outright (it turns a history read into a
delete). No calibration write, clock set, profile change, firmware or reset traffic.

`22`/`27`/`41` are read-only additions to the brief: `22` gives the band's own
Bluetooth address (the server's device key, stable across phones), `41` the band
clock that lets NEURO say which UTC offset the band's timestamps were written in.

## Protocol facts (from the real captures)

- History: newest record first, index 0 upward; 240-byte notifications on Windows
  (16 records); the end marker `56 FF` follows the last record. Every capture so far
  (4 reads, 21–22 Oct) returned **exactly 204 records**, covering only ~9 hours.
  That looks like a per-read cap, so the runner asks for ONE continuation (`56 02`)
  after a page of ≥200 new records, and stops when a page brings nothing new.
  **Continuation has never been observed on hardware.**
- Live: ~1 notification/second; HR moves, BP is 0 until the band produces a result
  (one populated packet ~88 s in, in the 21 Oct run), then quiet. The runner stops
  6 s after a BP pair, at 120+15 s, on cancel, or on disconnect, and always sends
  the stop if still connected.
- Calibration `88`: minDia, maxDia, minSys, maxSys. Recorded as OBSERVED at capture
  time, never asserted to apply to earlier readings.

## Time

Band timestamps are wall clock with no zone. NEURO stores the raw local string and,
per record: `utc_at`, `utc_method`, `utc_offset_min`, `tz_name`, `tz_rules_utc`,
`time_flags`.
- `band-clock-offset` (preferred when `41` was read): offset = band clock − phone
  UTC, rounded to 15 min; drift is the remainder. Flagged
  `offset-assumed-constant-since-band-clock-set` — wrong for records older than the
  band's last clock set.
- `phone-tz-rules`: the phone's timezone rules. Flags `dst-repeated-hour` (earlier
  instant chosen) and `dst-nonexistent-local-time` (no UTC).
- When the two disagree (e.g. a band still on BST after the clocks go back on
  25 Oct 2026) both are kept and `tz-rules-disagree` is set.

## Identity and dedupe

- Upload: `(bundle_id, payload_hash)`. Same payload again → `duplicate:true`, no
  writes (except `upload_count`). Different payload under the same id → kept beside
  it, both flagged `conflict`.
- History record: `(device_id, device_local, bytes after the index)`. The index is a
  list position that shifts as the band adds records, so it is never identity. Same
  identity → `sightings++` (retransmission). Same local time, different bytes →
  both rows kept and flagged `conflict`.
- Live: one session per bundle; every update kept; at most one final BP (the last
  populated pair).

## Statuses (never "complete history")

Sync `transfer_status`: `end-marker` | `no-end-marker` | `interrupted` | `error`. A
phone-claimed `end-marker` the bytes do not show is downgraded. Coverage is always
"what this transfer returned; the band may hold more".
Live: `result` | `no-result` | `cancelled` | `interrupted` | `error`;
`status_mismatch` when the phone's word disagrees with the bytes.

## Fixtures and privacy

Real packets live ONLY in the private iOS repo:
`nuero-ios/NeuroKit/Tests/NeuroKitTests/Fixtures/hume-v1-captures.json`, copied
verbatim from `hume-capture-20261022-092824-921159` and
`hume-capture-20261021-161541-725471` (the bleak probe ZIPs). This repo is public, so
`backend/services/hume-band.test.js` reads that file from the sibling checkout (or
`HUME_FIXTURES`) and SKIPS, saying so, when it is absent (e.g. on the Pi). Frames
built inside tests are labelled SYNTHETIC.

## Tests

- Backend: `services/hume-band.test.js` (21, incl. the real captures),
  `routes/hume-routing.test.js` (4, real HTTP). Mutation-checked: index in identity,
  trusting a claimed end marker.
- Swift: `NeuroKitTests/HumeV1Tests.swift` (14, mock BLE + real fixtures). Run on
  pi5 under `swift:6.0` docker with a scratch package of `HumeV1.swift` +
  `DurableQueue.swift` (location extensions stripped) + Linux stubs for
  `OutboxQueue`/`NeuroAPIClient.APIError`. The app-target files
  (`HumeBandService.swift`, `HumeDeviceScreen.swift`) need Xcode and are UNBUILT.

## Deploy

Backend: normal deploy (pull, build, `npm test`, restart). The tables are created by
`schema.sql` at boot; nothing else changes. iOS: build and install from the Mac.

## Physical iPhone acceptance test

1. Close the Hume app and nRF Connect on every device; band on the wrist, charged.
2. NEURO → Feeds → Hume band → **Hume band** → Choose band. Allow Bluetooth if asked.
   Pick "Hume Band BFCB" (the …XXXX suffix is this phone's identifier, not the MAC).
3. **Sync now.** Expect: "Last sync N records · transfer finished", a "Captured so
   far" range in band time, "Latest BP x/y" with the *Experimental Hume estimate*
   badge, and "Waiting to send 0" with a fresh "Last upload".
4. Diagnostics: first frames sent are `22…22`, `27…27`, `41…41`, `88…88`,
   `5600…56`; calibration reads dia 60–80, sys 110–130 (or whatever the band holds);
   no frame contains `99` in byte 0/1. Note whether a `5602…` page was sent and what
   it returned (the first hardware evidence on continuation).
5. On the Pi: `GET /api/health/hume/status` shows the device as
   `addr:09:04:02:18:BF:CB`, `lastSync.transfer_status`, `band_offset_min` (60 while
   the band runs BST), and record counts. Sync again: `records_retransmitted` ≈ the
   overlap, `records_new` small, no duplicates.
6. **Measure now**, wrist still. Progress counts to 120 s with HR. Expect either a
   result (shown as experimental) or "no BP result from the band". Run a second one
   and press **Cancel** after ~20 s: status "cancelled", Diagnostics shows the stop
   frame `28010000…29` sent.
7. Airplane mode → Sync now → "Waiting to send 1" and an upload error that says it
   will retry. Force-quit NEURO, reopen, airplane off → open the Hume band screen:
   pending returns to 0 and NEURO shows the bundle once.
8. Walk out of range mid-sync: status "interrupted — what arrived is kept"; the
   partial bundle still uploads.
9. Confirm Apple Health has NO new blood-pressure samples, and NEURO's My Health /
   Apple Health BP charts are unchanged.
