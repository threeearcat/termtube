const decoder = require('lame').Decoder;
const ffmpeg = require('fluent-ffmpeg');
const EventEmitter = require('events').EventEmitter;
const Speaker = require('speaker');
const ytdl = require('ytdl-core');

function player() {
    var self = this;
    this.videos = [];
    EventEmitter.call(this);
    this.emitter = new EventEmitter();
    
    /*
     * Add videos in the given list into this.videos if not duplicated.
     *
     * @param {An array of strings} Videos to be added
     */
    this.add = function(videos) {
        videos.forEach(function(video) {
            const found = self.videos.find(v => v.id == videos.id);
            if (!found) {
                self.videos.push(video);
            }
        });
        console.log("Total videos", self.videos.length);
    }
    /*
     * Start playing musics.
     */
    this.start = function() {
        self.emitter.emit('play');
    }

    this.play = function() {
        if (self.videos.length == 0) {
            setTimeout(self.play, 1000);
        } else {
            // Get a random item
            let video = self.videos[Math.floor(Math.random() * self.videos.length)];
            self._play(video);
        }
    }

    this._play = function(video) {
        const url = "https://www.youtube.com/watch?v=" + video.id;
        const title = video.snippet.title;
        console.log("Playing a music from", url);
        console.log("title", title);
        process.stdout.write(title);
        var opt = {
            videoFormat: 'mp4',
            quality: 'lowest',
            audioFormat: 'mp3',
            filter (format) {
                return format.container === opt.videoFormat && format.audioBitrate
            }
        }
        const source = ytdl(url, opt);

        // Create the Speaker instance
        const speaker = new Speaker({
            channels: 2,          // 2 channels
            bitDepth: 16,         // 16-bit samples
            sampleRate: 44100     // 44,100 Hz sample rate
        }).on('flush', function() {
            self.emitter.emit('play');
        });

        ffmpeg(source)
            .on('error', function(e) {
                console.log(e);
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
