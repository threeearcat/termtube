const decoder = require('lame').Decoder;
const ffmpeg = require('fluent-ffmpeg');
const EventEmitter = require('events').EventEmitter;
const ytdl = require('ytdl-core');

function player() {
    var self = this;
    this.ids = new Set();
    EventEmitter.call(this);
    this.emitter = new EventEmitter();
    
    /*
     * Add IDs in the given list into this.ids if not duplicated.
     *
     * @param {An array of strings} Video IDs to be added
     */
    this.add = function(ids) {
        ids.forEach(function(id) {self.ids.add(id);});
    }
    /*
     * Start playing musics.
     */
    this.start = function() {
        self.emitter.emit('play');
    }

    this.play = function() {
        if (self.ids.size == 0) {
            setTimeout(self.play, 1000);
        } else {
            let ids = self.ids.values();
            let id = ids.next().value;
            self._play(id);
        }
    }

    this._play = function(id) {
        const url = "https://www.youtube.com/watch?v=" + id;
        console.log(url);
        var opt = {
            videoFormat: 'mp4',
            quality: 'lowest',
            audioFormat: 'mp3',
            filter (format) {
                return format.container === opt.videoFormat && format.audioBitrate
            }
        }
        const video = ytdl(url, opt);

        const Speaker = require('speaker');
        // Create the Speaker instance
        const speaker = new Speaker({
            channels: 2,          // 2 channels
            bitDepth: 16,         // 16-bit samples
            sampleRate: 44100     // 44,100 Hz sample rate
        });

        ffmpeg(video)
            .on('error', function(e) {
                console.log(e);
            })
            .on('end', function() {
                self.emitter.emit('play');
            })
            .format('mp3')
            .pipe(decoder())
            .pipe(speaker);
    }

    /*
     * Pause playing a music. If the player is not playing a music, do nothing.
     */
    this.pause = function() {}

    this._pause = function() {}

    // Register event handlers
    this.emitter.on('play', self.play);
    this.emitter.on('pause', self.pause);
    return this
}
module.exports.player = player;
