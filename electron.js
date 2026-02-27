'use strict';

const path = require('path');
const { app, BrowserWindow, ipcMain } = require('electron');
const { Player } = require(__dirname + '/player');
const { Downloader } = require(__dirname + '/downloader');
const backend = require(__dirname + '/backend');
const pid = require(__dirname + '/pid');

pid.killExisting();
pid.writePid();

let mainWindow = null;
const p = new Player();
const d = new Downloader();

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 400,
        height: 600,
        frame: false,
        show: false,
        resizable: true,
        backgroundColor: '#2a2a3e',
        webPreferences: {
            preload: path.join(__dirname, 'gui', 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        }
    });

    mainWindow.loadFile(path.join(__dirname, 'gui', 'index.html'));

    mainWindow.on('close', e => {
        e.preventDefault();
        mainWindow.hide();
    });
}

// IPC handlers
ipcMain.handle('get-state', () => p.getState());

ipcMain.on('player-action', (_event, action) => {
    p.emitter.emit(action);
});

ipcMain.on('play-track', (_event, filename) => {
    p.emitter.emit('play-track', filename);
});

ipcMain.on('play-stream-track', (_event, title) => {
    p.emitter.emit('play-stream-track', title);
});

ipcMain.on('set-mode', (_event, mode) => {
    p.emitter.emit('set-mode', mode);
});

ipcMain.handle('add-playlist', (_event, data) => {
    return p.addPlaylist(data.name, data.url);
});

ipcMain.on('remove-playlist', (_event, name) => {
    p.emitter.emit('remove-playlist', name);
});

ipcMain.on('select-playlist', (_event, name) => {
    p.emitter.emit('select-playlist', name);
});

ipcMain.on('toggle-random', () => {
    p.emitter.emit('toggle-random');
});

// Forward player events to renderer
function forwardToRenderer(channel, data) {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(channel, data);
    }
}

p.emitter.on('state-changed', state => forwardToRenderer('state-changed', state));
p.emitter.on('title-changed', title => forwardToRenderer('title-changed', title));
p.emitter.on('playlist-changed', videos => forwardToRenderer('playlist-changed', videos));
p.emitter.on('playlists-changed', playlists => forwardToRenderer('playlists-changed', playlists));
p.emitter.on('stream-tracks-changed', tracks => forwardToRenderer('stream-tracks-changed', tracks));

// Toggle window visibility via Unix socket command
p.emitter.on('toggle', () => {
    if (!mainWindow) return;
    if (mainWindow.isVisible()) {
        mainWindow.hide();
    } else {
        mainWindow.show();
        mainWindow.focus();
    }
});

app.whenReady().then(() => {
    createWindow();
    backend.start(p, d);
});

app.on('activate', () => {
    if (mainWindow === null) {
        createWindow();
    }
});
