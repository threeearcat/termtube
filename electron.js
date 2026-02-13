'use strict'

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const {player} = require(__dirname + '/player');
const {downloader} = require(__dirname + '/downloader');
const backend = require(__dirname + '/backend');

let mainWindow = null;
let p = new player();
let d = new downloader();

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 400,
        height: 600,
        frame: false,
        show: false,
        resizable: true,
        backgroundColor: '#1a1a2e',
        webPreferences: {
            preload: path.join(__dirname, 'gui', 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        }
    });

    mainWindow.loadFile(path.join(__dirname, 'gui', 'index.html'));

    mainWindow.on('close', function (e) {
        e.preventDefault();
        mainWindow.hide();
    });
}

// IPC handlers
ipcMain.handle('get-state', () => {
    return p.getState();
});

ipcMain.on('player-action', (event, action) => {
    p.emitter.emit(action);
});

ipcMain.on('play-track', (event, filename) => {
    p.emitter.emit('play-track', filename);
});

// Forward player events to renderer
function forwardToRenderer(channel, data) {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(channel, data);
    }
}

p.emitter.on('state-changed', (state) => forwardToRenderer('state-changed', state));
p.emitter.on('title-changed', (title) => forwardToRenderer('title-changed', title));
p.emitter.on('playlist-changed', (videos) => forwardToRenderer('playlist-changed', videos));

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
