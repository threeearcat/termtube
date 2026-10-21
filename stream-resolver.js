'use strict';

const { execFile } = require('child_process');

class StreamResolver {
    constructor(concurrency = 4, run = execFile) {
        this._concurrency = concurrency;
        this._execFile = run;
        this._pending = [];
        this._active = new Set();
    }

    exec(args, callback) {
        this._pending.push({ args, callback });
        this._drain();
    }

    cancel() {
        this._pending = [];
        for (const job of this._active) {
            if (job.cancelled) continue;
            job.cancelled = true;
            job.killTimer = setTimeout(() => job.child.kill('SIGKILL'), 1000);
            job.killTimer.unref();
            job.child.kill('SIGTERM');
        }
    }

    _drain() {
        while (this._active.size < this._concurrency && this._pending.length > 0) {
            const job = this._pending.shift();
            this._active.add(job);
            job.child = this._execFile('yt-dlp', job.args, (err, stdout, stderr) => {
                clearTimeout(job.killTimer);
                this._active.delete(job);
                try {
                    if (!job.cancelled) job.callback(err, stdout, stderr);
                } finally {
                    this._drain();
                }
            });
        }
    }
}

module.exports = { StreamResolver };
