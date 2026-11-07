import test from "node:test";
import assert from "node:assert/strict";
import { analyseBuffer, analyseInSlices, analyseTrack, peekAnalysis } from "../.test-build/analysis.mjs";
import { analyseBuffer as reference } from "./fixtures/analysis-reference.mjs";

/** Stereo click track: a decaying 2 kHz burst on every beat, between a silent lead-in and tail. */
function clickTrack({ sr = 22050, bpm = 128, lead = 1.3, beats = 80, tail = 2 } = {}) {
  const burst = Math.round(sr * 0.025);
  const clicks = Array.from({ length: beats }, (_, k) => Math.round((lead + (k * 60) / bpm) * sr));
  const left = new Float32Array(clicks[beats - 1] + burst + Math.round(tail * sr));
  for (const at of clicks) {
    for (let i = 0; i < burst; i++) left[at + i] = 0.9 * Math.exp(-i / (sr * 0.004)) * Math.sin((2 * Math.PI * 2000 * i) / sr);
  }
  return { channels: [left, left.slice()], sr, first: clicks[0] / sr, last: clicks[beats - 1] / sr };
}

/** Stereo 1 kHz sine. */
function sine(sr, seconds = 5, amp = 0.2) {
  const left = Float32Array.from({ length: Math.round(sr * seconds) }, (_, i) => amp * Math.sin((2 * Math.PI * 1000 * i) / sr));
  return [left, left.slice()];
}

/** Seeded noise "music" on a beat, with optional silent edges; mono on request. */
function music(sr, seconds, seed, { head = 0, tail = 0, mono = false } = {}) {
  let s = seed;
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const n = Math.round(sr * seconds);
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  const beat = Math.round((sr * 60) / (90 + 60 * rnd()));
  for (let i = Math.round(head * sr); i < n - Math.round(tail * sr); i++) {
    l[i] = (rnd() - 0.5) * 0.5 * ((i % beat) < sr * 0.05 ? 1 : 0.25) + 0.1 * Math.sin(i * 0.05);
    r[i] = l[i] * 0.8 + (rnd() - 0.5) * 0.05;
  }
  return mono ? [l] : [l, r];
}

test("click track: silent edges, intro/outro tempo and their beat anchors", () => {
  const t = clickTrack();
  const a = analyseBuffer(t.channels, t.sr);
  assert.ok(Math.abs(a.head - 1.3) < 0.05, `head ${a.head}`);
  assert.ok(Math.abs(a.tail - 2) < 0.05, `tail ${a.tail}`);
  assert.ok(a.intro && Math.abs(a.intro.bpm - 128) < 1, `intro ${JSON.stringify(a.intro)}`);
  assert.ok(a.outro && Math.abs(a.outro.bpm - 128) < 1, `outro ${JSON.stringify(a.outro)}`);
  assert.ok(Math.abs(a.intro.at - t.first) < 0.015, `intro.at ${a.intro.at} vs first click ${t.first}`);
  assert.ok(Math.abs(a.outro.at - t.last) < 0.015, `outro.at ${a.outro.at} vs last click ${t.last}`);
});

test("a stereo 1 kHz sine at 0.2 measures -14 LUFS at 48 kHz and 22.05 kHz", () => {
  for (const sr of [48000, 22050]) {
    const a = analyseBuffer(sine(sr), sr);
    assert.ok(Math.abs(a.lufs + 14) <= 0.3, `${sr} Hz: ${a.lufs} LUFS`);
    assert.equal(a.onset, 0, "music from the first sample");
  }
});

test("silence has no loudness, onset or beat grid", () => {
  const zero = new Float32Array(22050 * 30);
  const a = analyseBuffer([zero, zero], 22050);
  assert.equal(a.lufs, null);
  assert.equal(a.onset, null);
  assert.equal(a.intro, null);
  assert.equal(a.outro, null);
});

