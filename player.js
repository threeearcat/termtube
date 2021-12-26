const fs = require('fs');
const EventEmitter = require('events').EventEmitter;
const unix = require(__dirname + '/unix');
const mpd = require('mpd');

const commandSockDef = '/tmp/command.sock';
const titleSockDef = '/tmp/title.sock';

function player(commandSock=commandSockDef, titleSock=titleSockDef) {
    let self = this;
    this.videos = [];

    // Player's attributes
    this.emitter = new EventEmitter();

    // MPD's attributes
    this.mpd_ready = false;
    this.mpd_state = 'stop';
    this.cmd = mpd.cmd;
    this.mpd = mpd.connect({
        port: 6600,
        host: 'localhost',
    });

    this.print_title = function() {
        self.mpd_command('currentsong', [], function(err, msg) {
            if (err) throw err;
            const re = /^file: ([a-z0-9\.\-\_]*)$/im;
            let found = msg.match(re);
            if (found == null || found.length < 2) {
                return;
            }
            let filename = found[1];
            found = self.videos.find(elem => elem.filename == filename);
            let towrite = filename;
            if (found != undefined) {
                towrite = found.title;
            }
            console.log(towrite);
            if (self.client) {
                self.client.write(towrite);
            }
        });
    }

    this.mpd_update_state = function() {
        self.mpd_command("status", [], function(err, msg) {
            if (err) throw err;
            const re = /^state: ([a-z]*)$/im;
            found = msg.match(re);
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
        filename = id + '.webm';
        if (self.videos.findIndex(elem => elem.filename == filename) != -1) {
            return;
        }
        self.videos.push({'title': title, 'filename': filename});
        self.mpd_command('update')
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
    }

    this.startstop = function() {
        if (self.mpd_check_state('stop') || self.mpd_check_state('pause')) {
            self.start();
        } else {
            self.stop();
        }
    }

    this.reload = function() {
        self.mpd_command('clear');
        self.mpd_command('update');
        self.videos.forEach(function (video) {
            self.mpd_command('add', [video.filename]);
        });
    }

    this.next = function() {
        self.mpd.sendCommand('next');
    }

    // Register event handlers
    this.emitter.on('start', self.startstop);
    this.emitter.on('stop', self.startstop);
    this.emitter.on('reload', self.reload);
    this.emitter.on('next', self.next);

    // Launch sockets
    this.handler = unix.handler(self.emitter, commandSock);
    this.client = unix.client(titleSock);

    // Now we are ready
    return this
}

module.exports.player = player;
