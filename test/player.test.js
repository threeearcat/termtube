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

test('selecting track 302 resolves it immediately alongside four background jobs and reuses its URL', t => {
    const { player, processes, commands } = createPlayer(t);
    player.selectPlaylist('calm-jazz');
    processes.calls[0].finish(null, playlistOutput(302));
    player.playStreamTrack('Track 301');
    assert.equal(processes.calls.length, 6);
    assert.equal(processes.active.size, 5);
    assert.deepEqual(processes.calls[5].args, ['-g', 'https://example.com/track/301']);
    for (const child of processes.calls.slice(1, 5)) assert.deepEqual(child.signals, []);

    processes.calls[5].finish(null, 'https://example.com/audio/301\n');
    const count = processes.calls.length;
    player.playStreamTrack('Track 301');
    assert.equal(processes.calls.length, count, 'reuse the extraction while waiting for MPD');
    assert.equal(commands.filter(c => c.name === 'play').length, 0);
    commands.find(c => c.name === 'add').callback(null);
    commands.find(c => c.name === 'playlistfind').callback(null, 'Pos: 0\n');
    assert.deepEqual(commands.find(c => c.name === 'play').args, ['0']);
    assert.equal(processes.active.size, 4, 'background retrieval continues');

    player.playStreamTrack('Track 301');
    assert.equal(processes.calls.length, count, 'ready tracks must not be extracted again');
    commands.findLast(c => c.name === 'playlistfind').callback(null, 'Pos: 0\n');
    assert.equal(commands.filter(c => c.name === 'play').length, 2);
    assert.equal(processes.peak, 5);
    while (processes.active.size > 0) {
        const child = processes.active.values().next().value;
        child.finish(null, `https://example.com/audio/background/${processes.calls.indexOf(child)}\n`);
        commands.findLast(c => c.name === 'add').callback(null);
    }
    assert.equal(processes.calls.length, 303, 'each track is extracted exactly once');
    assert.equal(commands.filter(c => c.name === 'add').length, 302);
});

test('selecting an unloaded track stops playback and waits for that track despite background completions', t => {
    const { player, processes, commands } = createPlayer(t);
    player.selectPlaylist('calm-jazz');
    processes.calls[0].finish(null, playlistOutput(302));
    player._mpdState = 'play';
    const beforeSelection = commands.length;

    player.playStreamTrack('Track 301');
    assert.equal(commands[beforeSelection]?.name, 'stop', 'MPD must not keep playing other tracks while waiting');
    processes.calls[1].finish(null, 'https://example.com/audio/background\n');
    commands.find(c => c.name === 'add').callback(null);
    assert.equal(commands.filter(c => c.name === 'play').length, 0);

    processes.calls[5].finish(null, 'https://example.com/audio/301\n');
    commands.findLast(c => c.name === 'add').callback(null);
    const lookup = commands.find(c => c.name === 'playlistfind');
    assert.deepEqual(lookup.args, ['file', 'https://example.com/audio/301']);
    lookup.callback(null, 'Pos: 1\n');
    assert.deepEqual(commands.find(c => c.name === 'play').args, ['1']);
});

test('selecting a duplicate title by its playlist index resolves the clicked entry', t => {
    const { player, processes, commands } = createPlayer(t);
    player.selectPlaylist('calm-jazz');
    processes.calls[0].finish(null, playlistOutput(302).replaceAll(/Track \d+/g, 'Same title'));
    player.playStreamTrack(301);
    assert.deepEqual(processes.calls[5]?.args, ['-g', 'https://example.com/track/301']);
    processes.calls[5].finish(null, 'https://example.com/audio/301\n');
    commands.find(c => c.name === 'add').callback(null);
    commands.find(c => c.name === 'playlistfind').callback(null, 'Pos: 0\n');
    assert.deepEqual(commands.find(c => c.name === 'play').args, ['0']);
});

