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
const { StreamResolver, YoutubeQueue } = require('../stream-resolver');

function setup(t, { count = 302, hold = new Set() } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termtube-test-'));
    const lofi = path.join(dir, 'lofi.lst');
    const playlists = path.join(dir, 'playlists.json');
    fs.writeFileSync(lofi, 'https://example.com/lofi/0\nhttps://example.com/lofi/1\n');
    fs.writeFileSync(playlists, JSON.stringify([
        { name: 'rock', url: 'https://example.com/playlist?list=rock' },
        { name: 'other', url: 'https://example.com/playlist?list=other' },
    ]));
    t.mock.method(mpd, 'connect', () => new EventEmitter());
    t.mock.method(unix, 'handler', () => null);
    const calls = [];
    const scheduler = new YoutubeQueue((file, args, callback) => {
        const child = {
            args, signals: [],
            kill(signal) { this.signals.push(signal); },
            finish(error = null, stdout = '', stderr = '') { callback(error, stdout, stderr); },
        };
        calls.push(child);
        return child;
    }, { interval: 0, cooldown: 3600000 });
    const player = new Player(path.join(dir, 'command.sock'), lofi, playlists, new StreamResolver(scheduler), path.join(dir, 'session.json'));
    player._random = false;
    const commands = [];
    const queue = [];
    let playing = false;
    t.mock.method(player, '_printTitle', title => { player._currentTitle = title; });
    t.mock.method(player, '_mpdCommand', (name, args = [], callback = () => {}) => {
        const command = { name, args, callback };
        commands.push(command);
        if (hold.has(name)) return;
        if (name === 'clear') { queue.length = 0; playing = false; }
        if (name === 'add') queue.push(args[0]);
        if (name === 'play') playing = true;
        if (name === 'stop') playing = false;
        if (name === 'status') callback(null, `state: ${playing ? 'play' : 'stop'}\n`);
        else if (name === 'currentsong') callback(null, queue.length ? `file: ${queue[0]}\n` : '');
        else callback(null, '');
    });
    t.after(() => {
        player.stop();
        if (scheduler.active) scheduler.active.child.finish(new Error('terminated'));
        clearTimeout(scheduler.timer);
        fs.rmSync(dir, { recursive: true, force: true });
    });
    function list(n = count, titles = false) {
        calls.at(-1).finish(null, Array.from({ length: n }, (_, i) => `https://example.com/track/${i}\n${titles ? 'Same title' : `Track ${i}`}`).join('\n'));
    }
    function resolve(id, child = calls.at(-1)) { child.finish(null, `https://example.com/audio/${id}\n`); }
    function end() {
        queue.shift();
        playing = queue.length > 0;
        player._updateMpdState();
    }
    return { player, calls, commands, scheduler, queue, list, resolve, end, hold };
}

test('a 302-track playlist enumerates once and performs no audio lookup until play', t => {
    const { player, calls, list, queue } = setup(t);
    player.selectPlaylist('rock');
    assert.ok(calls[0].args.includes('--flat-playlist'));
    list();
    assert.equal(player.streamTracks.length, 302);
    assert.equal(calls.length, 1);
    assert.equal(queue.length, 0);
});

test('play resolves only current + next and MPD transitions without another play command', t => {
    const { player, calls, list, resolve, queue, end, commands } = setup(t);
    player.selectPlaylist('rock'); list();
    player.start();
    assert.equal(calls.length, 2);
    assert.equal(calls[1].args.at(-1), 'https://example.com/track/0');
    resolve(0);
    assert.deepEqual(queue, ['https://example.com/audio/0']);
    assert.equal(calls.length, 3);
    resolve(1);
    assert.equal(calls.length, 3, 'idle prefetch stops after the next song');
    assert.equal(queue.length, 2);
    const plays = commands.filter(c => c.name === 'play').length;
    end();
    assert.equal(player._currentTitle, 'Track 1');
    assert.equal(commands.filter(c => c.name === 'play').length, plays);
    assert.equal(calls[3].args.at(-1), 'https://example.com/track/2');
    resolve(2);
    assert.equal(queue.length, 2);
});

