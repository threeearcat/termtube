'use strict';

const fs = require('fs');
const auth = require(__dirname + '/auth.js');
const { google } = require('googleapis');
const notifier = require('node-notifier');
const { validate } = require(__dirname + '/downloader');

const HAVE_PATH = process.env.HOME + '/.music/downloaded.json';
const MUSIC_DIR = process.env.HOME + '/.music/';
const APP_NAME = 'Termtube';

function cleanupBrokenFiles(have) {
    const clean = [];
    const checks = have.map(entry => {
        const filepath = MUSIC_DIR + entry.id + '.webm';
        return validate(filepath).then(() => {
            clean.push(entry);
        }).catch(err => {
            console.log('removing broken file:', entry.title, '(' + err + ')');
            try { fs.unlinkSync(filepath); } catch (_) {}
        });
    });
    return Promise.all(checks).then(() => {
        if (clean.length !== have.length) {
            console.log('cleaned up', have.length - clean.length, 'broken files');
            fs.writeFileSync(HAVE_PATH, JSON.stringify(clean));
        }
        return clean;
    });
}

function start(p, d) {
    let have = [];
    if (fs.existsSync(HAVE_PATH)) {
        have = JSON.parse(fs.readFileSync(HAVE_PATH, 'utf-8'));
    }

    cleanupBrokenFiles(have).then(clean => {
        have = clean;
        run(p, d, have);
    });
}

function run(p, d, have) {
    function exitCallback(options, exitCode) {
        if (exitCode || exitCode === 0) console.log(`ExitCode ${exitCode}`);
        if (options.exit) {
            notifier.notify({ title: APP_NAME, message: 'Exiting...' });
            process.exit();
        }
    }

    ['SIGINT', 'SIGUSR1', 'SIGUSR2', 'uncaughtException', 'SIGTERM'].forEach(sig => {
        process.on(sig, exitCallback.bind(null, { exit: true }));
    });

    const likedIds = new Set();

    function pruneUnliked() {
        const removed = [];
        for (let i = have.length - 1; i >= 0; i--) {
            if (!likedIds.has(have[i].id)) {
                const entry = have[i];
                console.log('Removing unliked track:', entry.title);
                try { fs.unlinkSync(MUSIC_DIR + entry.id + '.webm'); } catch (_) {}
                p.remove(entry.id + '.webm');
                have.splice(i, 1);
                removed.push(entry.title);
            }
        }
        if (removed.length > 0) {
            console.log('Pruned', removed.length, 'unliked tracks');
            fs.writeFileSync(HAVE_PATH, JSON.stringify(have));
        }
    }

    function retrieveVideos(authClient, callback, token) {
        if (token === '') {
            likedIds.clear();
        }
        console.log('Retrieving videos', token);
        const youtube = google.youtube('v3');
        youtube.videos.list({
            auth: authClient,
            part: 'id,snippet',
            myRating: 'like',
            maxResults: 50,
            pageToken: token,
        }).then(res => {
            const ids = res.data.items.map(a => a.id);
            console.log('Received IDs', ids);
            ids.forEach(id => likedIds.add(id));
            if (callback) {
                res.data.items.forEach(video => callback(video));
            }
            let nextToken = res.data.nextPageToken;
            let timeout = 1;
            if (nextToken === undefined) {
                console.log('collected all videos');
                pruneUnliked();
                nextToken = '';
                timeout = 600;
            }
            setTimeout(retrieveVideos, timeout * 1000, authClient, callback, nextToken);
        }).catch(err => {
            console.error('Execute error', err);
            if (err.response && err.response.data && err.response.data.error === 'invalid_grant') {
                notifier.notify({
                    title: APP_NAME,
                    message: 'OAuth token is expired. Need to re-authenticate.'
                });
            }
        });
    }

    function toJson(id, title) {
        return { id, title };
    }

    function authCallback(authClient) {
        console.log('auth done');
        const downloadCallback = (id, title, success) => {
            if (success) {
                have.push(toJson(id, title));
                fs.writeFileSync(HAVE_PATH, JSON.stringify(have));
                p.add(id, title);
            }
        };
        const videoCallback = video => {
            const id = video.id;
            const title = video.snippet.title;
            const found = have.findIndex(elem => elem.id === id && elem.title === title);
            if (found !== -1) {
                console.log('Already downloaded', title);
                p.add(id, title);
            } else {
                d.download(video, downloadCallback);
            }
        };
        retrieveVideos(authClient, videoCallback, '');
    }

    const scopes = ['https://www.googleapis.com/auth/youtube.readonly'];
    const tokenDir = (process.env.HOME || process.env.HOMEPATH || process.env.USERPROFILE) + '/.credentials/';
    const tokenPath = {
        dir: tokenDir,
        path: tokenDir + 'termtube.json'
    };

    auth.authorize(authCallback, scopes, tokenPath);
}

module.exports = { start };
