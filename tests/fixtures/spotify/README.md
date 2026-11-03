Spotify pages for tests/spotify-web.test.mjs.

- `embed-playlist.html`, `fetch-playlist.json`: captured 2026-11-03 from a public playlist
  (Spotify's "Today's Top Hits") without signing in, trimmed to three songs; the embed's
  anonymous token is replaced with a placeholder.
- `library.json`, `liked.json`, `profile.json`: hand-written in the shapes the web player's
  `libraryV3`, `fetchLibraryTracks` and `profileAttributes` answers had in October 2026.
  They need a signed-in account to capture, so they are not live captures.