test('sequential playback wraps around and reuses cached URLs without growing the MPD queue', t => {
    const { player, list, resolve, calls, queue, end } = setup(t, { count: 3 });
    player.selectPlaylist('rock'); list(); player.start(); resolve(0); resolve(1);
    end(); resolve(2);
    end();
    assert.deepEqual(queue, ['https://example.com/audio/2', 'https://example.com/audio/0']);
    end();
    assert.deepEqual(queue, ['https://example.com/audio/0', 'https://example.com/audio/1']);
    assert.equal(calls.length, 4, 'one enumeration plus one lookup per played video');
});

test('track 302 starts without resolving the preceding 301 entries', t => {
    const { player, calls, list, resolve, queue } = setup(t);
    player.selectPlaylist('rock'); list(); player.playStreamTrack(301);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].args.at(-1), 'https://example.com/track/301');
    assert.ok(calls[1].args.includes('bestaudio/best'));
    resolve(301);
    assert.equal(queue[0], 'https://example.com/audio/301');
    assert.equal(calls[2].args.at(-1), 'https://example.com/track/0');
});

test('duplicate titles are selected by index, and repeated clicks reuse an active lookup', t => {
    const { player, calls, list, resolve, queue } = setup(t);
    player.selectPlaylist('rock'); list(302, true);
    player.playStreamTrack(301); player.playStreamTrack(301);
    assert.equal(calls.length, 2);
    resolve(301);
    assert.equal(queue[0], 'https://example.com/audio/301');
});

test('preparing a newly selected track keeps the current audio playing', t => {
    const { player, calls, list, resolve, commands, queue } = setup(t);
    player.selectPlaylist('rock'); list(); player.start(); resolve(0);
    const prefetch = calls.at(-1);
    const before = commands.length;
    player.playStreamTrack(301);
    assert.deepEqual(prefetch.signals, ['SIGTERM']);
    assert.equal(commands.slice(before).some(c => ['stop', 'clear'].includes(c.name)), false);
    prefetch.finish(new Error('terminated'));
    assert.equal(calls.at(-1).args.at(-1), 'https://example.com/track/301');
    resolve(301);
    assert.equal(queue[0], 'https://example.com/audio/301');
});

test('rapid selections cancel obsolete lookups and never create concurrent extractors', t => {
    const { player, calls, list, scheduler, resolve, queue } = setup(t);
    player.selectPlaylist('rock'); list(); player.playStreamTrack(300);
    const old = calls.at(-1);
    player.playStreamTrack(299); player.playStreamTrack(298); player.playStreamTrack(297);
    assert.equal(calls.length, 2);
    old.finish(null, 'https://example.com/stale\n');
    assert.equal(scheduler.pending.length, 0);
    assert.equal(calls.at(-1).args.at(-1), 'https://example.com/track/297');
    resolve(297);
    assert.equal(queue[0], 'https://example.com/audio/297');
});

test('natural end waits for the existing prefetch instead of resolving another song', t => {
    const { player, calls, list, resolve, end, queue } = setup(t);
    player.selectPlaylist('rock'); list(); player.start(); resolve(0);
    const count = calls.length;
    end();
    assert.equal(calls.length, count);
    resolve(1);
    assert.equal(queue[0], 'https://example.com/audio/1');
});

test('a failed successor is replaced while the current audio continues', t => {
    const { player, calls, list, resolve, queue } = setup(t);
    player.selectPlaylist('rock'); list(); player.start(); resolve(0);
    calls.at(-1).finish(new Error('unavailable'));
    assert.equal(player._streamPlaying, true);
    assert.equal(queue[0], 'https://example.com/audio/0');
    assert.equal(calls.at(-1).args.at(-1), 'https://example.com/track/2');
    resolve(2);
    assert.deepEqual(queue, ['https://example.com/audio/0', 'https://example.com/audio/2']);
});

test('three unavailable tracks cannot churn through an entire playlist', t => {
    const { player, calls, list, queue } = setup(t);
    player.selectPlaylist('rock'); list(); player.start();
    for (let i = 0; i < 3; i++) calls.at(-1).finish(new Error('unavailable'));
    assert.equal(calls.length, 4);
    assert.equal(queue.length, 0);
    assert.equal(player._streamAutoplay, false);
});

