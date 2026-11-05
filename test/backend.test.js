'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

async function boot() {
    const process = new EventEmitter();
    const exits = [];
    const errors = [];
    process.env = { HOME: '/test-home' };
    process.exit = code => exits.push(code);
    const entry = path.join(__dirname, '..', 'backend.js');
    const modules = {
        fs: { existsSync: () => false },
        [path.join(__dirname, '..', 'auth.js')]: { authorize() {} },
        googleapis: { google: {} },
        'node-notifier': {},
        [path.join(__dirname, '..', 'downloader')]: { validate() {} },
    };
    const context = { __dirname: path.dirname(entry), process, module: { exports: {} },
        console: { log() {}, error: (...args) => errors.push(args) },
        require(name) { assert.ok(Object.hasOwn(modules, name)); return modules[name]; },
    };
    vm.runInNewContext(fs.readFileSync(entry, 'utf8'), context, { filename: entry });
    context.module.exports.start({}, {});
    await Promise.resolve(); await Promise.resolve();
    return { process, exits, errors };
}

test('an uncaught controller error logs its stack and exits with failure for supervision', async () => {
    const { process, exits, errors } = await boot();
    const error = new Error('controller failed');
    process.emit('uncaughtException', error);
    assert.deepEqual(exits, [1]);
    assert.equal(errors[0][1], error.stack);
});

test('ordinary shutdown signals exit cleanly and diagnostic signals have no exit handler', async () => {
    const { process, exits } = await boot();
    assert.equal(process.listenerCount('SIGUSR1'), 0);
    assert.equal(process.listenerCount('SIGUSR2'), 0);
    process.emit('SIGTERM');
    assert.deepEqual(exits, [0]);
});
