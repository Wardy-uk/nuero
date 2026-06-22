# Apple Watch IRK capture — RESULTS

## The IRK (proven correct)
- Raw (BlueZ `/var/lib/bluetooth/<adapter>/<watch>/info`): `2E0F010E4738175560D042FA99A1BF2D`
- **Home Assistant / Private BLE Device format (USE THIS): `2dbfa199fa42d0605517384738010e0f`**
- Verified: HA's bundled resolver (`bluetooth_data_tools.resolve_private_address`) matches
  this reversed form against the Watch's live RPAs (observed e.g. `4B:7F:44:E3:37:88`,
  `6E:DD:4E:04:72:09` — two different rotating addresses, same key = the Watch).

## How it was captured
- `pihrm.py` = a fake BLE Heart Rate Monitor (service `0x180D`, HR Measurement char
  flagged `encrypt-read`) that forces the Watch to bond from
  **Settings → Bluetooth → Health Devices**. On bond, watchOS distributes its IRK,
  which BlueZ writes to `/var/lib/bluetooth/88:A2:9E:BA:06:96/<watch-mac>/info`.
- Re-run capture: `sudo systemd-run --unit=pihrm --collect /usr/bin/python3 -u ~/watch-irk/pihrm.py`
- Verify a key vs live adverts: `python3 ~/watch-irk/verify_irk.py <addrs...>`

## Why HA on the Pi cannot use it (the hardware wall)
- Pi onboard Bluetooth = **brcm bcm43438**. HA reports it does **NOT support passive scan**
  (`components/bluetooth/config_flow.py` returns `LocalNoPassiveOptionsFlowHandler`
  when `manager.supports_passive_scan` is False — so there is no "passive" option to set).
- An Apple Watch advertises its resolvable address sparsely and non-connectable. The Pi's
  active-only scanning catches it only intermittently — never reliably inside the
  config-flow's check window — so adding Private BLE Device always returns `irk_not_found`.
- IMPORTANT: the IRK and its format are correct. The radio is the limitation, not the key.
- Also note: while the Watch is BONDED to the Pi, BlueZ resolves its address to the fixed
  identity and HA never sees a raw RPA. For Private BLE the Watch must stay UNBONDED.

## The fix (last mile): ESP32 Bluetooth Proxy
1. Get any ESP32 dev board (~£5).
2. Flash ESPHome Bluetooth Proxy via the web installer: https://esphome.io/projects/
   (use Chrome/Edge, plug in the ESP32, Connect, choose Bluetooth Proxy, enter wifi).
3. It auto-discovers in HA (Settings → Devices). HA now has a passive-capable scanner.
4. Add Private BLE Device with IRK `2dbfa199fa42d0605517384738010e0f` → resolves the Watch.
5. Tell Claude the new `sensor.<watch>_estimated_distance` entity id to wire SARA's lock:
   - `SARA_HA_PROXIMITY_ENTITY=sensor.<watch>_estimated_distance`
   - `SARA_HA_PROXIMITY_AWAY_M=5`

## Current SARA state
- Auto-lock works on the iPhone tracker (`device_tracker.nicks_iphone`). Unchanged and working.
- PiHRM peripheral stopped; adapter restored to non-discoverable/non-pairable.