test('random playback chooses from the entire playlist and excludes the current track', t => {
    const { player, calls, list, resolve } = setup(t);
    t.mock.method(Math, 'random', () => 0.9999);
    player._random = true;
    player.selectPlaylist('rock'); list(); player.start();
    assert.equal(calls.at(-1).args.at(-1), 'https://example.com/track/301');
    resolve(301);
    assert.equal(calls.at(-1).args.at(-1), 'https://example.com/track/300');
});

for (const action of ['stop', 'switch-mode', 'replace-url']) {
    test(`a delayed MPD response cannot autoplay after ${action}`, t => {
        const { player, calls, commands, hold } = setup(t, { hold: new Set(['add']) });
        player.playUrl('https://www.youtube.com/live/old');
        calls[0].finish(null, 'Old live\nhttps://example.com/audio/old\n');
        const add = commands.find(c => c.name === 'add');
        if (action === 'stop') player.stop();
        else if (action === 'switch-mode') player.setMode('likes');
        else player.playUrl('https://www.youtube.com/live/new');
        hold.delete('add');
        add.callback(null);
        assert.equal(commands.filter(c => c.name === 'play').length, 0);
    });
}

test('stop cancels delayed prefetch and does not advance at a later stop notification', t => {
    const { player, list, resolve, calls, commands } = setup(t);
    player.selectPlaylist('rock'); list(); player.start(); resolve(0);
    const prefetch = calls.at(-1);
    player.stop();
    const count = calls.length;
    prefetch.finish(null, 'https://example.com/stale\n');
    player._updateMpdState();
    assert.equal(calls.length, count);
    assert.equal(commands.filter(c => c.name === 'play').length, 1);
});

test('stop during enumeration cannot autoplay, and play can reload the cancelled listing', t => {
    const { player, calls, list } = setup(t);
    player.selectPlaylist('rock'); player.start(); player.stop();
    calls[0].finish(null, 'https://example.com/stale\nStale\n');
    assert.equal(calls.length, 1);
    player.start(); list();
    assert.equal(calls.at(-1).args.at(-1), 'https://example.com/track/0');
});

test('switching playlists discards cancelled metadata and URLs', t => {
    const { player, calls, list, resolve, queue } = setup(t);
    player.selectPlaylist('rock'); list(); player.start();
    const old = calls.at(-1);
    player.selectPlaylist('other');
    old.finish(null, 'https://example.com/stale\n');
    assert.equal(player.currentPlaylist, 'other');
    assert.equal(queue.length, 0);
    assert.deepEqual(player._streamUrlToTitle, {});
    list(2); player.start(); resolve(0);
    assert.equal(queue[0], 'https://example.com/audio/0');
});

test('expired cached URLs refresh only the selected track without re-enumerating', t => {
    const { player, calls, list, resolve, queue } = setup(t);
    player.selectPlaylist('rock'); list(); player.playStreamTrack(301); resolve(301);
    const pending = calls.at(-1);
    player.stop(); pending.finish(new Error('terminated'));
    player._streamTrackJobs[301].expiresAt = 1;
    const before = calls.length;
    player.playStreamTrack(301);
    assert.equal(calls.length, before + 1);
    assert.equal(calls.at(-1).args.includes('--flat-playlist'), false);
    assert.equal(calls.at(-1).args.at(-1), 'https://example.com/track/301');
    resolve('fresh');
    assert.equal(queue[0], 'https://example.com/audio/fresh');
});

test('MPD failures refresh stale URLs once but do not loop on a fresh failing URL', t => {
    const { player, calls, list, resolve, commands, hold } = setup(t, { count: 1 });
    player.selectPlaylist('rock'); list(); player.start(); resolve(0);
    player._activeStreamTrack.expiresAt = 1;
    hold.add('status'); player._updateMpdState();
    commands.at(-1).callback(null, 'state: stop\nerror: HTTP 403\n');
    assert.equal(calls.at(-1).args.at(-1), 'https://example.com/track/0');
    resolve('fresh');
    const before = calls.length;
    player._updateMpdState(); commands.at(-1).callback(null, 'state: stop\nerror: HTTP 403\n');
    assert.equal(calls.length, before);
    assert.equal(player._streamPlaying, false);
});

