/**
 * Canvas — looping video artwork behind the player. BitChord's canvas lookup,
 * in ByTune's own code: the same four sources, asked in the same order until
 * one answers.
 *
 *  1. Apple Music's motion artwork: the most clips. Read with the anonymous
 *     token Apple's web player uses, and scored, because its search returns a
 *     plausible wrong album for almost anything.
 *  2. Tidal's video covers, square, on a lot of what Apple misses.
 *  3. The community index, the only one that reaches back catalogue.
 *  4. Spotify's own Canvas, only for a listener who connected Spotify (it
 *     needs their session) and last, as the heaviest to reach.
 *
 * Every answer is checked against what was asked for: all four will
 * confidently answer a search with the wrong record, and a wrong clip is worse
 * than none. Misses are cached, because nothing having a canvas is the common
 * case.
 */
import * as music from "./music-service";
import { spotifyCanvas } from "./spotify";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const COMMUNITY_MANIFEST = "https://vivimusicanvas.mkmdevilmi.workers.dev/canvas.json";
const COMMUNITY_TTL_MS = 30 * 60 * 1000;
const TIDAL_SEARCH = "https://api.tidal.com/v1/search";
const TIDAL_EMBED_TOKEN = "vNVdglQOjFJJGG2U";
const APPLE_CATALOG = "https://amp-api.music.apple.com/v1/catalog";
const APPLE_WEB_PLAYER = "https://music.apple.com/us/browse";
const APPLE_TOKEN_RETRY_MS = 30 * 60 * 1000;

interface CanvasHit {
  url: string;
  source: "apple" | "tidal" | "community" | "spotify";
}

/* ------------------------------ matching ------------------------------- */

function normalizeForMatch(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/\(.*?\)|\[.*?]/g, " ")
    .replace(/\b(feat|ft|featuring|with)\b.*$/, "")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function splitArtists(artist: string): string[] {
  return artist
    .split(/,|;| & | x | and /i)
    .map((a) => normalizeForMatch(a))
    .filter((a) => a.length > 1);
}

/** Exact normalized title, every wanted artist credited. */
function isMatch(gotName: string, gotArtists: string[], wantName: string, wantArtist: string): boolean {
  if (normalizeForMatch(gotName) !== normalizeForMatch(wantName)) return false;
  const wanted = splitArtists(wantArtist);
  const credited = gotArtists.map(normalizeForMatch).filter((a) => a !== "");
  if (!wanted.length || !credited.length) return false;
  return wanted.every((w) => credited.some((c) => c === w));
}

/** YouTube's packaging ("(Official Video)", "[4K]", "| Lyrical") that no catalogue has, off before searching. */
const NOISE = /\((?:from|official|lyrical|video|audio)[^)]*\)|\[[^\]]*]|\b(?:official (?:video|audio|music video)|lyrical|full song|4k video)\b/gi;
function cleaned(s: string): string {
  return s.replace(NOISE, " ").split(" | ")[0].replace(/\s+/g, " ").trim() || s;
}

async function fetchText(url: string, headers: Record<string, string> = {}, timeoutMs = 8000): Promise<string | null> {
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, ...headers }, signal: AbortSignal.timeout(timeoutMs) });
    return res.ok ? await res.text() : null;
  } catch {
    return null;
  }
}

/* ----------------------------- community -------------------------------- */

/**
 * Only https video URLs may enter the manifest — the community index is
 * third-party content, and the result is handed to a media element. A file:/UNC
 * or other-scheme URL would make the app perform local/network requests at
 * playback time (e.g. an SMB auth leak). Exported for regression tests.
 */
