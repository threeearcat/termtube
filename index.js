const fs = require('fs');
const auth = require(__dirname + "/auth.js")
const {google} = require('googleapis');
const player = require('./player');

/*
 * @param {google.auth.OAuth2} auth An authorized OAuth2 client.
 * @param {function} callback A callback function.
 */
function getLikes(auth, callback) {
    var youtube = google.youtube('v3');
    var token = "";

    youtube.videos.list({
        auth: auth,
        "part": "id",
        "myRating": "like",
        pageToken: token,
    }).then(function(res) {
        if (res.data.nextPageToken.length != 0) {
            token = res.data.nextPageToken;
        }
        let ids = res.data.items.map(a => a.id);
        console.log("Received IDs", ids);
        callback(ids);
    }).catch(function(err) { console.error("Execute error", err); });
}

function main() {
    var p = new player.player();
    auth.authorize(function(auth) { getLikes(auth, p.add); });
    p.start();
}

if (require.main === module) {
    main();
}