for (const mode of ['stream', 'url']) {
    for (const stopBeforeListing of [false, true]) {
        test(`${mode} URL refresh ${stopBeforeListing ? 'respects stop before listing finishes' : 'waits for the selected track instead of autoplaying another'}`, t => {
            const { player, processes, commands } = createPlayer(t);
            if (mode === 'stream') player.selectPlaylist('calm-jazz');
            else player.playUrl('https://www.youtube.com/playlist?list=custom');
            processes.calls[0].finish(null, playlistOutput(302));
            player._streamUrlsExpireAt = 1;
            player.playStreamTrack('Track 301');
            if (stopBeforeListing) player.stop();
            for (const child of [...processes.active]) child.finish(new Error('terminated'));
            const listing = processes.calls.at(-1);
            assert.ok(listing.args.includes('--flat-playlist'));
            listing.finish(null, playlistOutput(302));
            // A different track becomes ready first, as happens with concurrent loading.
            const background = [...processes.active].find(child => child.args.at(-1).endsWith('/0'));
            background.finish(null, 'https://example.com/audio/background\n');
            commands.findLast(c => c.name === 'add').callback(null);
            assert.equal(commands.filter(c => c.name === 'play').length, 0, 'background tracks must not autoplay');
            if (stopBeforeListing) return;

            const selected = [...processes.active].find(child => child.args.at(-1).endsWith('/301'));
            assert.ok(selected, 'the selected track must be resolved in the foreground after refresh');
            selected.finish(null, 'https://example.com/audio/301\n');
            commands.findLast(c => c.name === 'add').callback(null);
            const lookup = commands.find(c => c.name === 'playlistfind');
            assert.deepEqual(lookup.args, ['file', 'https://example.com/audio/301']);
            lookup.callback(null, 'Pos: 1\n');
            assert.deepEqual(commands.find(c => c.name === 'play').args, ['1']);
        });
    }
}

test('selecting a track already being resolved does not launch a duplicate process', t => {
    const { player, processes, commands } = createPlayer(t);
    player.selectPlaylist('calm-jazz');
    processes.calls[0].finish(null, playlistOutput(302));
    player.playStreamTrack('Track 0');
    assert.equal(processes.calls.length, 5);
    processes.calls[1].finish(null, 'https://example.com/audio/0\n');
    commands.find(c => c.name === 'add').callback(null);
    commands.find(c => c.name === 'playlistfind').callback(null, 'Pos: 0\n');
    assert.equal(commands.filter(c => c.name === 'play').length, 1);
    assert.equal(processes.peak, 4);
});

test('refreshing after an MPD error preserves a pending selection', t => {
    const { player, processes, commands } = createPlayer(t);
    player.selectPlaylist('calm-jazz');
    processes.calls[0].finish(null, playlistOutput(302));
    player.playStreamTrack('Track 301');
    player._streamUrlsExpireAt = 1;
    player._updateMpdState();
    commands.find(c => c.name === 'status').callback(null, 'state: stop\nerror: expired URL\n');
    for (const child of [...processes.active]) child.finish(new Error('terminated'));
    processes.calls.at(-1).finish(null, playlistOutput(302));
    const selected = [...processes.active].find(child => child.args.at(-1).endsWith('/301'));
    assert.ok(selected);
    selected.finish(null, 'https://example.com/audio/301\n');
    commands.findLast(c => c.name === 'add').callback(null);
    const lookup = commands.find(c => c.name === 'playlistfind');
    assert.deepEqual(lookup.args, ['file', 'https://example.com/audio/301']);
    lookup.callback(null, 'Pos: 0\n');
    assert.deepEqual(commands.find(c => c.name === 'play').args, ['0']);
});

test('a selected track removed during URL refresh never falls back to another track', t => {
    const { player, processes, commands } = createPlayer(t);
    player.selectPlaylist('calm-jazz');
    processes.calls[0].finish(null, playlistOutput(302));
    player._streamUrlsExpireAt = 1;
    player.playStreamTrack('Track 301');
    for (const child of [...processes.active]) child.finish(new Error('terminated'));
    processes.calls.at(-1).finish(null, playlistOutput(1));
    processes.calls.at(-1).finish(null, 'https://example.com/audio/0\n');
    commands.findLast(c => c.name === 'add').callback(null);
    assert.equal(commands.filter(c => c.name === 'play').length, 0);
});