test('lofi also resolves only the selected stream and a single successor', t => {
    const { player, calls, queue } = setup(t);
    player.setMode('lofi');
    assert.equal(calls.length, 0);
    assert.equal(player.streamTracks.length, 2);
    player.playStreamTrack(1);
    calls[0].finish(null, 'Lofi 1\nhttps://example.com/audio/lofi1\n');
    assert.equal(queue[0], 'https://example.com/audio/lofi1');
    assert.equal(calls[1].args.at(-1), 'https://example.com/lofi/0');
});

test('a live URL resolves title and audio, autoplays, and never prefetches itself', t => {
    const { player, calls, queue } = setup(t);
    assert.equal(player.playUrl('https://www.youtube.com/live/example'), null);
    assert.equal(player.getState().urlLoading, true);
    calls[0].finish(null, 'Live radio\r\nhttps://example.com/audio/live\r\n');
    assert.equal(player.getState().urlLoading, false);
    assert.deepEqual(player.streamTracks, ['Live radio']);
    assert.deepEqual(queue, ['https://example.com/audio/live']);
    assert.equal(calls.length, 1);
});

test('a URL playlist supports lazy selection without changing saved playlists', t => {
    const { player, calls, list, resolve } = setup(t);
    const saved = fs.readFileSync(player.playlistsPath, 'utf8');
    player.playUrl('https://www.youtube.com/watch?v=example&list=custom'); list();
    const first = calls.at(-1);
    player.playStreamTrack(301); first.finish(new Error('terminated'));
    resolve(301);
    assert.equal(fs.readFileSync(player.playlistsPath, 'utf8'), saved);
    assert.equal(player.currentPlaylist, '');
});

test('invalid URLs preserve the current mode and do not create an extractor', t => {
    const { player, calls } = setup(t);
    player.selectPlaylist('rock');
    for (const url of ['', 'not a URL', 'file:///tmp/song', '--exec=x', 'ftp://example.com', 'https://user:pass@example.com', null, {}]) {
        assert.equal(player.playUrl(url), 'invalid-url');
    }
    assert.equal(player.mode, 'stream');
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].signals, []);
});

test('URL mode can be selected before entering a URL and remembers it across mode changes', t => {
    const { player, calls } = setup(t);
    player.setMode('url'); player.start();
    assert.equal(calls.length, 0);
    player.playUrl('https://www.youtube.com/live/example');
    player.setMode('likes'); calls[0].finish(new Error('terminated'));
    player.setMode('url');
    assert.equal(player.currentUrl, 'https://www.youtube.com/live/example');
    assert.equal(calls.length, 1, 'returning to URL mode does not resolve before play');
    player.start();
    assert.equal(calls.length, 2);
});

test('returning to likes restores MPD random, repeat, and consume settings', t => {
    const { player, commands } = setup(t);
    player._random = true;
    player.setMode('lofi'); player.setMode('likes');
    for (const [name, value] of [['random', '1'], ['repeat', '1'], ['consume', '0']]) {
        assert.deepEqual(commands.findLast(c => c.name === name).args, [value]);
    }
});

test('a bot check preserves current audio, pauses prefetch, and automatically retries after cooldown', t => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000000 });
    const { player, list, resolve, calls, queue } = setup(t);
    player.selectPlaylist('rock'); list(); player.start(); resolve(0);
    calls.at(-1).finish(new Error('extract failed'), '', 'ERROR: Sign in to confirm you’re not a bot');
    assert.deepEqual(queue, ['https://example.com/audio/0']);
    assert.equal(player._streamPlaying, true);
    const before = calls.length;
    t.mock.timers.tick(3599999);
    assert.equal(calls.length, before);
    t.mock.timers.tick(1);
    assert.equal(calls.length, before + 1);
    resolve(1);
    assert.equal(queue.length, 2);
});

test('stop during cooldown prevents automatic recovery from restarting playback', t => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000000 });
    const { player, list, calls } = setup(t);
    player.selectPlaylist('rock'); list(); player.start();
    calls.at(-1).finish(new Error('HTTP Error 429'));
    player.stop();
    const before = calls.length;
    t.mock.timers.tick(3600000);
    assert.equal(calls.length, before);
});

