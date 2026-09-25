const { contextBridge, ipcRenderer } = require("electron");

// Read-only by design: this window shows room state and can't act on it.
// It's click-through and non-focusable (see createRosterOverlayWindow in
// main.js), so there's nothing for it to send back.
contextBridge.exposeInMainWorld("rosterOverlay", {
  onPresence: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("roster:presence", listener);
    return () => ipcRenderer.removeListener("roster:presence", listener);
  },
  onTheme: (callback) => {
    const listener = (_event, theme) => callback(theme);
    ipcRenderer.on("snug:theme", listener);
    return () => ipcRenderer.removeListener("snug:theme", listener);
  },
});
