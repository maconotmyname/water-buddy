'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const waterBuddyApi = {
  getModel: () => ipcRenderer.invoke('water-buddy:get-model'),
  previewSettings: (settings) => ipcRenderer.invoke('water-buddy:preview-settings', settings),
  saveSettings: (settings, mode) => ipcRenderer.invoke('water-buddy:save-settings', settings, mode),
  setMode: (mode) => ipcRenderer.invoke('water-buddy:set-mode', mode),
  drink: () => ipcRenderer.invoke('water-buddy:drink'),
  undoDrink: () => ipcRenderer.invoke('water-buddy:undo-drink'),
  windowAction: (action) => ipcRenderer.invoke('water-buddy:window-action', action),
  moveWindow: (movement) => ipcRenderer.send('water-buddy:move-window', movement),
  setPetPeek: (open) => ipcRenderer.send('water-buddy:pet-peek', Boolean(open)),
  onModel: (callback) => subscribe('water-buddy:model', callback),
  onReminder: (callback) => subscribe('water-buddy:reminder', callback),
  onOpenSettings: (callback) => subscribe('water-buddy:open-settings', callback),
  onWindowMode: (callback) => subscribe('water-buddy:window-mode', callback)
};

if (process.env.WATER_BUDDY_TEST_MODE === 'true') {
  waterBuddyApi.testSetNow = (timestamp) => ipcRenderer.invoke('water-buddy:test-set-now', timestamp);
}

contextBridge.exposeInMainWorld('waterBuddy', waterBuddyApi);
