// Preload — exposes a minimal, safe native bridge to the SAiM renderer.
// Available as window.saimNative. Absent in a plain browser / on the Pi kiosk, so the
// frontend treats OS lock as an optional capability and never depends on it.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('saimNative', {
  platform: process.platform,
  capabilities: () => ipcRenderer.invoke('saim:capabilities'),
  lockOS: () => ipcRenderer.invoke('saim:lock'),
  wakeOS: () => ipcRenderer.invoke('saim:wake'),
  attention: (on) => ipcRenderer.invoke('saim:attention', !!on),
  // Subscribe to "Windows was unlocked" (Hello). Returns an unsubscribe fn.
  onOSUnlock: (cb) => {
    const handler = () => cb();
    ipcRenderer.on('saim:os-unlocked', handler);
    return () => ipcRenderer.removeListener('saim:os-unlocked', handler);
  },
});
