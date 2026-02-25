'use strict'

const fs = require('fs');
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const {player} = require(__dirname + '/player');
const {downloader} = require(__dirname + '/downloader');
const backend = require(__dirname + '/backend');

const PID_FILE = process.env.HOME + '/.termtube.pid';

if (process.argv.includes('--kill')) {
    try {
        const old = parseInt(fs.readFileSync(PID_FILE, 'utf-8'));
        if (old !== process.pid) {
            process.kill(old);
            for (let i = 0; i < 30; i++) {
                try { process.kill(old, 0); } catch (_) { break; }
                require('child_process').execSync('sleep 0.1');
            }
        }
    } catch (e) {}
    try { fs.unlinkSync('/tmp/command.sock'); } catch (_) {}
}
fs.writeFileSync(PID_FILE, String(process.pid));

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
        backgroundColor: '#2a2a3e',
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

ipcMain.on('play-stream-track', (event, title) => {
    p.emitter.emit('play-stream-track', title);
});

ipcMain.on('set-mode', (event, mode) => {
    p.emitter.emit('set-mode', mode);
});

ipcMain.handle('add-playlist', (event, data) => {
    return p.addPlaylist(data.name, data.url);
});

ipcMain.on('remove-playlist', (event, name) => {
    p.emitter.emit('remove-playlist', name);
});

ipcMain.on('select-playlist', (event, name) => {
    p.emitter.emit('select-playlist', name);
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
p.emitter.on('playlists-changed', (playlists) => forwardToRenderer('playlists-changed', playlists));
p.emitter.on('stream-tracks-changed', (tracks) => forwardToRenderer('stream-tracks-changed', tracks));

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
