/**
 * Spotify, all in main. Two things, both unofficial (Spotify's own pages and web player, not
 * an API), so either may change or stop working:
 *  - a public playlist link, read without signing in: the embed page, then the web player's
 *    playlist query with the anonymous token that page hands out (for songs past its 100);
 *  - Connect Spotify: the listener signs in to Spotify in a locked-down window, and their own
 *    session reads their playlists and Liked Songs.
 * The session cookie is sealed (secrets.ts) in a main-only store, one per ByTune owner (an account,
 * or the guest): signing out and back in finds it again, another account never sees it, and a guest
 * who creates an account brings it along. It never reaches the renderer, sync or backups.
 * Disconnecting wipes this owner's, a data reset everyone's, with the sign-in window's storage, the
 * tokens and the remembered matches.
 *
 * Matching a song to YouTube Music lives here too: matchSong searches, track-match.ts judges,
 * and the answer is remembered in a main-only store keyed by Spotify id (or the song's text).
 */
import { BrowserWindow, session } from "electron";
import { currentOwner } from "./data-transition";
import * as music from "./music-service";
import * as persist from "./persist";
import { openSecret, sealSecret } from "./secrets";
import * as web from "./spotify-web";
import { MATCH_LANGUAGES, bestMatch, searchQueries } from "./track-match";
import type { ImportedPlaylist, ImportSong, SpotifyPlaylistInfo, SpotifyStatus, Track } from "../src/types";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const WEB = "https://open.spotify.com";
const PATHFINDER = "https://api-partner.spotify.com/pathfinder/v2/query";
const PARTITION = "persist:spotify";
const STORE = "spotify";
const MATCHES = "track-matches";
const TIMEOUT_MS = 15_000;
/** YouTube's own playlist maximum; anything past it isn't read. */
const MAX_SONGS = 5000;
const MAX_PLAYLISTS = 1000;
export const LIKED_ID = "liked";

/** The last query hashes known to work (the web player, 2026-11-03); its live script wins. */
const KNOWN_HASHES = {
  fetchPlaylist: "21ea11a6ac75a5f3e01fd365d29c18e0a4a8b7dc09f89bbb5d73910190c6acaf",
  libraryV3: "390c78e5b951029bad359785e69b07b536a509c581cbcd0aded5e5067f187455",
  fetchLibraryTracks: "087278b20b743578a6262c2b0b4bcd20d879c503cc359a2285baf083ef944240",
  profileAttributes: "08ffb4730af3746e04a8301396f20875dbbce10c75243803091a9274eacc8ac0",
};
type Operation = keyof typeof KNOWN_HASHES;

interface Player {
  secret: { version: number; secret: string } | null;
  hashes: Partial<Record<Operation, string>>;
}
/** One ByTune owner's Spotify. */
interface Account {
  /** sealed sp_dc */
  cookie?: string;
  name?: string;
  /** the playlists as last read, shown at once (and while Spotify can't be reached) */
  playlists?: SpotifyPlaylistInfo[];
}
interface Saved {
  /** by ByTune owner: an account's id, or "guest" */
  owners?: Record<string, Account>;
  player?: Player;
}

export class SpotifySessionError extends Error {}
const CHANGED = "Spotify changed something, so ByTune couldn't read it. Try again later, or reconnect Spotify.";
const EXPIRED = "Your Spotify session has ended. Connect Spotify again.";

const saved = (): Saved => (persist.readData(STORE) as Saved | null) ?? {};
const save = (patch: Partial<Saved>): Promise<void> => persist.writeData(STORE, { ...saved(), ...patch });
const account = (owner = currentOwner()): Account => saved().owners?.[owner] ?? {};
/** Updates one owner's record (null removes it). */
function saveAccount(patch: Partial<Account> | null, owner = currentOwner()): Promise<void> {
  const owners = { ...saved().owners };
  if (patch) owners[owner] = { ...owners[owner], ...patch };
  else delete owners[owner];
  return save({ owners });
}

function get(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, { ...init, headers: { "User-Agent": UA, ...(init.headers as Record<string, string>) }, signal: AbortSignal.timeout(TIMEOUT_MS) });
}