const BLOCK = 1 << 15;
const buffers = [
  ["click track 128 BPM, 22.05 kHz", clickTrack().channels, 22050],
  ["click track 100 BPM, 11.025 kHz", clickTrack({ sr: 11025, bpm: 100 }).channels, 11025],
  ["click track 170 BPM, 48 kHz", clickTrack({ sr: 48000, bpm: 170, beats: 40 }).channels, 48000],
  ["sine, 48 kHz", sine(48000), 48000],
  ["sine, 22.05 kHz", sine(22050), 22050],
  ["silence", [new Float32Array(22050 * 30), new Float32Array(22050 * 30)], 22050],
  ["music with silent edges", music(22050, 200, 7, { head: 2.2, tail: 3.7 }), 22050],
  ["mono", music(22050, 61, 11, { mono: true }), 22050],
  ["shorter than a second", music(22050, 0.7, 5), 22050],
  ["a length that is no multiple of anything", music(22050, 33.33337, 9, { head: 1 }), 22050],
  ["exactly 20 blocks", music(22050, (BLOCK * 20) / 22050, 13), 22050],
  ["three channels (the third ignored)", [...music(22050, 20, 17), new Float32Array(22050 * 20).fill(0.3)], 22050],
];

test("the sliced analysis matches the 26f6713 analysis bit for bit", async (t) => {
  // Yield through a microtask here: the same slicing and resuming, without waiting on timers.
  let posts = 0;
  globalThis.scheduler = {
    postTask: async (callback, options) => {
      posts++;
      assert.equal(options.priority, "background");
      return callback();
    },
  };
  t.after(() => delete globalThis.scheduler);
  for (const [name, channels, sr] of buffers) {
    const ref = reference(channels, sr);
    assert.deepStrictEqual(analyseBuffer(channels, sr), ref, `${name}: in one go`);
    assert.deepStrictEqual(await analyseInSlices(channels, sr, 0), ref, `${name}: a yield after every step`);
    assert.deepStrictEqual(await analyseInSlices(channels, sr), ref, `${name}: 4 ms slices`);
  }
  // A long one at the long-song rate, in slices only.
  const long = music(11025, 720, 3, { head: 0.4, tail: 9 });
  assert.deepStrictEqual(await analyseInSlices(long, 11025), reference(long, 11025), "12 min at 11.025 kHz");
  assert.ok(posts > 0, "the slices yield through scheduler.postTask");
});

test("a long analysis yields to queued work: a 25 ms timer keeps its pace", async () => {
  // 10 min: analysed in one go it stalls the timer 170-360 ms on a fast machine, well past the bound.
  const channels = music(22050, 600, 1);
  const ticks = [];
  const timer = setInterval(() => ticks.push(performance.now()), 25);
  await new Promise((r) => setTimeout(r, 60));
  await analyseInSlices(channels, 22050);
  await new Promise((r) => setTimeout(r, 60));
  clearInterval(timer);
  const gaps = ticks.slice(1).map((t, i) => t - ticks[i]);
  assert.ok(Math.max(...gaps) < 100, `longest gap between ticks ${Math.max(...gaps).toFixed(0)} ms`);
});

/** A fake response body: `chunks` of `size` bytes (Infinity: never ends). */
function body(size, chunks) {
  const chunk = new Uint8Array(size);
  let sent = 0;
  return {
    getReader: () => ({
      read: async () => (sent++ < chunks ? { done: false, value: chunk } : { done: true, value: undefined }),
    }),
  };
}

