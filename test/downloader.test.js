'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { test } = require('node:test');
const { Downloader } = require('../downloader');
const { StreamResolver, YoutubeQueue } = require('../stream-resolver');

function setup(t) {
    t.mock.method(fs, 'existsSync', () => false);
    const calls = [];
    const transfers = [];
    const queue = new YoutubeQueue((file, args, callback) => {
        const child = { args, kill() {}, finish: (err = null, stdout = '', stderr = '') => callback(err, stdout, stderr) };
        calls.push(child);
        return child;
    }, { interval: 0 });
    const resolver = new StreamResolver(queue);
    const downloader = new Downloader(resolver, (url, dest) => new Promise((resolve, reject) => transfers.push({ url, dest, resolve, reject })));
    const results = [];
    const add = id => downloader.download({ id, snippet: { title: 'Track ' + id } }, (...args) => results.push(args));
    t.after(() => {
        resolver.cancel();
        if (queue.active) queue.active.child.finish(new Error('terminated'));
        clearTimeout(queue.timer);
    });
    return { queue, resolver, downloader, calls, transfers, results, add };
}

test('likes downloads serialize transfers and deduplicate IDs across sync cycles', async t => {
    const { downloader, calls, transfers, add, results } = setup(t);
    add('first'); add('first'); add('second');
    assert.equal(calls.length, 1);
    calls[0].finish(null, 'https://example.com/audio/first\n');
    assert.equal(transfers.length, 1);
    assert.equal(calls.length, 1, 'second transfer waits until the first completes');
    transfers[0].resolve(); await Promise.resolve();
    assert.equal(calls.length, 2);
    calls[1].finish(null, 'https://example.com/audio/second\n');
    transfers[1].reject(new Error('network failed')); await Promise.resolve();
    assert.deepEqual(results.map(result => [result[0], result[2]]), [['first', true], ['second', false]]);
    assert.equal(downloader.downloading, 0);
    assert.equal(downloader.ids.size, 0);
});

test('a YouTube block stops the likes backlog and later sync attempts without network requests', t => {
    const { calls, add, results, downloader } = setup(t);
    add('first'); add('second'); add('third');
    calls[0].finish(new Error('HTTP Error 429: Too Many Requests'));
    assert.equal(calls.length, 1);
    assert.equal(results.length, 3);
    assert.equal(downloader.ids.size, 0);
    add('fourth');
    assert.equal(calls.length, 1);
    assert.equal(results.length, 4);
});

test('a selected stream can resolve during a likes transfer using the same queue', async t => {
    const { calls, transfers, add, queue } = setup(t);
    add('first'); add('second');
    calls[0].finish(null, 'https://example.com/audio/first\n');
    const player = new StreamResolver(queue);
    let played;
    player.exec(['-g', 'selected-track'], (err, stdout) => { played = stdout; }, 2);
    assert.equal(calls.length, 2);
    calls[1].finish(null, 'https://example.com/audio/selected\n');
    assert.ok(played);
    transfers[0].resolve(); await Promise.resolve();
    assert.equal(calls[2].args.at(-1), 'https://youtu.be/second');
    calls[2].finish(new Error('unavailable'));
});
