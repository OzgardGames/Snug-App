const { contextBridge, ipcRenderer } = require("electron");

// The desktop-only replacement for the browser's native screen-share
// picker — see main.js's openSharePicker. Exposed as window.sharePicker.
contextBridge.exposeInMainWorld("sharePicker", {
  getSources: () => ipcRenderer.invoke("share-picker:get-sources"),
  pick: (id) => ipcRenderer.send("share-picker:pick", id),
  cancel: () => ipcRenderer.send("share-picker:cancel"),
  onTheme: (callback) => {
    const listener = (_event, theme) => callback(theme);
    ipcRenderer.on("snug:theme", listener);
    return () => ipcRenderer.removeListener("snug:theme", listener);
  },
});
