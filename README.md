# TermTube

Toy YouTube player based on terminal interface

The Electron app keeps a single instance. Launching it again focuses its existing
window without restarting playback. Session startup can pass `--background` to
preserve the window's visibility. Duplicate launches, including `--kill`, keep the existing
instance and do not change its PID file or command socket.

Stream and lofi URL resolution runs up to four yt-dlp processes in the background.
Selecting a pending playlist track uses one additional foreground slot, without
waiting for the rest of the playlist. Tracks already being resolved or ready to
play reuse their existing request or URL.
Playback waits for the selected track, including when stream URLs need refreshing
or multiple playlist entries have the same title.
Switching modes or playlists cancels queued lookups and terminates running ones.

Select **url** from the mode menu, paste a YouTube live stream or playlist URL,
and press **Play** (or Enter). Playback starts as soon as the first track is
ready. URLs are kept for the current session without changing saved playlists.
The mode supports track selection, random playback, and refreshing expired URLs.

Terminal clients can use the same mode through the command socket:

```sh
printf '%s' 'play-url:https://www.youtube.com/live/VIDEO_ID' | socat - UNIX-CONNECT:/tmp/command.sock
printf '%s' 'play-url:https://www.youtube.com/playlist?list=PLAYLIST_ID' | socat - UNIX-CONNECT:/tmp/command.sock
```
