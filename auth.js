'use strict';

const fs = require('fs');
const readline = require('readline');
const { google } = require('googleapis');
const OAuth2 = google.auth.OAuth2;

exports.authorize = (callback, scopes, tokenPath) => {
    fs.readFile(__dirname + '/client_secret.json', (err, content) => {
        if (err) {
            console.log('Error loading client secret file: ' + err);
            return;
        }
        authorize(JSON.parse(content), callback, scopes, tokenPath);
    });
};

function authorize(credentials, callback, scopes, tokenPath) {
    const clientSecret = credentials.installed.client_secret;
    const clientId = credentials.installed.client_id;
    const redirectUrl = credentials.installed.redirect_uris[0];
    const oauth2Client = new OAuth2(clientId, clientSecret, redirectUrl);

    fs.readFile(tokenPath.path, (err, token) => {
        if (err) {
            getNewToken(oauth2Client, callback, scopes, tokenPath);
        } else {
            oauth2Client.credentials = JSON.parse(token);
            callback(oauth2Client);
        }
    });
}

function getNewToken(oauth2Client, callback, scopes, tokenPath) {
    const authUrl = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: scopes
    });
    console.log('Authorize this app by visiting this url: ', authUrl);
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });
    rl.question('Enter the code from that page here: ', code => {
        rl.close();
        oauth2Client.getToken(code, (err, token) => {
            if (err) {
                console.log('Error while trying to retrieve access token', err);
                return;
            }
            oauth2Client.credentials = token;
            storeToken(tokenPath, token);
            callback(oauth2Client);
        });
    });
}

function storeToken(tokenPath, token) {
    try {
        fs.mkdirSync(tokenPath.dir);
    } catch (err) {
        if (err.code !== 'EEXIST') {
            throw err;
        }
    }
    fs.writeFile(tokenPath.path, JSON.stringify(token), err => {
        if (err) throw err;
        console.log('Token stored to ' + tokenPath.path);
    });
}
