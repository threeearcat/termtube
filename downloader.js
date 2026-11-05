'use strict';

const fs = require('fs');
const https = require('https');
const { exec } = require('child_process');
const { StreamResolver } = require('./stream-resolver');

const MAX_DOWNLOADING = 1;

function validate(filepath) {
    return new Promise((resolve, reject) => {
        exec('ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 ' + JSON.stringify(filepath), (err, stdout) => {
            if (err) {
                reject('ffprobe failed: ' + err.message);
                return;
            }
            const duration = parseFloat(stdout.trim());
            if (isNaN(duration) || duration <= 0) {
                reject('invalid duration: ' + stdout.trim());
                return;
            }
            resolve(duration);
        });
    });
}

function download(url, dest) {
    return new Promise((resolve, reject) => {
        const request = https.get(url, response => {
            if (response.statusCode === 200) {
                const file = fs.createWriteStream(dest, { flags: 'wx' });
                file.on('finish', () => resolve());
                file.on('error', err => {
                    file.close();
                    if (err.code === 'EEXIST') reject('File already exists');
                    else fs.unlink(dest, () => reject(err.message));
                });
                response.pipe(file);
            } else if (response.statusCode === 302 || response.statusCode === 301) {
                response.resume();
                download(response.headers.location, dest).then(resolve, reject);
            } else {
                reject(`Server responded with ${response.statusCode}: ${response.statusMessage}`);
            }
        });

        request.on('error', err => {
            reject(err.message);
        });
    });
}

class Downloader {
    constructor(resolver = new StreamResolver(), transfer = download) {
        this.downloading = 0;
        this.resolver = resolver;
        this.pending = [];
        this.ids = new Set();
        this.transfer = transfer;
    }

    _download(id, title, callback) {
        const dest = process.env.HOME + '/.music/' + id + '.webm';
        this.downloading += 1;
        const finish = success => {
            this.downloading -= 1;
            this.ids.delete(id);
            callback(id, title, success);
            this._drain();
        };
        if (fs.existsSync(dest)) {
            finish(false);
            return;
        }

        console.log('downloading', id, title);

        this.resolver.exec(['--no-playlist', '-f', 'bestaudio/best', '-g', 'https://youtu.be/' + id], (err, stdout) => {
            if (err) {
                console.log('download failed:', title, err.code === 'YOUTUBE_BLOCKED' ? err.message : 'URL extraction failed');
                finish(false);
                return;
            }
            const lines = stdout.split(/\r?\n/).filter(line => line.length !== 0);
            if (lines.length === 0) {
                finish(false);
                return;
            }
            const musicUrl = lines[lines.length - 1];
            this.transfer(musicUrl, dest).then(() => {
                console.log('download done', title);
                finish(true);
            }, err => {
                console.log('failed downloading', title, err);
                finish(false);
            });
        }, -1);
    }

    _drain() {
        if (this.resolver.queue.getError()) {
            for (const { video, callback } of this.pending.splice(0)) {
                this.ids.delete(video.id);
                callback(video.id, video.snippet.title, false);
            }
            return;
        }
        if (this.downloading >= MAX_DOWNLOADING || !this.pending.length) return;
        const { video, callback } = this.pending.shift();
        this._download(video.id, video.snippet.title, callback);
    }

    download(video, callback) {
        if (this.ids.has(video.id)) return;
        this.ids.add(video.id);
        this.pending.push({ video, callback });
        this._drain();
    }
}

module.exports = { Downloader, validate };
