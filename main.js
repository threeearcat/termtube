'use strict'

const {player} = require(__dirname + '/player');
const {downloader} = require(__dirname + '/downloader');
const backend = require(__dirname + '/backend');

let p = new player();
let d = new downloader();

backend.start(p, d);
