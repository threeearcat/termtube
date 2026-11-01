# TermTube

Toy YouTube player based on terminal interface

Stream and lofi URL resolution runs up to four yt-dlp processes in the background.
Selecting a pending playlist track uses one additional foreground slot, without
waiting for the rest of the playlist. Tracks already being resolved or ready to
play reuse their existing request or URL.
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
