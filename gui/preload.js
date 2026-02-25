const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('termtube', {
    getState: () => ipcRenderer.invoke('get-state'),
    playerAction: (action) => ipcRenderer.send('player-action', action),
    playTrack: (filename) => ipcRenderer.send('play-track', filename),
    playStreamTrack: (title) => ipcRenderer.send('play-stream-track', title),
    setMode: (mode) => ipcRenderer.send('set-mode', mode),
    addPlaylist: (name, url) => ipcRenderer.invoke('add-playlist', { name, url }),
    removePlaylist: (name) => ipcRenderer.send('remove-playlist', name),
    selectPlaylist: (name) => ipcRenderer.send('select-playlist', name),
    onStateChanged: (cb) => ipcRenderer.on('state-changed', (_e, state) => cb(state)),
    onTitleChanged: (cb) => ipcRenderer.on('title-changed', (_e, title) => cb(title)),
    onPlaylistChanged: (cb) => ipcRenderer.on('playlist-changed', (_e, videos) => cb(videos)),
    onPlaylistsChanged: (cb) => ipcRenderer.on('playlists-changed', (_e, playlists) => cb(playlists)),
    onStreamTracksChanged: (cb) => ipcRenderer.on('stream-tracks-changed', (_e, tracks) => cb(tracks)),
});
