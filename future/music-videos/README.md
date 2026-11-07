# Music videos (shelved)

Taken out of the app on 2026-11-01, to come back later with changes. Nothing in this folder is built, typechecked, tested or packaged: the typecheck covers `src/`, `electron/` and `scripts/` only, the bundles start from `electron/main.ts`, `electron/preload.ts`, `electron/po-page.ts` and `src/main.tsx`, and electron-builder packs only `dist/` and `dist-electron/`.

The whole feature (code, setting, Settings row, tests) is in `music-videos.patch`.

## What it did

- **Settings › Appearance › Music videos** (off by default): "Show the video in Now Playing when a music video is playing · up to 720p, uses more data". With Streaming quality on Low or Medium, a note under it offered a **Set to High** button; videos never played at Low.
- **Fullscreen Now Playing only.** When the playing track was a music video, its picture took the cover's place (16:9), muted, following the audio's clock. Never for local files, at Low quality, or during an Automix blend.
- A catalogue song's own YouTube "video" is a still picture of its cover, so it was detected and skipped. Measured per pixel, those stills run 0.2–0.4 bits per second and real videos 1.2 and up (cut-off: 0.6).
- For a song, **Watch the music video** (next to Add to Library) found its video with a Videos search and swapped it in at the same moment; **Back to the song** swapped back. A search, because YouTube links a song to its video only for signed-in listeners.

## Where each piece lived

| Piece | File |
|---|---|
| `pickVideo`: a video-only file up to 720p (short side), VP9 over H.264 over AV1, 30 fps or less first, plus the still-picture check | `electron/audio-format.ts` |
| `ResolvedStream.video`, picked in `resolveStream` from the same YouTube answer as the audio (same expiry, same file pinning) | `electron/music-service.ts` |
| The stream proxy serves the picture for `&v=1` (404 when there is none) | `electron/stream-proxy.ts` |
| `pickMusicVideo` (Videos search rows → the video: same title and first artist, plausible length) and `musicVideoFor` (cached per song) | `electron/ytm.ts`, `electron/music-service.ts` |
| IPC `music:videoVersion` and preload `videoVersion(song)` | `electron/main.ts`, `electron/preload.ts` |
| `followStep`: keeps the muted video in step with the audio (jumps when far off, eases the speed by up to 5% when close) | `src/lib/videoSync.ts` |
| `FsVideo`, the switch button and the 16:9 art box | `src/components/NowPlaying.tsx` |
| `swapCurrent(track)`: plays another version of the current song in its place, from the same moment | `src/stores/player.ts` |
| Setting `showVideos`, its Settings row and the quality note; kept in backups | `src/stores/settings.ts`, `src/views/SettingsView.tsx`, `electron/backup-transfer.ts` |
| 5 tests, plus the `videoSync` build step in the `test` script | `tests/format-pick.test.mjs`, `tests/radio.test.mjs`, `tests/playback-reliability.test.mjs`, `tests/video-sync.test.mjs`, `package.json` |

## Bringing it back

```bash
git apply --3way future/music-videos/music-videos.patch
```

The patch is made against commit a860a76: every file it changes is as in that commit, so `--3way` can merge it into code that has changed since. Checked on a copy of a860a76: it applied cleanly, and the typecheck and all 503 tests passed. If a file still conflicts, re-add that piece by hand using the table above. Then delete this folder.
