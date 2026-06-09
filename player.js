'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { EventEmitter } = require('events');
const unix = require(__dirname + '/unix');
const mpd = require('mpd');

const COMMAND_SOCK = '/tmp/command.sock';
const LOFI_URL_FILE = process.env.HOME + '/.mpd/lofi.lst';
const PLAYLISTS_PATH = process.env.HOME + '/.termtube/playlists.json';
const DEFAULT_PLAYLISTS = [
    { name: 'calm-jazz', url: 'https://www.youtube.com/playlist?list=PL61ZikC3WfojSgt1PeWLSzj9qqXpVpCfA' }
];
const STREAM_URL_FALLBACK_TTL_MS = 6 * 60 * 60 * 1000;
const STREAM_URL_REFRESH_MARGIN_MS = 30 * 60 * 1000;

function directUrlExpiry(url) {
    try {
        const expire = new URL(url).searchParams.get('expire');
        if (!expire) return null;
        const expiry = parseInt(expire, 10);
        return Number.isFinite(expiry) ? expiry * 1000 : null;
    } catch {
        return null;
    }
}

class Player {
    constructor(commandSock = COMMAND_SOCK, lofiURLFile = LOFI_URL_FILE, playlistsPath = PLAYLISTS_PATH) {
        this.videos = [];
        this.mode = 'likes';
        this._currentTitle = '';
        this.currentPlaylist = '';
        this.streamTracks = [];
        this._streamUrlToTitle = {};
        this._streamUrlsExpireAt = 0;
        this._streamGen = 0;
        this._random = true;

        this.emitter = new EventEmitter();
        try {
            this.lofiURLs = fs.readFileSync(lofiURLFile, 'utf-8').split('\n');
        } catch {
            console.log('failed to read the lofi URLs', lofiURLFile);
            this.lofiURLs = [];
        }

        this.playlistsPath = playlistsPath;
        try {
            this.playlists = JSON.parse(fs.readFileSync(playlistsPath, 'utf-8'));
        } catch {
            const dir = path.dirname(playlistsPath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            this.playlists = DEFAULT_PLAYLISTS.slice();
            fs.writeFileSync(playlistsPath, JSON.stringify(this.playlists, null, 2));
        }

        // MPD state
        this._mpdReady = false;
        this._mpdState = 'stop';
        this.cmd = mpd.cmd;
        this._mpdRetries = 0;
        this._connectMpd();

        // Register event handlers
        this.emitter.on('start', () => this.startStop());
        this.emitter.on('stop', () => this.startStop());
        this.emitter.on('reload', () => this.reload());
        this.emitter.on('next', () => this.next());
        this.emitter.on('mode-change', () => this.modeChange());
        this.emitter.on('set-mode', target => this.setMode(target));
        this.emitter.on('play-track', filename => this.playTrack(filename));
        this.emitter.on('play-stream-track', title => this.playStreamTrack(title));
        this.emitter.on('remove-playlist', name => this.removePlaylist(name));
        this.emitter.on('select-playlist', name => this.selectPlaylist(name));
        this.emitter.on('toggle-random', () => this.toggleRandom());

        // Launch sockets
        this.handler = unix.handler(this.emitter, commandSock);
    }

    // --- MPD connection ---

    _connectMpd() {
        this._mpdReady = false;
        this.mpd = mpd.connect({
            path: process.env.HOME + '/.mpd/socket'
        });
        const scheduleReconnect = () => {
            this._mpdReady = false;
            if (++this._mpdRetries >= 5) {
                console.log('mpd: giving up after 5 retries');
                return;
            }
            setTimeout(() => {
                console.log('mpd reconnecting (' + this._mpdRetries + '/5)...');
                this._connectMpd();
            }, 2000);
        };
        this.mpd.on('error', err => {
            console.log('mpd connection error:', err.message);
            scheduleReconnect();
        });
        this.mpd.on('end', () => {
            console.log('mpd connection closed');
            scheduleReconnect();
        });
        this.mpd.on('ready', () => {
            console.log('mpd ready');
            this._mpdReady = true;
            this._mpdRetries = 0;
            this._mpdCommand('stop');
            this.reload();
            this._mpdCommand('random', [this._random ? '1' : '0']);
            this._mpdCommand('repeat', ['1']);
        });
        this.mpd.on('system-player', () => {
            this._updateMpdState();
        });
    }

    _mpdCommand(cmd, args = [], callback = () => {}) {
        if (!this._mpdReady) return;
        return this.mpd.sendCommand(this.cmd(cmd, args), callback);
    }

    _resetStreamExpiry() {
        this._streamUrlsExpireAt = Date.now() + STREAM_URL_FALLBACK_TTL_MS;
    }

    _rememberStreamUrl(url, title) {
        this._streamUrlToTitle[url] = title;
        const expiresAt = directUrlExpiry(url) || (Date.now() + STREAM_URL_FALLBACK_TTL_MS);
        this._streamUrlsExpireAt = Math.min(this._streamUrlsExpireAt || expiresAt, expiresAt);
    }

    _streamUrlsNeedRefresh() {
        if (this.mode !== 'lofi' && this.mode !== 'stream') return false;
        if (!this._streamUrlsExpireAt) return true;
        return Date.now() + STREAM_URL_REFRESH_MARGIN_MS >= this._streamUrlsExpireAt;
    }

    _refreshStreamUrls(autoplay) {
        if (this.mode === 'lofi') {
            this._switchToLofi({ autoplay });
            return true;
        }
        if (this.mode === 'stream') {
            this._switchToStream(undefined, { autoplay });
            return true;
        }
        return false;
    }

    // Re-resolve stream/lofi URLs if they are stale before issuing playback.
    // Returns true when a refresh was kicked off (caller should not also play).
    _ensureFreshUrls() {
        if (this._streamUrlsNeedRefresh()) {
            this._refreshStreamUrls(true);
            return true;
        }
        return false;
    }

    // --- Title / State ---

    _printTitle(title) {
        title = title.trim();
        console.log('Title: ' + title);
        this._currentTitle = title;
        fs.writeFile(process.env.HOME + '/.mpd/current_title', title, err => {
            if (err) console.log(err);
        });
        this.emitter.emit('title-changed', title);
    }

    _updateTitle() {
        this._mpdCommand('currentsong', [], (err, msg) => {
            if (err) { console.log('currentsong error:', err.message); return; }
            const fileMatch = msg.match(/^file: (.+)$/im);
            if (!fileMatch || !fileMatch[1]) {
                this._printTitle('Unknown title');
                return;
            }
            const file = fileMatch[1];
            if (this.mode === 'stream' || this.mode === 'lofi') {
                const mapped = this._streamUrlToTitle[file];
                if (mapped) {
                    this._printTitle(mapped);
                } else if (this.mode === 'lofi') {
                    this._printTitle('Playing lofi music');
                } else {
                    this._printTitle('Playing ' + this.currentPlaylist);
                }
                return;
            }
            const localMatch = file.match(/^([a-z0-9.\-_]*)$/im);
            if (!localMatch) {
                this._printTitle('Unknown title');
                return;
            }
            const filename = localMatch[1];
            const found = this.videos.find(v => v.filename === filename);
            this._printTitle(found ? found.title : filename);
        });
    }

    _updateMpdState() {
        this._mpdCommand('status', [], (err, msg) => {
            if (err) { console.log('status error:', err.message); return; }
            const found = msg.match(/^state: ([a-z]*)$/im);
            if (!found || found.length < 2) {
                this._setState('stop');
            } else {
                this._setState(found[1]);
            }
            // MPD reports playback failures (e.g. expired stream URLs return 403)
            // via an `error:` line. If our URLs are stale, self-heal by refreshing
            // instead of letting MPD churn through the whole dead queue. Gated on
            // _streamUrlsNeedRefresh() so fresh-but-failing URLs don't loop.
            if (/^error: /im.test(msg) && this._streamUrlsNeedRefresh()) {
                console.log('mpd playback error with stale stream URLs; refreshing');
                this._mpdCommand('clearerror');
                this._refreshStreamUrls(true);
                return;
            }
            this._updateTitle();
        });
    }

    _checkState(s) {
        return this._mpdState === s;
    }

    _setState(state) {
        console.log('change the state to', state);
        this._mpdState = state;
        this.emitter.emit('state-changed', this.getState());
    }

    // --- Random ---

    toggleRandom() {
        this._random = !this._random;
        this._mpdCommand('random', [this._random ? '1' : '0']);
        console.log('random:', this._random);
        this.emitter.emit('state-changed', this.getState());
    }

    // --- Playback ---

    start() {
        if (this._ensureFreshUrls()) return;
        if (this._checkState('stop') && this.mode === 'likes') {
            this.reload();
        }
        this._mpdCommand('play');
    }

    stop() {
        this._mpdCommand('stop');
    }

    startStop() {
        if (this._checkState('stop') || this._checkState('pause')) {
            this.start();
        } else {
            this.stop();
        }
    }

    next() {
        if (this._ensureFreshUrls()) return;
        this._mpdCommand('next');
    }

    reload() {
        this.mode = 'likes';
        ++this._streamGen;
        this._streamUrlsExpireAt = 0;
        this.emitter.emit('state-changed', this.getState());
        this._mpdCommand('clear');
        this._mpdCommand('update');
        this.videos.forEach(video => {
            this._mpdCommand('add', [video.filename]);
        });
    }

    // --- Likes ---

    add(id, title) {
        const filename = id + '.webm';
        if (this.videos.findIndex(v => v.filename === filename) !== -1) {
            return;
        }
        this.videos.push({ title, filename });
        this.emitter.emit('playlist-changed', this.videos);
        this._mpdCommand('update');
        if (this.mode === 'likes') {
            this._mpdCommand('add', [filename]);
        }
    }

    remove(filename) {
        const idx = this.videos.findIndex(v => v.filename === filename);
        if (idx === -1) return;
        this.videos.splice(idx, 1);
        this.emitter.emit('playlist-changed', this.videos);
        this._mpdCommand('playlistfind', ['file', filename], (err, msg) => {
            if (err) return;
            const found = msg.match(/^Id: (\d+)$/im);
            if (found && found.length >= 2) {
                this._mpdCommand('deleteid', [found[1]]);
            }
        });
    }

    playTrack(filename) {
        this._mpdCommand('playlistfind', ['file', filename], (err, msg) => {
            if (err) return;
            const found = msg.match(/^Pos: (\d+)$/im);
            if (found && found.length >= 2) {
                this._mpdCommand('play', [found[1]]);
            }
        });
    }

    // --- Mode switching ---

    modeChange() {
        if (this.mode === 'likes') {
            this._switchToLofi();
        } else if (this.mode === 'lofi') {
            this._switchToStream();
        } else {
            this._switchToLikes();
        }
    }

    setMode(target) {
        if (target.startsWith('stream:')) {
            const name = target.slice(7);
            const pl = this.playlists.find(p => p.name === name);
            if (pl) this._switchToStream(pl);
            return;
        }
        if (target === this.mode) return;
        if (target === 'lofi') {
            this._switchToLofi();
        } else if (target === 'stream') {
            this._switchToStream();
        } else {
            this._switchToLikes();
        }
    }

    _switchToLikes() {
        console.log('change mode to likes');
        this.mode = 'likes';
        this.emitter.emit('state-changed', this.getState());
        this.reload();
    }

    _switchToLofi(options = {}) {
        console.log('change mode to lofi');
        this.mode = 'lofi';
        const gen = ++this._streamGen;
        this._streamUrlToTitle = {};
        this._resetStreamExpiry();
        const urls = this.lofiURLs.filter(url => url.length > 0);
        let autoplayStarted = false;
        const maybeAutoplay = () => {
            if (!options.autoplay || autoplayStarted) return;
            autoplayStarted = true;
            this._mpdCommand('play');
        };
        // Seed the track list with placeholders so the GUI can show every entry
        // (titles fill in as they resolve; failures are marked broken).
        this.streamTracks = urls.map(url => ({ title: url, broken: false }));
        this.emitter.emit('stream-tracks-changed', this.streamTracks);
        this.emitter.emit('state-changed', this.getState());
        this._mpdCommand('clear');
        urls.forEach((url, i) => {
            execFile('yt-dlp', ['--print', '%(title)s', '-g', url], (err, stdout) => {
                if (gen !== this._streamGen) return;
                const lines = err ? [] : stdout.trim().split('\n');
                if (lines.length < 2) {
                    console.log('lofi URL is broken:', url);
                    this.streamTracks[i] = { title: url, broken: true };
                    this.emitter.emit('stream-tracks-changed', this.streamTracks);
                    return;
                }
                const title = lines[0];
                const streamUrl = lines[lines.length - 1];
                this.streamTracks[i] = { title, broken: false };
                this._rememberStreamUrl(streamUrl, title);
                this.emitter.emit('stream-tracks-changed', this.streamTracks);
                this._mpdCommand('add', [streamUrl], maybeAutoplay);
            });
        });
    }

    _switchToStream(playlist, options = {}) {
        if (!playlist) {
            if (this.playlists.length === 0) return;
            playlist = this.playlists.find(p => p.name === this.currentPlaylist) || this.playlists[0];
        }
        console.log('change mode to stream:', playlist.name);
        this.mode = 'stream';
        this.currentPlaylist = playlist.name;
        const gen = ++this._streamGen;
        this._resetStreamExpiry();
        this.emitter.emit('state-changed', this.getState());
        this.streamTracks = [];
        this._streamUrlToTitle = {};
        this.emitter.emit('stream-tracks-changed', this.streamTracks);
        this._mpdCommand('clear');
        execFile('yt-dlp', ['--flat-playlist', '--print', 'url', '--print', 'title', playlist.url], (err, stdout) => {
            if (gen !== this._streamGen) return;
            if (err) {
                console.log('stream playlist error:', playlist.name);
                // Resolution failed, so the (now-cleared) queue has no fresh URLs;
                // mark stale so the next play attempt retries instead of giving up.
                this._streamUrlsExpireAt = 0;
                return;
            }
            const lines = stdout.trim().split('\n');
            const tracks = [];
            for (let i = 0; i + 1 < lines.length; i += 2) {
                tracks.push({ url: lines[i], title: lines[i + 1] });
            }
            console.log(playlist.name + ': loading', tracks.length, 'tracks');
            this.streamTracks = tracks.map(t => t.title);
            this.emitter.emit('stream-tracks-changed', this.streamTracks);
            let autoplayStarted = false;
            const maybeAutoplay = () => {
                if (!options.autoplay || autoplayStarted) return;
                autoplayStarted = true;
                this._mpdCommand('play');
            };
            tracks.forEach(track => {
                execFile('yt-dlp', ['-g', track.url], (err, stdout) => {
                    if (gen !== this._streamGen) return;
                    if (err) return;
                    const lines = stdout.split(/\r?\n/).filter(line => line.length !== 0);
                    if (lines.length === 0) return;
                    const streamUrl = lines[lines.length - 1];
                    this._rememberStreamUrl(streamUrl, track.title);
                    this._mpdCommand('add', [streamUrl], maybeAutoplay);
                });
            });
        });
    }

    // --- Stream playlist CRUD ---

    addPlaylist(name, url) {
        if (this.playlists.find(p => p.name === name)) return 'duplicate';
        if (!/[?&]list=/.test(url)) return 'not-playlist';
        this.playlists.push({ name, url });
        this._savePlaylists();
        this.emitter.emit('playlists-changed', this.playlists);
        return null;
    }

    removePlaylist(name) {
        const idx = this.playlists.findIndex(p => p.name === name);
        if (idx === -1) return;
        this.playlists.splice(idx, 1);
        this._savePlaylists();
        this.emitter.emit('playlists-changed', this.playlists);
        if (this.mode === 'stream' && this.currentPlaylist === name) {
            if (this.playlists.length > 0) {
                this._switchToStream(this.playlists[0]);
            } else {
                this._switchToLikes();
            }
        }
    }

    selectPlaylist(name) {
        const pl = this.playlists.find(p => p.name === name);
        if (!pl) return;
        this._switchToStream(pl);
    }

    playStreamTrack(title) {
        // Stale URLs would 403 and make MPD skip through the whole dead queue,
        // so re-resolve first; the refresh autoplays from the top.
        if (this._ensureFreshUrls()) return;
        const url = Object.keys(this._streamUrlToTitle).find(
            k => this._streamUrlToTitle[k] === title
        );
        if (!url) return;
        this._mpdCommand('playlistfind', ['file', url], (err, msg) => {
            if (err) return;
            const found = msg.match(/^Pos: (\d+)$/im);
            if (found && found.length >= 2) {
                this._mpdCommand('play', [found[1]]);
            }
        });
    }

    _savePlaylists() {
        fs.writeFileSync(this.playlistsPath, JSON.stringify(this.playlists, null, 2));
    }

    // --- State ---

    getState() {
        return {
            mode: this.mode,
            state: this._mpdState,
            title: this._currentTitle,
            videos: this.videos,
            playlists: this.playlists,
            currentPlaylist: this.currentPlaylist,
            streamTracks: this.streamTracks,
            random: this._random
        };
    }
}

module.exports = { Player };
