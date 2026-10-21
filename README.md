# TermTube

Toy YouTube player based on terminal interface

Stream and lofi URL resolution runs up to four yt-dlp processes in the background.
Selecting a pending playlist track uses one additional foreground slot, without
waiting for the rest of the playlist. Tracks already being resolved or ready to
play reuse their existing request or URL.
Switching modes or playlists cancels queued lookups and terminates running ones.
