const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('mapCache', {
  get: key => ipcRenderer.invoke('map-cache:get', key),
  put: row => ipcRenderer.invoke('map-cache:put', row),
  stats: () => ipcRenderer.invoke('map-cache:stats'),
  clear: () => ipcRenderer.invoke('map-cache:clear'),
});
