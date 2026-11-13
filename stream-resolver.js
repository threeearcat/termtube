'use strict';

const { execFile } = require('child_process');
const { EventEmitter } = require('events');

// Separate yt-dlp processes do not share --sleep-requests timers. Use one
// paced queue for playback, playlist enumeration, and likes downloads.
class YoutubeQueue extends EventEmitter {
    constructor(run = execFile, { interval = 10000, cooldown = 30000 } = {}) {
        super();
        this.run = run;
        this.interval = interval;
        this.cooldown = cooldown;
        this.pending = [];
        this.active = null;
        this.nextAt = 0;
        this.blockedUntil = 0;
        this.blockError = null;
        this.metadataBlockedUntil = 0;
        this.metadataBlockError = null;
        this.downloadBlockedUntil = 0;
        this.downloadBlockError = null;
        this.timer = null;
    }

    getError(metadata = false, download = false) {
        const until = metadata ? this.metadataBlockedUntil : download ? this.downloadBlockedUntil : this.blockedUntil;
        const error = metadata ? this.metadataBlockError : download ? this.downloadBlockError : this.blockError;
        return Date.now() < until ? error : null;
    }

    exec(owner, args, callback, priority) {
        const job = { owner, args, callback, priority, cancelled: false, metadata: args.includes('--flat-playlist') };
        job.download = !job.metadata && priority < 0;
        const blocked = this.getError(job.metadata, job.download);
        if (blocked) {
            queueMicrotask(() => { if (!job.cancelled) callback(blocked, '', ''); });
        } else {
            this.pending.push(job);
            this._drain();
        }
        return job;
    }

    cancel(owner, selected = null) {
        this.pending = this.pending.filter(job => {
            if (job.owner !== owner || (selected && job !== selected)) return true;
            job.cancelled = true;
            return false;
        });
        const job = this.active;
        if (job?.owner === owner && (!selected || job === selected) && !job.cancelled) {
            job.cancelled = true;
            job.killTimer = setTimeout(() => job.child.kill('SIGKILL'), 1000);
            job.killTimer.unref();
            job.child.kill('SIGTERM');
        }
        if (!this.pending.length) {
            clearTimeout(this.timer);
            this.timer = null;
        }
    }

    _drain() {
        if (this.active || !this.pending.length || this.timer) return;
        const wait = this.nextAt - Date.now();
        if (wait > 0) {
            this.timer = setTimeout(() => { this.timer = null; this._drain(); }, wait);
            return;
        }
        const priority = Math.max(...this.pending.map(job => job.priority));
        const index = this.pending.findIndex(job => job.priority === priority);
        const [job] = this.pending.splice(index, 1);
        this.active = job;
        const args = ['--sleep-requests', '1', '--retries', '0', '--extractor-retries', '0', '--socket-timeout', '15', ...job.args];
        job.child = this.run('yt-dlp', args, (err, stdout = '', stderr = '') => {
            clearTimeout(job.killTimer);
            this.active = null;
            this.nextAt = Date.now() + this.interval;
            // Share pacing, but isolate cooldowns for playback, background
            // downloads, and flat metadata so a likes failure cannot disable
            // otherwise working playlist browsing or playback.
            if (err && /(?:HTTP(?: Error| status)?[ :]*429|Too Many Requests|Sign in to confirm.*bot|rate.limit(?:ed|ing)|captcha challenge)/i.test(stderr + '\n' + err.message)) {
                err = Object.assign(new Error('YouTube ' + (job.metadata ? 'playlist ' : job.download ? 'download ' : '') + 'requests paused for ' + Math.ceil(this.cooldown / 1000) + ' seconds after a rate limit or bot check.'), { code: 'YOUTUBE_BLOCKED' });
                if (job.metadata) {
                    this.metadataBlockError = err;
                    this.metadataBlockedUntil = Date.now() + this.cooldown;
                } else if (job.download) {
                    this.downloadBlockError = err;
                    this.downloadBlockedUntil = Date.now() + this.cooldown;
                } else {
                    this.blockError = err;
                    this.blockedUntil = Date.now() + this.cooldown;
                }
                const sameCategory = queued => queued.metadata === job.metadata && queued.download === job.download;
                const pending = this.pending.filter(sameCategory);
                this.pending = this.pending.filter(queued => !sameCategory(queued));
                clearTimeout(this.timer);
                this.timer = null;
                this.emit(job.metadata ? 'metadata-blocked' : job.download ? 'download-blocked' : 'blocked', err);
                for (const queued of pending) {
                    if (!queued.cancelled) queued.callback(err, '', '');
                }
            }
            try {
                if (!job.cancelled) job.callback(err, stdout, stderr);
            } finally {
                this._drain();
            }
        });
    }
}

const youtubeQueue = new YoutubeQueue();

class StreamResolver {
    constructor(queue = youtubeQueue) {
        this.queue = queue;
    }

    exec(args, callback, priority = 0) {
        return this.queue.exec(this, args, callback, priority);
    }

    prioritize(job) {
        for (const pending of this.queue.pending) {
            if (pending.owner === this) pending.priority = pending === job ? 2 : 0;
        }
        this.queue._drain();
    }

    cancel(job = null) {
        this.queue.cancel(this, job);
        if (job) job.cancelled = true;
    }
}

module.exports = { StreamResolver, YoutubeQueue };
