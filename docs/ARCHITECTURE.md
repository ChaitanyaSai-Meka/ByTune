# ByTune Architecture

A high-level map of how ByTune works, for contributors. This document intentionally goes deeper than the README.

## Layers

```
UI  (React 18 + Tailwind)
  views/        home, search, album, artist, playlist, library,
                local music, downloads, replay, settings
  components/   design-system primitives, sidebar, player bar,
                queue, lyrics, context menus, toasts
  pip/          mini player (picture-in-picture) window app
        │
Application state  (Zustand stores)
  stores/       player · library · settings · ui · recents · listening
        │
Audio engine  (src/lib/audio.ts)
  <audio> element ⇄ store, error recovery with stream-source rotation,
  MediaSession (media keys + now-playing overlays), play-event logging
        │  IPC (contextBridge preload, electron/preload.ts)
Main process  (Electron, electron/)
  main.ts           app lifecycle, window, IPC routing
  music-service.ts  YouTube Music: search / albums / playlists / home /
                    lyrics + stream URL resolution
  po-token.ts       BotGuard PO-token minting (sandboxed JSDOM + bgutils-js)
  stream-proxy.ts   local 127.0.0.1 range-aware streaming proxy
  media-controls.ts Windows media flyout + media keys via ByTuneMedia.exe
                    (media-helper.cs): full-size cover instead of Chromium's
                    150px copy
  downloads.ts      track downloader with progress events
  persist.ts        JSON persistence for renderer stores (+ legacy migration)
  sync-merge.ts     library merge for account sync
        │
Providers & storage
  YouTube Music (InnerTube) · LRCLIB (lyrics fallback) · local files
  (music-metadata) · optional Supabase account (auth + library backup)
```

## How streaming works (no login required)

YouTube gates stream URLs behind BotGuard "PO tokens" for anonymous sessions. ByTune handles this end-to-end locally:

1. A BotGuard challenge is taken from the YouTube homepage (with an `/att/get` fallback) and the interpreter runs inside a sandboxed JSDOM environment presented as youtube.com — the same approach as the [bgutil](https://github.com/Brainicism/bgutil-ytdlp-pot-provider) provider.
2. The resulting WebPO token is bound to the session's visitor data and attached to InnerTube requests.
3. Stream URLs are resolved by rotating InnerTube clients (VISIONOS / IOS / ANDROID_VR / WEB / MUSIC / ANDROID / TV), each validated with a real open-range request to dodge SABR-gated URLs.
4. All googlevideo traffic flows through a small local proxy (`127.0.0.1`) in the main process — the media element plays from localhost, which sidesteps the renderer being rejected by googlevideo entirely.

If every InnerTube route fails, public Piped mirrors are tried as a last resort.

Note that YouTube actively changes this plumbing; if playback ever breaks, updating `youtubei.js` (`npm i youtubei.js@latest`) usually fixes it.

## Persistence

- Library, settings, recents and listening history are persisted as JSON in the app's user-data directory and restored on launch (`persist.ts`).
- Downloads are written as `.m4a` files to the user-configured downloads folder and tracked in a download registry that is reconciled at boot.
- With an account (optional), the library is backed up to Supabase and merged across devices (`sync-merge.ts`); guest data stays on the device only.

## Automix

`src/lib/analysis.ts` decodes each song once at a reduced sample rate and finds its silent edges, its first musical onset, its integrated loudness (BS.1770) and beat grids at the intro and outro. Automix blends where the outgoing song's sound really ends, brings the next song in at its first sound, and slides the blend by under one beat so the beats land together when the tempos are within 4% (`planBlend` in `src/lib/audio.ts`). It does not stretch tempo. The plain Crossfade setting uses fixed-length fades; Skip silence trims the same edges. The same measurement levels Piped streams and local files without ReplayGain.

## Local music

Folders are imported through an approved-directories list, scanned with tag + artwork extraction via `music-metadata`, and indexed into songs/albums/artists. A non-music filter hides short recordings, clips and voice notes (re-applied on rescan).
