/**
 * Stream resolution in electron/music-service.ts, with its cache, its client rotation and the real
 * rendition picker (audio-format.ts), plus the download queue (downloads.ts) on top of it. InnerTube,
 * the PO token, the market and the local library are stubs; googlevideo is a fake fetch.
 * Each test loads a fresh copy of the modules, so caches and the preferred client start clean.
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const require = createRequire(import.meta.url);
const ID = "dQw4w9WgXcQ";
const OTHER = "kJQP7kiw5Fk";
// itag → the file YouTube offers for it
const FORMATS = {
  251: { mime_type: 'audio/webm; codecs="opus"', bitrate: 151105, content_length: "4000000" },
  140: { mime_type: 'audio/mp4; codecs="mp4a.40.2"', bitrate: 130613, content_length: "3000000" },
  141: { mime_type: 'audio/mp4; codecs="mp4a.40.2"', bitrate: 256000, content_length: "9000000" },
};

let code = null;
async function load({ offered = [251, 140], localTracks = {} } = {}) {
  code ??= build({
    stdin: {
      contents: `export * as music from "./electron/music-service"; export * as downloads from "./electron/downloads";`,
      resolveDir: fileURLToPath(new URL("..", import.meta.url)),
      sourcefile: "stream-resolve-entry.ts",
      loader: "ts",
    },
    bundle: true, platform: "node", format: "cjs", write: false,
    external: ["electron", "youtubei.js", "./po-token", "./market", "./local-library", "./lyrics", "./artwork", "./ytm"],
  }).then((r) => r.outputFiles[0].text);
  const s = { offered, calls: [], fetched: [], n: 0 };
  const yt = {
    session: { context: { client: { visitorData: "visitor", gl: "US", hl: "en" } } },
    // One InnerTube answer per call; every URL is new, so a body fetched shows which answer it came from.
    getBasicInfo: async (videoId, { client }) => {
      s.calls.push(`${videoId} ${client}`);
      const n = ++s.n;
      return {
        playability_status: { status: "OK" },
        streaming_data: {
          adaptive_formats: s.offered.map((itag) => ({ itag, has_audio: true, has_video: false, url: `https://gv.invalid/${videoId}/${itag}?n=${n}`, ...FORMATS[itag] })),
        },
      };
    },
  };
  const stubs = {
    electron: { app: { getLocaleCountryCode: () => "US", getLocale: () => "en-US", isPackaged: true, getPath: () => os.tmpdir() } },
    "youtubei.js": { Innertube: { create: async () => yt } },
    "./po-token": { getPoToken: async () => "po", invalidatePoToken() {} },
    "./market": { resolveMarket: () => ({ country: "US", source: "test" }) },
    "./local-library": { localTrackById: (id) => localTracks[id] ?? null },
    "./lyrics": {},
    "./artwork": {},
    "./ytm": {},
  };
  const module = { exports: {} };
  vm.runInNewContext(await code, {
    module, exports: module.exports, URL, AbortController, AbortSignal, setTimeout, clearTimeout, Buffer,
    console: { log() {}, warn() {} },
    process: { env: {} },
    // googlevideo: the probe and the downloads read a few bytes of whatever URL they were given
    fetch: async (url) => {
      s.fetched.push(String(url));
      return new Response(new Uint8Array([1, 2, 3]), { status: 206 });
    },
    require: (name) => stubs[name] ?? require(name),
  });
  return { ...module.exports, s };
}

test("retryStream drops the song's cached renditions and starts from the next client", async () => {
  const { music, s } = await load();
  const first = await music.resolveStream(ID);
  assert.equal(first.itag, 251, "Opus 251 is the best on offer");
  await music.resolveStream(ID);
  assert.deepEqual(s.calls, [`${ID} VISIONOS`], "cached: a seek asks InnerTube nothing");

  s.offered = [251, 140, 141]; // 256k AAC appears, and it outranks 251
  const healed = await music.resolveStream(ID, true);
  assert.equal(healed.itag, 251, "a refresh (the proxy's 403 heal) keeps the file the player opened");

  music.retryStream(ID);
  const retried = await music.resolveStream(ID);
  assert.equal(s.calls.length, 3, "the cached rendition is gone");
  assert.equal(s.calls.at(-1), `${ID} IOS`, "a retry starts from the next client");
  assert.equal(retried.itag, 141, "with nothing pinned it may take the best file again");
});

test("retryStream forgets every variant of that song and nothing of the others", async () => {
  const { music, s } = await load();
  await music.resolveStream(ID); // playback
  await music.resolveStream(ID, false, 64); // the low-quality setting
  await music.resolveStream(OTHER);
  assert.equal(s.calls.length, 3);
  music.retryStream(ID);
  await music.resolveStream(OTHER);
  assert.equal(s.calls.length, 3, "another song keeps its cached URL");
  await music.resolveStream(ID);
  await music.resolveStream(ID, false, 64);
  assert.equal(s.calls.length, 5, "both of the song's variants resolve again");
});

test("a download always resolves a fresh URL, even when an earlier download cached one", async () => {
  const { downloads, s } = await load();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bytune-dl-fresh-"));
  try {
    const done = [];
    downloads.addDownloadListener((e) => {
      if (e.type === "done" || e.type === "failed") done.push(e);
    });
    const finished = async (count) => {
      for (let i = 0; i < 200 && done.length < count; i++) await new Promise((r) => setTimeout(r, 5));
      assert.equal(done.length, count, "the download finished");
      assert.equal(done.at(-1).type, "done", done.at(-1).reason);
    };
    const track = { id: ID, title: "Song", artist: "Artist", duration: 200, thumb: "" };
    downloads.enqueueDownload(track, dir);
    await finished(1);
    downloads.enqueueDownload(track, dir); // the same song again, minutes later
    await finished(2);
    assert.equal(s.calls.length, 2, "the second download asked InnerTube again");
    assert.equal(s.fetched.at(-1), `https://gv.invalid/${ID}/140?n=2`, "and fetched the new URL, not the cached one");
    assert.ok(s.fetched.every((u) => u.includes("/140?")), "downloads take the mp4 rendition");
    assert.deepEqual(fs.readdirSync(dir).sort(), ["Artist - Song (1).m4a", "Artist - Song.m4a"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("localGainDb reads the scanned ReplayGain, and 0 dB is a real value", async () => {
  const { music } = await load({ localTracks: { "local:a": { gainDb: -6.5 }, "local:zero": { gainDb: 0 }, "local:untagged": {} } });
  assert.equal(music.localGainDb("local:a"), -6.5);
  assert.equal(music.localGainDb("local:zero"), 0, "a file already at the reference level");
  assert.equal(music.localGainDb("local:untagged"), null, "no tag: the renderer measures instead");
  assert.equal(music.localGainDb("local:missing"), null);
});
