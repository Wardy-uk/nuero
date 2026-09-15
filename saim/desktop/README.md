# SAiM Pi desktop launcher (WS2-WP1)

This folder is the **Pi desktop launcher path**: a desktop icon that opens SAiM
Mission Control full-screen on the Pi 5.

| File | Role |
|------|------|
| `SAiM.desktop` | XDG desktop entry — the clickable icon |
| `saim.svg` | Icon used by the entry |
| `../scripts/start-saim.sh` | What the entry runs: ensures the runtime is up, then opens the UI |

The launcher only **displays** SAiM. The runtime itself is kept alive by PM2
(`runtime/start.sh` + `runtime/ecosystem.config.js`) and starts on boot — see the
main [SAiM README](../README.md).

## Assumed install path

The `.desktop` entry uses `/mnt/data/nuero/saim` (the Pi 5 deployment path from
WS0). If SAiM lives elsewhere, edit the `Exec=` and `Icon=` lines in
`SAiM.desktop` to match.

## Install on the Pi 5

```bash
cd /mnt/data/nuero/saim

# 1. Make the launcher script executable
chmod +x scripts/start-saim.sh

# 2a. Put the icon on the desktop (double-click to launch)
cp desktop/SAiM.desktop ~/Desktop/
chmod +x ~/Desktop/SAiM.desktop          # Pi OS: lets the desktop trust the icon

# 2b. (optional) Also add it to the application menu
mkdir -p ~/.local/share/applications
cp desktop/SAiM.desktop ~/.local/share/applications/
update-desktop-database ~/.local/share/applications 2>/dev/null || true
```

On first double-click, Pi OS may ask whether to trust the launcher — choose
**Execute**. After that, the SAiM icon opens Mission Control full-screen.

## Launch from a terminal (no icon)

```bash
bash /mnt/data/nuero/saim/scripts/start-saim.sh
```

Override the URL if the backend is on a different host/port:

```bash
SAIM_URL=http://pi5.tailecb90f.ts.net:3005/ bash scripts/start-saim.sh
```

## Notes

- The script opens Chromium in `--kiosk` mode (full-screen, no browser chrome; Pi OS
  default browser) and falls back to `firefox --kiosk`, then `xdg-open`.
- **Taskbar:** on Pi OS labwc the panel (`wf-panel-pi`) reserves screen space and
  respawns if killed, so a kiosk window can't cover it. The launcher hides the panel
  (stops its `lwrespawn` supervisor + the panel) **for the SAiM session only** and
  restores it when the browser closes. On any desktop without `wf-panel-pi` this is a
  no-op. If SAiM is force-killed before it can restore the panel, logging out and back
  in (or a reboot) brings the panel back via the normal desktop autostart.
- If the runtime is not answering, the script nudges PM2 and waits ~10s. If it is
  still down, it tells you to run `runtime/start.sh` and exits without opening a
  blank window.
- To leave kiosk mode and bring the taskbar back: `Alt`+`F4` (labwc closes the
  window, which lets the launcher restore the panel).
