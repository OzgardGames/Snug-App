const { contextBridge, ipcRenderer } = require("electron");

// The overlay is its own tiny renderer (not the Next.js app). Its buttons
// send REQUESTS to the main process (overlay:* channels) rather than
// pretending to be the app renderer — main.js turns each into the same
// dispatch a global shortcut would trigger, so behavior is identical no
// matter which trigger fired it. Kept distinct from the snug:* channels
// (main -> app renderer commands) so direction is unambiguous.
contextBridge.exposeInMainWorld("overlay", {
  muteSelf: () => ipcRenderer.send("overlay:request-mute-self"),
  muteAll: () => ipcRenderer.send("overlay:request-mute-all"),
  startShare: () => ipcRenderer.send("overlay:request-share"),
  saveReplay: () => ipcRenderer.send("overlay:request-save-replay"),
  onMuteState: (callback) => {
    const listener = (_event, muted) => callback(muted);
    ipcRenderer.on("overlay:mute-state", listener);
    return () => ipcRenderer.removeListener("overlay:mute-state", listener);
  },
  onDeafenState: (callback) => {
    const listener = (_event, deafened) => callback(deafened);
    ipcRenderer.on("overlay:deafen-state", listener);
    return () => ipcRenderer.removeListener("overlay:deafen-state", listener);
  },
  // Fired once per save attempt (success or failure) — see triggerSaveClip
  // / notifyRecordingResult in main.js. The overlay has no room for error
  // text, so this only drives a brief flash on the button itself; the real
  // message goes to the main window as a toast.
  onSaveResult: (callback) => {
    const listener = (_event, result) => callback(result);
    ipcRenderer.on("overlay:save-result", listener);
    return () => ipcRenderer.removeListener("overlay:save-result", listener);
  },
  // The overlay window is a full square (see main.js) but only the quarter
  // -circle drawn inside it should ever intercept clicks — everything
  // outside that curve needs to fall through to the game underneath.
  // overlay.html tracks the cursor and toggles this itself.
  // Live theme updates — the overlay outlives a theme switch, unlike the
  // splash, so it can't rely on the value baked into its URL at load.
  onTheme: (callback) => {
    const listener = (_event, theme) => callback(theme);
    ipcRenderer.on("snug:theme", listener);
    return () => ipcRenderer.removeListener("snug:theme", listener);
  },
  setInteractive: (interactive) => ipcRenderer.send("overlay:set-interactive", interactive),
});
