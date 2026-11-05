# TermTube

Toy YouTube player based on terminal interface

The Electron app keeps a single instance. Launching it again focuses its existing
window without restarting playback. Session startup can pass `--background` to
preserve the window's visibility. Duplicate launches, including `--kill`, keep the existing
instance and do not change its PID file or command socket.

On Linux with a systemd user manager, the first launch starts `termtube.service`.
The service keeps the controller alive independently of its launcher and restarts
it after an unexpected exit. Read its logs with
`journalctl --user -u termtube.service` and stop it with
`systemctl --user stop termtube.service`.
Streaming selections and playback intent are saved atomically under
`${XDG_STATE_HOME:-~/.local/state}/termtube/session.json`. A restarted controller
resolves fresh audio URLs, resumes the selected track, and prepares its successor.
Stopped playback stays stopped, and YouTube cooldowns survive restarts.

Playlist selection loads metadata without resolving every track's audio URL.
Playback prepares only the current song and one successor. MPD transitions to
the prepared successor directly and consumes finished queue entries. Random
playback still chooses from the full playlist. Selecting another song keeps the
current audio playing until the selected song is ready; cached URLs are reused
until they need refreshing. Lofi uses the same on-demand loading.

Playback lookups and likes downloads share one yt-dlp process slot, with ten
seconds between processes and one second between extraction requests. Playback
takes priority over background downloads. Likes downloads run one at a time and
deduplicate pending videos. A YouTube rate limit or bot check pauses all lookups
for one hour, preserves current playback, and retries pending playback after the
pause. Stop and mode changes cancel pending playback and automatic recovery.
Unavailable successors are skipped with at most three attempts per transition.

Select **url** from the mode menu, paste a YouTube live stream or playlist URL,
and press **Play** (or Enter). Playback starts as soon as the first track is
ready. URLs are kept in playback recovery state without changing saved playlists.
The mode supports track selection, random playback, and refreshing expired URLs.

Terminal clients can use the same mode through the command socket:

```sh
printf '%s' 'play-url:https://www.youtube.com/live/VIDEO_ID' | socat - UNIX-CONNECT:/tmp/command.sock
printf '%s' 'play-url:https://www.youtube.com/playlist?list=PLAYLIST_ID' | socat - UNIX-CONNECT:/tmp/command.sock
```
