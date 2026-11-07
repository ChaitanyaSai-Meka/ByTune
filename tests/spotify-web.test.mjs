/**
 * Reading Spotify's pages (electron/spotify-web.ts): links, the public embed page, the web
 * player's playlist / liked songs / library / profile answers, and its token code.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  SpotifyFormatError, canvazClip, canvazRequest, hotp, isSpotifyShortLink, parseCanvasAnswer, parseEmbedPage, parseLibraryPage,
  parseLikedPage, parsePlaylistPage, parseProfileName, parseTrackSearch, playerScriptUrl, playerSecret, playerTotp, queryHash,
  spotifyPlaylistId,
} from "../.test-build/spotify-web.mjs";

const fixture = (name) => readFileSync(new URL(`./fixtures/spotify/${name}`, import.meta.url), "utf8");
const json = (name) => JSON.parse(fixture(name));

test("a playlist id comes out of every kind of Spotify link, and nothing else", () => {
  const id = "37i9dQZF1DXcBWIGoYBM5M";
  for (const link of [
    `https://open.spotify.com/playlist/${id}`,
    `https://open.spotify.com/playlist/${id}?si=1a2b3c&pt=xyz`,
    `https://open.spotify.com/intl-de/playlist/${id}`,
    `https://open.spotify.com/embed/playlist/${id}`,
    `  spotify:playlist:${id}  `,
    `spotify:user:spotify:playlist:${id}`,
  ]) assert.equal(spotifyPlaylistId(link), id, link);
  for (const bad of [
    `https://open.spotify.com/album/${id}`,
    `https://open.spotify.com.evil.example/playlist/${id}`,
    `https://evil.example/open.spotify.com/playlist/${id}`,
    `javascript:alert(1)//open.spotify.com/playlist/${id}`,
    `https://open.spotify.com/playlist/short`,
    "Artist - Title",
    "",
  ]) assert.equal(spotifyPlaylistId(bad), null, bad);
  assert.equal(isSpotifyShortLink("https://spotify.link/AbC123xyz"), true);
  assert.equal(isSpotifyShortLink("https://spotify.link.evil.example/AbC123"), false);
});

test("the embed page gives the name, cover, songs and its anonymous token", () => {
  const p = parseEmbedPage(fixture("embed-playlist.html"));
  assert.equal(p.name, "Today’s Top Hits");
  assert.equal(p.owner, "Spotify");
  assert.match(p.thumb, /^https:\/\/i\.scdn\.co\/image\//);
  assert.equal(p.token, "anonymous-token-from-the-embed");
  assert.equal(p.songs.length, 3);
  assert.deepEqual(p.songs[0], { spotifyId: "7bxaFZ1O3cHkgLKMsdC3xR", title: "Loser", artist: "Tame Impala", duration: 223, explicit: true });
  assert.throws(() => parseEmbedPage("<html>Page not found</html>"), SpotifyFormatError);
  assert.throws(() => parseEmbedPage('<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{}}}</script>'), /private or no longer exists/);
});

test("a playlist page gives full songs: album, cover, length, explicit", () => {
  const p = parsePlaylistPage(json("fetch-playlist.json"));
  assert.equal(p.name, "Today’s Top Hits");
  assert.equal(p.owner, "Spotify");
  assert.equal(p.total, 50);
  assert.equal(p.songs.length, 3);
  const [first] = p.songs;
  assert.equal(first.spotifyId, "7bxaFZ1O3cHkgLKMsdC3xR");
  assert.equal(first.title, "Loser");
  assert.equal(first.artist, "Tame Impala");
  assert.equal(first.duration, 223);
  assert.equal(first.explicit, true);
  assert.ok(first.album, "album name");
  assert.match(first.thumb, /^https:\/\/i\.scdn\.co\/image\/ab67616d00001e02/, "the 300px cover for rows");
  assert.throws(() => parsePlaylistPage({ data: { playlistV2: { __typename: "NotFound" } } }), SpotifyFormatError);
  assert.throws(() => parsePlaylistPage({ errors: [{ message: "x" }] }), SpotifyFormatError);
});

test("liked songs, the library's playlists and the profile name", () => {
  const liked = parseLikedPage(json("liked.json"));
  assert.equal(liked.total, 2);
  assert.deepEqual(liked.songs.map((s) => `${s.title} | ${s.artist} | ${s.album} | ${s.duration}`), [
    "Blinding Lights | The Weeknd | After Hours | 200",
    "Srivalli | Sid Sriram, Devi Sri Prasad | Pushpa - The Rise (Telugu) | 224",
  ]);
  const lib = parseLibraryPage(json("library.json"));
  assert.equal(lib.total, 4);
  assert.equal(lib.read, 4, "folders and missing rows count as read, so paging moves on");
  assert.deepEqual(lib.playlists.map((p) => `${p.id} ${p.name} ${p.owner}`), [
    "37i9dQZF1DXcBWIGoYBM5M Today’s Top Hits Spotify",
    "5ABHKGoOzxkaa28ttQV9sE road trip Me",
  ]);
  assert.match(lib.playlists[0].thumb, /ab67616d0000b273/, "the widest cover");
  assert.equal(parseProfileName(json("profile.json")), "Test Listener");
  assert.throws(() => parseLikedPage({ data: { me: null } }), SpotifyFormatError);
  assert.throws(() => parseLibraryPage({}), SpotifyFormatError);
});

test("the web player's script: its address, newest secret and query hashes", () => {
  const page = '<script src="https://open.spotifycdn.com/cdn/build/web-player/web-player.9eb14096.js"></script>';
  assert.equal(playerScriptUrl(page), "https://open.spotifycdn.com/cdn/build/web-player/web-player.9eb14096.js");
  assert.equal(playerScriptUrl('<script src="https://evil.example/web-player.9eb14096.js">'), null);
  const script = `x=[{secret:'a\\x41b\\'c',version:59},{secret:"new\\u0021",version:61},{secret:'mid',version:60}];` +
    `q("fetchPlaylist","query","${"a".repeat(64)}",null);q('libraryV3', 'query', '${"b".repeat(64)}')`;
  assert.deepEqual(playerSecret(script), { version: 61, secret: "new!" });
  assert.deepEqual(playerSecret(`[{secret:'a\\x41b\\'c',version:59}]`), { version: 59, secret: "aAb'c" });
  assert.equal(playerSecret("nothing here"), null);
  assert.equal(queryHash(script, "fetchPlaylist"), "a".repeat(64));
  assert.equal(queryHash(script, "libraryV3"), "b".repeat(64));
  assert.equal(queryHash(script, "canvas"), null);
});

test("token codes: RFC 4226 vectors, and the web player's key derivation", () => {
  const key = Buffer.from("12345678901234567890");
  assert.deepEqual([0n, 1n, 2n, 9n].map((c) => hotp(key, c)), ["755224", "287082", "359152", "520489"]);
  // Thirty-second steps: the same code within a step, a new one in the next.
  const t = 1_793_000_010_000;
  assert.equal(playerTotp("secret", t), playerTotp("secret", t + 15_000));
  assert.notEqual(playerTotp("secret", t), playerTotp("secret", t + 30_000));
  assert.match(playerTotp("secret", t), /^\d{6}$/);
  // The key is the decimal codes of each character XORed with (index % 33) + 9, joined.
  const derived = Buffer.from([..."ab"].map((c, i) => c.charCodeAt(0) ^ ((i % 33) + 9)).join(""));
  assert.equal(playerTotp("ab", t), hotp(derived, BigInt(Math.floor(t / 30_000))));
});

test("Canvas: the track search's hits, and the canvas query's clip (videos only)", () => {
  const hit = (uri, name, artists, album) => ({ item: { data: { uri, name, artists: { items: artists.map((n) => ({ profile: { name: n } })) }, albumOfTrack: { name: album } } } });
  const search = { data: { searchV2: { tracksV2: { items: [
    hit("spotify:track:0VjIjW4GlUZAMYd2vXMi3b", "Blinding Lights", ["The Weeknd"], "After Hours"),
    hit("spotify:episode:xyz", "Not a track", ["Someone"], ""),
    hit("spotify:track:7J1uxwnxfQLu4APicE5Rnj", "", ["Nameless"], ""),
    hit("spotify:track:2qSkIjg1o9h3YT9RAgYN75", "Espresso", ["Sabrina Carpenter", "Guest"], undefined),
  ] } } } };
  assert.deepEqual(parseTrackSearch(search), [
    { uri: "spotify:track:0VjIjW4GlUZAMYd2vXMi3b", name: "Blinding Lights", artists: ["The Weeknd"], album: "After Hours" },
    { uri: "spotify:track:2qSkIjg1o9h3YT9RAgYN75", name: "Espresso", artists: ["Sabrina Carpenter", "Guest"], album: "" },
  ]);
  assert.deepEqual(parseTrackSearch({ data: null }), []);

  const answer = (url) => ({ data: { trackUnion: { canvas: url === undefined ? null : { url, type: "VIDEO_LOOPING" } } } });
  const clip = "https://canvaz.scdn.co/upload/artist/x/video/abc.cnvs.mp4";
  assert.equal(parseCanvasAnswer(answer(clip)), clip);
  assert.equal(parseCanvasAnswer(answer(undefined)), null, "no Canvas");
  assert.equal(parseCanvasAnswer(answer("https://canvaz.scdn.co/upload/artist/x/image/abc.cnvs.jpg")), null, "a still image");
  assert.equal(parseCanvasAnswer(answer("http://canvaz.scdn.co/abc.cnvs.mp4")), null, "https only");
});

test("Canvas: canvaz-cache's protobuf, both ways, with the scan for renumbered fields", () => {
  const uri = "spotify:track:0VjIjW4GlUZAMYd2vXMi3b";
  const bytes = (s) => [...new TextEncoder().encode(s)];
  assert.deepEqual([...canvazRequest(uri)], [0x0a, uri.length + 2, 0x0a, uri.length, ...bytes(uri)]);

  const ld = (field, body) => [(field << 3) | 2, body.length, ...body];
  const canvas = (url, track, urlField = 2) => ld(1, [...ld(1, bytes("id")), 0x18, 0x01, ...ld(urlField, bytes(url)), ...ld(5, bytes(track))]);
  const mine = "https://canvaz.scdn.co/upload/a/video/mine.cnvs.mp4";
  const other = "https://canvaz.scdn.co/upload/a/video/other.cnvs.mp4";
  assert.equal(canvazClip(Uint8Array.from([...canvas(other, "spotify:track:other"), ...canvas(mine, uri)]), uri), mine, "the asked track's own clip");
  assert.equal(canvazClip(Uint8Array.from(canvas(other, "spotify:track:other")), uri), other, "else the first");
  assert.equal(canvazClip(Uint8Array.from(canvas(mine, uri, 7)), uri), mine, "a renumbered url field is still found");
  assert.equal(canvazClip(Uint8Array.from(canvas("https://canvaz.scdn.co/a/image/x.cnvs.jpg", uri)), uri), null, "a still image");
  assert.equal(canvazClip(Uint8Array.from([0x0a, 0x01, 0x00]), uri), null, "the empty answer a logged-out token gets");
  assert.equal(canvazClip(Uint8Array.from(canvas(mine, uri).slice(0, 20)), uri), null, "truncated, without throwing");
});
