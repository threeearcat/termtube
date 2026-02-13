const fs = require('fs');
const EventEmitter = require('events').EventEmitter;
const unix = require(__dirname + '/unix');
const mpd = require('mpd');

const commandSockDef = '/tmp/command.sock';
const lofiURLFileDef = process.env.HOME + '/.mpd/lofi.lst';
const calmJazzPlaylistDef = 'https://www.youtube.com/playlist?list=PL61ZikC3WfojSgt1PeWLSzj9qqXpVpCfA';

function player(commandSock=commandSockDef, lofiURLFile=lofiURLFileDef, calmJazzPlaylist=calmJazzPlaylistDef) {
    let self = this;
    this.videos = [];
    this.mode = 'likes';
    this.current_title = '';

    // Player's attributes
    this.emitter = new EventEmitter();
    try {
        const raw = fs.readFileSync(lofiURLFile);
        this.lofiURLs = raw.toString('utf-8').split('\n');
    } catch {
        console.log('failed to read the lofi URLs', lofiURLFile);
        this.lofiURLs = [];
    }
    this.calmJazzPlaylist = calmJazzPlaylist;

    // MPD's attributes
    this.mpd_ready = false;
    this.mpd_state = 'stop';
    this.cmd = mpd.cmd;
    this.mpd = mpd.connect({
        path: process.env.HOME+ "/.mpd/socket"
    });

    this._print_title = function(title) {
        title = title.trim();
        console.log("Title: " + title);
        self.current_title = title;
        const path = process.env.HOME + '/.mpd/current_title';
        fs.writeFile(path, title, function (err) {
            if (err) return console.log(err);
        });
        self.emitter.emit('title-changed', title);
    }

    this.print_title = function() {
        self.mpd_command('currentsong', [], function(err, msg) {
            if (err) throw err;
            const re = /^file: ([a-z0-9\.\-\_]*)$/im;
            let found = msg.match(re);
            if (found == null || found.length < 2) {
                if (self.mode == 'lofi') {
                    self._print_title("Playing lofi music");
                } else if (self.mode == 'calm-jazz') {
                    self._print_title("Playing calm jazz");
                } else {
                    self._print_title("Unknown title");
                }
                return;
            }
            let filename = found[1];
            found = self.videos.find(elem => elem.filename == filename);
            let towrite = filename;
            if (found != undefined) {
                towrite = found.title;
            }
            self._print_title(towrite);
        });
    }

    this.mpd_update_state = function() {
        self.mpd_command("status", [], function(err, msg) {
            if (err) throw err;
            const re = /^state: ([a-z]*)$/im;
            let found = msg.match(re);
            if (found == null || found.length < 2) {
                self.mpd_set_state('stop');
            } else {
                self.mpd_set_state(found[1]);
            }
            self.print_title();
        });
    }

    this.mpd.on('ready', function() {
        console.log("mpd ready");
        self.mpd_ready = true;
        self.mpd_update_state();
        self.mpd_command('random', ['1'])
        self.mpd_command('repeat', ['1'])
    });

    this.mpd.on('system-player', function(name) {
        self.mpd_update_state();
    });

    // MPD wrapper
    this.mpd_command = function(cmd, args=[], callback=function () {}) {
        if (!self.mpd_ready)
            return;
        return self.mpd.sendCommand(self.cmd(cmd, args), callback);
    }

    this.add = function(id, title) {
        const filename = id + '.webm';
        if (self.videos.findIndex(elem => elem.filename == filename) != -1) {
            return;
        }
        self.videos.push({'title': title, 'filename': filename});
        self.emitter.emit('playlist-changed', self.videos);
        self.mpd_command('update')
        if (self.mode == 'likes')
            self.mpd_command('add', [filename])
    }

    this.start = function() {
        if (self.mpd_check_state('stop')) {
            self.reload();
        }
        self.mpd_command('play');
    }

    this.stop = function() {
        self.mpd_command('stop');
    }

    this.mpd_check_state = function(s) {
        return self.mpd_state == s;
    }

    this.mpd_set_state = function(state) {
        console.log('change the state to ', state);
        self.mpd_state = state;
        self.emitter.emit('state-changed', self.getState());
    }

    this.startstop = function() {
        if (self.mpd_check_state('stop') || self.mpd_check_state('pause')) {
            self.start();
        } else {
            self.stop();
        }
    }

    this.reload = function() {
        self.mode = 'likes';
        self.emitter.emit('state-changed', self.getState());
        self.mpd_command('clear');
        self.mpd_command('update');
        self.videos.forEach(function (video) {
            self.mpd_command('add', [video.filename]);
        });
    }

    this.next = function() {
        self.mpd_command('next');
    }

    this.play_track = function(filename) {
        self.mpd_command('playlistfind', ['file', filename], function(err, msg) {
            if (err) return;
            const re = /^Pos: (\d+)$/im;
            const found = msg.match(re);
            if (found && found.length >= 2) {
                self.mpd_command('play', [found[1]]);
            }
        });
    }

    this._switch_to_lofi = function() {
        console.log('change mode to lofi');
        self.mode = 'lofi';
        self.emitter.emit('state-changed', self.getState());
        self.mpd_command('clear');
        self.lofiURLs.forEach(function(URL) {
            if (URL.length == 0)
                return;
            const exec = require('child_process').exec;
            const yt_downloader = 'yt-dlp';
            const cmd = yt_downloader + ' -g ' + URL + ' | tail -n 1';
            exec(cmd, function (err, stdout, stderr) {
                if (err) {
                    console.log('lofi stream error:', URL);
                    return;
                }
                stdout = stdout.trim();
                if (stdout.length == 0) {
                    console.log("URL is broken", URL);
                    return;
                }
                self.mpd_command('add', [stdout]);
            });
        });
    }

    this._switch_to_calmjazz = function() {
        console.log('change mode to calm-jazz');
        self.mode = 'calm-jazz';
        self.emitter.emit('state-changed', self.getState());
        self.mpd_command('clear');
        const exec = require('child_process').exec;
        const yt_downloader = 'yt-dlp';
        const cmd = yt_downloader + ' --flat-playlist --get-url ' + self.calmJazzPlaylist;
        exec(cmd, function (err, stdout, stderr) {
            if (err) {
                console.log('calm-jazz playlist error');
                return;
            }
            const videoURLs = stdout.trim().split('\n');
            console.log('calm-jazz: loading', videoURLs.length, 'tracks');
            videoURLs.forEach(function(URL) {
                if (URL.length == 0)
                    return;
                const streamCmd = yt_downloader + ' -g ' + URL + ' | tail -n 1';
                exec(streamCmd, function (err, stdout, stderr) {
                    if (err) {
                        return;
                    }
                    stdout = stdout.trim();
                    if (stdout.length == 0) {
                        return;
                    }
                    self.mpd_command('add', [stdout]);
                });
            });
        });
    }

    this._switch_to_likes = function() {
        console.log('change mode to likes');
        self.mode = 'likes';
        self.emitter.emit('state-changed', self.getState());
        self.reload();
    }

    this.mode_change = function() {
        if (self.mode == 'likes') {
            self._switch_to_lofi();
        } else if (self.mode == 'lofi') {
            self._switch_to_calmjazz();
        } else {
            self._switch_to_likes();
        }
    }

    this.set_mode = function(target) {
        if (target == self.mode) return;
        if (target == 'lofi') {
            self._switch_to_lofi();
        } else if (target == 'calm-jazz') {
            self._switch_to_calmjazz();
        } else {
            self._switch_to_likes();
        }
    }

    this.getState = function() {
        return {
            mode: self.mode,
            state: self.mpd_state,
            title: self.current_title,
            videos: self.videos
        };
    }

    // Register event handlers
    this.emitter.on('start', self.startstop);
    this.emitter.on('stop', self.startstop);
    this.emitter.on('reload', self.reload);
    this.emitter.on('next', self.next);
    this.emitter.on('mode-change', self.mode_change);
    this.emitter.on('set-mode', self.set_mode);
    this.emitter.on('play-track', self.play_track);

    // Launch sockets
    this.handler = unix.handler(self.emitter, commandSock);

    // Now we are ready
    return this
}

module.exports.player = player;
