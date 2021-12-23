'use strict'

const auth = require(__dirname + "/auth.js");
const {google} = require('googleapis');

function retrieve_video(auth, callback, token) {
    console.log("Retrieving videos", token);
    const youtube = google.youtube('v3');
    youtube.videos.list({
        auth: auth,
        "part": "id,snippet",
        "myRating": "like",
        "maxResults": 50,
        pageToken: token,
    }).then(function(res) {
        let ids = res.data.items.map(a => a.id);
        console.log("Received IDs", ids);
        if (callback != undefined) {
            callback(res.data.items);
        }
        token = res.data.nextPageToken;
        var timeout = 1;
        if (typeof token === 'undefined') {
            console.log("collected all videos");
            token = '';
            timeout = 600;
        }
        setTimeout(retrieve_video, timeout * 1000, auth, callback, token);
    }).catch(function(err) { console.error("Execute error", err); });
}

function auth_callback(auth) {
    console.log("auth done");
    retrieve_video(auth, undefined, '');
}

const scopes = ['https://www.googleapis.com/auth/youtube.readonly'];
const token_dir = (process.env.HOME || process.env.HOMEPATH ||
                   process.env.USERPROFILE) + '/.credentials/';
const token_path = {
    dir: token_dir,
    path: token_dir + 'termtube.json'
};

auth.authorize(auth_callback, scopes, token_path);
