import test from "node:test";
import assert from "node:assert/strict";
import { parsePlaylistFile, playlistToJson, playlistToM3u8, youtubePlaylistLink } from "../.test-build/playlist-share.mjs";

const songs = [
  { id: "dQw4w9WgXcQ", title: "Never", artist: "Rick", duration: 213, thumb: "", album: "Whenever" },
  { id: "local:abc", title: "Mine", artist: "Me", duration: 100, thumb: "", localPath: "C:\\Users\\me\\a.mp3" },
  { id: "9bZkp7q19f0", title: "Gangnam\nStyle", artist: "PSY", duration: 0, thumb: "" },
];

test("a playlist exported as M3U8 or JSON imports back the same songs, never local paths", () => {
  const m3u = playlistToM3u8("Road Trip", songs);
  assert.ok(!m3u.includes("local:") && !m3u.includes("C:\\"), "local files stay out");
  const fromM3u = parsePlaylistFile(m3u, "fallback");
  assert.equal(fromM3u.name, "Road Trip");
  assert.deepEqual(fromM3u.tracks.map((t) => [t.id, t.artist, t.title, t.duration]), [
    ["dQw4w9WgXcQ", "Rick", "Never", 213],
    ["9bZkp7q19f0", "PSY", "Gangnam Style", 0],
  ]);
  const json = playlistToJson("Road Trip", songs);
  assert.ok(!json.includes("localPath") && !json.includes("local:"));
  const fromJson = parsePlaylistFile(json, "fallback");
  assert.equal(fromJson.name, "Road Trip");
  assert.deepEqual(fromJson.tracks.map((t) => [t.id, t.album ?? null]), [
    ["dQw4w9WgXcQ", "Whenever"],
    ["9bZkp7q19f0", null],
  ]);
});

test("other players' playlists import their YouTube links and count the rest", () => {
  const foreign = [
    "#EXTM3U",
    "#EXTINF:180,Someone - Song",
    "https://youtu.be/dQw4w9WgXcQ",
    "#EXTINF:200,Local Thing",
    "C:\\Music\\track.mp3",
    "https://www.youtube.com/watch?v=9bZkp7q19f0&list=x",
  ].join("\r\n");
  const out = parsePlaylistFile(foreign, "My File");
  assert.equal(out.name, "My File");
  assert.deepEqual(out.tracks.map((t) => t.id), ["dQw4w9WgXcQ", "9bZkp7q19f0"]);
  assert.equal(out.skipped, 1);
  assert.deepEqual(parsePlaylistFile("{not json", "x").tracks, []);
  assert.equal(youtubePlaylistLink("VLPLabc"), "https://music.youtube.com/playlist?list=PLabc");
});

test("a shared file can't flood the library: 5000 songs at most, sane text and lengths", () => {
  const ids = Array.from({ length: 5001 }, (_, i) => `id${String(i).padStart(9, "0")}`);
  const big = JSON.stringify({ format: "bytune-playlist", name: "Huge", tracks: ids.map((id) => ({ id, title: "t", artist: "a", duration: 1e999 })) });
  const out = parsePlaylistFile(big, "x");
  assert.equal(out.tracks.length, 5000);
  assert.equal(out.skipped, 1);
  assert.equal(out.tracks[0].duration, 0, "Infinity is not a length");
  const long = parsePlaylistFile(`#EXTM3U\n#EXTINF:100,${"A".repeat(20000)} - Song\nhttps://youtu.be/dQw4w9WgXcQ\n`, "x");
  assert.equal(long.tracks[0].artist.length, 300);
});
