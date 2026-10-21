'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');
const mpd = require('mpd');
const unix = require('../unix');
const { Player } = require('../player');
const { StreamResolver } = require('../stream-resolver');

function fakeExec() {
    const calls = [];
    const active = new Set();
    let peak = 0;
    const run = (file, args, callback) => {
        assert.equal(file, 'yt-dlp');
        const child = {
            args,
            signals: [],
            kill(signal) {
                child.signals.push(signal);
                return true;
            },
            finish(err = null, stdout = '') {
                assert.ok(active.delete(child), 'process must finish only once');
                callback(err, stdout, '');
            },
        };
        calls.push(child);
        active.add(child);
        peak = Math.max(peak, active.size);
        return child;
    };
    return { run, calls, active, get peak() { return peak; } };
}

function createPlayer(t, lofiCount = 0) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termtube-test-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const lofiFile = path.join(dir, 'lofi.lst');
    const playlistsFile = path.join(dir, 'playlists.json');
    fs.writeFileSync(lofiFile, Array.from({ length: lofiCount }, (_, i) => `https://example.com/lofi/${i}`).join('\n'));
    fs.writeFileSync(playlistsFile, JSON.stringify([
        { name: 'calm-jazz', url: 'https://example.com/playlist?list=jazz' },
        { name: 'other', url: 'https://example.com/playlist?list=other' },
    ]));
    t.mock.method(mpd, 'connect', () => new EventEmitter());
    t.mock.method(unix, 'handler', () => null);
    const player = new Player(path.join(dir, 'command.sock'), lofiFile, playlistsFile);
    const processes = fakeExec();
    player._streamResolver = new StreamResolver(4, processes.run);
    const commands = [];
    t.mock.method(player, '_mpdCommand', (name, args = [], callback = () => {}) => {
        commands.push({ name, args, callback });
    });
    return { player, processes, commands };
}

function playlistOutput(count) {
    return Array.from({ length: count }, (_, i) => `https://example.com/track/${i}\nTrack ${i}`).join('\n');
}

test('a 302-track playlist never runs more than four resolvers and loads every track', t => {
    const { player, processes, commands } = createPlayer(t);
    player.selectPlaylist('calm-jazz');
    assert.equal(processes.calls.length, 1);
    assert.ok(processes.calls[0].args.includes('--flat-playlist'));
    processes.calls[0].finish(null, playlistOutput(302));

    assert.equal(player.streamTracks.length, 302);
    assert.equal(processes.active.size, 4);
    assert.equal(processes.calls.length, 5);

    let resolved = 0;
    while (processes.active.size > 0) {
        const child = processes.active.values().next().value;
        child.finish(null, `https://example.com/audio/${resolved++}\n`);
    }
    assert.equal(processes.peak, 4);
    assert.equal(resolved, 302);
    assert.equal(commands.filter(c => c.name === 'add').length, 302);
    assert.equal(Object.keys(player._streamUrlToTitle).length, 302);
});

test('a failed resolution frees a slot and does not prevent later tracks from loading', t => {
    const { player, processes, commands } = createPlayer(t);
    player.selectPlaylist('calm-jazz');
    processes.calls[0].finish(null, playlistOutput(5));
    processes.calls[1].finish(new Error('unavailable'));
    assert.equal(processes.active.size, 4);
    assert.equal(processes.calls.length, 6);
    for (const child of [...processes.active]) {
        child.finish(null, `https://example.com/audio/${processes.calls.indexOf(child)}\n`);
    }
    assert.equal(commands.filter(c => c.name === 'add').length, 4);
});

test('lofi resolution uses the same concurrency limit and preserves unavailable tracks', t => {
    const { player, processes, commands } = createPlayer(t, 8);
    player.setMode('lofi');
    assert.equal(player.streamTracks.length, 8);
    assert.equal(processes.active.size, 4);
    processes.calls[0].finish(new Error('unavailable'));
    assert.equal(player.streamTracks[0].broken, true);
    assert.equal(processes.active.size, 4);
    while (processes.active.size > 0) {
        const child = processes.active.values().next().value;
        const id = processes.calls.indexOf(child);
        child.finish(null, `Lofi ${id}\nhttps://example.com/audio/${id}\n`);
    }
    assert.equal(processes.peak, 4);
    assert.equal(commands.filter(c => c.name === 'add').length, 7);
});

test('autoplay can begin with the first resolved track while the rest remain queued', t => {
    const { player, processes, commands } = createPlayer(t);
    player._switchToStream(player.playlists[0], { autoplay: true });
    processes.calls[0].finish(null, playlistOutput(302));
    processes.calls[1].finish(null, 'https://example.com/audio/first\n');
    const firstAdd = commands.find(c => c.name === 'add');
    assert.ok(firstAdd);
    firstAdd.callback(null);
    assert.equal(commands.filter(c => c.name === 'play').length, 1);
    assert.equal(processes.active.size, 4);
    assert.equal(processes.calls.length, 6);
});

for (const mode of ['stream', 'lofi']) {
    test(`returning from ${mode} to likes terminates running jobs and discards queued ones`, t => {
        const { player, processes, commands } = createPlayer(t, 8);
        player.setMode(mode);
        if (mode === 'stream') processes.calls[0].finish(null, playlistOutput(302));
        const oldJobs = [...processes.active];
        const callCount = processes.calls.length;
        player.setMode('likes');
        for (const child of oldJobs) {
            assert.deepEqual(child.signals, ['SIGTERM']);
            child.finish(null, 'Old title\nhttps://example.com/stale\n');
        }
        assert.equal(processes.calls.length, callCount);
        assert.equal(processes.active.size, 0);
        assert.equal(commands.filter(c => c.name === 'add').length, 0);
        assert.deepEqual(player._streamUrlToTitle, {});
    });
}

