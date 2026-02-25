const fs = require('fs');
const EventEmitter = require('events').EventEmitter;
const unix = require(__dirname + '/unix');
const mpd = require('mpd');

const commandSockDef = '/tmp/command.sock';
const lofiURLFileDef = process.env.HOME + '/.mpd/lofi.lst';
const playlistsPathDef = process.env.HOME + '/.termtube/playlists.json';
const defaultPlaylists = [
    {"name": "calm-jazz", "url": "https://www.youtube.com/playlist?list=PL61ZikC3WfojSgt1PeWLSzj9qqXpVpCfA"}
];

function player(commandSock=commandSockDef, lofiURLFile=lofiURLFileDef, playlistsPath=playlistsPathDef) {
    let self = this;
    this.videos = [];
    this.mode = 'likes';
    this.current_title = '';
    this.currentPlaylist = '';
    this.streamTracks = [];
    this._streamUrlToTitle = {};
    this._streamGen = 0;

    // Player's attributes
    this.emitter = new EventEmitter();
    try {
        const raw = fs.readFileSync(lofiURLFile);
        this.lofiURLs = raw.toString('utf-8').split('\n');
    } catch {
        console.log('failed to read the lofi URLs', lofiURLFile);
        this.lofiURLs = [];
    }

    // Load streaming playlists from JSON (migrate if missing)
    this.playlistsPath = playlistsPath;
    try {
        this.playlists = JSON.parse(fs.readFileSync(playlistsPath, 'utf-8'));
    } catch {
        const dir = require('path').dirname(playlistsPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        this.playlists = defaultPlaylists.slice();
        fs.writeFileSync(playlistsPath, JSON.stringify(this.playlists, null, 2));
    }

    // MPD's attributes
    this.mpd_ready = false;
    this.mpd_state = 'stop';
    this.cmd = mpd.cmd;
    this._mpdRetries = 0;
    this._connectMpd = function() {
        self.mpd_ready = false;
        self.mpd = mpd.connect({
            path: process.env.HOME + "/.mpd/socket"
        });
        function scheduleReconnect(reason) {
            self.mpd_ready = false;
            if (++self._mpdRetries >= 5) {
                console.log('mpd: giving up after 5 retries');
                return;
            }
            setTimeout(function() {
                console.log('mpd reconnecting (' + self._mpdRetries + '/5)...');
                self._connectMpd();
            }, 2000);
        }
        self.mpd.on('error', function(err) {
            console.log('mpd connection error:', err.message);
            scheduleReconnect();
        });
        self.mpd.on('end', function() {
            console.log('mpd connection closed');
            scheduleReconnect();
        });
        self.mpd.on('ready', function() {
            console.log("mpd ready");
            self.mpd_ready = true;
            self._mpdRetries = 0;
            self.mpd_command('stop');
            self.reload();
            self.mpd_command('random', ['1']);
            self.mpd_command('repeat', ['1']);
        });
        self.mpd.on('system-player', function() {
            self.mpd_update_state();
        });
    };
    this._connectMpd();

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
            if (err) { console.log('currentsong error:', err.message); return; }
            // Try to get the full file URI (works for both local files and URLs)
            const fileRe = /^file: (.+)$/im;
            const fileMatch = msg.match(fileRe);
            if (!fileMatch || !fileMatch[1]) {
                self._print_title("Unknown title");
                return;
            }
            const file = fileMatch[1];
            // Stream mode: look up URL in mapping
            if (self.mode == 'stream' || self.mode == 'lofi') {
                const mapped = self._streamUrlToTitle[file];
                if (mapped) {
                    self._print_title(mapped);
                } else if (self.mode == 'lofi') {
                    self._print_title("Playing lofi music");
                } else {
                    self._print_title("Playing " + self.currentPlaylist);
                }
                return;
            }
            // Likes mode: match local filename
            const localRe = /^([a-z0-9\.\-\_]*)$/im;
            const localMatch = file.match(localRe);
            if (!localMatch) {
                self._print_title("Unknown title");
                return;
            }
            const filename = localMatch[1];
            const found = self.videos.find(elem => elem.filename == filename);
            self._print_title(found ? found.title : filename);
        });
    }

    this.mpd_update_state = function() {
        self.mpd_command("status", [], function(err, msg) {
            if (err) { console.log('status error:', err.message); return; }
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
        if (self.mpd_check_state('stop') && self.mode === 'likes') {
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
        ++self._streamGen;
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

    this.remove = function(filename) {
        const idx = self.videos.findIndex(elem => elem.filename == filename);
        if (idx === -1) return;
        self.videos.splice(idx, 1);
        self.emitter.emit('playlist-changed', self.videos);
        self.mpd_command('playlistfind', ['file', filename], function(err, msg) {
            if (err) return;
            const re = /^Id: (\d+)$/im;
            const found = msg.match(re);
            if (found && found.length >= 2) {
                self.mpd_command('deleteid', [found[1]]);
            }
        });
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
        const gen = ++self._streamGen;
        self.emitter.emit('state-changed', self.getState());
        self.mpd_command('clear');
        self.lofiURLs.forEach(function(URL) {
            if (URL.length == 0)
                return;
            const exec = require('child_process').exec;
            const yt_downloader = 'yt-dlp';
            const cmd = yt_downloader + ' -g ' + URL + ' | tail -n 1';
            exec(cmd, function (err, stdout, stderr) {
                if (gen !== self._streamGen) return;
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

    this._switch_to_stream = function(playlist) {
        if (!playlist) {
            if (self.playlists.length === 0) return;
            playlist = self.playlists.find(p => p.name === self.currentPlaylist) || self.playlists[0];
        }
        console.log('change mode to stream:', playlist.name);
        self.mode = 'stream';
        self.currentPlaylist = playlist.name;
        const gen = ++self._streamGen;
        self.emitter.emit('state-changed', self.getState());
        self.streamTracks = [];
        self._streamUrlToTitle = {};
        self.emitter.emit('stream-tracks-changed', self.streamTracks);
        self.mpd_command('clear');
        const exec = require('child_process').exec;
        const yt_downloader = 'yt-dlp';
        const cmd = yt_downloader + ' --flat-playlist --print url --print title ' + playlist.url;
        exec(cmd, function (err, stdout, stderr) {
            if (gen !== self._streamGen) return;
            if (err) {
                console.log('stream playlist error:', playlist.name);
                return;
            }
            const lines = stdout.trim().split('\n');
            const tracks = [];
            for (let i = 0; i + 1 < lines.length; i += 2) {
                tracks.push({ url: lines[i], title: lines[i + 1] });
            }
            console.log(playlist.name + ': loading', tracks.length, 'tracks');
            self.streamTracks = tracks.map(t => t.title);
            self.emitter.emit('stream-tracks-changed', self.streamTracks);
            tracks.forEach(function(track) {
                const streamCmd = yt_downloader + ' -g ' + track.url + ' | tail -n 1';
                exec(streamCmd, function (err, stdout, stderr) {
                    if (gen !== self._streamGen) return;
                    if (err) {
                        return;
                    }
                    stdout = stdout.trim();
                    if (stdout.length == 0) {
                        return;
                    }
                    self._streamUrlToTitle[stdout] = track.title;
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
            self._switch_to_stream();
        } else {
            self._switch_to_likes();
        }
    }

    this.set_mode = function(target) {
        if (target.startsWith('stream:')) {
            const name = target.slice(7);
            const pl = self.playlists.find(p => p.name === name);
            if (pl) self._switch_to_stream(pl);
            return;
        }
        if (target == self.mode) return;
        if (target == 'lofi') {
            self._switch_to_lofi();
        } else if (target == 'stream') {
            self._switch_to_stream();
        } else {
            self._switch_to_likes();
        }
    }

    this.getState = function() {
        return {
            mode: self.mode,
            state: self.mpd_state,
            title: self.current_title,
            videos: self.videos,
            playlists: self.playlists,
            currentPlaylist: self.currentPlaylist,
            streamTracks: self.streamTracks
        };
    }

    this._savePlaylists = function() {
        fs.writeFileSync(self.playlistsPath, JSON.stringify(self.playlists, null, 2));
    }

    this.addPlaylist = function(name, url) {
        if (self.playlists.find(p => p.name === name)) return 'duplicate';
        if (!/[?&]list=/.test(url)) return 'not-playlist';
        self.playlists.push({ name, url });
        self._savePlaylists();
        self.emitter.emit('playlists-changed', self.playlists);
        return null;
    }

    this.removePlaylist = function(name) {
        const idx = self.playlists.findIndex(p => p.name === name);
        if (idx === -1) return;
        self.playlists.splice(idx, 1);
        self._savePlaylists();
        self.emitter.emit('playlists-changed', self.playlists);
        if (self.mode === 'stream' && self.currentPlaylist === name) {
            if (self.playlists.length > 0) {
                self._switch_to_stream(self.playlists[0]);
            } else {
                self._switch_to_likes();
            }
        }
    }

    this.play_stream_track = function(title) {
        // Find the stream URL for this title
        const url = Object.keys(self._streamUrlToTitle).find(
            k => self._streamUrlToTitle[k] === title
        );
        if (!url) return;
        self.mpd_command('playlistfind', ['file', url], function(err, msg) {
            if (err) return;
            const re = /^Pos: (\d+)$/im;
            const found = msg.match(re);
            if (found && found.length >= 2) {
                self.mpd_command('play', [found[1]]);
            }
        });
    }

    this.selectPlaylist = function(name) {
        const pl = self.playlists.find(p => p.name === name);
        if (!pl) return;
        self._switch_to_stream(pl);
    }

    // Register event handlers
    this.emitter.on('start', self.startstop);
    this.emitter.on('stop', self.startstop);
    this.emitter.on('reload', self.reload);
    this.emitter.on('next', self.next);
    this.emitter.on('mode-change', self.mode_change);
    this.emitter.on('set-mode', self.set_mode);
    this.emitter.on('play-track', self.play_track);
    this.emitter.on('play-stream-track', self.play_stream_track);
    this.emitter.on('remove-playlist', self.removePlaylist);
    this.emitter.on('select-playlist', self.selectPlaylist);

    // Launch sockets
    this.handler = unix.handler(self.emitter, commandSock);

    // Now we are ready
    return this
}

module.exports.player = player;