test('a selected live URL is rebound to its refreshed track and still plays', t => {
    const { player, processes, commands } = createPlayer(t);
    player.playUrl('https://www.youtube.com/live/example');
    processes.calls[0].finish(null, 'Live\nhttps://example.com/audio/old\n');
    commands.find(c => c.name === 'add').callback(null);
    player._streamUrlsExpireAt = 1;
    player.playStreamTrack(0);
    processes.calls[1].finish(null, 'Updated live title\nhttps://example.com/audio/new\n');
    commands.findLast(c => c.name === 'add').callback(null);
    const lookup = commands.find(c => c.name === 'playlistfind');
    assert.deepEqual(lookup.args, ['file', 'https://example.com/audio/new']);
    lookup.callback(null, 'Pos: 0\n');
    assert.deepEqual(commands.findLast(c => c.name === 'play').args, ['0']);
});

test('lofi tracks can still be selected by the GUI playlist index', t => {
    const { player, processes, commands } = createPlayer(t, 2);
    player.setMode('lofi');
    processes.calls[1].finish(null, 'Second lofi\nhttps://example.com/audio/lofi/1\n');
    player.playStreamTrack(1);
    const lookup = commands.find(c => c.name === 'playlistfind');
    assert.deepEqual(lookup.args, ['file', 'https://example.com/audio/lofi/1']);
    lookup.callback(null, 'Pos: 0\n');
    assert.deepEqual(commands.find(c => c.name === 'play').args, ['0']);
});

test('rapid track selections prioritize the latest choice and use only one foreground slot', t => {
    const { player, processes, commands } = createPlayer(t);
    player.selectPlaylist('calm-jazz');
    processes.calls[0].finish(null, playlistOutput(302));
    player.playStreamTrack('Track 301');
    player.playStreamTrack('Track 300');
    player.playStreamTrack('Track 299');
    assert.equal(processes.calls.length, 6);
    processes.calls[5].finish(null, 'https://example.com/audio/301\n');
    commands.find(c => c.name === 'add').callback(null);
    assert.equal(commands.filter(c => c.name === 'play').length, 0);
    assert.equal(processes.calls.length, 7);
    assert.deepEqual(processes.calls[6].args, ['-g', 'https://example.com/track/299']);
    processes.calls[6].finish(null, 'https://example.com/audio/299\n');
    commands.findLast(c => c.name === 'add').callback(null);
    commands.findLast(c => c.name === 'playlistfind').callback(null, 'Pos: 1\n');
    assert.deepEqual(commands.find(c => c.name === 'play').args, ['1']);
    assert.equal(processes.peak, 5);
    processes.calls[1].finish(null, 'https://example.com/audio/0\n');
    assert.deepEqual(processes.calls[7].args, ['-g', 'https://example.com/track/4']);
});

for (const stopBeforeReady of [false, true]) {
    test(`play requested before the playlist loads ${stopBeforeReady ? 'respects a later stop' : 'starts as soon as the first track is ready'}`, t => {
        const { player, processes, commands } = createPlayer(t);
        player.selectPlaylist('calm-jazz');
        player.start();
        assert.equal(commands.filter(c => c.name === 'play').length, 0);
        processes.calls[0].finish(null, playlistOutput(302));
        processes.calls[1].finish(null, 'https://example.com/audio/first\n');
        if (stopBeforeReady) player.stop();
        commands.find(c => c.name === 'add').callback(null);
        const lookup = commands.find(c => c.name === 'playlistfind');
        if (lookup) lookup.callback(null, 'Pos: 0\n');
        assert.equal(commands.filter(c => c.name === 'play').length, stopBeforeReady ? 0 : 1);
        assert.equal(processes.active.size, 4);
    });
}

