'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  init: () => ipcRenderer.invoke('init'),
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  loadConversation: (title) => ipcRenderer.invoke('load-conversation', title),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (patch) => ipcRenderer.invoke('save-settings', patch),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
});