/** In-session state of the current owner's connection: its token, and why it last failed. */
const live: { owner: string; access: { token: string; expiresAt: number } | null; problem: string | null } = { owner: "", access: null, problem: null };
function here(): typeof live {
  // Another ByTune owner now: nothing minted for the last one carries over.
  if (live.owner !== currentOwner()) Object.assign(live, { owner: currentOwner(), access: null, problem: null });
  return live;
}

/* ---------------- the web player's script ---------------- */

let player: Player | null = null;
let reading: Promise<Player> | null = null;

/** Its token secret and query hashes, read from its 4 MB script (once, then when they stop working). */
function readPlayer(): Promise<Player> {
  reading ??= (async () => {
    const page = await (await get(`${WEB}/`)).text();
    const url = web.playerScriptUrl(page);
    if (!url) throw new web.SpotifyFormatError("No web player script on Spotify's page");
    const script = await (await get(url)).text();
    const hashes: Partial<Record<Operation, string>> = {};
    for (const op of Object.keys(KNOWN_HASHES) as Operation[]) {
      const hash = web.queryHash(script, op);
      if (hash) hashes[op] = hash;
    }
    player = { secret: web.playerSecret(script), hashes };
    await save({ player }).catch(() => undefined);
    return player;
  })().finally(() => (reading = null));
  return reading;
}
const known = (): Player | null => player ?? saved().player ?? null;
const hashOf = (op: Operation): string => known()?.hashes[op] ?? KNOWN_HASHES[op];

/** One web player query. A retired hash rereads the script once; 401 is the session's to handle. */
async function query(op: Operation, variables: Record<string, unknown>, token: string, retried = false): Promise<unknown> {
  const res = await get(PATHFINDER, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "Content-Type": "application/json;charset=UTF-8", "App-Platform": "WebPlayer" },
    body: JSON.stringify({ variables, operationName: op, extensions: { persistedQuery: { version: 1, sha256Hash: hashOf(op) } } }),
  });
  if (res.status === 401) throw new SpotifySessionError(EXPIRED);
  const body = (await res.json().catch(() => null)) as { errors?: { message?: string }[]; data?: unknown } | null;
  if (!retried && body?.errors?.some((e) => /PersistedQueryNotFound/i.test(e?.message ?? ""))) {
    await readPlayer();
    return query(op, variables, token, true);
  }
  if (!res.ok || !body?.data) throw new web.SpotifyFormatError(`Spotify's ${op} answered ${res.status}`);
  return body;
}

/** Every page of a playlist (or Liked Songs), 100 at a time, up to YouTube's playlist maximum. */
async function allSongs(read: (offset: number) => Promise<ImportedPlaylist>): Promise<ImportedPlaylist> {
  const first = await read(0);
  const songs = [...first.songs];
  for (let offset = 100; offset < Math.min(first.total, MAX_SONGS); offset += 100) {
    const page = await read(offset);
    if (!page.songs.length) break;
    songs.push(...page.songs);
  }
  return { ...first, songs: songs.slice(0, MAX_SONGS) };
}

const readPlaylist = (id: string, token: string) =>
  allSongs(async (offset) =>
    web.parsePlaylistPage(await query("fetchPlaylist", { uri: `spotify:playlist:${id}`, offset, limit: 100, enableWatchFeedEntrypoint: false }, token))
  );

/* ---------------- a public playlist link, no sign-in ---------------- */

