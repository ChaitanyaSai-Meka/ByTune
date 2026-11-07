# ByTune PC — Feature Parity Matrix (final)

Statuses were re-checked against the code on 2026-11-01. Earlier versions of this table claimed features that don't exist; those rows now say NOT IMPLEMENTED.
Statuses: **IMPLEMENTED** (works end-to-end) · **PARTIAL** (some of the surface, honestly labeled) · **N/A** (no meaningful desktop equivalent — intentionally excluded) · **BLOCKED** (needs a dependency or product decision; not faked).

## Playback
| Feature | Status | Notes |
|---|---|---|
| YT Music playback | IMPLEMENTED | pre-existing; youtubei.js + PO token + local stream proxy |
| Crossfade | IMPLEMENTED | dual-element equal-power blend (`src/lib/audio.ts`), 0–12s setting, armed 4s early |
| Automix (smart fade) | PARTIAL | real: both songs analysed once (`src/lib/analysis.ts`: silent edges, first onset, BS.1770 loudness, intro/outro beat grids); the blend runs from the outgoing song's last sound into the incoming song's first and slides under one beat so beats land together when tempos are within 4% (`planBlend`, `src/lib/audio.ts`); no tempo stretch. No vocal mask / bass-filter FX / WSOLA — BLOCKED (needs native DSP), never faked |
| Playback speed | IMPLEMENTED | 0.5–2×, pitch-preserving, persisted, wired to both elements |
| Skip silence | IMPLEMENTED | opt-in; decoded edge scan (−42dBFS), head seek + tail skip |
| Shuffle / Repeat / persistence | IMPLEMENTED | pre-existing |
| Queue mgmt (next/add/remove/clear/history) | IMPLEMENTED | pre-existing; one "Up next" list (your songs, then AutoPlay's suggestions), drag or Alt+↑/↓ to reorder, a song waits in the queue once |
| AutoPlay | IMPLEMENTED | endless: YouTube Music's own song radio (`next` on RDAMVM<id>, continuation-paged) queued as a tail after the listener's songs (`src/lib/autoplay.ts`); on by default for new installs |
| Radio | PARTIAL | artist-related rows + autoplay; no dedicated station endpoint |
| Gapless | PARTIAL | natural end only; crossfade covers transitions when enabled |
| Read-ahead | N/A | Chromium range-buffers; no separate read-ahead cache is needed |
| Mid-track quality upgrade | BLOCKED | single-catalogue resolver; revisit with more sources |
| Media session / background playback | IMPLEMENTED | SMTC + media keys + timeline (setPositionState added) |
| Stats for nerds | NOT IMPLEMENTED | no code for this exists in the repo or its git history (an earlier version of this table claimed it) |

## Audio / quality
| Feature | Status | Notes |
|---|---|---|
| Quality setting | PARTIAL | only Low carries a real ceiling (64 kbps); Medium/High/Lossless all resolve YouTube's best rendition |
| StreamFormat model | NOT IMPLEMENTED | nothing in the UI reports codec or bitrate |
| Lossless / Hi-Res | BLOCKED on sources | YouTube Music has no lossless rendition (≈160 kbps Opus anonymous); there is no addon protocol in this repo |
| Dolby Atmos badge | N/A | no E-AC-3 JOC on the YT Music stream path |
| Output PCM / USB DAC / system EQ | N/A | desktop OS mixer owns this |
| Spatial audio toggle | REMOVED | was a fake toggle |

## Automix analysis
| Feature | Status |
|---|---|
| Tempo detection (BPM + beat grid) | IMPLEMENTED (lightweight, browser-side) |
| Vocal analysis / phrase detection | BLOCKED — open-unmix-class DSP; explicitly excluded rather than faked |
| Tempo stretching / beat matching | BLOCKED — same |
| Efficient/Balanced/Performance modes | N/A (single-threaded worker-equivalent; nothing to tune yet) |

## Lyrics
| Feature | Status | Notes |
|---|---|---|
| Provider chain | IMPLEMENTED | BitChord's lyrics system in ByTune's own code — the same sources in the same order: lrc.red (Apple TTML by ISRC) + BiniLyrics (names the recording first; its ISRC goes to lrc.red and LyricsPlus) + BetterLyrics + Portato + PaxSenix + LyricsPlus + Unison + the video's captions + YT Music's Lyrics tab + KuGou + LRCLIB + Musixmatch + Genius (only when nothing else answered). All asked at once, answers taken in priority order: the highest-priority source with timed lyrics wins, plain text is the fallback. Every source is asked with BitChord's artist (the whole credit; BetterLyrics and Portato, whose keyless caches answer only what was asked before, get both of BitChord's forms, "A, B, C" then YouTube's "A, B & C") and lrc.red uses the recording BiniLyrics named before its own search's pick. A local file's own timed lyrics tag answers first, as in BitChord. On top of BitChord, every name-matched answer must name the playing recording (same song, same version words, a shared artist), read the way catalogues write names: Traditional and Simplified Chinese alike, an artist in another script by the entry's length, release labels like "(Album Version)", "Artist - Song (Lyrics)" uploads by their dash, and the playing release's own entry for its title track. A music video takes the identified recording at the album length, and a Portato file still sung after the track has ended is another song's (`electron/lyrics.ts`, `electron/hanFold.ts`, generated by `scripts/gen-han-fold.mjs`) |
| Word/syllable sync | IMPLEMENTED | TTML + rich-LRC parsers; karaoke sweep via rAF (`src/components/SyncedLyrics.tsx`) |
| Instrumental gaps | IMPLEMENTED | ≥5s silence between lines renders a pulse marker |
| Background vocals split | N/A (deferred) | TTML x-bg collected inline for now |
| Provider order + syllable-priority | IMPLEMENTED | BitChord's loop: answers awaited in priority order, the first timed one wins (word or line, BitChord's default); a file stamped all at 0:00 counts as plain text. Genius runs whenever nothing answered. Credited "Lyrics from …" |
| LyricsPlus / PaxSenix / KuGou | IMPLEMENTED | full ports (mirror race, Apple token scrape, hash-chain search) |
| Musixmatch / Genius | IMPLEMENTED | in the provider list (`electron/lyrics.ts` PROVIDERS): Musixmatch with rich sync when it has it (parked for the session when token.get answers 403, as it does on some networks for every client), Genius plain text last |
| Seek / highlight / blur / loading / unavailable states | IMPLEMENTED | pre-existing |