export function canvasUrlOk(url: string): boolean {
  try {
    return new URL(url, "https://invalid.invalid").protocol === "https:"
      && new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

let communityEntries: { song: string; artist: string; album: string; url: string }[] = [];
let communityFetchedAt = 0;

async function communityManifest(): Promise<typeof communityEntries> {
  const now = Date.now();
  if (communityEntries.length && now - communityFetchedAt < COMMUNITY_TTL_MS) return communityEntries;
  try {
    const res = await fetch(COMMUNITY_MANIFEST, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(8000) });
    if (res.ok) {
      const arr = (await res.json()) as any[];
      communityEntries = (Array.isArray(arr) ? arr : [])
        .map((o) => ({
          song: String(o?.song ?? ""),
          artist: String(o?.artist ?? ""),
          album: String(o?.album ?? ""),
          url: String(o?.url ?? ""),
        }))
        .filter((e) => e.song && e.artist && canvasUrlOk(e.url));
      communityFetchedAt = now;
    } else {
      communityFetchedAt = now; // serve what we have rather than dropping canvas
    }
  } catch {
    communityFetchedAt = now;
  }
  return communityEntries;
}

async function communityCanvas(title: string, artist: string, album?: string): Promise<CanvasHit | null> {
  const index = await communityManifest();
  const wantTitle = normalizeForMatch(title);
  const wantArtist = normalizeForMatch(artist);
  const wantAlbum = album ? normalizeForMatch(album) : null;
  const hit = index.find((e) => {
    const song = normalizeForMatch(e.song);
    const credited = normalizeForMatch(e.artist);
    const listed = normalizeForMatch(e.album);
    const titleOk = song !== "" && (wantTitle.includes(song) || song.includes(wantTitle));
    const artistOk = credited !== "" && (wantArtist.includes(credited) || credited.includes(wantArtist));
    const albumOk = listed === "" || !wantAlbum || listed === wantAlbum;
    return titleOk && artistOk && albumOk;
  });
  return hit ? { url: hit.url, source: "community" } : null;
}

/* ------------------------------- tidal ---------------------------------- */

function tidalCoverUrl(id: string): string | null {
  const parts = id.split("-");
  if (parts.length !== 5) return null;
  return `https://resources.tidal.com/videos/${parts.join("/")}/1280x1280.mp4`;
}

async function tidalGet(query: string, types: "TRACKS" | "ALBUMS"): Promise<any[] | null> {
  const qs = new URLSearchParams({ query, limit: "10", types, countryCode: "US" });
  try {
    const res = await fetch(`${TIDAL_SEARCH}?${qs.toString()}`, {
      headers: { "X-Tidal-Token": TIDAL_EMBED_TOKEN, "User-Agent": UA },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const json = await res.json();
    const section = types === "TRACKS" ? json?.tracks?.items : json?.albums?.items;
    return Array.isArray(section) ? section : null;
  } catch {
    return null;
  }
}

async function tidalCanvas(title: string, artist: string, album?: string): Promise<CanvasHit | null> {
  // Album-level first when we know the release: the cover belongs to the
  // album in Tidal's model, and an album query can't settle on a wrong song.
  if (album) {
    const albums = await tidalGet(`${album} ${artist}`, "ALBUMS");
    for (const rec of albums ?? []) {
      const name = String(rec?.title ?? "");
      const artists = (rec?.artists ?? []).map((a: any) => String(a?.name ?? ""));
      if (!isMatch(name, artists, album, artist)) continue;
      const id = rec?.videoCover;
      if (typeof id !== "string" || !id) continue;
      const url = tidalCoverUrl(id);
      if (url) return { url, source: "tidal" };
    }
  }
  const tracks = await tidalGet(`${artist} ${title}`, "TRACKS");
  for (const item of tracks ?? []) {
    const trackTitle = String(item?.title ?? "");
    const artists = (item?.artists ?? []).map((a: any) => String(a?.name ?? ""));
    if (!isMatch(trackTitle, artists, title, artist)) continue;
    const id = item?.album?.videoCover;
    if (typeof id !== "string" || !id) continue;
    const url = tidalCoverUrl(id);
    if (url) return { url, source: "tidal" };
  }
  return null;
}

/* ------------------------------- apple ---------------------------------- */

/** The floor a hit must clear: exact artist and title alone make 25; artist, a near title and the right album 37. */
const APPLE_MIN_SCORE = 12;
/** On one side only, these mark a different master of the track, often with a different clip. */
const EDITION_WORDS = ["deluxe", "expanded", "remastered", "remix", "version", "edit", "mix", "bonus"];
/** Playlists and radio mixes carry motion artwork of their own, which never belongs behind a track. */
const COMPILATION_MARKERS = ["playlist", "set list", "essentials", "dj mix", "mixed", "apple music", "today's hits", "session"];
const isCompilation = (name: string): boolean => COMPILATION_MARKERS.some((m) => name.toLowerCase().includes(m));
/** Apple names a single "Daylight - Single" where YouTube Music says "Daylight". */
const albumKey = (album: string): string => normalizeForMatch(album.replace(/\s+-\s+(?:single|ep)$/i, ""));

/**
 * How well an Apple search hit lines up with the track, or null to reject it
 * outright. The artist is a gate, not a score: a clip credited to someone else
 * is never the right one. Exported for tests.
 */
export function appleScore(
  hit: { name: string; artistName: string; albumName: string },
  title: string,
  artist: string,
  album?: string
): number | null {
  if (isCompilation(hit.name) || isCompilation(hit.albumName)) return null;
  const wanted = splitArtists(artist);
  const credited = splitArtists(hit.artistName);
  if (!wanted.length || !credited.length || !wanted.every((w) => credited.includes(w))) return null;

  const want = normalizeForMatch(title);
  const got = normalizeForMatch(hit.name);
  // A different song by the same artist is exactly the mismatch to keep out.
  let score = 10 + (got === want ? 15 : got.includes(want) || want.includes(got) ? 7 : -10);
  if (album && hit.albumName) {
    const wantAlbum = albumKey(album);
    const gotAlbum = albumKey(hit.albumName);
    score += gotAlbum === wantAlbum ? 20 : gotAlbum.includes(wantAlbum) || wantAlbum.includes(gotAlbum) ? 10 : 0;
  }
  for (const word of EDITION_WORDS) {
    const inWanted = title.toLowerCase().includes(word);
    const inHit = hit.name.toLowerCase().includes(word);
    if (inWanted && inHit) score += 5;
    else if (inHit) score -= 3;
  }
  return score;
}

let appleToken: { jwt: string; expiresAt: number } | null = null;
let appleRetryAt = 0;
let appleReading: Promise<string | null> | null = null;
/** Tokens the catalog has turned down: the bundle ships several JWTs, and only the web player's is honoured. */
const appleRejected = new Set<string>();

/** A JWT's expiry, and whether it names itself the web player's (header kid, payload issuer). */
function readJwt(jwt: string): { expiresAt: number; webPlayer: boolean } | null {
  const [header, payload] = jwt.split(".").map((part) => Buffer.from(part, "base64url").toString("utf8"));
  const exp = Number(/"exp"\s*:\s*(\d+)/.exec(payload ?? "")?.[1]);
  return exp ? { expiresAt: exp * 1000, webPlayer: header.includes("WebPlayKid") || payload.includes("AMPWebPlay") } : null;
}

/**
 * The read-only token Apple Music's web player mints for anonymous visitors,
 * read the way the browser gets it: the web player's page, its script bundle,
 * the token inside. Held until shortly before it expires; a failed read waits
 * half an hour rather than costing every track the round trip.
 */
function appleBearer(): Promise<string | null> {
  const now = Date.now();
  if (appleToken && now < appleToken.expiresAt - 60_000) return Promise.resolve(appleToken.jwt);
  if (now < appleRetryAt) return Promise.resolve(null);
  appleReading ??= (async () => {
    const page = await fetchText(APPLE_WEB_PLAYER);
    for (const path of new Set(page?.match(/\/assets\/index(?:-legacy)?[~-][A-Za-z0-9_-]+\.js/g) ?? [])) {
      const script = await fetchText(`https://music.apple.com${path}`, {}, 20_000);
      const usable = [...new Set(script?.match(/ey[A-Za-z0-9_-]+\.ey[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g) ?? [])]
        .filter((jwt) => !appleRejected.has(jwt))
        .flatMap((jwt) => {
          const read = readJwt(jwt);
          return read && read.expiresAt > Date.now() ? [{ jwt, ...read }] : [];
        });
      const pick = usable.find((t) => t.webPlayer) ?? usable[0];
      if (pick) {
        appleToken = { jwt: pick.jwt, expiresAt: pick.expiresAt };
        return pick.jwt;
      }
    }
    appleRetryAt = Date.now() + APPLE_TOKEN_RETRY_MS;
    return null;
  })().finally(() => (appleReading = null));
  return appleReading;
}

/** A catalog read. A 401 means this isn't the token the catalog honours: it's struck off, and the next track reads again. */
async function appleGet(url: string, bearer: string): Promise<any> {
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${bearer}`, Origin: "https://music.apple.com", Referer: "https://music.apple.com/", "User-Agent": UA },
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 401) {
      appleRejected.add(bearer);
      if (appleToken?.jwt === bearer) appleToken = null;
    }
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

/** Motion artwork is per storefront: the listener's own country's. */
function appleStorefront(): string {
  try {
    const country = music.currentMarket().country;
    return /^[a-z]{2}$/i.test(country) ? country.toLowerCase() : "us";
  } catch {
    return "us";
  }
}

/** The renditions to try: square first (it fills a square sleeve uncropped), then the raw one, then the 3:4. */
function motionUrls(video: any): string[] {
  const link = (key: string): string | null => {
    const asset = video?.[key];
    const url = asset?.video ?? asset?.videoUrl ?? asset?.hlsUrl ?? asset?.url;
    return typeof url === "string" && url ? url : null;
  };
  const urls = [link("motionDetailSquare") ?? link("motionSquareVideo1x1"), link("motionDetailRaw"), link("motionDetailTall") ?? link("motionTallVideo3x4")];
  return [...new Set(urls.filter((u): u is string => !!u && canvasUrlOk(u)))];
}

/**
 * The H.264 rendition in an HLS master playlist with the most pixels, at its
 * lowest rate: plenty for a cover, and HEVC doesn't decode everywhere.
 * Exported for tests.
 */
export function hlsVariant(master: string, base: string): string | null {
  const lines = master.split(/\r?\n/);
  let best: { url: string; px: number; bw: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith("#EXT-X-STREAM-INF:") || !/CODECS="[^"]*\bavc1\./.test(lines[i])) continue;
    const size = /RESOLUTION=(\d+)x(\d+)/.exec(lines[i]);
    const uri = lines[i + 1]?.trim();
    if (!size || !uri || uri.startsWith("#")) continue;
    const px = Number(size[1]) * Number(size[2]);
    const bw = Number(/[:,]BANDWIDTH=(\d+)/.exec(lines[i])?.[1] ?? Infinity);
    if (!best || px > best.px || (px === best.px && bw < best.bw)) best = { url: new URL(uri, base).href, px, bw };
  }
  return best?.url ?? null;
}

/**
 * The one file behind an HLS media playlist, when every segment is a byte
 * range of the file its init segment opens: that file is a whole fragmented
 * MP4, and a plain <video> plays it. Null for any other layout. Exported for
 * tests.
 */
export function hlsSingleFile(media: string, base: string): string | null {
  const init = /#EXT-X-MAP:URI="([^"]+)"/.exec(media)?.[1];
  const segments = media.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  if (!init || !segments.length || segments.some((s) => s !== init)) return null;
  const url = new URL(init, base).href;
  return canvasUrlOk(url) ? url : null;
}

/** Apple serves motion artwork as HLS; this is the file inside, which the player's <video> plays as it is. */
async function appleMp4(masterUrl: string): Promise<string | null> {
  const master = await fetchText(masterUrl);
  const variant = master ? hlsVariant(master, masterUrl) : null;
  const media = variant ? await fetchText(variant) : null;
  return media && variant ? hlsSingleFile(media, variant) : null;
}

async function appleCanvas(title: string, artist: string, album?: string): Promise<CanvasHit | null> {
  const bearer = await appleBearer();
  if (!bearer) return null;
  const store = appleStorefront();
  // Everything known goes into the term: an artist alone pulls in their whole discography.
  const lower = title.toLowerCase();
  const term = [lower.includes(artist.toLowerCase()) ? "" : artist, title, album && !lower.includes(album.toLowerCase()) ? album : ""]
    .filter(Boolean)
    .join(" ");
  const qs = new URLSearchParams({ term, types: "songs", limit: "10", extend: "editorialVideo", include: "albums" });
  const songs = (await appleGet(`${APPLE_CATALOG}/${store}/search?${qs}`, bearer))?.results?.songs?.data;
  if (!Array.isArray(songs)) return null;

  const ranked: { song: any; hit: { name: string; artistName: string; albumName: string }; score: number }[] = [];
  for (const song of songs) {
    const a = song?.attributes ?? {};
    const hit = { name: String(a.name ?? ""), artistName: String(a.artistName ?? ""), albumName: String(a.albumName ?? "") };
    const score = appleScore(hit, title, artist, album);
    if (score !== null && score >= APPLE_MIN_SCORE) ranked.push({ song, hit, score });
  }
  ranked.sort((x, y) => y.score - x.score);

  const tried = new Set<string>();
  for (const { song, hit } of ranked) {
    // The last word, as on every source: the same title, and the same album when both sides know it.
    if (normalizeForMatch(hit.name) !== normalizeForMatch(title)) continue;
    if (album && hit.albumName && albumKey(hit.albumName) !== albumKey(album)) continue;
    let video = song?.attributes?.editorialVideo;
    if (!video) {
      // Not every hit expands its album, but the song's web address always ends in the album's id.
      const id = song?.relationships?.albums?.data?.[0]?.id ?? /\/album\/[^/?]+\/(\d+)/.exec(String(song?.attributes?.url ?? ""))?.[1];
      if (typeof id !== "string" || !/^\d+$/.test(id) || tried.has(id)) continue;
      tried.add(id);
      const rec = (await appleGet(`${APPLE_CATALOG}/${store}/albums/${id}?extend=editorialVideo`, bearer))?.data?.[0]?.attributes;
      if (!rec || isCompilation(String(rec.name ?? ""))) continue;
      video = rec.editorialVideo;
    }
    for (const master of motionUrls(video)) {
      const url = await appleMp4(master);
      if (url) return { url, source: "apple" };
    }
  }
  return null;
}

/* ------------------------------ spotify --------------------------------- */

async function spotifySource(title: string, artist: string, album?: string): Promise<CanvasHit | null> {
  const found = await spotifyCanvas([title, artist, album].filter(Boolean).join(" "), (hit) => isMatch(hit.name, hit.artists, title, artist));
  return found && canvasUrlOk(found.url) ? { url: found.url, source: "spotify" } : null;
}

/* ------------------------------- cache ---------------------------------- */

interface Entry {
  hit: CanvasHit | null;
}
const cache = new Map<string, Entry>();
const CACHE_MAX = 64;
let inFlight: Promise<CanvasHit | null> | null = null;
let inFlightKey = "";

const none = (): CanvasHit | null => null;

/**
 * The canvas for a track, or null. Never throws; a local file has no
 * catalogue identity worth searching on.
 */
export async function canvasFor(
  rawTitle: string,
  rawArtist: string,
  rawAlbum?: string
): Promise<{ url: string; source: string } | null> {
  const title = cleaned(rawTitle);
  const artist = cleaned(rawArtist);
  const album = rawAlbum ? cleaned(rawAlbum) : undefined;
  const key = `${normalizeForMatch(title)}|${normalizeForMatch(artist)}|${album ? normalizeForMatch(album) : ""}`;
  if (!normalizeForMatch(title) || !normalizeForMatch(artist)) return null;
  const cached = cache.get(key);
  if (cached) return cached.hit;
  if (inFlight && inFlightKey === key) return inFlight;

  inFlightKey = key;
  inFlight = (async (): Promise<CanvasHit | null> => {
    const hit =
      (await appleCanvas(title, artist, album).catch(none)) ??
      (await tidalCanvas(title, artist, album).catch(none)) ??
      (await communityCanvas(title, artist, album).catch(none)) ??
      (await spotifySource(title, artist, album).catch(none));
    cache.set(key, { hit });
    while (cache.size > CACHE_MAX) {
      const first = cache.keys().next().value;
      if (first === undefined) break;
      cache.delete(first);
    }
    return hit;
  })().finally(() => {
    inFlight = null;
    inFlightKey = "";
  });
  return inFlight;
}