/** A spotify.link share link leads (by redirect, or a page naming it) to the playlist. */
async function followShortLink(link: string): Promise<string | null> {
  const res = await get(link, { redirect: "manual" });
  const target = res.headers.get("location") ?? (await res.text()).match(/https:\/\/open\.spotify\.com\/[^"'\s<>]+/)?.[0] ?? "";
  return web.spotifyPlaylistId(target);
}

export async function publicPlaylist(link: string): Promise<ImportedPlaylist> {
  const id = web.spotifyPlaylistId(link) ?? (web.isSpotifyShortLink(link) ? await followShortLink(link) : null);
  if (!id) throw new Error("That isn't a link to a Spotify playlist.");
  const res = await get(`${WEB}/embed/playlist/${id}`);
  if (res.status === 404) throw new Error("That playlist is private or no longer exists.");
  if (!res.ok) throw new Error(`Spotify didn't answer (HTTP ${res.status}). Try again in a moment.`);
  const { token, ...embed } = web.parseEmbedPage(await res.text());
  // The embed lists only the first 100 songs, without albums or covers; the web player's
  // query, with the token the embed hands out, has all of them.
  if (token) {
    try {
      const full = await readPlaylist(id, token);
      return { ...embed, songs: full.songs, total: full.total };
    } catch (err) {
      console.warn("[bytune] spotify: reading the whole playlist failed, keeping the embed's songs:", err instanceof Error ? err.message : err);
    }
  }
  return embed;
}

/* ---------------- Connect Spotify ---------------- */

/** A cookie value as RFC 6265 allows one (no spaces, quotes, commas, semicolons or backslashes): safe in a header. */
const COOKIE = /^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]{20,4096}$/;

/** A web player token for the signed-in listener. A retired secret rereads the script once. */
async function mint(cookie: string, fresh = false): Promise<{ token: string; expiresAt: number }> {
  const p = fresh || !known()?.secret ? await readPlayer() : known()!;
  if (!p.secret) throw new web.SpotifyFormatError("No token secret in the web player's script");
  const code = web.playerTotp(p.secret.secret, Date.now());
  const params = new URLSearchParams({ reason: "init", productType: "web-player", totp: code, totpServer: code, totpVer: String(p.secret.version) });
  const res = await get(`${WEB}/api/token?${params}`, { headers: { Cookie: `sp_dc=${cookie}` } });
  const body = (await res.json().catch(() => ({}))) as { accessToken?: unknown; accessTokenExpirationTimestampMs?: unknown; isAnonymous?: unknown; totpVerExpired?: unknown };
  if (res.status === 401 || body.isAnonymous === true) throw new SpotifySessionError(EXPIRED);
  if (!fresh && (res.status === 400 || body.totpVerExpired)) return mint(cookie, true);
  if (typeof body.accessToken !== "string") throw new web.SpotifyFormatError(`Spotify's token answered ${res.status}`);
  const expiresAt = typeof body.accessTokenExpirationTimestampMs === "number" ? body.accessTokenExpirationTimestampMs : Date.now() + 3_600_000;
  return { token: body.accessToken, expiresAt };
}

async function userToken(): Promise<string> {
  const s = here();
  if (s.access && Date.now() < s.access.expiresAt - 30_000) return s.access.token;
  const cookie = openSecret(account().cookie);
  if (!cookie) throw new SpotifySessionError("Connect Spotify first.");
  s.access = await mint(cookie);
  return s.access.token;
}

/** Runs a signed-in read; an expired token is renewed once, and a failure is remembered for Settings. */
async function signedIn<T>(read: (token: string) => Promise<T>): Promise<T> {
  const s = here();
  try {
    let result: T;
    try {
      result = await read(await userToken());
    } catch (err) {
      if (!(err instanceof SpotifySessionError) || !s.access) throw err;
      s.access = null;
      result = await read(await userToken());
    }
    s.problem = null;
    return result;
  } catch (err) {
    s.problem = err instanceof SpotifySessionError ? err.message : CHANGED;
    console.warn("[bytune] spotify:", err instanceof Error ? err.message : err);
    throw new Error(s.problem);
  }
}

export function spotifyStatus(): SpotifyStatus {
  const a = account();
  if (!a.cookie) return { connected: false };
  const { problem } = here();
  return { connected: true, ...(a.name ? { name: a.name } : {}), ...(problem ? { problem } : {}) };
}

/** Liked Songs and the library's playlists. Kept per owner, so they show at once and while Spotify can't be reached. */
export async function spotifyPlaylists(): Promise<SpotifyPlaylistInfo[]> {
  const owner = currentOwner();
  try {
    const lists = await signedIn(async (token) => {
      const out: SpotifyPlaylistInfo[] = [{ id: LIKED_ID, name: "Liked Songs" }];
      for (let offset = 0; offset < MAX_PLAYLISTS; ) {
        const page = web.parseLibraryPage(
          await query("libraryV3", {
            filters: ["Playlists"], order: null, textFilter: "", features: ["LIKED_SONGS", "YOUR_EPISODES_V2", "PRERELEASES", "EVENTS"], limit: 50, offset,
            flatten: true, expandedFolders: [], folderUri: null, includeFoldersWhenFlattening: false,
          }, token)
        );
        out.push(...page.playlists);
        offset += page.read;
        if (!page.read || offset >= page.total) break;
      }
      return out;
    });
    // Unless that owner disconnected (or signed out) meanwhile.
    if (account(owner).cookie) await saveAccount({ playlists: lists }, owner);
    return lists;
  } catch (err) {
    const kept = account(owner).playlists;
    if (kept) return kept;
    throw err;
  }
}

export function spotifyPlaylist(id: string): Promise<ImportedPlaylist> {
  return signedIn((token) =>
    id === LIKED_ID
      ? allSongs(async (offset) => web.parseLikedPage(await query("fetchLibraryTracks", { offset, limit: 100 }, token)))
      : readPlaylist(id, token)
  );
}

/** Keeps a captured session for this ByTune owner: checks it's a signed-in one, and learns the account's name. */
async function adopt(cookie: string): Promise<void> {
  const s = here();
  s.access = await mint(cookie);
  // A new Spotify account here starts afresh: no name or playlists of the one before.
  await saveAccount(null);
  await saveAccount({ cookie: sealSecret(cookie) });
  try {
    const name = web.parseProfileName(await query("profileAttributes", {}, s.access.token));
    await saveAccount({ name });
  } catch (err) {
    console.warn("[bytune] spotify: profile:", err instanceof Error ? err.message : err);
  }
  s.problem = null;
}

const SIGN_IN_HOST = /^(?:[a-z0-9-]+\.)*spotify\.com$|^accounts\.google\.com$|^appleid\.apple\.com$|^(?:www|m)\.facebook\.com$/i;
function signInUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && SIGN_IN_HOST.test(u.hostname);
  } catch {
    return false;
  }
}