test('mode changes cancel the foreground slot as well as all background work', t => {
    const { player, processes, commands } = createPlayer(t);
    player.selectPlaylist('calm-jazz');
    processes.calls[0].finish(null, playlistOutput(302));
    player.playStreamTrack('Track 301');
    assert.equal(processes.active.size, 5);
    player.setMode('likes');
    for (const child of [...processes.active]) {
        assert.deepEqual(child.signals, ['SIGTERM']);
        child.finish(null, 'https://example.com/stale\n');
    }
    assert.equal(processes.calls.length, 6);
    assert.equal(processes.active.size, 0);
    assert.equal(commands.filter(c => c.name === 'add' || c.name === 'play').length, 0);
});

test('a failed selected track can be retried through the foreground slot', t => {
    const { player, processes, commands } = createPlayer(t);
    player.selectPlaylist('calm-jazz');
    processes.calls[0].finish(null, playlistOutput(302));
    player.playStreamTrack('Track 301');
    processes.calls[5].finish(new Error('temporary failure'));
    player.playStreamTrack('Track 301');
    assert.equal(processes.calls.length, 7);
    assert.deepEqual(processes.calls[6].args, ['-g', 'https://example.com/track/301']);
    processes.calls[6].finish(null, 'https://example.com/audio/retry\n');
    commands.find(c => c.name === 'add').callback(null);
    commands.find(c => c.name === 'playlistfind').callback(null, 'Pos: 0\n');
    assert.equal(commands.filter(c => c.name === 'play').length, 1);
});

test('autoplay continues with another track when the first extraction fails', t => {
    const { player, processes, commands } = createPlayer(t);
    player.selectPlaylist('calm-jazz');
    player.start();
    processes.calls[0].finish(null, playlistOutput(302));
    processes.calls[1].finish(new Error('unavailable'));
    processes.calls[2].finish(null, 'https://example.com/audio/second\n');
    commands.find(c => c.name === 'add').callback(null);
    assert.equal(commands.filter(c => c.name === 'play').length, 1);
});

test('a delayed MPD lookup cannot play an earlier selection or restart playback after stop', t => {
    const { player, processes, commands } = createPlayer(t);
    player.selectPlaylist('calm-jazz');
    processes.calls[0].finish(null, playlistOutput(302));
    player.playStreamTrack('Track 301');
    processes.calls[5].finish(null, 'https://example.com/audio/301\n');
    commands.find(c => c.name === 'add').callback(null);
    const oldLookup = commands.find(c => c.name === 'playlistfind');
    player.playStreamTrack('Track 300');
    oldLookup.callback(null, 'Pos: 0\n');
    assert.equal(commands.filter(c => c.name === 'play').length, 0);
    processes.calls[6].finish(null, 'https://example.com/audio/300\n');
    commands.findLast(c => c.name === 'add').callback(null);
    const latestLookup = commands.findLast(c => c.name === 'playlistfind');
    player.stop();
    latestLookup.callback(null, 'Pos: 1\n');
    assert.equal(commands.filter(c => c.name === 'play').length, 0);
});

test('stop returns a queued selection to background loading', t => {
    const { player, processes } = createPlayer(t);
    player.selectPlaylist('calm-jazz');
    processes.calls[0].finish(null, playlistOutput(302));
    player.playStreamTrack('Track 301');
    player.playStreamTrack('Track 300');
    player.stop();
    processes.calls[5].finish(null, 'https://example.com/audio/301\n');
    assert.equal(processes.calls.length, 6);
    assert.equal(processes.active.size, 4);
});

test('URL mode can be selected before entering a URL and participates in mode cycling', t => {
    const { player, processes, commands } = createPlayer(t);
    player.setMode('stream');
    player.modeChange();
    assert.equal(player.mode, 'url');
    assert.equal(player.getState().urlLoading, false);
    assert.deepEqual(player.streamTracks, []);
    assert.deepEqual(processes.calls[0].signals, ['SIGTERM']);
    const count = commands.length;
    player.start();
    assert.equal(commands.length, count);
    player.modeChange();
    assert.equal(player.mode, 'likes');
});

