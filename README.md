# TermTube

Toy YouTube player based on terminal interface

The Electron app keeps a single instance. Launching it again focuses its existing
window without restarting playback. Session startup can pass `--background` to
preserve the window's visibility. Duplicate launches, including `--kill`, keep the existing
instance and do not change its PID file or command socket.

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
ready. URLs are kept for the current session without changing saved playlists.
The mode supports track selection, random playback, and refreshing expired URLs.

Terminal clients can use the same mode through the command socket:

```sh
printf '%s' 'play-url:https://www.youtube.com/live/VIDEO_ID' | socat - UNIX-CONNECT:/tmp/command.sock
printf '%s' 'play-url:https://www.youtube.com/playlist?list=PLAYLIST_ID' | socat - UNIX-CONNECT:/tmp/command.sock
```