/** No page in the sign-in window leaves Spotify's (and its sign-in partners') pages. */
function lockDown(contents: Electron.WebContents): void {
  contents.setWindowOpenHandler(({ url }) =>
    signInUrl(url)
      ? { action: "allow", overrideBrowserWindowOptions: { autoHideMenuBar: true, webPreferences: { partition: PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false } } }
      : { action: "deny" }
  );
  contents.on("did-create-window", (child) => lockDown(child.webContents));
  contents.on("will-navigate", (event) => {
    if (!signInUrl(event.url)) event.preventDefault();
  });
  contents.on("will-redirect", (event) => {
    if (event.isMainFrame && !signInUrl(event.url)) event.preventDefault();
  });
  contents.on("will-attach-webview", (event) => event.preventDefault());
}

let connecting: Promise<SpotifyStatus> | null = null;
let signInWindow: BrowserWindow | null = null;

/** Opens Spotify's sign-in; resolves once the session is kept, or the window is closed. */
export function connectSpotify(parent: BrowserWindow | null): Promise<SpotifyStatus> {
  if (signInWindow && !signInWindow.isDestroyed()) signInWindow.focus();
  connecting ??= openSignIn(parent).finally(() => (connecting = null));
  return connecting;
}

async function openSignIn(parent: BrowserWindow | null): Promise<SpotifyStatus> {
  const ses = session.fromPartition(PARTITION);
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.setUserAgent(UA);
  // A fresh sign-in every time: nothing of an earlier account is left to pick up.
  await ses.clearStorageData();
  const win = new BrowserWindow({
    width: 480,
    height: 760,
    ...(parent ? { parent } : {}),
    title: "Connect Spotify",
    autoHideMenuBar: true,
    backgroundColor: "#121212",
    webPreferences: { partition: PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false, spellcheck: false },
  });
  signInWindow = win;
  lockDown(win.webContents);
  return new Promise<SpotifyStatus>((resolve) => {
    let done = false;
    const finish = async (cookie: string | null): Promise<void> => {
      if (done) return;
      done = true;
      ses.cookies.removeListener("changed", onCookie);
      if (cookie) {
        try {
          await adopt(cookie);
        } catch (err) {
          here().problem = err instanceof SpotifySessionError ? err.message : CHANGED;
          console.warn("[bytune] spotify: connect:", err instanceof Error ? err.message : err);
        }
      }
      // Every window of the sign-in, a Facebook or Apple popup included.
      for (const w of BrowserWindow.getAllWindows()) if (w.webContents.session === ses) w.close();
      signInWindow = null;
      // The sealed copy is the only one kept.
      await ses.clearStorageData().catch(() => undefined);
      resolve(spotifyStatus());
    };
    const onCookie = (_e: Electron.Event, cookie: Electron.Cookie, _cause: string, removed: boolean): void => {
      const domain = (cookie.domain ?? "").replace(/^\./, "");
      if (!removed && cookie.name === "sp_dc" && /(^|\.)spotify\.com$/.test(domain) && COOKIE.test(cookie.value)) void finish(cookie.value);
    };
    ses.cookies.on("changed", onCookie);
    win.on("closed", () => void finish(null));
    void win.loadURL(`https://accounts.spotify.com/login?continue=${encodeURIComponent(`${WEB}/`)}`).catch(() => undefined);
  });
}

