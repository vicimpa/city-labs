// Bridge between the editor page and the app: file access, window state and MCP tool calls.
const { contextBridge, ipcRenderer } = require('electron');

const EVENTS = new Set(['file:changed', 'file:open-request', 'menu', 'app:save-and-close', 'mcp:call', 'update']);

contextBridge.exposeInMainWorld('vspbHost', {
  platform: process.platform,
  menu: (x, y) => ipcRenderer.send('app:menu', { x, y }),
  zoom: () => ipcRenderer.send('app:zoom'),
  setLang: (l) => ipcRenderer.send('app:lang', l),
  current: () => ipcRenderer.invoke('file:current'),
  reload: () => ipcRenderer.invoke('file:reload'),
  open: () => ipcRenderer.invoke('file:open'),
  openPath: (p) => ipcRenderer.invoke('file:openPath', p),
  openSample: () => ipcRenderer.invoke('file:sample'),
  newFile: () => ipcRenderer.invoke('file:new'),
  save: (bytes) => ipcRenderer.invoke('file:save', bytes),
  saveAs: (bytes) => ipcRenderer.invoke('file:saveAs', bytes),
  info: () => ipcRenderer.invoke('app:info'),
  update: (action) => ipcRenderer.invoke('app:update', action),
  setDirty: (d) => ipcRenderer.send('doc:dirty', d),
  setTitle: (t) => ipcRenderer.send('doc:title', t),
  closeNow: () => ipcRenderer.send('app:close-now'),
  toolResult: (id, result) => ipcRenderer.send('mcp:result', { id, result }),
  on: (channel, fn) => { if (EVENTS.has(channel)) ipcRenderer.on(channel, (_e, data) => fn(data)); },
});
