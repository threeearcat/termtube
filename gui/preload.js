const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('termtube', {
    getState: () => ipcRenderer.invoke('get-state'),
    playerAction: (action) => ipcRenderer.send('player-action', action),
    onStateChanged: (cb) => ipcRenderer.on('state-changed', (_e, state) => cb(state)),
    onTitleChanged: (cb) => ipcRenderer.on('title-changed', (_e, title) => cb(title)),
    onPlaylistChanged: (cb) => ipcRenderer.on('playlist-changed', (_e, videos) => cb(videos)),
});
