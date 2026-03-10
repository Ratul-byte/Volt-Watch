const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('voltwatch', {
  onUpdate: (callback) => ipcRenderer.on('update', (_, data) => callback(data)),
  getData: () => ipcRenderer.invoke('get-data'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
  resetData: () => ipcRenderer.invoke('reset-data'),
  getSystemInfo: () => ipcRenderer.invoke('get-system-info'),
});
