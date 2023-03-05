'use strict'

const fs = require('fs');
const auth = require(__dirname + "/auth.js");
const {google} = require('googleapis');
const {player} = require(__dirname + '/player');
const {downloader} = require(__dirname + '/downloader');
const notifier = require('node-notifier');

let p = new player();
let d = new downloader();

const have_path = process.env.HOME + '/.mpd/music/have.json';
const app_name = "Termtube"

let have = [];
if (fs.existsSync(have_path)) {
    const buf = fs.readFileSync(have_path);
    const json = buf.toString()
    have = JSON.parse(json);
}

function exit_callback(options, exitCode) {
    if (exitCode || exitCode === 0) console.log(`ExitCode ${exitCode}`);
    if (options.exit) {
        notifier.notify({
            title: app_name,
            message: "Exiting...",
        });
        process.exit();
    }
}

const others = [`SIGINT`, `SIGUSR1`, `SIGUSR2`, `uncaughtException`, `SIGTERM`]
others.forEach((eventType) => {
    process.on(eventType, exit_callback.bind(null, { exit: true }));
})

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
            const videos = res.data.items;
            videos.forEach(function(video) {
                callback(video);
            });
        }
        token = res.data.nextPageToken;
        var timeout = 1;
        if (typeof token === 'undefined') {
            console.log("collected all videos");
            token = '';
            timeout = 600;
        }
        setTimeout(retrieve_video, timeout * 1000, auth, callback, token);
    }).catch(function(err) {
		console.error("Execute error", err);
		if (err.response.data.error == "invalid_grant") {
			notifier.notify({
				title: app_name,
				message: "OAuth token is expired. Need to re-authenticate."
			});
		}
	});
}

function auth_callback(auth) {
    console.log("auth done");
    let to_json = function(id, title) { return {'id': id, 'title': title}; }
    let download_callback = function(id, title, success) {
        if (success) {
            have.push(to_json(id, title));
            fs.writeFileSync(have_path, JSON.stringify(have));
            p.add(id, title);
        }
    }
    let callback = function(video) {
        let id = video.id
        let title = video.snippet.title
        const found = have.findIndex(elem => JSON.stringify(elem) === JSON.stringify(to_json(id, title)));
        if (found != -1) {
            // We already downloaded it before
            console.log('Already downloaded', title);
            p.add(id, title);
            return;
        } else {
            d.download(video, download_callback);
        }
    }
    retrieve_video(auth, callback, '');
}

const scopes = ['https://www.googleapis.com/auth/youtube.readonly'];
const token_dir = (process.env.HOME || process.env.HOMEPATH ||
                   process.env.USERPROFILE) + '/.credentials/';
const token_path = {
    dir: token_dir,
    path: token_dir + 'termtube.json'
};

auth.authorize(auth_callback, scopes, token_path);
