/**
 * Reading Spotify's web pages and answers. Pure, so it is unit-tested against captured pages
 * (tests/fixtures/spotify). None of this is an official API: a public playlist link is read
 * from Spotify's embed page, and Connect Spotify uses the web player's own token and queries
 * with the listener's own session. Any of it can change without notice; a shape this doesn't
 * recognise is a SpotifyFormatError, which the app reports as "Spotify changed something".
 */
import { createHmac } from "node:crypto";
import type { ImportedPlaylist, ImportSong, SpotifyPlaylistInfo } from "../src/types";

export class SpotifyFormatError extends Error {}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const at = (v: unknown, ...keys: string[]): unknown => keys.reduce<unknown>((o, k) => obj(o)?.[k], v);

const ID = /^[A-Za-z0-9]{22}$/;

/** The playlist id in a Spotify link or URI ("open.spotify.com/intl-de/playlist/…?si=…"), or null. */
export function spotifyPlaylistId(input: string): string | null {
  const text = input.trim();
  const uri = /^spotify:(?:user:[^:\s]+:)?playlist:([A-Za-z0-9]{22})$/.exec(text);
  if (uri) return uri[1];
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(url.protocol) || !/(^|\.)spotify\.com$/i.test(url.hostname)) return null;
  const parts = url.pathname.split("/").filter(Boolean);
  const id = parts[parts.indexOf("playlist") + 1];
  return parts.includes("playlist") && id && ID.test(id) ? id : null;
}

/** A spotify.link share link, which has to be followed to learn the playlist. */
export function isSpotifyShortLink(input: string): boolean {
  return /^https:\/\/spotify\.link\/[A-Za-z0-9]{6,20}\/?$/.test(input.trim());
}

/** The widest image: Spotify lists sizes in no fixed order (and sometimes without sizes). */
function largest(sources: unknown): string | undefined {
  let best: { url: string; width: number } | undefined;
  for (const s of arr(sources)) {
    const url = str(at(s, "url"));
    const width = num(at(s, "width")) ?? 0;
    if (url?.startsWith("https://") && (!best || width > best.width)) best = { url, width };
  }
  return best?.url;
}

/** The smallest image at least `min` wide, else the widest: rows don't need 640px. */
function sized(sources: unknown, min = 300): string | undefined {
  const list = arr(sources)
    .map((s) => ({ url: str(at(s, "url")), width: num(at(s, "width")) ?? 0 }))
    .filter((s): s is { url: string; width: number } => !!s.url?.startsWith("https://"))
    .sort((a, b) => a.width - b.width);
  return (list.find((s) => s.width >= min) ?? list.at(-1))?.url;
}

const trackId = (uri: unknown): string | undefined => /^spotify:track:([A-Za-z0-9]{22})$/.exec(str(uri) ?? "")?.[1];
const seconds = (ms: unknown): number => {
  const n = num(ms);
  return n && n > 0 && n < 86_400_000 ? Math.round(n / 1000) : 0;
};

/** A track the web player describes (playlist rows, liked songs). */
function songOf(data: unknown, uri: unknown): ImportSong | null {
  const title = str(at(data, "name"));
  const spotifyId = trackId(uri) ?? trackId(at(data, "uri"));
  if (!title || !spotifyId) return null;
  const artist = arr(at(data, "artists", "items"))
    .map((a) => str(at(a, "profile", "name")))
    .filter(Boolean)
    .join(", ");
  const album = obj(at(data, "albumOfTrack"));
  return {
    spotifyId,
    title,
    artist,
    ...(str(album?.name) ? { album: str(album?.name) } : {}),
    duration: seconds(at(data, "trackDuration", "totalMilliseconds") ?? at(data, "duration", "totalMilliseconds")),
    ...(sized(at(album, "coverArt", "sources")) ? { thumb: sized(at(album, "coverArt", "sources")) } : {}),
    ...(at(data, "contentRating", "label") === "EXPLICIT" ? { explicit: true } : {}),
  };
}

