/**
 * Reading a pasted list or a CSV export into songs to match (src/lib/importSongs.ts), and telling
 * a Spotify link from a list.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const mod = build({
  entryPoints: [fileURLToPath(new URL("../src/lib/importSongs.ts", import.meta.url))],
  bundle: true, platform: "node", format: "esm", write: false,
}).then((r) => import(`data:text/javascript;base64,${Buffer.from(r.outputFiles[0].text).toString("base64")}`));

test("pasted lines: Artist - Title, a bare title, numbering and bullets", async () => {
  const { parseSongList } = await mod;
  assert.deepEqual(parseSongList("Tame Impala - Loser\r\n2. Coldplay – Yellow\n• Sid Sriram — Samajavaragamana\n\n# a note\nClarity\n"), [
    { artist: "Tame Impala", title: "Loser", duration: 0 },
    { artist: "Coldplay", title: "Yellow", duration: 0 },
    { artist: "Sid Sriram", title: "Samajavaragamana", duration: 0 },
    { artist: "", title: "Clarity", duration: 0 },
  ]);
  assert.deepEqual(parseSongList("Jay-Z - 99 Problems"), [{ artist: "Jay-Z", title: "99 Problems", duration: 0 }], "a hyphen inside a name isn't the separator");
  assert.deepEqual(parseSongList("   \n\n"), []);
});

test("an Exportify CSV: quoted cells, several artists, milliseconds", async () => {
  const { parseSongList } = await mod;
  const csv = [
    '"Track URI","Track Name","Artist URI(s)","Artist Name(s)","Album Name","Disc Number","Track Number","Track Duration (ms)"',
    '"spotify:track:1","Loser","spotify:artist:a","Tame Impala","Deadbeat","1","3","223069"',
    '"spotify:track:2","Kesariya (From ""Brahmastra"")","spotify:artist:b;spotify:artist:c","Pritam;Arijit Singh","Kesariya, the album","1","1","268000"',
  ].join("\n");
  assert.deepEqual(parseSongList(csv), [
    { title: "Loser", artist: "Tame Impala", album: "Deadbeat", duration: 223 },
    { title: 'Kesariya (From "Brahmastra")', artist: "Pritam, Arijit Singh", album: "Kesariya, the album", duration: 268 },
  ]);
});

test("a TuneMyMusic-style CSV with a m:ss length, and a CSV without a title column reads as lines", async () => {
  const { parseSongList } = await mod;
  assert.deepEqual(parseSongList("Track name,Artist name,Album,Duration\nYellow,Coldplay,Parachutes,4:26\n"), [
    { title: "Yellow", artist: "Coldplay", album: "Parachutes", duration: 266 },
  ]);
  // No recognised header: each line is a song ("Artist - Title" or a bare title).
  assert.deepEqual(parseSongList("Hello, Goodbye\nThe Beatles - Let It Be"), [
    { artist: "", title: "Hello, Goodbye", duration: 0 },
    { artist: "The Beatles", title: "Let It Be", duration: 0 },
  ]);
});

test("Spotify links are told apart from song lists", async () => {
  const { isSpotifyLink } = await mod;
  assert.equal(isSpotifyLink(" https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M?si=x "), true);
  assert.equal(isSpotifyLink("https://spotify.link/AbC123xyz"), true);
  assert.equal(isSpotifyLink("spotify:playlist:37i9dQZF1DXcBWIGoYBM5M"), true);
  assert.equal(isSpotifyLink("https://open.spotify.com/playlist/x\nColdplay - Yellow"), false, "a list that starts with a link is a list");
  assert.equal(isSpotifyLink("Coldplay - Yellow"), false);
});
