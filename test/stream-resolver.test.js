'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { StreamResolver, YoutubeQueue } = require('../stream-resolver');

function setup(t, options = {}) {
    const calls = [];
    const active = new Set();
    const queue = new YoutubeQueue((file, args, callback) => {
        assert.equal(file, 'yt-dlp');
        const child = {
            args, signals: [],
            kill(signal) { this.signals.push(signal); },
            finish(err = null, stdout = '', stderr = '') {
                assert.ok(active.delete(child));
                callback(err, stdout, stderr);
            },
        };
        calls.push(child);
        active.add(child);
        assert.equal(active.size, 1, 'all owners share a single process slot');
        return child;
    }, options);
    const foreground = new StreamResolver(queue);
    const downloads = new StreamResolver(queue);
    t.after(() => {
        foreground.cancel(); downloads.cancel();
        if (queue.active) queue.active.child.finish(new Error('terminated'));
        clearTimeout(queue.timer);
    });
    return { queue, calls, foreground, downloads };
}

test('playback and downloads share spacing and queued playback gets priority', t => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
    const { calls, foreground, downloads } = setup(t);
    downloads.exec(['-g', 'download-1'], () => {}, -1);
    downloads.exec(['-g', 'download-2'], () => {}, -1);
    foreground.exec(['-g', 'prefetch'], () => {});
    const selected = foreground.exec(['-g', 'selected'], () => {});
    foreground.prioritize(selected);
    calls[0].finish();
    t.mock.timers.tick(9999);
    assert.equal(calls.length, 1);
    t.mock.timers.tick(1);
    assert.equal(calls[1].args.at(-1), 'selected');
    assert.ok(calls[1].args.includes('--sleep-requests'));
    calls[1].finish(); t.mock.timers.tick(10000);
    assert.equal(calls[2].args.at(-1), 'prefetch');
    calls[2].finish(); t.mock.timers.tick(10000);
    assert.equal(calls[3].args.at(-1), 'download-2');
});

for (const error of ['HTTP Error 429: Too Many Requests', 'Sign in to confirm you’re not a bot', 'This session has been rate-limited by YouTube', 'YouTube is requiring a captcha challenge before playback']) {
    test(`${error} pauses owners of the same request category during cooldown`, async t => {
        t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
        const { queue, calls, foreground, downloads } = setup(t, { interval: 0, cooldown: 3600000 });
        const failures = [];
        downloads.exec(['-g', 'download'], err => failures.push(err?.code), 0);
        foreground.exec(['-g', 'selected'], err => failures.push(err?.code), 2);
        calls[0].finish(new Error('failed'), '', error);
        assert.deepEqual(failures, ['YOUTUBE_BLOCKED', 'YOUTUBE_BLOCKED']);
        foreground.exec(['-g', 'retry-too-soon'], err => failures.push(err?.code));
        await Promise.resolve();
        assert.equal(failures.length, 3);
        t.mock.timers.tick(3599999);
        assert.equal(calls.length, 1);
        t.mock.timers.tick(1);
        assert.equal(queue.getError(), null);
        foreground.exec(['-g', 'retry-after-wait'], () => {});
        assert.equal(calls.length, 2);
    });
}

test('cancelled work cannot hide a rate limit from the other owner', t => {
    const { queue, foreground, downloads, calls } = setup(t, { interval: 0 });
    foreground.exec(['-g', 'old-selection'], () => assert.fail('cancelled callback'));
    let blocked;
    downloads.exec(['-g', 'download'], err => { blocked = err; });
    foreground.cancel();
    calls[0].finish(new Error('HTTP Error 429'));
    assert.equal(blocked.code, 'YOUTUBE_BLOCKED');
    assert.ok(queue.getError());
    assert.equal(calls.length, 1);
});

