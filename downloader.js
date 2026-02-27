'use strict';

const fs = require('fs');
const https = require('https');
const { exec } = require('child_process');

const MAX_DOWNLOADING = 10;

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
                download(response.headers.location, dest).then(() => resolve());
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
    constructor() {
        this.downloading = 0;
    }

    _download(id, title, callback) {
        if (this.downloading >= MAX_DOWNLOADING) {
            setTimeout(() => this._download(id, title, callback), 60 * 1000);
            return;
        }
        const dest = process.env.HOME + '/.music/' + id + '.webm';
        this.downloading += 1;
        if (fs.existsSync(dest)) {
            this.downloading -= 1;
            callback(id, title, false);
            return;
        }

        console.log('downloading', id, title);

        const cmd = 'yt-dlp -g https://youtu.be/' + id;
        exec(cmd, (err, stdout) => {
            if (err) {
                console.log('download failed', err);
                this.downloading -= 1;
                callback(id, title, false);
                return;
            }
            const lines = stdout.split(/\r?\n/).filter(line => line.length !== 0);
            if (lines.length === 0) {
                this.downloading -= 1;
                callback(id, title, false);
                return;
            }
            const musicUrl = lines[lines.length - 1];
            download(musicUrl, dest).then(() => {
                console.log('download done', title);
                callback(id, title, true);
            }).catch(err => {
                console.log('failed downloading', title, err);
                callback(id, title, false);
            }).finally(() => {
                this.downloading -= 1;
            });
        });
    }

    download(video, callback) {
        this._download(video.id, video.snippet.title, callback);
    }
}

module.exports = { Downloader, validate };
