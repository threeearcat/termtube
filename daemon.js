const {player} = require(__dirname + '/player');
const auth = require(__dirname + "/auth.js")
const {google} = require('googleapis');

var token = '';
/*
 * @param {google.auth.OAuth2} auth An authorized OAuth2 client.
 * @param {function} callback A callback function.
 */
function getLikes(auth, callback) {
    var youtube = google.youtube('v3');

    youtube.videos.list({
        auth: auth,
        "part": "id,snippet",
        "myRating": "like",
        "maxResults": 50,
        pageToken: token,
    }).then(function(res) {
        let ids = res.data.items.map(a => a.id);
        console.log("Received IDs", ids);
        callback(res.data.items);
        token = res.data.nextPageToken;
        var timeout = 1;
        if (typeof token === 'undefined') {
            // Collected all videos
            token = '';
            timeout = 600;
        }
        setTimeout(getLikes, timeout * 1000, auth, callback);
    }).catch(function(err) { console.error("Execute error", err); });
}

(function() {
    var p = new player();
    process.on('message', function(unused) {
        p.ping();
    });
    auth.authorize(function(auth) { getLikes(auth, p.add); })
})();
