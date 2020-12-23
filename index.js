const fs = require('fs');
const ytdl = require('ytdl-core');
const url = 'http://youtube.com/watch?v=34aQNMvGEZQ'
var ffmpeg = require('fluent-ffmpeg');
const decoder = require('lame').Decoder;

var auth = require(__dirname + "/auth.js")
var {google} = require('googleapis');

function getLikes(auth) {
    var youtube = google.youtube('v3');
    var token = "";

    youtube.videos.list({
        auth: auth,
        "part": "snippet,contentDetails,statistics",
        "myRating": "like",
        pageToken: token,
    }).then(function(res) {
        play(res.data.items[0].id);
    },
            function(err) { console.error("Execute error", err); });
}

/**
 *    id - Youtube video ID to play
 */
function play(id) {
    id = "s29fcv5E52Y";
    const url = "https://www.youtube.com/watch?v=" + id;
    console.log(url);

    opt = {
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

    // let writeStream = fs.createWriteStream('secret.flv');
    convert(video, speaker);
}

/**
 *    input - input stream
 *    output - output stream
 */
function convert(input, output) {
    ffmpeg(input)
        .on('error', function(e) {
            console.log(e);
        })
        .format('mp3')
        .pipe(decoder())
        .pipe(output);
}

function main() {
    auth.authorize(getLikes);
}

if (require.main === module) {
    main();
}
