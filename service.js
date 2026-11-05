'use strict';

const { spawnSync } = require('child_process');

// A scope tracks Electron but cannot restart it. Launch the controller as a
// service so it outlives its launcher and recovers even from a native crash.
function startService(app, { run = spawnSync, env = process.env, platform = process.platform } = {}) {
    if (platform !== 'linux' || env.TERMTUBE_SUPERVISED === '1') return false;
    const options = { encoding: 'utf8', timeout: 10000 };
    if (run('systemctl', ['--user', 'show', '--property=Version', '--value'], options).status !== 0) return false;

    app.releaseSingleInstanceLock();
    const args = [
        '--user', '--collect', '--unit=termtube', '--service-type=exec',
        '--property=Restart=always', '--property=RestartSec=3',
        '--property=TimeoutStopSec=5', '--property=StandardOutput=journal',
        '--property=StandardError=journal', '--setenv=TERMTUBE_SUPERVISED=1',
    ];
    for (const name of ['DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'PATH', 'XDG_STATE_HOME']) {
        if (env[name]) args.push(`--setenv=${name}=${env[name]}`);
    }
    args.push(process.execPath, __dirname);
    if (process.argv.includes('--background')) args.push('--background');
    if (run('systemd-run', args, options).status === 0) return true;
    // Another launch can have created the service after we released the lock.
    if (run('systemctl', ['--user', 'is-active', '--quiet', 'termtube.service'], options).status === 0) return true;

    console.error('Could not start termtube.service; running without automatic restart.');
    return !app.requestSingleInstanceLock();
}

module.exports = { startService };
