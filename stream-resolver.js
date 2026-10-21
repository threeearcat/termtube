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
        const job = { args, callback, priority: false };
        this._pending.push(job);
        this._drain();
        return job;
    }

    prioritize(job) {
        // Only the latest selection needs the foreground slot. Earlier queued
        // selections go back to background loading without duplicate requests.
        for (const pending of this._pending) pending.priority = false;
        if (this._pending.includes(job)) job.priority = true;
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
        while (this._pending.length > 0) {
            const active = [...this._active];
            let index = active.some(job => job.priority)
                ? -1 : this._pending.findIndex(job => job.priority);
            if (index === -1) {
                if (active.filter(job => !job.priority).length >= this._concurrency) return;
                index = this._pending.findIndex(job => !job.priority);
                if (index === -1) return;
            }
            const [job] = this._pending.splice(index, 1);
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
