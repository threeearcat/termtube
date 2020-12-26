var net = require('net');
const fs = require('fs');

function handler(obj) {
    let sockpath = process.argv.length > 2 ? process.argv[2] : '/tmp/command.sock';
    var server = net.createServer(function (s) { _handler(server, s, obj); });

    server.on('error', function(e) { trycleanup(e, server, sockpath); });

    listen(server, sockpath);
}
module.exports.handler = handler;

function _handler(server, stream, obj) {
    // console.log('_handler', stream);
    console.log('connected');
    stream.on('data', function(c) {
        cmd = c.toString();
        cmd.split(/\s+/).forEach(c => {
            console.log('cmd:', c);
            obj.emit(c);
        });
    });
}

function trycleanup(e, server, sockpath) {
    // Strategy: try to connect the unix socket as a client, and if
    // the connection is succeeded, we give up.
    if (e.code != 'EADDRINUSE') {
        _quit();
    }

    console.log('address is is use');

    var clientSocket = new net.Socket();
    clientSocket.on('error', function(e) {
        if (e.code != 'ECONNREFUSED') {
            _quit();
        }
        // We can't connect the server. Clean up.
        console.log('cleaning up');
        fs.unlinkSync(sockpath);
        listen(server, sockpath);
    });

    clientSocket.connect({path: sockpath}, function() {
        _quit();
    });
}

function _quit() {
    console.log('Cannot open the command handler. exit');
    process.exit();
}

function listen(server, sockpath) {
    console.log('listen to ' + sockpath);
    server.listen(sockpath);
}
