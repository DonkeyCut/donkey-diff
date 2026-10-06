const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("donkeyDiffDesktop", {
  platform: process.platform,
  development: process.argv.includes("--donkey-diff-dev"),
  getUpdateState: () => ipcRenderer.invoke("update-state"),
  activateUpdate: () => ipcRenderer.invoke("update-action"),
  onUpdateState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("update-state", listener);
    return () => ipcRenderer.removeListener("update-state", listener);
  },
  request: (route, method, body) =>
    ipcRenderer.invoke("git-request", route, method, body),
  chooseProject: () => ipcRenderer.invoke("choose-project"),
  writeClipboardText: (text) => ipcRenderer.invoke("clipboard-write-text", text),
  fileAction: (projectId, path, action) =>
    ipcRenderer.invoke("file-action", projectId, path, action),
  onOpenProject: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("open-project", listener);
    return () => ipcRenderer.removeListener("open-project", listener);
  },
});
