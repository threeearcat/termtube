const fs = require('fs');
const EventEmitter = require('events').EventEmitter;
const unix = require(__dirname + '/unix');
const mpd = require('mpd');

const commandSockDef = '/tmp/command.sock';
const titleSockDef = '/tmp/title.sock';

function player(commandSock=commandSockDef, titleSock=titleSockDef) {
    let self = this;

		// Player's attributes
    this.videos = [];
    this.emitter = new EventEmitter();

		// MPD's attributes
		this.mpd_ready = false;
		this.mpd_state = 'stop';
		this.cmd = mpd.cmd;
		this.client = mpd.connect({
				port: 6600,
				host: 'localhost',
		});

		this.mpd_update_state = function() {
				self.client.sendCommand(self.cmd("status", []), function(err, msg) {
						if (err) throw err;
						const re = /^state: ([a-z]*)$/im;
						found = msg.match(re);
						if (found == null || found.length < 2) {
								self.mpd_set_state('stop');
						} else {
								self.mpd_set_state(found[1]);
						}
				});
		}

		this.client.on('ready', function() {
				console.log("mpd ready");
				self.mpd_ready = true;
				self.mpd_update_state();
		});

		this.client.on('system-player', function(name) {
				self.client.sendCommand(self.cmd("status", []), function(err, msg) {
						if (err) throw err;
						self.mpd_update_state();
				});
		});

		// MPD wrapper
		this.mpd_command = function(cmd, args=[], callback=function () {}) {
				return self.client.sendCommand(self.cmd(cmd, args), callback);
		}

		this.mpd_add = function(id, title) {
				const exec = require('child_process').exec;
				const url = "https://youtu.be/" + id;
				const cmd = 'youtube-dl -g ' + url;
				exec(cmd, function (err, stdout, stderr) {
						if (err) throw err;
						const lines = stdout.split(/\r?\n/).filter(function(line) {
								return line.length != 0;
						});
						if (lines.length == 0) {
								return false
						}
						const music_url = lines[lines.length - 1];
						self.mpd_command('add', [music_url], function(err, msg) {
								if (err) throw err;
								self.mpd_start();
						});
				});
		}

		this.mpd_start = function() {
				if (!self.mpd_ready) {
						return;
				}
				self.mpd_command('play');
		}

		this.mpd_stop = function() {
				if (!self.mpd_ready) {
						return;
				}
				self.mpd_command('stop');
		}

    this.mpd_check_state = function(s) {
				return self.mpd_state == s;
		}

		this.mpd_set_state = function(state) {
				console.log('change the state to ', state);
				self.mpd_state = state;
		}

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
				self.mpd_add(id, title);
    }

    this.start = function() {
        console.log('start');
        if (!self.mpd_ready || self.mpd_check_state('play')) {
            return;
        }
        if (self.videos.length == 0) {
            setTimeout(self.start, 1000);
        } else if (self.mpd_check_state('pause')) {
						self.mpd_start();
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
        if (!self.mpd_check_state('play') &&
            !self.mpd_check_state('pause')) {
            return;
        }
				self.mpd_stop();
    }

    this.startstop = function() {
        if (self.mpd_check_state('stop') || self.mpd_check_state('pause')) {
            self.start();
        } else {
            self.stop();
        }
    }

    // Register event handlers
    this.emitter.on('start', self.startstop);
    this.emitter.on('stop', self.startstop);

    // Launch sockets
    this.handler = unix.handler(self.emitter, commandSock);

    // Now we are ready
    return this
}

module.exports.player = player;