for (const metadata of [false, true]) {
    test(`explicit ${metadata ? 'playlist' : 'audio'} requests bypass cooldown while retaining process spacing`, async t => {
        t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
        const { queue, calls, foreground } = setup(t);
        const args = metadata ? ['--flat-playlist', 'playlist'] : ['-g', 'audio'];
        foreground.exec(args, () => {});
        calls[0].finish(new Error('HTTP Error 429'));
        const failures = [];
        foreground.exec(args, err => failures.push(err?.code));
        foreground.exec(args, err => assert.equal(err, null), 2, { interactive: true });
        await Promise.resolve();
        assert.deepEqual(failures, ['YOUTUBE_BLOCKED']);
        t.mock.timers.tick(9999);
        assert.equal(calls.length, 1);
        t.mock.timers.tick(1);
        assert.equal(calls.length, 2, 'the click waits only for normal process spacing');
        calls[1].finish();
        assert.ok(queue.getError(metadata), 'automatic requests keep their cooldown');
        foreground.exec(args, err => failures.push(err?.code));
        await Promise.resolve();
        assert.deepEqual(failures, ['YOUTUBE_BLOCKED', 'YOUTUBE_BLOCKED']);
        assert.equal(calls.length, 2);
    });
}

for (const promoted of [false, true]) {
    test(`a rate limit preserves a queued ${promoted ? 'promoted prefetch' : 'explicit selection'}`, t => {
        const { foreground, downloads, calls } = setup(t, { interval: 0 });
        downloads.exec(['-g', 'old'], () => {});
        const failures = [];
        foreground.exec(['-g', 'automatic'], err => failures.push(err?.code));
        const selected = foreground.exec(['-g', 'selected'], err => assert.equal(err, null), 0, { interactive: !promoted });
        foreground.prioritize(selected, promoted);
        calls[0].finish(new Error('HTTP Error 429'));
        assert.deepEqual(failures, ['YOUTUBE_BLOCKED']);
        assert.equal(calls.length, 2);
        assert.equal(calls[1].args.at(-1), 'selected');
        calls[1].finish();
    });
}

for (const metadata of [false, true]) {
    test(`${metadata ? 'playlist' : 'audio'} cooldown does not block the other request category`, async t => {
        const { queue, foreground, downloads, calls } = setup(t, { interval: 0 });
        const audioArgs = ['-g', 'audio'];
        const metadataArgs = ['--flat-playlist', '--print', 'url', 'playlist'];
        const blockedArgs = metadata ? metadataArgs : audioArgs;
        const allowedArgs = metadata ? audioArgs : metadataArgs;
        const failures = [];
        downloads.exec(blockedArgs, err => failures.push(err?.code));
        foreground.exec(allowedArgs, err => assert.equal(err, null));
        calls[0].finish(new Error('Sign in to confirm you are not a bot'));
        assert.deepEqual(failures, ['YOUTUBE_BLOCKED']);
        assert.equal(calls.length, 2, 'the other category still gets its queued process');
        assert.equal(calls[1].args.includes('--flat-playlist'), !metadata);
        calls[1].finish(null, 'metadata or audio\n');
        foreground.exec(blockedArgs, err => failures.push(err?.code));
        await Promise.resolve();
        assert.deepEqual(failures, ['YOUTUBE_BLOCKED', 'YOUTUBE_BLOCKED']);
        assert.equal(calls.length, 2);
        assert.ok(queue.getError(metadata));
        assert.equal(queue.getError(!metadata), null);
    });
}

test('cancelling one owner preserves the other owner and kills stubborn processes', t => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
    const { foreground, downloads, calls } = setup(t, { interval: 0 });
    foreground.exec(['-g', 'old'], () => assert.fail('cancelled callback'));
    downloads.exec(['-g', 'download'], () => {});
    foreground.cancel(); foreground.cancel();
    assert.deepEqual(calls[0].signals, ['SIGTERM']);
    t.mock.timers.tick(1000);
    assert.deepEqual(calls[0].signals, ['SIGTERM', 'SIGKILL']);
    calls[0].finish(new Error('killed'));
    assert.equal(calls[1].args.at(-1), 'download');
});

test('exited cancelled processes never receive SIGKILL and ordinary failures do not block', t => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
    const { foreground, calls, queue } = setup(t, { interval: 0 });
    foreground.exec(['-g', 'old'], () => assert.fail('cancelled callback'));
    foreground.cancel(); calls[0].finish(new Error('terminated'));
    t.mock.timers.tick(1000);
    assert.deepEqual(calls[0].signals, ['SIGTERM']);
    foreground.exec(['-g', 'unavailable'], () => {});
    calls[1].finish(new Error('video unavailable'));
    assert.equal(queue.getError(), null);
    foreground.exec(['-g', 'available'], () => {});
    assert.equal(calls.length, 3);
});
