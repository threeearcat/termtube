'use strict';

const path = require('path');
const { app, BrowserWindow, ipcMain } = require('electron');

// This is a tiny control window with no GPU-heavy content. Hardware
// acceleration only adds a GPU process that can fail to launch (error_code=1002)
// when the X/compositor stack is restarting (e.g. on xmonad restart), which
// crashes the app ("GPU process isn't usable. Goodbye."). Software rendering is
// plenty here and removes that failure mode. Must run before app 'ready'.
app.disableHardwareAcceleration();

// Acquire the lock before touching the PID file, MPD, or command socket.
if (app.requestSingleInstanceLock()) {
    start();
} else {
    app.quit();
}

function start() {
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

        mainWindow.on('closed', () => { mainWindow = null; });

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

    ipcMain.on('play-stream-track', (_event, selection) => {
        p.emitter.emit('play-stream-track', selection);
    });

    ipcMain.on('set-mode', (_event, mode) => {
        p.emitter.emit('set-mode', mode);
    });

    ipcMain.handle('play-url', (_event, url) => p.playUrl(url));

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

    function showWindow() {
        if (!mainWindow) createWindow();
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
    }

    // Session startup is silent. Manual launches focus the existing window.
    app.on('second-instance', (_event, argv) => {
        if (!argv.includes('--background')) app.whenReady().then(showWindow);
    });

    app.whenReady().then(() => {
        if (!mainWindow) createWindow();
        backend.start(p, d);
    });

    app.on('activate', () => {
        app.whenReady().then(showWindow);
    });
}
