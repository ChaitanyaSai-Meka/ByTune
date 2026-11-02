import test from "node:test";
import assert from "node:assert/strict";
import { analyseBuffer, analyseTrack, peekAnalysis } from "../.test-build/analysis.mjs";

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

test("analyseTrack: one fetch per song, gates before fetching, decode rate follows length", async () => {
  const fetched = [];
  const rates = [];
  const sizes = {}; // url -> reported Content-Length
  const failing = new Set();
  globalThis.window = {
    addEventListener() {}, // the settings store's persistence registers unload flushes
    bytune: { getStreamUrl: async (id) => `stream:${id}`, localTrackUrl: async (id) => `local:${id}` },
  };
  globalThis.fetch = async (url) => {
    fetched.push(url);
    const ok = !failing.has(url);
    failing.delete(url);
    return {
      ok,
      body: { cancel: async () => {} },
      headers: { get: (h) => (h === "content-length" ? String(sizes[url] ?? 1e6) : null) },
      arrayBuffer: async () => new ArrayBuffer(8),
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
  assert.ok(same[0] && same.every((r) => r === same[0]));
  assert.equal(peekAnalysis("a"), same[0]);
  assert.deepEqual(rates, [22050], "a 4-min song decodes at 22.05 kHz");
  assert.equal(await analyseTrack({ id: "a", duration: 240 }), same[0]);
  assert.equal(fetched.length, 1, "a cached analysis is never fetched again");

  assert.equal(await analyseTrack({ id: "long", duration: 21 * 60 }), null);
  assert.equal(fetched.length, 1, "a song over 20 min is never fetched");

  await analyseTrack({ id: "b", duration: 12 * 60 });
  assert.equal(rates.at(-1), 11025, "a 12-min song decodes at 11.025 kHz");

  sizes["stream:huge"] = 200 * 1024 * 1024;
  const decodes = rates.length;
  assert.equal(await analyseTrack({ id: "huge", duration: 300 }), null);
  assert.equal(rates.length, decodes, "an oversized download is never decoded");

  await analyseTrack({ id: "dl", duration: 200, localPath: "C:/Music/dl.m4a" });
  assert.equal(fetched.at(-1), "local:dl", "local files go through the local route");

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
