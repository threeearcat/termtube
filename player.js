const decoder = require('lame').Decoder;
const ffmpeg = require('fluent-ffmpeg');
const EventEmitter = require('events').EventEmitter;
const Speaker = require('speaker');
const ytdl = require('ytdl-core');
const command = require(__dirname + '/command.js');

const status = Object.freeze(
    {'idle'    :1,
     'playing' :2,
     'paused'  :3
    })

function player(sock='/tmp/command.sock') {
    var self = this;
    this.videos = [];
    EventEmitter.call(this);
    this.emitter = new EventEmitter();
    this.title = '-';

    /*
     * Add videos in the given list into this.videos if not duplicated.
     *
     * @param {An array of videos} Videos to be added
     */
    this.add = function(videos) {
        videos.forEach(function(video) {
            const found = self.videos.find(v => v.id == videos.id);
            if (!found) {
                self.videos.push(video);
            }
        });
        console.log('Total videos', self.videos.length);
    }

    /*
     * Play a music randomly selected from the playlist.
     */
    this.start = function() {
        console.log('start');
        if (!self.checkStatus(status.idle)) {
            return;
        }
        if (self.videos.length == 0) {
            setTimeout(self.start, 1000);
        } else {
            // Get a random item
            let video = self.videos[Math.floor(Math.random() * self.videos.length)];
            // Play a music from the beginning.
            self.loadMusic(video);
            self.openSpeaker();
            self.playCurrent();
            self.setStatus(status.playing);
        }
    }

    /*
     * Pause playing a music. If the player is not playing a music, do nothing.
     */
    this.pause = function() {
        console.log('pause');
        if (!self.checkStatus(status.playing)) {
            return;
        }
        self.closeSpeaker();
        self.setStatus(status.paused);
    }

    /*
     * Stop playing a music. If the player is not playing a music, do nothing.
     */
    this.stop = function() {
        console.log('stop');
        if (!self.checkStatus(status.playing) &&
            !self.checkStatus(status.paused)) {
            return;
        }
        self.closeSpeaker();
        self.unloadMusic();
        self.setStatus(status.idle);
    }

    /*
     * Resume playing a music.
     */
    this.resume = function() {
        console.log('resume');
        if (!self.checkStatus(status.paused)) {
            return;
        }
        self.openSpeaker();
        self.playCurrent();
        self.setStatus(status.playing);
    }

    /*
     * Play a next music.
     */
    this.next = function() {
        console.log('next');
        self.stop();
        self.start();
    }

    // Register event handlers
    this.emitter.on('start', self.start);
    this.emitter.on('stop', self.stop);
    this.emitter.on('pause', self.pause);
    this.emitter.on('resume', self.resume);
    this.emitter.on('next', self.next);

    // Workers
    this.loadMusic = function(video) {
        const url = 'https://www.youtube.com/watch?v=' + video.id;
        const title = video.snippet.title;
        console.log('Playing a music from', url);
        var opt = {
            videoFormat: 'mp4',
            quality: 'lowest',
            audioFormat: 'mp3',
            filter (format) {
                return format.container === opt.videoFormat && format.audioBitrate
            }
        }
        const source = ytdl(url, opt);
        // The music being played
        self.ffmpeg = ffmpeg(source)
        self.ffmpeg.on('error', function(e) {
            console.log(e);
        });
        self.current = self.ffmpeg
            .format('mp3')
            .pipe(decoder());
        self.title = title;
    }

    this.unloadMusic = function() {
        if (isUndef(self.current)) {
            return;
        }
        self.ffmpeg.kill();
        self.ffmpeg =
        self.current = undefined;
        self.title = '-';
    }

    this.openSpeaker = function() {
        if (!isUndef(self.speaker)) {
            return;
        }
        // Create the Speaker instance to play the music
        self.speaker = new Speaker({});
        self.speaker.on('flush', function() {
            console.log('speaker flushed');
            self.stop();
            self.emitter.emit('start');
        });
        self.speaker.on('error', function(e) {
            // FIXME: The speaker error can be suppressed by emitting
            // the 'close' event instead of calling .close() in
            // .closeSpeaker(). But it slows down the close so I don't
            // want to. For now, just ignore the below error as it
            // likely indicates that we closed the speaker.
            if (e.toString() !== 'Error: write() failed: 0') {
                console.log(e);
                self.stop();
            }
        });
    }

    this.closeSpeaker = function() {
        if (isUndef(self.speaker)) {
            return;
        }
        self.speaker.close();
        self.speaker = undefined;
    }

    this.playCurrent = function() {
        if (isUndef(self.current) || isUndef(self.speaker)) {
            return;
        }
        self.current.pipe(self.speaker);
    }

    this.checkStatus = function(s) { return self.status == s; }
    this.setStatus = function(s) {
        console.log('change status:', s);
        const misc = s === status.paused ? '(paused)' : '';
        process.stdout.write(self.title + ' ' + misc);
        return self.status = s;
    }

    this.handler = command.handler(self.emitter, sock);

    // Now we are ready
    this.setStatus(status.idle);

    return this
}
module.exports.player = player;

function isUndef(v) {
    return typeof(v) === 'undefined';
}
