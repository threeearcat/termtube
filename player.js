const fs = require('fs');
const EventEmitter = require('events').EventEmitter;
const unix = require(__dirname + '/unix');
const mpd = require('mpd');

const commandSockDef = '/tmp/command.sock';
const titleSockDef = '/tmp/title.sock';

function player(commandSock=commandSockDef, titleSock=titleSockDef) {
    let self = this;
    this.videos = []

    // Player's attributes
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
        if (!self.mpd_ready)
            return;
        return self.client.sendCommand(self.cmd(cmd, args), callback);
    }

    this.add = function(id, title) {
        if (self.videos.findIndex(elem => elem == id) != -1) {
            return;
        }
        filename = id + '.webm';
        self.videos.push(filename);
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
            self.mpd_command('add', [video]);
        });
    }

    this.next = function() {
        self.client.sendCommand('next');
    }

    // Register event handlers
    this.emitter.on('start', self.startstop);
    this.emitter.on('stop', self.startstop);
    this.emitter.on('reload', self.reload);
    this.emitter.on('next', self.next);

    // Launch sockets
    this.handler = unix.handler(self.emitter, commandSock);

    // Now we are ready
    return this
}

module.exports.player = player;
