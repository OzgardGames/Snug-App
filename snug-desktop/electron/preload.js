const { contextBridge, ipcRenderer } = require("electron");

// Exposed to the renderer as `window.snugDesktop`. Only present when running
// inside the desktop app — the web app checks for it before using it, so
// the same room-page code runs unmodified in a browser tab.
//
// Each `on*` subscribes to a main-process-triggered action (global hotkey,
// tray click, overlay button) and returns an unsubscribe function.
function subscribe(channel) {
  return (callback) => {
    const listener = () => callback();
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  };
}

contextBridge.exposeInMainWorld("snugDesktop", {
  isDesktop: true,
  onGlobalMuteSelfToggle: subscribe("snug:mute-self-toggle"),
  onGlobalMuteAllToggle: subscribe("snug:mute-all-toggle"),
  onGlobalStartShare: subscribe("snug:start-share"),
  // The renderer reports its own mute/deafen state back to the main process
  // so the tray icon / overlay can reflect it without guessing.
  reportMuteState: (muted) => ipcRenderer.send("snug:mute-state", muted),
  reportDeafenState: (deafened) => ipcRenderer.send("snug:deafen-state", deafened),
  // The native-side windows (splash/overlay/share picker) are file://
  // pages that can't read the web layer's localStorage, so the theme has
  // to be pushed to them through the main process — see setUiTheme.
  reportTheme: (theme) => ipcRenderer.send("snug:report-theme", theme),
  // Instant replay records in its own file:// window, which gets a
  // different set of deviceIds than this page does (Chromium scopes and
  // salts them per origin), so the id of the mic chosen here is meaningless
  // over there. The LABEL is the one identifier that means the same thing
  // in both, so that's what crosses — see recording.html's pickMicStream.
  reportPreferredMicLabel: (label) => ipcRenderer.send("snug:preferred-mic-label", label),
  // Who's in the room, who's talking, what they're playing — drives the
  // always-on-top roster overlay. null when you're not in a room, which is
  // what hides it.
  reportRoomPresence: (state) => ipcRenderer.send("snug:room-presence", state),
  onGameChanged: (callback) => {
    const listener = (_event, game) => callback(game);
    ipcRenderer.on("snug:game-changed", listener);
    return () => ipcRenderer.removeListener("snug:game-changed", listener);
  },
  // Launch-at-login. On by default (Snug is a leave-it-running voice
  // client); Settings is where it gets turned off.
  getOpenAtLogin: () => ipcRenderer.invoke("snug:get-open-at-login"),
  setOpenAtLogin: (enabled) => ipcRenderer.invoke("snug:set-open-at-login", enabled),
  // Drives the custom window controls (WindowControlsPill.tsx) — there is
  // no native OS window chrome at all (see main.js's frame: false), so
  // every one of these has to be a real round trip to the main process.
  minimizeWindow: () => ipcRenderer.send("snug:window-minimize"),
  maximizeWindow: () => ipcRenderer.send("snug:window-maximize-toggle"),
  closeWindow: () => ipcRenderer.send("snug:window-close"),
  isWindowMaximized: () => ipcRenderer.invoke("snug:window-is-maximized"),
  onWindowMaximizedChange: subscribeWithValue("snug:window-maximized"),
  // Called on every route change — see main.js's compact/full window sizes.
  setWindowMode: (mode) => ipcRenderer.send("snug:window-mode", mode),
  // Drives the compact window's actual height — see useDesktopContentSize.ts.
  reportContentSize: (height) => ipcRenderer.send("snug:content-size", height),
  // Global-shortcut rebinding (Settings' Shortcuts section) and the overlay
  // toggle button — all three round-trip to main.js, which is the only
  // process that owns globalShortcut registrations and the overlay window.
  getShortcuts: () => ipcRenderer.invoke("snug:get-shortcuts"),
  setShortcut: (action, accelerator) =>
    ipcRenderer.invoke("snug:set-shortcut", { action, accelerator }),
  resetShortcuts: () => ipcRenderer.invoke("snug:reset-shortcuts"),
  toggleOverlay: () => ipcRenderer.send("snug:toggle-overlay"),
  // Manual edge/corner resize for the room window — see ResizeHandles.tsx
  // and main.js's resizeSession for why this can't just be
  // resizable: true (the window is also transparent, which breaks Windows'
  // normal OS-level edge resize hit-testing).
  startResize: (edge) => ipcRenderer.send("snug:resize-start", edge),
  resizeMove: () => ipcRenderer.send("snug:resize-move"),
  endResize: () => ipcRenderer.send("snug:resize-end"),
  // Instant replay — Settings' own toggle/buffer-length controls, plus a
  // manual "Save clip now" for testing it don't need the overlay or the
  // shortcut to exercise. The actual capture runs in its own hidden
  // window (recording.html), never this one — see main.js.
  getRecordingSettings: () => ipcRenderer.invoke("recording:get-settings"),
  setRecordingSettings: (next) => ipcRenderer.invoke("recording:set-settings", next),
  saveReplayNow: () => ipcRenderer.send("recording:save-clip"),
  openRecordingsFolder: () => ipcRenderer.invoke("recording:open-folder"),
  // Clips saved this session, for the room's Recordings list. The file
  // paths that come back are handed straight back to the three calls
  // below; main.js re-checks every one of them against the recordings
  // folder rather than trusting them (see isOurClip).
  listSessionClips: () => ipcRenderer.invoke("recording:list-session"),
  deleteClip: (file) => ipcRenderer.invoke("recording:delete-clip", file),
  playClip: (file) => ipcRenderer.invoke("recording:play-clip", file),
  readClip: (file) => ipcRenderer.invoke("recording:read-clip", file),
  // Room news as one of Snug's own notification cards. Silently does
  // nothing while the window has focus — main.js decides that, since the
  // page can't tell whether it's the window you're actually looking at.
  notify: (payload) => ipcRenderer.send("snug:notify", payload),
  onRecordingSaved: subscribeWithValue("recording:saved"),
  getRecordingUsage: () => ipcRenderer.invoke("recording:get-usage"),
  // Pushed when something OUTSIDE Settings changes these — today that's
  // the tray's "turn off" item, which would otherwise leave an open
  // Settings panel showing a stale toggle.
  onRecordingSettingsChanged: subscribeWithValue("recording:settings-changed"),

  // Auto-update. The app never restarts itself — see setupAutoUpdate in
  // main.js — so the UI's job is just to say when one is waiting and offer
  // the restart.
  getUpdateStatus: () => ipcRenderer.invoke("update:get-status"),
  checkForUpdate: () => ipcRenderer.invoke("update:check"),
  restartToUpdate: () => ipcRenderer.send("update:restart"),
  onUpdateStatus: subscribeWithValue("update:status"),
  getAppVersion: () => ipcRenderer.invoke("app:version"),
});

function subscribeWithValue(channel) {
  return (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  };
}
