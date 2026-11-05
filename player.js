'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { StreamResolver } = require(__dirname + '/stream-resolver');
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
    constructor(commandSock = COMMAND_SOCK, lofiURLFile = LOFI_URL_FILE, playlistsPath = PLAYLISTS_PATH, resolver = new StreamResolver()) {
        this.videos = [];
        this.mode = 'likes';
        this._currentTitle = '';
        this.currentPlaylist = '';
        this.currentUrl = '';
        this.urlError = '';
        this.streamTracks = [];
        this._streamUrlToTitle = {};
        this._streamGen = 0;
        this._streamResolver = resolver;
        this._streamTrackJobs = [];
        this._pendingStreamTrack = null;
        this._streamAutoplay = false;
        this._random = true;
        this._activeStreamTrack = null;
        this._nextStreamTrack = null;
        this._streamPlaying = false;
        this._streamListLoading = false;
        this._playRequest = 0;
        this._prefetchFailures = 0;
        this._startFailures = 0;
        this._retryTimer = null;

        this.emitter = new EventEmitter();
        this._streamResolver.queue.on('blocked', error => {
            console.log(error.message);
            this._scheduleStreamRetry();
        });
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
        this.emitter.on('play-url', url => this.playUrl(url));
        this.emitter.on('play-track', filename => this.playTrack(filename));
        this.emitter.on('play-stream-track', selection => this.playStreamTrack(selection));
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

    _isStreaming() {
        return ['lofi', 'stream', 'url'].includes(this.mode);
    }

    _cancelStreamResolution() {
        ++this._streamGen;
        ++this._playRequest;
        clearTimeout(this._retryTimer);
        this._retryTimer = null;
        this._streamResolver.cancel();
        this._streamTrackJobs = [];
        this._pendingStreamTrack = null;
        this._activeStreamTrack = null;
        this._nextStreamTrack = null;
        this._streamAutoplay = false;
        this._streamPlaying = false;
        this._streamListLoading = false;
        this._streamUrlToTitle = {};
        return this._streamGen;
    }

    _trackUrlIsFresh(track) {
        return !!track?.streamUrl && Date.now() + STREAM_URL_REFRESH_MARGIN_MS < track.expiresAt;
    }

    _scheduleStreamRetry() {
        if (!this._isStreaming() || this._retryTimer) return;
        if (!this._streamPlaying && !this._pendingStreamTrack && !this._streamAutoplay) return;
        const gen = this._streamGen;
        const wait = Math.max(1, this._streamResolver.queue.blockedUntil - Date.now());
        this._retryTimer = setTimeout(() => {
            this._retryTimer = null;
            if (gen !== this._streamGen || !this._isStreaming()) return;
            if (this._pendingStreamTrack) this._requestStreamTrack(this._pendingStreamTrack);
            else if (this._streamPlaying) this._prepareNextStreamTrack();
            else if (this._streamAutoplay) this.start();
        }, wait);
        this._retryTimer.unref();
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
        const gen = this._streamGen;
        const request = this._playRequest;
        this._mpdCommand('currentsong', [], (err, msg) => {
            if (err || gen !== this._streamGen || request !== this._playRequest) return;
            const fileMatch = msg.match(/^file: (.+)$/im);
            if (!fileMatch || !fileMatch[1]) {
                this._printTitle('Unknown title');
                return;
            }
            const file = fileMatch[1];
            if (['stream', 'lofi', 'url'].includes(this.mode)) {
                const track = this._streamTrackJobs.find(track => track.streamUrl === file);
                if (track && track !== this._activeStreamTrack && this._streamPlaying && !this._pendingStreamTrack) {
                    if (this._activeStreamTrack) this._activeStreamTrack.queued = false;
                    this._activeStreamTrack = track;
                    this._nextStreamTrack = null;
                    this._prefetchFailures = 0;
                    this._prepareNextStreamTrack();
                }
                const mapped = this._streamUrlToTitle[file];
                if (mapped) {
                    this._printTitle(mapped);
                } else if (this.mode === 'lofi') {
                    this._printTitle('Playing lofi music');
                } else {
                    this._printTitle('Playing ' + (this.mode === 'url' ? this.currentUrl : this.currentPlaylist));
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
        const gen = this._streamGen;
        const request = this._playRequest;
        this._mpdCommand('status', [], (err, msg) => {
            if (err || gen !== this._streamGen || request !== this._playRequest) return;
            const state = msg.match(/^state: ([a-z]*)$/im)?.[1] || 'stop';
            this._setState(state);
            if (this._isStreaming() && /^error: /im.test(msg)) {
                const track = this._pendingStreamTrack || this._activeStreamTrack;
                this._mpdCommand('clearerror');
                if (track?.streamUrl && !this._trackUrlIsFresh(track)) {
                    track.streamUrl = null;
                    this._requestStreamTrack(track);
                } else {
                    // Fresh URLs that fail must not cause an unbounded retry loop.
                    this._streamPlaying = false;
                    this._streamAutoplay = false;
                    this._reportUrlError();
                }
                return;
            }
            if (this._isStreaming() && state === 'stop' && this._streamPlaying && !this._pendingStreamTrack) {
                // The song ended before its successor was ready. Reuse the
                // pending prefetch instead of restarting the whole playlist.
                this._streamPlaying = false;
                const next = this._nextStreamTrack || this._chooseStreamTrack(this._activeStreamTrack);
                if (next) this._requestStreamTrack(next);
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
        // Keep the prepared successor; future choices use the new setting.
        if (!this._isStreaming()) {
            this._mpdCommand('random', [this._random ? '1' : '0']);
        }
        this.emitter.emit('state-changed', this.getState());
    }

    // --- Playback ---

    start() {
        if (this._isStreaming()) {
            if (this.mode === 'url' && !this.currentUrl) return;
            this._streamAutoplay = true;
            if (this._streamListLoading) return;
            if (!this._streamTrackJobs.length) {
                if (this.mode === 'stream') this._switchToStream(undefined, { autoplay: true });
                else if (this.mode === 'url') this._switchToUrl({ autoplay: true });
                return;
            }
            const track = this._pendingStreamTrack || this._activeStreamTrack || this._chooseStreamTrack();
            if (track) this._requestStreamTrack(track);
            return;
        }
        if (this._checkState('stop')) this.reload();
        this._mpdCommand('play');
    }

    stop() {
        ++this._playRequest;
        clearTimeout(this._retryTimer);
        this._retryTimer = null;
        this._pendingStreamTrack = null;
        this._streamAutoplay = false;
        this._streamPlaying = false;
        this._nextStreamTrack = null;
        this._streamResolver.cancel();
        for (const track of this._streamTrackJobs) track.job = null;
        this._streamListLoading = false;
        this._mpdCommand('stop');
    }

    startStop() {
        if (this._streamAutoplay || this._pendingStreamTrack || this._streamPlaying) this.stop();
        else if (this._checkState('stop') || this._checkState('pause')) this.start();
        else this.stop();
    }

    next() {
        if (this._isStreaming()) {
            if (this._streamListLoading) { this._streamAutoplay = true; return; }
            const track = this._nextStreamTrack || this._chooseStreamTrack(this._pendingStreamTrack || this._activeStreamTrack);
            if (track) this._requestStreamTrack(track);
            return;
        }
        this._mpdCommand('next');
    }

    reload() {
        this.mode = 'likes';
        this._cancelStreamResolution();
        this._configureMpdQueue(false);
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
        } else if (this.mode === 'stream') {
            this._switchToUrl();
        } else {
            this._switchToLikes();
        }
    }

    setMode(target) {
        if (typeof target !== 'string') return;
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
        } else if (target === 'url') {
            this._switchToUrl();
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
        this.mode = 'lofi';
        this._beginStreamLoad(options);
        this._installStreamTracks(this.lofiURLs.filter(url => url.trim()).map(url => ({ url, title: url, resolveTitle: true })));
    }

    _switchToStream(playlist, options = {}) {
        if (!playlist) {
            if (this.playlists.length === 0) return;
            playlist = this.playlists.find(p => p.name === this.currentPlaylist) || this.playlists[0];
        }
        console.log('change mode to stream:', playlist.name);
        this.mode = 'stream';
        this.currentPlaylist = playlist.name;
        this._loadStream(playlist, options);
    }

    // --- Direct URL playback ---

    playUrl(url) {
        if (typeof url !== 'string') return 'invalid-url';
        url = url.trim();
        try {
            const parsed = new URL(url);
            if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
                return 'invalid-url';
            }
        } catch {
            return 'invalid-url';
        }
        this.currentUrl = url;
        this._switchToUrl({ autoplay: true });
        return null;
    }

    _switchToUrl(options = {}) {
        this.mode = 'url';
        this._loadStream(this.currentUrl ? { name: this.currentUrl, url: this.currentUrl } : null, options);
    }

    _configureMpdQueue(streaming) {
        this._mpdCommand('random', [!streaming && this._random ? '1' : '0']);
        this._mpdCommand('repeat', [streaming ? '0' : '1']);
        this._mpdCommand('single', ['0']);
        // MPD transitions directly to the prepared successor and discards the
        // finished entry, keeping its queue bounded to current + next.
        this._mpdCommand('consume', [streaming ? '1' : '0']);
    }

    _beginStreamLoad(options) {
        const gen = this._cancelStreamResolution();
        this._streamAutoplay = !!options.autoplay;
        this._startFailures = 0;
        this.streamTracks = [];
        this.urlError = '';
        this._currentTitle = '';
        this._configureMpdQueue(true);
        this._mpdCommand('clear');
        this.emitter.emit('title-changed', '');
        this.emitter.emit('stream-tracks-changed', this.streamTracks);
        this.emitter.emit('state-changed', this.getState());
        return gen;
    }

    _loadStream(source, options = {}) {
        const gen = this._beginStreamLoad(options);
        if (!source) return;
        if (this.mode === 'url' && !new URL(source.url).searchParams.get('list')) {
            this._installStreamTracks([{ url: source.url, title: source.url, resolveTitle: true }]);
            return;
        }
        this._streamListLoading = true;
        this._streamResolver.exec(['--flat-playlist', '--yes-playlist', '--print', 'url', '--print', 'title', source.url], (err, stdout) => {
            if (gen !== this._streamGen) return;
            this._streamListLoading = false;
            if (err) {
                if (err.code === 'YOUTUBE_BLOCKED') this._scheduleStreamRetry();
                else this._reportUrlError();
                return;
            }
            const lines = stdout.trim().split(/\r?\n/);
            const tracks = [];
            for (let i = 0; i + 1 < lines.length; i += 2) tracks.push({ url: lines[i], title: lines[i + 1] });
            console.log(source.name + ': listed', tracks.length, 'tracks');
            this._installStreamTracks(tracks);
        }, 2);
    }

    _installStreamTracks(tracks) {
        this._streamTrackJobs = tracks;
        this._emitStreamTracks();
        if (!tracks.length) { this._reportUrlError(); return; }
        if (this._streamAutoplay) this.start();
    }

    _emitStreamTracks() {
        this.streamTracks = this._streamTrackJobs.map(track => track.failed
            ? { title: track.title, broken: true } : track.title);
        this.emitter.emit('stream-tracks-changed', this.streamTracks);
        this.emitter.emit('state-changed', this.getState());
    }

    _chooseStreamTrack(current = null) {
        const tracks = this._streamTrackJobs;
        const available = tracks.filter(track => !track.failed && track !== current);
        if (!available.length) return current && !current.failed ? current : null;
        if (this._random) return available[Math.floor(Math.random() * available.length)];
        const index = tracks.indexOf(current);
        for (let step = 1; step <= tracks.length; step++) {
            const track = tracks[(index + step) % tracks.length];
            if (!track.failed && track !== current) return track;
        }
        return null;
    }

    _requestStreamTrack(track) {
        if (this._streamResolver.queue.getError() && !this._trackUrlIsFresh(track)) {
            this._pendingStreamTrack = track;
            this._streamAutoplay = true;
            this._scheduleStreamRetry();
            return;
        }
        if (this._pendingStreamTrack !== track) ++this._playRequest;
        this._pendingStreamTrack = track;
        this._streamAutoplay = true;
        this.urlError = '';
        track.failed = false;
        // Keep the current audio playing until the chosen track is ready.
        for (const other of this._streamTrackJobs) {
            if (other !== track && other.job) {
                this._streamResolver.cancel(other.job);
                other.job = null;
            }
        }
        if (this._trackUrlIsFresh(track)) this._activateStreamTrack(track);
        else if (!track.job) this._queueStreamTrack(track);
        this._streamResolver.prioritize(track.job);
        this.emitter.emit('state-changed', this.getState());
    }

    _queueStreamTrack(track) {
        const gen = this._streamGen;
        track.streamUrl = null;
        const args = ['--no-playlist', '-f', 'bestaudio/best'];
        if (track.resolveTitle) args.push('--print', 'title');
        args.push('-g', track.url);
        track.job = this._streamResolver.exec(args, (err, stdout) => {
            if (gen !== this._streamGen) return;
            track.job = null;
            const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
            if (err || lines.length < (track.resolveTitle ? 2 : 1)) {
                if (err?.code === 'YOUTUBE_BLOCKED') { this._scheduleStreamRetry(); return; }
                track.failed = true;
                if (this._pendingStreamTrack === track) {
                    this._pendingStreamTrack = null;
                    const next = this._chooseStreamTrack(track);
                    if (next && ++this._startFailures < 3) this._requestStreamTrack(next);
                    else { this._streamAutoplay = false; this._reportUrlError(); }
                } else if (this._nextStreamTrack === track) {
                    this._nextStreamTrack = null;
                    if (++this._prefetchFailures < 3) this._prepareNextStreamTrack();
                }
                this._emitStreamTracks();
                return;
            }
            if (track.resolveTitle) track.title = lines[0];
            track.streamUrl = lines.at(-1);
            track.expiresAt = directUrlExpiry(track.streamUrl) || Date.now() + STREAM_URL_FALLBACK_TTL_MS;
            track.failed = false;
            this._streamUrlToTitle[track.streamUrl] = track.title;
            this._emitStreamTracks();
            if (this._pendingStreamTrack === track) this._activateStreamTrack(track);
            else if (this._nextStreamTrack === track) this._addPreparedTrack(track);
        }, this._pendingStreamTrack === track ? 2 : 0);
    }

    _activateStreamTrack(track) {
        const gen = this._streamGen;
        const request = ++this._playRequest;
        this._streamPlaying = false;
        this._nextStreamTrack = null;
        for (const entry of this._streamTrackJobs) entry.queued = false;
        this._mpdCommand('clear');
        this._mpdCommand('add', [track.streamUrl], err => {
            if (gen !== this._streamGen || request !== this._playRequest || this._pendingStreamTrack !== track) return;
            if (err) { this._pendingStreamTrack = null; this._streamAutoplay = false; this._reportUrlError(); return; }
            track.queued = true;
            this._activeStreamTrack = track;
            this._prefetchFailures = 0;
            this._startFailures = 0;
            this._mpdCommand('play', [], err => {
                if (gen !== this._streamGen || request !== this._playRequest) return;
                if (err) { this._streamPlaying = false; this._reportUrlError(); return; }
                this._pendingStreamTrack = null;
                this._streamAutoplay = false;
                this._streamPlaying = true;
                this._prepareNextStreamTrack();
            });
        });
    }

    _prepareNextStreamTrack() {
        if (!this._streamPlaying || this._pendingStreamTrack) return;
        if (!this._nextStreamTrack) this._nextStreamTrack = this._chooseStreamTrack(this._activeStreamTrack);
        const track = this._nextStreamTrack;
        if (!track || track === this._activeStreamTrack) return;
        if (this._trackUrlIsFresh(track)) this._addPreparedTrack(track);
        else if (this._streamResolver.queue.getError()) this._scheduleStreamRetry();
        else if (!track.job) this._queueStreamTrack(track);
    }

    _addPreparedTrack(track) {
        if (track.queued || !this._streamPlaying || this._pendingStreamTrack || this._nextStreamTrack !== track) return;
        track.queued = true;
        const gen = this._streamGen;
        this._mpdCommand('add', [track.streamUrl], err => {
            if (gen !== this._streamGen) return;
            if (err) track.queued = false;
        });
    }

    _reportUrlError() {
        this.urlError = 'Unable to play this URL. Check that the live stream or playlist is available and try again.';
        this._streamAutoplay = false;
        console.log('Unable to prepare stream playback');
        this.emitter.emit('state-changed', this.getState());
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

    playStreamTrack(selection) {
        if (!this._isStreaming()) return;
        const track = Number.isInteger(selection)
            ? this._streamTrackJobs[selection]
            : this._streamTrackJobs.find(track => track.title === selection);
        if (!track) return;
        this._startFailures = 0;
        this._requestStreamTrack(track);
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
            currentUrl: this.currentUrl,
            urlError: this.urlError,
            urlLoading: this.mode === 'url' && !!this.currentUrl && !this.urlError && !!(this._streamAutoplay || this._pendingStreamTrack || this._streamListLoading),
            streamTracks: this.streamTracks,
            random: this._random
        };
    }
}

module.exports = { Player };
