const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  platform: process.platform,

  pickFiles: (mode) => ipcRenderer.invoke('dialog:pickFiles', mode),
  pickDirectory: () => ipcRenderer.invoke('dialog:pickDirectory'),
  defaultDir: () => ipcRenderer.invoke('app:defaultDir'),
  exists: (target) => ipcRenderer.invoke('fs:exists', target),

  getPathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  },

  start: (payload) => ipcRenderer.invoke('task:start', payload),
  cancel: () => ipcRenderer.send('task:cancel'),

  onProgress: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('task:progress', handler);
    return () => ipcRenderer.removeListener('task:progress', handler);
  },

  windowControl: (action) => ipcRenderer.send(`win:${action}`),
});
