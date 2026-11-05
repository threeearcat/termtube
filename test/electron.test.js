'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const entry = path.join(__dirname, '..', 'electron.js');
const source = fs.readFileSync(entry, 'utf8');

function boot({ primary = true, ready = Promise.resolve(), handoff = false } = {}) {
    const calls = [];
    const windows = [];
    const app = new EventEmitter();
    app.disableHardwareAcceleration = () => {};
    app.requestSingleInstanceLock = () => { calls.push('lock'); return primary; };
    app.quit = () => calls.push('quit');
    app.whenReady = () => ready;
    const ipcMain = new EventEmitter();
    ipcMain.handle = () => {};
    class BrowserWindow extends EventEmitter {
        constructor(options) {
            super();
            this.visible = options.show;
            this.minimized = false;
            this.webContents = { send() {} };
            windows.push(this);
        }
        loadFile() {}
        isVisible() { return this.visible; }
        isMinimized() { return this.minimized; }
        restore() { calls.push('restore'); this.minimized = false; }
        show() { calls.push('show'); this.visible = true; }
        hide() { this.visible = false; }
        focus() { calls.push('focus'); }
    }
    class Player {
        constructor() {
            calls.push('player');
            this.emitter = new EventEmitter();
        }
    }
    class Downloader {
        constructor() { calls.push('downloader'); }
    }
    const modules = {
        electron: { app, BrowserWindow, ipcMain },
        path,
        './service': { startService() { return handoff; } },
        [path.join(__dirname, '..', 'player')]: { Player },
        [path.join(__dirname, '..', 'downloader')]: { Downloader },
        [path.join(__dirname, '..', 'backend')]: { start() { calls.push('backend'); } },
        [path.join(__dirname, '..', 'pid')]: {
            killExisting() { calls.push('kill-existing'); },
            writePid() { calls.push('write-pid'); },
        },
    };
    vm.runInNewContext(source, {
        __dirname: path.dirname(entry),
        require(name) {
            assert.ok(Object.hasOwn(modules, name), `unexpected import: ${name}`);
            if (!['electron', 'path'].includes(name)) calls.push(`load:${path.basename(name)}`);
            return modules[name];
        },
    }, { filename: entry });
    return { app, calls, windows };
}

test('a duplicate quits before loading the backend or touching the PID, MPD, or command socket', async () => {
    const { calls, windows } = boot({ primary: false });
    await Promise.resolve();
    assert.deepEqual(calls, ['lock', 'quit']);
    assert.equal(windows.length, 0);
});

test('a launcher hands off to the service before touching playback or the PID file', async () => {
    const { calls, windows } = boot({ handoff: true });
    await Promise.resolve();
    assert.ok(calls.includes('quit'));
    assert.equal(calls.includes('player'), false);
    assert.equal(calls.includes('write-pid'), false);
    assert.equal(windows.length, 0);
});

test('the primary acquires its lock before initializing exactly one player and window', async () => {
    const { calls, windows } = boot();
    await Promise.resolve();
    assert.equal(calls[0], 'lock');
    for (const action of ['write-pid', 'player', 'downloader', 'backend']) {
        assert.equal(calls.filter(c => c === action).length, 1);
    }
    assert.equal(windows.length, 1);
    assert.equal(windows[0].visible, false);
});

test('repeated background launches keep the existing window and backend unchanged', async () => {
    const { app, calls, windows } = boot();
    await Promise.resolve();
    const before = calls.slice();
    for (let i = 0; i < 10; i++) app.emit('second-instance', {}, ['electron', '.', '--background']);
    await Promise.resolve();
    assert.deepEqual(calls, before);
    assert.equal(windows.length, 1);
    assert.equal(windows[0].visible, false);
});

test('manual launches, including --kill, restore the same window without restarting playback', async () => {
    const { app, calls, windows } = boot();
    await Promise.resolve();
    windows[0].minimized = true;
    const before = calls.slice();
    app.emit('second-instance', {}, ['electron', '.', '--kill']);
    await Promise.resolve();
    assert.deepEqual(calls.slice(before.length), ['restore', 'show', 'focus']);
    app.emit('second-instance', {}, ['electron', '.']);
    await Promise.resolve();
    assert.equal(windows.length, 1);
    assert.equal(windows[0].visible, true);
    assert.equal(calls.filter(c => c === 'write-pid').length, 1);
    assert.equal(calls.filter(c => c === 'backend').length, 1);
});

test('a launch during startup waits for readiness and still creates only one window', async () => {
    let finishReady;
    const ready = new Promise(resolve => { finishReady = resolve; });
    const { app, windows, calls } = boot({ ready });
    app.emit('second-instance', {}, ['electron', '.']);
    assert.equal(windows.length, 0);
    finishReady();
    await ready;
    assert.equal(windows.length, 1);
    assert.equal(windows[0].visible, true);
    assert.equal(calls.filter(c => c === 'backend').length, 1);
});

test('activation reuses the existing window', async () => {
    const { app, windows } = boot();
    await Promise.resolve();
    for (let i = 0; i < 3; i++) app.emit('activate');
    await Promise.resolve();
    assert.equal(windows.length, 1);
    assert.equal(windows[0].visible, true);
});