## Canvas
| Feature | Status |
|---|---|
| Canvas providers | IMPLEMENTED: community index + Tidal (embed token), match-verified, negative-cached LRU-64 (`electron/canvas.ts`) |
| Apple Music canvas | BLOCKED — token scraping from the web player; provider shape accepts it later |
| Renderer | IMPLEMENTED: looping muted video over still art in Now Playing, `animatedCanvas` setting now real |
| Spotify canvas (needs your session cookie) | N/A — not carried over |

## Downloads / offline
| Feature | Status |
|---|---|
| Queue, concurrency (2), cancel, retry | IMPLEMENTED (`electron/downloads.ts`) |
| Progress + lifecycle events | IMPLEMENTED (`download:event` channel) |
| Metadata + cover embedding | BLOCKED — needs a tagger dependency (mp4/flac writers); not faked |
| Download quality | IMPLEMENTED (ceiling passed to the resolver) |
| Offline playback of saved files | PARTIAL — files land in your download folder; the app doesn't play them back from disk yet |
| Cache management | N/A — ByTune streams via browser buffering; the fake "cache limit" slider was removed |

## Local music library
| Feature | Status |
|---|---|
| Folder scan/rescan, tags, cover art, durations | IMPLEMENTED (`electron/local-library.ts`, music-metadata; art via localart:// protocol) |
| Non-music filter (≥30s + recordings/voice-notes paths) | IMPLEMENTED (desktop-path heuristics) |
| Songs/albums/artists + search + sort | IMPLEMENTED (`src/views/LocalMusicView.tsx`, sidebar entry) |
| Genres view | PARTIAL — genre captured in tags, no dedicated view yet |

## Sources
| Feature | Status |
|---|---|
| MusicSource abstraction | NOT IMPLEMENTED — no code for this exists in the repo or its git history (an earlier version of this table claimed it) |
| JioSaavn | NOT IMPLEMENTED — no code for this exists in the repo or its git history (an earlier version of this table claimed it) |
| Addon HTTP sources | NOT IMPLEMENTED — no code for this exists in the repo or its git history (an earlier version of this table claimed it) |
| Search fan-out merge | NOT IMPLEMENTED — YouTube Music is the only catalogue |
| QuickJS module sources | NOT IMPLEMENTED |
| TrackMatcher scoring | PARTIAL — full 661-line scorer not ported; providers self-match via strict title/artist checks |

## Search / discovery
| Feature | Status |
|---|---|
| Songs/artists/albums/videos + suggestions + recents | IMPLEMENTED (pre-existing) |
| Playlists in results | IMPLEMENTED |
| Dropdown-only typing (home stays) + rich dropdown | IMPLEMENTED (earlier in this track of work) |
| Multi-source search | NOT IMPLEMENTED — YouTube Music only |
| Progressive results | PARTIAL — top result still waits on the YT call |

## Playlists
Create/rename/delete/add/remove/queue/play next: IMPLEMENTED (pre-existing). Pin to top: IMPLEMENTED.

## Accounts
| Feature | Status |
|---|---|
| YT Music sign-in | NOT IMPLEMENTED — no code for this exists in the repo or its git history (an earlier version of this table claimed it); ByTune streams anonymously |
| Multi-account / brand selection | N/A (v1: one session) — the store format takes more later |

## Integrations
| Feature | Status |
|---|---|
| ListenBrainz | NOT IMPLEMENTED — no code for this exists in the repo or its git history (an earlier version of this table claimed it) |
| Last.fm | NOT IMPLEMENTED — no code for this exists in the repo or its git history (an earlier version of this table claimed it) |
| Discord Rich Presence | NOT IMPLEMENTED — no code for this exists in the repo or its git history (an earlier version of this table claimed it) |

## Replay / statistics
| Feature | Status |
|---|---|
| Listen recording (5s progress bus, ≥30s play floor) | IMPLEMENTED (`electron/stats.ts`, monthly JSON buckets) |
| Top songs/artists/albums, listening time, plays | IMPLEMENTED |
| Activity (28-day) + hour-of-day charts | IMPLEMENTED |
| Periods: this/last month, year, all time | IMPLEMENTED |
| Replay view (opened from Settings; no sidebar entry yet) | IMPLEMENTED — only real recorded data; empty periods say so |
| Share-image recap | N/A (v1) |

## Desktop-native
Keyboard shortcuts, media keys, SMTC, right-click menus: IMPLEMENTED (pre-existing). Drag-to-reorder: IMPLEMENTED for the queue and playlists (a playlist song can still be dragged out onto another playlist or the queue). Tray/mini-player: N/A (v1). Android Auto / widgets / haptics / overscroll: N/A — no desktop equivalent needed.

## Security hardening (this pass)
CSP meta (script/style/img/media/connect allowlists), `sandbox: true` on the BrowserWindow, DevTools gated to dev builds, filesystem allowlist for open/reveal/download paths (only user-picked or default download dirs + app data), proxy token map (no raw-URL relay), npm audit: 0 vulnerabilities.

## Known limitations (honest)
- Lossless/Hi-Res: YouTube Music cannot provide it, and ByTune has no other source.
- Automix does beat-aligned crossfades; it does not do vocal analysis, bass/filter transitions or tempo stretch (marked BLOCKED, not faked).
- Download metadata embedding awaits a tagger dependency.
- Lyrics sources can't be switched off or reordered yet. Every source is asked at once and answers are taken in BitChord's default priority order: lrc.red, BiniLyrics, BetterLyrics, Portato, PaxSenix, LyricsPlus, Unison, then the video's own captions and YouTube Music's lyrics tab, then KuGou, LRCLIB and Musixmatch, with Genius's plain text last. The highest-priority source with timed lyrics wins.