/** The public playlist an embed page shows: up to its first 100 songs, and the anonymous token it hands out. */
export function parseEmbedPage(html: string): ImportedPlaylist & { token: string | null } {
  const data = /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/.exec(html)?.[1];
  if (!data) throw new SpotifyFormatError("The Spotify page had no playlist data");
  let root: unknown;
  try {
    root = JSON.parse(data);
  } catch {
    throw new SpotifyFormatError("The Spotify page's playlist data didn't read");
  }
  const state = at(root, "props", "pageProps", "state");
  const entity = obj(at(state, "data", "entity"));
  if (!entity) throw new SpotifyFormatError("That playlist is private or no longer exists");
  const songs = arr(entity.trackList).flatMap((t): ImportSong[] => {
    const title = str(at(t, "title"));
    const spotifyId = trackId(at(t, "uri"));
    if (!title || !spotifyId) return [];
    return [
      {
        spotifyId,
        title,
        artist: str(at(t, "subtitle")) ?? "",
        duration: seconds(at(t, "duration")),
        ...(at(t, "isExplicit") === true ? { explicit: true } : {}),
      },
    ];
  });
  return {
    name: str(entity.name) ?? str(entity.title) ?? "Spotify playlist",
    ...(str(entity.subtitle) ? { owner: str(entity.subtitle) } : {}),
    ...(largest(at(entity, "coverArt", "sources")) ? { thumb: largest(at(entity, "coverArt", "sources")) } : {}),
    songs,
    total: songs.length,
    token: str(at(state, "settings", "session", "accessToken")) ?? null,
  };
}

/** One page of a playlist (the web player's fetchPlaylist query). */
export function parsePlaylistPage(json: unknown): ImportedPlaylist {
  const p = obj(at(json, "data", "playlistV2"));
  const content = obj(p?.content);
  if (!p || !content) throw new SpotifyFormatError("Spotify's playlist answer didn't read");
  const songs = arr(content.items).flatMap((item) => {
    const data = at(item, "itemV2", "data");
    const song = at(data, "__typename") === "Track" ? songOf(data, at(data, "uri")) : null;
    return song ? [song] : [];
  });
  return {
    name: str(p.name) ?? "Spotify playlist",
    ...(str(at(p, "ownerV2", "data", "name")) ? { owner: str(at(p, "ownerV2", "data", "name")) } : {}),
    ...(largest(at(arr(at(p, "images", "items"))[0], "sources")) ? { thumb: largest(at(arr(at(p, "images", "items"))[0], "sources")) } : {}),
    songs,
    total: num(content.totalCount) ?? songs.length,
  };
}

/** One page of Liked Songs (fetchLibraryTracks). */
export function parseLikedPage(json: unknown): ImportedPlaylist {
  const tracks = obj(at(json, "data", "me", "library", "tracks"));
  if (!tracks) throw new SpotifyFormatError("Spotify's liked songs answer didn't read");
  const songs = arr(tracks.items).flatMap((item) => {
    const wrapper = at(item, "track");
    const song = songOf(at(wrapper, "data"), at(wrapper, "_uri"));
    return song ? [song] : [];
  });
  return { name: "Liked Songs", songs, total: num(tracks.totalCount) ?? songs.length };
}

/** One page of the library's playlists (libraryV3 with the Playlists filter). */
export function parseLibraryPage(json: unknown): { playlists: SpotifyPlaylistInfo[]; total: number; read: number } {
  const library = obj(at(json, "data", "me", "libraryV3"));
  if (!library) throw new SpotifyFormatError("Spotify's library answer didn't read");
  const items = arr(library.items);
  const playlists = items.flatMap((entry): SpotifyPlaylistInfo[] => {
    const wrapper = obj(at(entry, "item"));
    const data = obj(wrapper?.data);
    const id = /^spotify:playlist:([A-Za-z0-9]{22})$/.exec(str(wrapper?._uri) ?? "")?.[1];
    const name = str(data?.name);
    if (data?.__typename !== "Playlist" || !id || !name) return [];
    const thumb = largest(at(arr(at(data, "images", "items"))[0], "sources"));
    const owner = str(at(data, "ownerV2", "data", "name"));
    return [{ id, name, ...(owner ? { owner } : {}), ...(thumb ? { thumb } : {}) }];
  });
  return { playlists, total: num(library.totalCount) ?? items.length, read: items.length };
}

