/**
 * The canvas lookup (electron/canvas.ts): how Apple's search hits are scored, and how an
 * Apple motion clip's HLS playlists lead to the one MP4 file a <video> can play.
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const require = createRequire(import.meta.url);

/** canvas.ts with its relative imports (music-service, spotify) stubbed out: they pull in the app. */
async function load() {
  const { outputFiles } = await build({
    entryPoints: [fileURLToPath(new URL("../electron/canvas.ts", import.meta.url))],
    bundle: true, platform: "node", format: "cjs", write: false,
    plugins: [{ name: "stub", setup(b) {
      b.onResolve({ filter: /^\.\.?\// }, (a) => ({ path: a.path, namespace: "stub" }));
      b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: "module.exports = {};", loader: "js" }));
    } }],
  });
  fs.mkdirSync(".test-build", { recursive: true });
  const outfile = path.resolve(".test-build", "canvas.cjs");
  fs.writeFileSync(outfile, outputFiles[0].text);
  return require(outfile);
}
const { appleScore, hlsVariant, hlsSingleFile } = await load();

test("Apple: the artist is a gate, the title and album score, compilations are out", () => {
  const hit = (name, artistName, albumName) => ({ name, artistName, albumName });
  const want = ["Blinding Lights", "The Weeknd", "After Hours"];
  assert.equal(appleScore(hit("Blinding Lights", "The Weeknd", "After Hours (Deluxe)"), ...want), 45);
  assert.equal(appleScore(hit("Blinding Lights", "The Weeknd", "After Hours"), "Blinding Lights", "The Weeknd"), 25, "no album known");
  assert.equal(appleScore(hit("Blinding Lights", "Someone Else", "After Hours"), ...want), null, "another artist's");
  assert.equal(appleScore(hit("Blinding Lights", "The Weeknd", "Today's Hits (DJ Mix)"), ...want), null, "a mix");
  assert.equal(appleScore(hit("Blinding Lights (Mixed)", "The Weeknd", "After Hours"), ...want), null);
  assert.ok(appleScore(hit("Blinding Lights (Remix)", "The Weeknd", "After Hours"), ...want) < 45, "a remix ranks below the original");
  assert.equal(appleScore(hit("Save Your Tears", "The Weeknd", "After Hours"), ...want), 20, "same album, another song: the title check stops it later");
  assert.equal(appleScore(hit("Daylight", "David Kushner", "Daylight - Single"), "Daylight", "David Kushner", "Daylight"), 45, "Apple's ' - Single'");
  assert.equal(
    appleScore(hit("Señorita", "Shawn Mendes & Camila Cabello", "Señorita - Single"), "Senorita", "Camila Cabello, Shawn Mendes", "Senorita"),
    45,
    "accents, and credits in any order"
  );
});

const MASTER = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=2615203,CODECS="avc1.640020",RESOLUTION=1080x1080,URI="https://cdn.example/iframes.m3u8"
#EXT-X-STREAM-INF:AVERAGE-BANDWIDTH=2125654,BANDWIDTH=2499558,CODECS="avc1.64001f",RESOLUTION=768x768
https://cdn.example/a/clip_768.m3u8
#EXT-X-STREAM-INF:AVERAGE-BANDWIDTH=1859556,BANDWIDTH=2177387,CODECS="hvc1.2.20000000.L123.B0",RESOLUTION=1080x1080
https://cdn.example/a/clip_hevc_1080.m3u8
#EXT-X-STREAM-INF:AVERAGE-BANDWIDTH=6622443,BANDWIDTH=8385793,CODECS="avc1.640020",RESOLUTION=1080x1080
https://cdn.example/a/clip_1080_high.m3u8
#EXT-X-STREAM-INF:AVERAGE-BANDWIDTH=3897254,BANDWIDTH=4635000,CODECS="avc1.640020",RESOLUTION=1080x1080
clip_1080_low.m3u8
`;

test("Apple's HLS: the H.264 rendition with the most pixels, at its lowest rate", () => {
  assert.equal(hlsVariant(MASTER, "https://cdn.example/a/master.m3u8"), "https://cdn.example/a/clip_1080_low.m3u8");
  assert.equal(hlsVariant(MASTER.replace(/avc1/g, "hvc1"), "https://cdn.example/a/master.m3u8"), null, "HEVC only");
  assert.equal(hlsVariant("#EXTM3U\n", "https://cdn.example/m.m3u8"), null);
});

test("Apple's HLS: one fragmented MP4 in byte ranges is the file a <video> plays", () => {
  const media = `#EXTM3U
#EXT-X-TARGETDURATION:5
#EXT-X-MAP:URI="clip_1080-.mp4",BYTERANGE="896@0"
#EXTINF:4.56667,
#EXT-X-BYTERANGE:1383327@896
clip_1080-.mp4
#EXTINF:3.86667,
#EXT-X-BYTERANGE:1038188@1384223
clip_1080-.mp4
#EXT-X-ENDLIST
`;
  const base = "https://cdn.example/a/clip_1080_low.m3u8";
  assert.equal(hlsSingleFile(media, base), "https://cdn.example/a/clip_1080-.mp4");
  assert.equal(hlsSingleFile(media.replace(/^clip_1080-\.mp4$/m, "seg1.m4s"), base), null, "separate segment files");
  assert.equal(hlsSingleFile(media.replace(/#EXT-X-MAP.*\n/, ""), base), null, "no init segment");
  assert.equal(hlsSingleFile(media, "http://cdn.example/a/x.m3u8"), null, "https only");
});
