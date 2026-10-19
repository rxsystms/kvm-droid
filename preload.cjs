const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('android', {
  request: (message) => ipcRenderer.invoke('device:request', message),
  screenshots: (action) => ipcRenderer.invoke('screenshots:request', action),
});
