'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  init: () => ipcRenderer.invoke('init'),
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  loadConversation: (title) => ipcRenderer.invoke('load-conversation', title),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (patch) => ipcRenderer.invoke('save-settings', patch),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  exportImage: (title, msgIds) => ipcRenderer.invoke('export-image', title, msgIds),
  saveImage: (src) => ipcRenderer.invoke('save-image', src),
  onExportResult: (callback) => {
    const listener = (_event, result) => callback(result);
    ipcRenderer.on('image-export-result', listener);
    return () => ipcRenderer.removeListener('image-export-result', listener);
  },
});
