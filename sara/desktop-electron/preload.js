// Preload — exposes a minimal, safe native bridge to the SARA renderer.
// Available as window.saraNative. Absent in a plain browser / on the Pi kiosk, so the
// frontend treats OS lock as an optional capability and never depends on it.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('saraNative', {
  platform: process.platform,
  capabilities: () => ipcRenderer.invoke('sara:capabilities'),
  lockOS: () => ipcRenderer.invoke('sara:lock'),
  wakeOS: () => ipcRenderer.invoke('sara:wake'),
  attention: (on) => ipcRenderer.invoke('sara:attention', !!on),
  // Subscribe to "Windows was unlocked" (Hello). Returns an unsubscribe fn.
  onOSUnlock: (cb) => {
    const handler = () => cb();
    ipcRenderer.on('sara:os-unlocked', handler);
    return () => ipcRenderer.removeListener('sara:os-unlocked', handler);
  },
});
