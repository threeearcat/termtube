const fs = require('fs');
const EventEmitter = require('events').EventEmitter;
const unix = require(__dirname + '/unix');

const status = Object.freeze(
    {'idle'    :1,
     'playing' :2,
     'paused'  :3
    })

const commandSockDef = '/tmp/command.sock';

function player(commandSock=commandSockDef) {
    let self = this;
    this.videos = [];
    this.emitter = new EventEmitter();

    /*
     * Add videos in the given list into this.videos if not duplicated.
     *
     * @param {An array of videos} Videos to be added
     */
    this.add = function(videos) {
        videos.forEach(function(video) {
            const found = self.videos.find(v => v.id == video.id);
            if (!found) {
                self.videos.push(video);
            }
        });
        console.log('Total videos', self.videos.length);
    }

    this.__start = function(id, title) {
				console.log("playing ", title);
        self.setStatus(status.playing);
    }

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
            self.__start(video.id, video.snippet.title);
        }
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
        self.setStatus(status.idle);
    }

    this.startstop = function() {
        if (self.checkStatus(status.idle)) {
            self.start();
        } else {
            self.stop();
        }
    }

    this.checkStatus = function(s) {
				return self.status == s;
		}

    this.setStatus = function(s) {
        console.log('change status:', s);
        self.status = s;
    }

    // Register event handlers
    this.emitter.on('start', self.startstop);
    this.emitter.on('stop', self.startstop);

    // Launch sockets
    this.handler = unix.handler(self.emitter, commandSock);

    // Now we are ready
    this.setStatus(status.idle);

    return this
}

module.exports.player = player;