test('cached audio can still be selected during a YouTube cooldown', t => {
    const { player, list, resolve, calls, queue } = setup(t);
    player.selectPlaylist('rock'); list(); player.start(); resolve(0);
    calls.at(-1).finish(new Error('HTTP Error 429'));
    player.stop();
    const before = calls.length;
    player.playStreamTrack(0);
    assert.deepEqual(queue, ['https://example.com/audio/0']);
    assert.equal(player._streamPlaying, true);
    assert.equal(calls.length, before);
});

test('a restarted controller restores the selection and refills the queue after natural transitions', t => {
    const original = setup(t, { count: 3 });
    original.player.selectPlaylist('rock'); original.list();
    original.player.playStreamTrack(2); original.resolve(2);
    const saved = fs.readFileSync(original.player.sessionPath, 'utf8');
    assert.equal(saved.includes('example.com/audio'), false, 'signed audio URLs must not be persisted');

    const restored = setup(t, { count: 3 });
    fs.writeFileSync(restored.player.sessionPath, saved);
    restored.player.mpd.emit('ready');
    assert.equal(restored.player.mode, 'stream');
    assert.equal(restored.player.currentPlaylist, 'rock');
    assert.equal(restored.calls.length, 1, 'reuse metadata without enumerating the playlist again');
    assert.equal(restored.calls[0].args.at(-1), 'https://example.com/track/2');
    assert.equal(restored.commands.some(c => ['clear', 'stop'].includes(c.name)), false, 'keep existing MPD audio until resolution completes');
    restored.resolve(2); restored.resolve(0);
    restored.end(); restored.resolve(1);
    assert.deepEqual(restored.queue, ['https://example.com/audio/0', 'https://example.com/audio/1']);
});

test('stopping playback persists the selection without autoplay on restart', t => {
    const original = setup(t);
    original.player.playUrl('https://www.youtube.com/live/example');
    original.calls[0].finish(null, 'Radio\nhttps://example.com/audio/live\n');
    original.player.stop();
    const restored = setup(t);
    fs.copyFileSync(original.player.sessionPath, restored.player.sessionPath);
    restored.player.mpd.emit('ready');
    assert.equal(restored.player.mode, 'url');
    assert.equal(restored.player.currentUrl, 'https://www.youtube.com/live/example');
    assert.equal(restored.calls.length, 0);
    assert.equal(restored.player._streamAutoplay, false);
    restored.player.start();
    assert.equal(restored.calls.length, 1);
});

test('a controller restart preserves the YouTube cooldown instead of issuing more lookups', t => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000000 });
    const original = setup(t);
    original.player.selectPlaylist('rock'); original.list(); original.player.start();
    original.calls.at(-1).finish(new Error('HTTP Error 429'));
    const restored = setup(t);
    fs.copyFileSync(original.player.sessionPath, restored.player.sessionPath);
    restored.player.mpd.emit('ready');
    assert.equal(restored.calls.length, 0);
    t.mock.timers.tick(3599999);
    assert.equal(restored.calls.length, 0);
    t.mock.timers.tick(1);
    assert.equal(restored.calls.length, 1);
});

test('MPD reconnection preserves stream mode and recovers an exhausted queue', t => {
    const { player, list, resolve, end, commands, queue, calls } = setup(t, { count: 2 });
    player.mpd.emit('ready');
    player.selectPlaylist('rock'); list(); player.start(); resolve(0); resolve(1);
    end();
    const before = commands.length;
    player.mpd.emit('ready');
    assert.equal(player.mode, 'stream');
    assert.equal(commands.slice(before).some(c => ['stop', 'clear'].includes(c.name)), false);
    assert.equal(queue.length, 2);
    assert.equal(calls.length, 3);
});

test('an invalid saved session falls back to a usable likes player', t => {
    const { player, calls } = setup(t);
    fs.writeFileSync(player.sessionPath, '{broken');
    player.mpd.emit('ready');
    assert.equal(player.mode, 'likes');
    assert.equal(calls.length, 0);
});
