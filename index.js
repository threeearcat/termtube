const fs = require('fs');
// Seems like pm2 is an overkill
const pm2 = require('pm2');
const EventEmitter = require('events').EventEmitter;

const unix = require(__dirname + '/unix');

const daemonName = 'termtube-daemon';
const sock = '/tmp/termtube_output.sock'

const args = require('yargs')
      .scriptName('termtube')
      .usage('$0 [--help] [-v|--verbose]', 'Toy youtube player')
      .option('daemon', {
          alias: 'd',
          default: true,
          type: 'boolean',
          description: 'Run termtube as a daemon'
      })
      .option('verbose', {
          alias: 'v',
          type: 'boolean',
          description: 'Run with verbose logging'
      })
      .version(false)
      .help()
      .argv;

if (!args.v) { console.log = function() {} }

function start_daemon(callback) {
    console.log('connect to the pm2 daemon');
    pm2.connect(function(err) {
        _errCheck(err);

        const daemon = __dirname + '/' + 'daemon.js'
        const opt = { name: daemonName, script: daemon };

        console.log('start the ' + daemonName + ' daemon');
        console.log('path: ' + daemon);
        pm2.start(opt, (err, proc) => {
            _errCheck(err);
            if (proc.length != 1) {
                _quit(new Error('wrong'));
            }
            callback(proc[0].pm2_env.pm_id);
        })
    });
}

function pingIfAlive(proc) {
    if (proc.pm2_env.status !== 'online') {
        console.log('restart the termtube daemon');
        pm2.restart(proc, function(err) { _errCheck(err); });
    }
    ping(proc.pm_id);
}

function ping(id) {
    // Pint the termtube daemon
    console.log('ping to', id);
    pm2.sendDataToProcessId({
        type : 'process:msg',
        data : {},
        id   : id,
        topic: 'ping'
    }, function(err, res) {
        _errCheck(err);
    });
}

function openPrinter(sock) {
    // open the unix domain socket
    const printer = new EventEmitter();
    printer.on('title', function(title) {
        process.stdout.write(title);
    });
    unix.handler(printer, sock);
}

function killIfExist(fn) {
    const pid = fs.readFileSync(fn, 'utf8');
    try {
        process.kill(pid);
    } catch (e) { /* Ignore */ }
}

function logPID() {
    const fn = process.env.HOME + '/.termtube.pid';
    killIfExist(fn);
    fs.writeFile(fn, process.pid.toString(), function (err) {
        if (err) { console.error(err); }
    });
}

function main() {
    logPID();
    if (args.d) {
        // Run as a daemon
        openPrinter(sock);
        pm2.list(function (err, procs) {
            const proc = procs.find(proc => proc.name == daemonName);
            if (proc) {
                console.log('found the daemon', proc.name, proc.pm_id);
                pingIfAlive(proc);
            } else {
                start_daemon(ping);
            }
        });
    } else {
        require(__dirname + '/daemon.js');
    }
}

if (require.main === module) {
    const electron = require('electron')
    const proc = require('child_process')

    // will print something similar to /Users/maf/.../Electron
    console.log(electron)

    // spawn Electron
    const child = proc.spawn(electron, ["/home/daeryong/playground/termtube/ui.js"]);

    child.stdout.on('data', (data) => {
        console.log(`${data}`);
    });

    child.stdin.write("hihi");

    // main();
}

function _errCheck(err) { if (err) { _quit(err); }}
function _quit(err) {
    console.error(err);
    process.exit(2);
}