/** The signed-in account's display name (profileAttributes). */
export function parseProfileName(json: unknown): string {
  const profile = obj(at(json, "data", "me", "profile"));
  if (!profile) throw new SpotifyFormatError("Spotify's profile answer didn't read");
  return str(profile.name) ?? str(profile.username) ?? "Spotify";
}

/* ---------------- the web player's own values ---------------- */

/** The web player's main script, as its page links it. */
export function playerScriptUrl(html: string): string | null {
  return /https:\/\/open\.spotifycdn\.com\/cdn\/build\/web-player\/web-player\.[0-9a-f]+\.js/.exec(html)?.[0] ?? null;
}

/** A JavaScript string literal's body, unescaped (the script writes its secrets as literals). */
function unescapeJs(body: string): string {
  return body.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])/g, (_, esc: string) => {
    if (esc[0] === "u" && esc.length > 1) return String.fromCodePoint(parseInt(esc.replace(/[u{}]/g, ""), 16));
    if (esc[0] === "x" && esc.length === 3) return String.fromCharCode(parseInt(esc.slice(1), 16));
    return ({ n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v", "0": "\0" } as Record<string, string>)[esc] ?? esc;
  });
}

/** The newest token secret the script declares (`{secret:'…',version:61}`), or null. */
export function playerSecret(script: string): { version: number; secret: string } | null {
  const found = [...script.matchAll(/\{secret:(['"])((?:\\.|(?!\1).)*)\1,version:(\d+)\}/g)].map((m) => ({
    version: Number(m[3]),
    secret: unescapeJs(m[2]),
  }));
  return found.sort((a, b) => b.version - a.version)[0] ?? null;
}

/** A persisted query's hash as the script declares it (`"fetchPlaylist","query","<64 hex>"`). */
export function queryHash(script: string, operation: string): string | null {
  return new RegExp(`["']${operation}["']\\s*,\\s*["']query["']\\s*,\\s*["']([0-9a-f]{64})["']`).exec(script)?.[1] ?? null;
}

/* ---------------- Canvas (ported from BitChord, GPL-3.0: SpotifyCanvas, SpotifyCanvasQuery) ---------------- */

/** One track in an answer to the web player's searchTracks query. */
export interface SpotifyTrackHit {
  uri: string;
  name: string;
  artists: string[];
  album: string;
}

/** The tracks in a searchTracks answer, in Spotify's order. */
export function parseTrackSearch(json: unknown): SpotifyTrackHit[] {
  return arr(at(json, "data", "searchV2", "tracksV2", "items")).flatMap((item) => {
    const d = at(item, "item", "data");
    const uri = str(at(d, "uri"));
    const name = str(at(d, "name"));
    if (!uri?.startsWith("spotify:track:") || !name) return [];
    const artists = arr(at(d, "artists", "items")).flatMap((a) => str(at(a, "profile", "name")) ?? []);
    return [{ uri, name, artists, album: str(at(d, "albumOfTrack", "name")) ?? "" }];
  });
}

/** A Canvas that is a video at an https URL; some are still images, which the player doesn't show. */
const canvasVideo = (url: string | undefined): string | null => (url?.startsWith("https://") && /\.mp4(?:[?#]|$)/i.test(url) ? url : null);

/** The clip in an answer to the canvas query, or null (no Canvas, or one this can't play). */
export function parseCanvasAnswer(json: unknown): string | null {
  return canvasVideo(str(at(json, "data", "trackUnion", "canvas", "url")));
}

function varint(n: number): number[] {
  const out: number[] = [];
  for (; n > 0x7f; n >>>= 7) out.push((n & 0x7f) | 0x80);
  return [...out, n];
}
const field1 = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => Uint8Array.from([0x0a, ...varint(bytes.length), ...bytes]);

/** canvaz-cache's request, `CanvasRequest { repeated Track tracks = 1 }` with `Track { string track_uri = 1 }`, hand-rolled. */
export function canvazRequest(trackUri: string): Uint8Array<ArrayBuffer> {
  return field1(field1(new TextEncoder().encode(trackUri)));
}

/** A protobuf message's fields: varints as numbers, length-delimited ones as bytes; anything else ends the read. */
function* protoFields(bytes: Uint8Array): Generator<[number, number | Uint8Array]> {
  let i = 0;
  const read = (): number => {
    let n = 0;
    for (let shift = 0; ; shift += 7) {
      if (i >= bytes.length || shift > 49) throw new SpotifyFormatError("truncated protobuf");
      const b = bytes[i++];
      n += (b & 0x7f) * 2 ** shift;
      if (b < 0x80) return n;
    }
  };
  while (i < bytes.length) {
    const tag = read();
    const wire = tag % 8;
    if (wire === 0) yield [Math.floor(tag / 8), read()];
    else if (wire === 2) {
      const len = read();
      if (i + len > bytes.length) throw new SpotifyFormatError("truncated protobuf");
      yield [Math.floor(tag / 8), bytes.subarray(i, i + len)];
      i += len;
    } else if (wire === 1) i += 8;
    else if (wire === 5) i += 4;
    else throw new SpotifyFormatError(`protobuf wire type ${wire}`);
  }
}

/**
 * The clip in canvaz-cache's answer, `CanvasResponse { repeated Canvas canvases = 1 }` with
 * `Canvas { id = 1; canvas_url = 2; track_uri = 5 }`: this track's own first, else the first.
 * When the fields don't read (Spotify renumbered them), any .cnvs.mp4 URL in the bytes.
 */
export function canvazClip(bytes: Uint8Array, trackUri: string): string | null {
  const hits: { url: string; track?: string }[] = [];
  const text = (b: number | Uint8Array): string | undefined => (typeof b === "number" ? undefined : new TextDecoder().decode(b));
  try {
    for (const [n, canvas] of protoFields(bytes)) {
      if (n !== 1 || typeof canvas === "number") continue;
      const hit: { url?: string; track?: string } = {};
      for (const [f, v] of protoFields(canvas)) {
        if (f === 2) hit.url = text(v);
        else if (f === 5) hit.track = text(v);
      }
      if (hit.url) hits.push({ url: hit.url, track: hit.track });
    }
  } catch {
    // a truncated answer: what was read stands, and the scan below covers the rest
  }
  const url = (hits.find((h) => h.track === trackUri) ?? hits[0])?.url
    ?? /https:\/\/[^"'\s\x00-\x1F]+\.cnvs\.mp4/.exec(new TextDecoder("latin1").decode(bytes))?.[0];
  return canvasVideo(url);
}

/** RFC 4226: six digits from an HMAC-SHA1 over the counter. */
export function hotp(key: Buffer, counter: bigint): string {
  const block = Buffer.alloc(8);
  block.writeBigUInt64BE(counter);
  const h = createHmac("sha1", key).update(block).digest();
  const o = h[h.length - 1] & 0x0f;
  const code = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(code % 1_000_000).padStart(6, "0");
}

/** The web player's token code: thirty-second steps, keyed by the secret's character codes XORed with their index. */
export function playerTotp(secret: string, epochMs: number): string {
  const key = Buffer.from([...secret].map((c, i) => c.charCodeAt(0) ^ ((i % 33) + 9)).join(""), "utf8");
  return hotp(key, BigInt(Math.floor(epochMs / 30_000)));
}
