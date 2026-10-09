const { contextBridge, ipcRenderer } = require('electron');

// Expose named window commands only, never ipcRenderer, Node, file access or service credentials.
contextBridge.exposeInMainWorld('jobloomDesktop', Object.freeze({
  platform: 'windows',
  minimize: () => ipcRenderer.invoke('desktop:window', 'minimize'),
  toggleMaximize: () => ipcRenderer.invoke('desktop:window', 'toggle-maximize'),
  close: () => ipcRenderer.invoke('desktop:window', 'close'),
}));
