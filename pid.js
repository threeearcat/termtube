'use strict';

const fs = require('fs');
const { execSync } = require('child_process');

const PID_FILE = process.env.HOME + '/.termtube.pid';
const SOCK_PATH = '/tmp/command.sock';

function killExisting() {
    if (!process.argv.includes('--kill')) return;
    try {
        const old = parseInt(fs.readFileSync(PID_FILE, 'utf-8'));
        if (old !== process.pid) {
            process.kill(old);
            for (let i = 0; i < 30; i++) {
                try { process.kill(old, 0); } catch (_) { break; }
                execSync('sleep 0.1');
            }
        }
    } catch (_) {}
    try { fs.unlinkSync(SOCK_PATH); } catch (_) {}
}

function writePid() {
    fs.writeFileSync(PID_FILE, String(process.pid));
}

module.exports = { killExisting, writePid };
