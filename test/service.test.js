'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { startService } = require('../service');

function setup(statuses = [0, 0]) {
    const calls = [];
    const app = {
        releaseSingleInstanceLock() { calls.push('release'); },
        requestSingleInstanceLock() { calls.push('lock'); return true; },
    };
    const options = {
        platform: 'linux', env: { DISPLAY: ':0', PATH: '/usr/bin', UNRELATED_TOKEN: 'do-not-forward' },
        run(command, args) { calls.push({ command, args }); return { status: statuses.shift() }; },
    };
    return { app, options, calls };
}

test('the controller runs as a restarting service with logs and only the required environment', () => {
    const { app, options, calls } = setup();
    assert.equal(startService(app, options), true);
    assert.equal(calls[1], 'release', 'release the singleton before starting its replacement');
    const { command, args } = calls[2];
    assert.equal(command, 'systemd-run');
    for (const arg of ['--unit=termtube', '--property=Restart=always', '--property=RestartSec=3', '--property=StandardError=journal', '--setenv=TERMTUBE_SUPERVISED=1', '--setenv=DISPLAY=:0']) assert.ok(args.includes(arg));
    assert.equal(args.some(arg => arg.includes('UNRELATED_TOKEN')), false);
    assert.equal(args.includes('--scope'), false);
});

test('a managed controller and non-Linux launches do not create another service', () => {
    for (const overrides of [{ env: { TERMTUBE_SUPERVISED: '1' } }, { platform: 'darwin' }]) {
        const { app, options, calls } = setup();
        assert.equal(startService(app, { ...options, ...overrides }), false);
        assert.equal(calls.length, 0);
    }
});

test('an unavailable user manager keeps the original singleton and runs directly', () => {
    const { app, options, calls } = setup([1]);
    assert.equal(startService(app, options), false);
    assert.equal(calls.length, 1);
});

test('a service launch failure reacquires the singleton before running directly', t => {
    t.mock.method(console, 'error', () => {});
    const { app, options, calls } = setup([0, 1, 1]);
    assert.equal(startService(app, options), false);
    assert.equal(calls.at(-1), 'lock');
});

test('a racing launch reuses the service that is already active', () => {
    const { app, options, calls } = setup([0, 1, 0]);
    assert.equal(startService(app, options), true);
    assert.equal(calls.includes('lock'), false);
});