test('a live URL resolves its title and audio and autoplays only after MPD accepts it', t => {
    const { player, processes, commands } = createPlayer(t);
    const url = 'https://www.youtube.com/live/example';
    assert.equal(player.playUrl(`  ${url}  `), null);
    assert.equal(player.mode, 'url');
    assert.equal(player.currentUrl, url);
    assert.equal(player.getState().urlLoading, true);
    assert.ok(processes.calls[0].args.includes('--no-playlist'));
    assert.ok(processes.calls[0].args.includes('bestaudio/best'));
    processes.calls[0].finish(null, 'Live radio\r\nhttps://example.com/live-audio\r\n');
    assert.deepEqual(player.streamTracks, ['Live radio']);
    assert.equal(player._streamUrlToTitle['https://example.com/live-audio'], 'Live radio');
    assert.equal(commands.filter(c => c.name === 'play').length, 0);
    commands.find(c => c.name === 'add').callback(null);
    assert.equal(player.getState().urlLoading, false);
    assert.equal(commands.filter(c => c.name === 'play').length, 1);

    player.playStreamTrack('Live radio');
    assert.equal(processes.calls.length, 1, 'reuse the resolved live URL');
    commands.find(c => c.name === 'playlistfind').callback(null, 'Pos: 0\n');
    assert.deepEqual(commands.findLast(c => c.name === 'play').args, ['0']);
});

test('a URL playlist stays separate from saved playlists and supports prioritized track selection', t => {
    const { player, processes, commands } = createPlayer(t);
    const saved = fs.readFileSync(player.playlistsPath, 'utf8');
    player.playUrl('https://www.youtube.com/watch?v=example&list=custom');
    assert.ok(processes.calls[0].args.includes('--yes-playlist'));
    processes.calls[0].finish(null, playlistOutput(302));
    assert.equal(player.streamTracks.length, 302);
    assert.equal(processes.active.size, 4);
    player.playStreamTrack('Track 301');
    assert.equal(processes.active.size, 5);
    processes.calls[5].finish(null, 'https://example.com/custom/301\n');
    commands.find(c => c.name === 'add').callback(null);
    commands.find(c => c.name === 'playlistfind').callback(null, 'Pos: 0\n');
    assert.deepEqual(commands.find(c => c.name === 'play').args, ['0']);
    assert.equal(fs.readFileSync(player.playlistsPath, 'utf8'), saved);
    assert.equal(player.currentPlaylist, '');
});

test('invalid URLs preserve the active playback and do not start an extractor', t => {
    const { player, processes, commands } = createPlayer(t);
    player.selectPlaylist('calm-jazz');
    const count = commands.length;
    for (const url of ['', 'not a URL', 'file:///tmp/song.webm', '--exec=command', 'ftp://example.com/live', 'https://user:pass@example.com/live', null, {}]) {
        assert.equal(player.playUrl(url), 'invalid-url');
    }
    assert.equal(player.mode, 'stream');
    assert.equal(player.currentPlaylist, 'calm-jazz');
    assert.equal(player.currentUrl, '');
    assert.equal(processes.calls.length, 1);
    assert.deepEqual(processes.calls[0].signals, []);
    assert.equal(commands.length, count);
});

for (const url of ['https://www.youtube.com/live/example', 'https://www.youtube.com/playlist?list=custom']) {
    test(`expired URLs reload the same source in URL mode: ${url}`, t => {
        const { player, processes, commands } = createPlayer(t);
        player.playUrl(url);
        const listing = processes.calls[0].args.includes('--flat-playlist');
        if (listing) processes.calls[0].finish(null, playlistOutput(1));
        processes.calls[listing ? 1 : 0].finish(null,
            listing ? 'https://example.com/audio\n' : 'Live\nhttps://example.com/audio\n');
        commands.find(c => c.name === 'add').callback(null);
        player._streamUrlsExpireAt = 1;
        player.start();
        assert.equal(player.mode, 'url');
        assert.equal(player.currentUrl, url);
        assert.equal(processes.calls.at(-1).args.at(-1), url);
        assert.equal(processes.calls.at(-1).args.includes('--flat-playlist'), listing);
        assert.equal(player.getState().urlLoading, true);
    });
}

