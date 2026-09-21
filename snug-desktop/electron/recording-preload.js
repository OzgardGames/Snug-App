const { contextBridge, ipcRenderer } = require("electron");

// The instant-replay capture window's own bridge — separate from preload.js
// (the main app window's) since this page never loads the web app at all,
// it's pure Electron content driving getUserMedia/MediaRecorder. See
// recording.html for what actually calls these.
contextBridge.exposeInMainWorld("recorder", {
  onStart: (callback) => {
    const listener = (_event, config) => callback(config);
    ipcRenderer.on("recording:start", listener);
    return () => ipcRenderer.removeListener("recording:start", listener);
  },
  onSave: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("recording:save", listener);
    return () => ipcRenderer.removeListener("recording:save", listener);
  },
  onStop: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("recording:stop", listener);
    return () => ipcRenderer.removeListener("recording:stop", listener);
  },
  // Every finished segment (periodic or save-triggered) is handed to the
  // main process as it completes — that's what lets main.js build up a
  // real rolling buffer of clean, self-contained files instead of this
  // page owning the "last N seconds" concept itself. The page can't touch
  // the filesystem under sandbox: true, so this is also how the bytes
  // actually reach disk (see recording:segment-ready in main.js).
  segmentReady: (arrayBuffer, meta) => ipcRenderer.send("recording:segment-ready", { arrayBuffer, ...meta }),
  // Acks a save request specifically — separate from segmentReady because
  // a save can fail before any segment exists to report (nothing captured
  // yet), and main.js needs to know that outcome to respond to whoever
  // asked for the save, distinct from the ring buffer bookkeeping above.
  flushComplete: (result) => ipcRenderer.send("recording:flush-complete", result),
});