test("analyseTrack: one ranged fetch per song, gates before fetching, decode rate follows length, downloads stop at the cap", async () => {
  const fetched = [];
  const rates = [];
  const sizes = {}; // url -> reported Content-Length (null: none reported)
  const streams = {}; // url -> [chunk size, chunk count]
  const failing = new Set();
  const signals = [];
  globalThis.window = {
    addEventListener() {}, // the settings store's persistence registers unload flushes
    bytune: { getStreamUrl: async (id) => `stream:${id}`, localTrackUrl: async (id) => `local:${id}` },
  };
  globalThis.fetch = async (url, init) => {
    fetched.push({ url, range: init?.headers?.Range ?? null });
    signals.push(init?.signal);
    const ok = !failing.has(url);
    failing.delete(url);
    const length = url in sizes ? sizes[url] : 8;
    const [size, count] = streams[url] ?? [8, 1];
    return {
      ok,
      status: ok ? 206 : 500,
      body: body(size, count),
      headers: { get: (h) => (h === "content-length" && length !== null ? String(length) : null) },
    };
  };
  globalThis.OfflineAudioContext = class {
    constructor(channels, length, rate) {
      rates.push(rate);
      this.rate = rate;
    }
    async decodeAudioData() {
      const [l, r] = sine(this.rate, 12);
      return { sampleRate: this.rate, length: l.length, numberOfChannels: 2, getChannelData: (c) => (c ? r : l) };
    }
  };

  const same = await Promise.all([1, 2, 3].map(() => analyseTrack({ id: "a", duration: 240 })));
  assert.equal(fetched.length, 1, "three concurrent calls share one fetch");
  assert.equal(fetched[0].range, "bytes=0-", "a ranged request, as the media element makes (a plain GET is throttled)");
  assert.ok(same[0] && same.every((r) => r === same[0]));
  assert.equal(peekAnalysis("a"), same[0]);
  assert.deepEqual(rates, [22050], "a 4-min song decodes at 22.05 kHz");
  assert.equal(await analyseTrack({ id: "a", duration: 240 }), same[0]);
  assert.equal(await analyseTrack({ id: "a" }), same[0], "a cached analysis answers whatever length is asked with");
  assert.equal(fetched.length, 1, "a cached analysis is never fetched again");

  assert.equal(await analyseTrack({ id: "long", duration: 21 * 60 }), null);
  assert.equal(await analyseTrack({ id: "none", duration: 0 }), null);
  assert.equal(await analyseTrack({ id: "unset" }), null);
  assert.equal(await analyseTrack({ id: "nan", duration: NaN }), null);
  assert.equal(fetched.length, 1, "a song over 20 min, or of unknown length, is never fetched");

  await analyseTrack({ id: "b", duration: 12 * 60 });
  assert.equal(rates.at(-1), 11025, "a 12-min song decodes at 11.025 kHz");

  sizes["stream:huge"] = 200 * 1024 * 1024;
  const decodes = rates.length;
  assert.equal(await analyseTrack({ id: "huge", duration: 300 }), null);
  assert.equal(rates.length, decodes, "an oversized download is never decoded");
  assert.equal(signals.at(-1).aborted, true, "and its request is aborted");

  // No Content-Length and no end: reading stops past 150 MB, the request is aborted, nothing is decoded.
  sizes["stream:endless"] = null;
  streams["stream:endless"] = [8 * 1024 * 1024, Infinity];
  assert.equal(await analyseTrack({ id: "endless", duration: 300 }), null);
  assert.equal(rates.length, decodes, "a capped download is never decoded");
  assert.equal(signals.at(-1).aborted, true, "the capped request is aborted");

  // No Content-Length, but a normal size: read to the end and analysed.
  sizes["stream:chunked"] = null;
  streams["stream:chunked"] = [64 * 1024, 40];
  assert.ok(await analyseTrack({ id: "chunked", duration: 200 }), "a response without a length is still analysed");

  await analyseTrack({ id: "dl", duration: 200, localPath: "C:/Music/dl.m4a" });
  assert.equal(fetched.at(-1).url, "local:dl", "local files go through the local route");

  failing.add("stream:flaky");
  assert.equal(await analyseTrack({ id: "flaky", duration: 200 }), null);
  assert.ok(await analyseTrack({ id: "flaky", duration: 200 }), "a failure is retried, not cached");

  const burst = await Promise.all(["q1", "q2", "q3", "q4", "q5"].map((id) => analyseTrack({ id, duration: 200 })));
  assert.deepEqual(
    burst.map((r) => r !== null),
    [true, false, true, true, true],
    "q1 was already running; q2 lost its place to three newer requests",
  );

  const asks = ["r1", "r2", "r3", "r4", "r2", "r5"].map((id) => analyseTrack({ id, duration: 200 }));
  assert.equal(asks[1], asks[4], "a repeat request shares the pending promise");
  assert.deepEqual(
    (await Promise.all(asks)).map((r) => r !== null),
    [true, true, false, true, true, true],
    "asking again for r2 made it newer than r3, which gave way to r5",
  );
});
