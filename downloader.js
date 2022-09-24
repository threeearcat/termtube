const https = require('https');
const fs = require('fs');

const MAX_DOWNLOADING = 10;

function download(url, dest) {
    return new Promise((resolve, reject) => {
        const request = https.get(url, response => {
            if (response.statusCode === 200) {

                const file = fs.createWriteStream(dest, { flags: 'wx' });
                file.on('finish', () => resolve());
                file.on('error', err => {
                    file.close();
                    if (err.code === 'EEXIST') reject('File already exists');
                    else fs.unlink(dest, () => reject(err.message)); // Delete temp file
                });
                response.pipe(file);
            } else if (response.statusCode === 302 || response.statusCode === 301) {
                // Recursively follow redirects, only a 200 will resolve.
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

function downloader() {
    self = this;
    this.downloading = 0;

    this.__download = function(id, title, callback) {
        if (self.downloading >= MAX_DOWNLOADING) {
            setTimeout(self.__download, 60 * 1000, id, title, callback);
            return;
        }
        const dest = process.env.HOME+'/.mpd/music/'+id+'.webm';
        self.downloading += 1;
        if(fs.existsSync(dest)) {
            self.downloading -= 1;
            callback(id, title, false);
            return;
        }

        console.log('downloading', id, title);

        const exec = require('child_process').exec;
        const url = "https://youtu.be/" + id;
        const cmd = 'youtube-dl -g ' + url;
        exec(cmd, function (err, stdout, stderr) {
            if (err) {
                console.log('download failed', err);
                self.downloading -= 1;
                callback(id, title, false);
                return;
            }
            const lines = stdout.split(/\r?\n/).filter(function(line) {
                return line.length != 0;
            });
            if (lines.length == 0) {
                self.downloading -= 1;
                callback(id, title, false);
                return;
            }
            const music_url = lines[lines.length - 1];
            download(music_url, dest).then(function (){
                console.log('download done', title);
                callback(id, title, true);
            }).catch(function (err) {
                console.log('failed downloading', title, err);
                callback(id, title, false);
            }).finally(function () {
                self.downloading -= 1;
            });
        });
    }

    this.download = function(video, callback) {
        self.__download(video.id, video.snippet.title, callback);
    }
}

module.exports.downloader = downloader
