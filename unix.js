'use strict';

const net = require('net');
const fs = require('fs');

function handler(emitter, sockpath) {
    const server = net.createServer(stream => {
        console.log('connected');
        stream.on('data', c => {
            c.toString().split('\\,').forEach(raw => {
                const [cmd, ...toks] = raw.trim().split(':');
                const args = toks.join(':');
                console.log('cmd:', cmd, 'args:', args);
                emitter.emit(cmd, args);
            });
        });
    }).on('error', e => {
        console.log(e);
        trycleanup(e, server, sockpath);
    });
    listen(server, sockpath);
    return server;
}

function trycleanup(e, server, sockpath) {
    if (e.code !== 'EADDRINUSE') {
        quit();
    }

    console.log('address is in use');

    const clientSocket = new net.Socket();
    clientSocket.on('error', e => {
        if (e.code !== 'ECONNREFUSED') {
            quit();
        }
        console.log('cleaning up');
        fs.unlinkSync(sockpath);
        listen(server, sockpath);
    });

    clientSocket.connect({ path: sockpath }, () => {
        quit();
    });
}

function quit() {
    console.log('Cannot open the command handler. exit.');
    process.exit();
}

function listen(server, sockpath) {
    console.log('listen to ' + sockpath);
    server.listen(sockpath);
}

function client(sockpath) {
    const c = net.connect(sockpath, () => {
        console.log('connected to server', sockpath);
    }).on('error', err => {
        console.log('failed to connect to server', sockpath);
    });
    return c;
}

module.exports = { handler, client };
