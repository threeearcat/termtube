const fs = require('fs');
const ytdl = require('ytdl-core');
const url = 'http://youtube.com/watch?v=34aQNMvGEZQ'

var auth = require(__dirname + "/auth.js")
var {google} = require('googleapis');

function getLikes(auth) {
    var youtube = google.youtube('v3');
    youtube.videos.list({
        auth: auth,
        "part": "snippet,contentDetails,statistics",
        "myRating": "like"
    }).then(function(res) { },
            function(err) { console.error("Execute error", err); });
}

function main() {
    auth.authorize(getLikes);
}

if (require.main === module) {
    main();
}
