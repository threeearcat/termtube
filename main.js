'use strict'

const fs = require('fs');
const {player} = require(__dirname + '/player');
const {downloader} = require(__dirname + '/downloader');
const backend = require(__dirname + '/backend');

const PID_FILE = process.env.HOME + '/.termtube.pid';

if (process.argv.includes('--kill')) {
    try {
        const old = parseInt(fs.readFileSync(PID_FILE, 'utf-8'));
        if (old !== process.pid) process.kill(old);
    } catch (e) {}
}
fs.writeFileSync(PID_FILE, String(process.pid));

let p = new player();
let d = new downloader();

backend.start(p, d);
