var net = require('net');
const fs = require('fs');

function handler(obj, sockpath) {
    var server = net.createServer(function (s) {
		_handler(server, s, obj);
	}).on('error', function(e) {
		console.log(e);
		trycleanup(e, server, sockpath);
	});
	_listen(server, sockpath);
	return server;
}

function _handler(server, stream, obj) {
    // console.log('_handler', stream);
    console.log('connected');
    stream.on('data', function(c) {
        const cmds = c.toString()
        // Handle (backslash + comma)-separated commands
        cmds.split('\\,').forEach(c => {
            _handleCommand(c, obj);
        });
    });
}

function _handleCommand(rawCmd, obj) {
    // FIXME: very inefficient
    const [cmd, ...toks] = rawCmd.trim().split(':');
    const args = toks.join(':')
    console.log('cmd:', cmd, 'args:', args);
    obj.emit(cmd, args);
}

function trycleanup(e, server, sockpath) {
    // Strategy: try to connect the unix socket as a client, and if
    // the connection is succeeded, we give up.
    if (e.code != 'EADDRINUSE') {
        _quit();
    }

    console.log('address is in use');

    var clientSocket = new net.Socket();
    clientSocket.on('error', function(e) {
        if (e.code != 'ECONNREFUSED') {
            _quit();
        }
        // We can't connect the server. Clean up.
        console.log('cleaning up');
        fs.unlinkSync(sockpath);
        _listen(server, sockpath);
    });

    clientSocket.connect({path: sockpath}, function() {
        _quit();
    });
}

function _quit() {
    console.log('Cannot open the command handler. exit.');
    process.exit();
}

function _listen(server, sockpath) {
    console.log('listen to ' + sockpath);
    server.listen(sockpath);
}

function client(sockpath) {
    var client = net.connect(sockpath, function() {
        console.log('connected to server', sockpath);
    }).on('error', function(err) {
        console.log('failed to connect to server', sockpath);
    });
    return client;
}

module.exports = {
    handler: handler,
    client: client,
};
