'use strict';

const { Player } = require(__dirname + '/player');
const { Downloader } = require(__dirname + '/downloader');
const backend = require(__dirname + '/backend');
const pid = require(__dirname + '/pid');

pid.killExisting();
pid.writePid();

const p = new Player();
const d = new Downloader();

backend.start(p, d);