test('switching away while the playlist is being listed cancels the listing', t => {
    const { player, processes } = createPlayer(t);
    player.selectPlaylist('calm-jazz');
    player.setMode('likes');
    assert.deepEqual(processes.calls[0].signals, ['SIGTERM']);
    processes.calls[0].finish(null, playlistOutput(302));
    assert.equal(processes.calls.length, 1);
    assert.equal(processes.active.size, 0);
    assert.deepEqual(player.streamTracks, []);
});

for (const [label, change, expectedPlaylist] of [
    ['reselecting the playlist', player => player.selectPlaylist('calm-jazz'), 'calm-jazz'],
    ['selecting another playlist', player => player.selectPlaylist('other'), 'other'],
    ['refreshing expired URLs', player => {
        player._streamUrlsExpireAt = 1;
        player.start();
    }, 'calm-jazz'],
]) {
    test(`${label} cancels old work and loads only the new selection`, t => {
        const { player, processes, commands } = createPlayer(t);
        player.selectPlaylist('calm-jazz');
        processes.calls[0].finish(null, playlistOutput(302));
        const oldJobs = [...processes.active];
        change(player);
        assert.equal(processes.calls.length, 5, 'new work waits for old processes to exit');
        for (const child of oldJobs) {
            assert.deepEqual(child.signals, ['SIGTERM']);
            child.finish(null, 'https://example.com/stale\n');
        }
        assert.equal(processes.calls.length, 6, 'only the new listing should have started');
        assert.equal(commands.filter(c => c.name === 'add').length, 0);
        assert.equal(player.currentPlaylist, expectedPlaylist);
        processes.calls[5].finish(null, playlistOutput(2));
        for (const child of [...processes.active]) {
            child.finish(null, `https://example.com/fresh/${processes.calls.indexOf(child)}\n`);
        }
        assert.equal(commands.filter(c => c.name === 'add').length, 2);
        assert.equal(processes.peak, 4);
    });
}

test('rapid mode changes retain the concurrency cap and discard intermediate selections', t => {
    const { player, processes } = createPlayer(t, 8);
    player.selectPlaylist('calm-jazz');
    processes.calls[0].finish(null, playlistOutput(302));
    const oldJobs = [...processes.active];
    for (let i = 0; i < 20; i++) {
        player.setMode('lofi');
        player.selectPlaylist('calm-jazz');
    }
    assert.equal(processes.calls.length, 5);
    for (const child of oldJobs) {
        assert.deepEqual(child.signals, ['SIGTERM'], 'repeated cancellation sends SIGTERM once');
        child.finish(new Error('terminated'));
    }
    assert.equal(processes.calls.length, 6);
    assert.equal(processes.active.size, 1);
    assert.ok(processes.calls[5].args.includes('--flat-playlist'));
    assert.equal(processes.peak, 4);
    processes.calls[5].finish(null, '');
});

for (const mode of ['stream', 'lofi']) {
    test(`a delayed MPD add response cannot autoplay after leaving ${mode}`, t => {
        const { player, processes, commands } = createPlayer(t, 1);
        if (mode === 'stream') {
            player._switchToStream(player.playlists[0], { autoplay: true });
            processes.calls[0].finish(null, playlistOutput(1));
            processes.calls[1].finish(null, 'https://example.com/audio\n');
        } else {
            player._switchToLofi({ autoplay: true });
            processes.calls[0].finish(null, 'Lofi title\nhttps://example.com/audio\n');
        }
        const add = commands.find(c => c.name === 'add');
        assert.ok(add);
        player.setMode('likes');
        add.callback(null);
        assert.equal(commands.filter(c => c.name === 'play').length, 0);
    });
}

test('a process that ignores SIGTERM is killed after the grace period', t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const processes = fakeExec();
    const resolver = new StreamResolver(1, processes.run);
    let callbacks = 0;
    resolver.exec(['-g', 'https://example.com/old'], () => callbacks++);
    resolver.cancel();
    resolver.exec(['-g', 'https://example.com/new'], () => callbacks++);
    const old = processes.calls[0];
    assert.deepEqual(old.signals, ['SIGTERM']);
    assert.equal(processes.calls.length, 1);
    t.mock.timers.tick(1000);
    assert.deepEqual(old.signals, ['SIGTERM', 'SIGKILL']);
    old.finish(new Error('killed'));
    assert.equal(callbacks, 0);
    assert.equal(processes.calls.length, 2);
    assert.equal(processes.peak, 1);
    processes.calls[1].finish(null, 'https://example.com/fresh\n');
    assert.equal(callbacks, 1);
});

test('a terminated process does not receive SIGKILL after it has exited', t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const processes = fakeExec();
    const resolver = new StreamResolver(1, processes.run);
    resolver.exec(['-g', 'https://example.com/old'], () => assert.fail('cancelled callback'));
    resolver.cancel();
    const child = processes.calls[0];
    child.finish(new Error('terminated'));
    t.mock.timers.tick(1000);
    assert.deepEqual(child.signals, ['SIGTERM']);
});
