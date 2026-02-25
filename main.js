'use strict'

const fs = require('fs');
const {Player} = require(__dirname + '/player');
const {downloader} = require(__dirname + '/downloader');
const backend = require(__dirname + '/backend');

const PID_FILE = process.env.HOME + '/.termtube.pid';

if (process.argv.includes('--kill')) {
    try {
        const old = parseInt(fs.readFileSync(PID_FILE, 'utf-8'));
        if (old !== process.pid) {
            process.kill(old);
            for (let i = 0; i < 30; i++) {
                try { process.kill(old, 0); } catch (_) { break; }
                require('child_process').execSync('sleep 0.1');
            }
        }
    } catch (e) {}
    try { fs.unlinkSync('/tmp/command.sock'); } catch (_) {}
}
fs.writeFileSync(PID_FILE, String(process.pid));

let p = new Player();
let d = new downloader();

backend.start(p, d);
