const fs = require('fs');
const {google} = require('googleapis');
const {player} = require(__dirname + '/player');
const auth = require(__dirname + "/auth.js")

const args = require('yargs')
      .scriptName("termtube")
      .usage('$0 [--help] [-v|--verbose]', 'Toy youtube player')
      .option('verbose', {
          alias: 'v',
          type: 'boolean',
          description: 'Run with verbose logging'
      })
      .version(false)
      .help()
      .argv;

if (!args.v) { console.log = function() {} }

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

function main() {
    var p = new player();
    auth.authorize(function(auth) { getLikes(auth, p.add); });
}

if (require.main === module) {
    main();
}
