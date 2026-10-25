// Splash buttons: download the new build now, or later.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('splash', { choose: (c) => ipcRenderer.send('splash:choice', c) });
