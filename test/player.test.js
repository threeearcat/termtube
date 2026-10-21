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