test('replacing a URL cancels old listing, foreground, and background work', t => {
    const { player, processes, commands } = createPlayer(t);
    player.playUrl('https://www.youtube.com/playlist?list=old');
    processes.calls[0].finish(null, playlistOutput(302));
    player.playStreamTrack('Track 301');
    const oldJobs = [...processes.active];
    player.emitter.emit('play-url', 'https://www.youtube.com/live/new');
    for (const child of oldJobs) {
        assert.deepEqual(child.signals, ['SIGTERM']);
        child.finish(null, 'https://example.com/stale\n');
    }
    assert.equal(processes.calls.length, 7);
    assert.equal(commands.filter(c => c.name === 'add' || c.name === 'play').length, 0);
    assert.deepEqual(player.streamTracks, ['https://www.youtube.com/live/new']);
    processes.calls[6].finish(null, 'New live\nhttps://example.com/new-audio\n');
    commands.find(c => c.name === 'add').callback(null);
    assert.equal(commands.filter(c => c.name === 'play').length, 1);
});

for (const action of ['stop', 'switch-mode', 'replace-url']) {
    test(`a late MPD add cannot autoplay an old URL after ${action}`, t => {
        const { player, processes, commands } = createPlayer(t);
        player.playUrl('https://www.youtube.com/live/old');
        processes.calls[0].finish(null, 'Old live\nhttps://example.com/old-audio\n');
        const add = commands.find(c => c.name === 'add');
        if (action === 'stop') player.startStop();
        else if (action === 'switch-mode') player.setMode('likes');
        else player.playUrl('https://www.youtube.com/live/new');
        add.callback(null);
        assert.equal(commands.filter(c => c.name === 'play').length, 0);
    });
}

for (const failure of ['live', 'listing', 'empty-playlist', 'all-tracks', 'mpd']) {
    test(`URL mode reports ${failure} failures and allows retry`, t => {
        const { player, processes, commands } = createPlayer(t);
        const playlist = ['listing', 'empty-playlist', 'all-tracks'].includes(failure);
        const url = playlist ? 'https://www.youtube.com/playlist?list=custom' : 'https://www.youtube.com/live/example';
        player.playUrl(url);
        if (failure === 'live' || failure === 'listing') {
            processes.calls[0].finish(new Error('unavailable'));
        } else if (failure === 'empty-playlist') {
            processes.calls[0].finish(null, '');
        } else if (failure === 'all-tracks') {
            processes.calls[0].finish(null, playlistOutput(2));
            processes.calls[1].finish(new Error('unavailable'));
            assert.equal(player.getState().urlError, '', 'another track may still succeed');
            processes.calls[2].finish(new Error('unavailable'));
        } else {
            processes.calls[0].finish(null, 'Live\nhttps://example.com/audio\n');
            commands.find(c => c.name === 'add').callback(new Error('MPD rejected URL'));
        }
        assert.ok(player.getState().urlError);
        assert.equal(player.getState().urlLoading, false);
        const count = processes.calls.length;
        player.start();
        assert.equal(processes.calls.length, count + 1);
        assert.equal(processes.calls.at(-1).args.at(-1), url);
        assert.equal(player.getState().urlError, '');
        assert.equal(player.getState().urlLoading, true);
    });
}

test('returning to URL mode remembers the URL without selecting or changing a saved playlist', t => {
    const { player, processes } = createPlayer(t);
    player.selectPlaylist('other');
    processes.calls[0].finish(null, '');
    const url = 'https://www.youtube.com/live/example';
    player.playUrl(url);
    player.setMode('likes');
    processes.calls[1].finish(new Error('terminated'));
    player.setMode('url');
    assert.equal(player.currentPlaylist, 'other');
    assert.equal(player.currentUrl, url);
    assert.equal(processes.calls[2].args.at(-1), url);
    assert.equal(player._streamAutoplay, false);
});