/** Disconnect: this owner's session and playlists, the sign-in window's storage, tokens and remembered matches go. */
export async function disconnectSpotify(): Promise<void> {
  await saveAccount(null).catch(() => undefined);
  await forgetSessions(false);
}

/** A data reset: every owner's Spotify goes. */
export function forgetSpotify(): Promise<void> {
  return forgetSessions(true);
}

async function forgetSessions(everyone: boolean): Promise<void> {
  if (signInWindow && !signInWindow.isDestroyed()) signInWindow.close();
  Object.assign(live, { owner: "", access: null, problem: null });
  matches = {};
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  await Promise.all([
    everyone ? persist.writeData(STORE, {}).catch(() => undefined) : null,
    persist.writeData(MATCHES, {}).catch(() => undefined),
    session.fromPartition(PARTITION).clearStorageData().catch(() => undefined),
  ]);
}

/** A guest who creates an account brings their Spotify along, as they bring their library. */
export async function moveGuestSpotify(owner: string): Promise<void> {
  const guest = account("guest");
  if (!guest.cookie || account(owner).cookie) return;
  await saveAccount(guest, owner);
  await saveAccount(null, "guest");
}

/* ---------------- matching to YouTube Music ---------------- */

interface Remembered {
  t: Track | null;
  at: number;
}
const FOUND_MS = 30 * 86_400_000;
const MISSED_MS = 86_400_000;
const MAX_REMEMBERED = 5000;
let matches: Record<string, Remembered> | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
const matching = new Map<string, Promise<Track | null>>();

function remember(key: string, t: Track | null): void {
  const all = (matches ??= {});
  all[key] = { t, at: Date.now() };
  const keys = Object.keys(all);
  if (keys.length > MAX_REMEMBERED) {
    for (const k of keys.sort((a, b) => all[a].at - all[b].at).slice(0, keys.length - MAX_REMEMBERED)) delete all[k];
  }
  saveTimer ??= setTimeout(() => {
    saveTimer = null;
    void persist.writeData(MATCHES, matches ?? {}).catch(() => undefined);
  }, 2000);
}

/** At most four searches at once, however many pages are matching. */
let searching = 0;
const queue: (() => void)[] = [];
async function slot<T>(run: () => Promise<T>): Promise<T> {
  if (searching >= 4) await new Promise<void>((go) => queue.push(go));
  searching++;
  try {
    return await run();
  } finally {
    searching--;
    queue.shift()?.();
  }
}

/** The YouTube Music song a song from elsewhere is, or null; remembered for a month (a miss for a day). */
export async function matchSong(song: ImportSong, prefer: string): Promise<Track | null> {
  const lang = (MATCH_LANGUAGES as readonly string[]).includes(prefer) ? prefer : "";
  const key = `${song.spotifyId ? `sp:${song.spotifyId}` : `t:${song.title}|${song.artist}|${song.duration}`.toLowerCase()}|${lang}`;
  matches ??= (persist.readData(MATCHES) as Record<string, Remembered> | null) ?? {};
  const hit = matches[key];
  if (hit && Date.now() - hit.at < (hit.t ? FOUND_MS : MISSED_MS)) return hit.t;
  // Two pages asking for the same song share one search.
  const running = matching.get(key);
  if (running) return running;
  const search = slot(async () => {
    let found: Track | null = null;
    for (const q of searchQueries(song)) {
      const { rows } = await music.searchPage(q, "songs");
      found = bestMatch(song, rows.flatMap((r) => (r.kind === "track" || r.kind === "top" ? [r.song] : [])), lang);
      if (found) break;
    }
    remember(key, found);
    return found;
  }).finally(() => matching.delete(key));
  matching.set(key, search);
  return search;
}
