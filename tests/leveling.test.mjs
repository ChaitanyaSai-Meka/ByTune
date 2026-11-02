import test from "node:test";
import assert from "node:assert/strict";
import { boot, endedAt, firstSoundAt, flushMicrotasks, play, read, setAnalysis, track } from "./automix-harness.mjs";

const live = (h, id) => h.elements.find((e) => e.src === `fake:${id}` && !e.paused);

test("volume leveling levels change the playing volume; Off plays as mastered", async () => {
  const h = await boot({ fadeSeconds: 0 });
  try {
    h.setDuration("song", 200);
    await play(h, [track("song", 200)]);
    await h.advance(500);
    const normal = live(h, "song").volume; // unknown loudness: assumed -9 LUFS → -14
    h.engine.useSettings.setState({ loudnessLevel: "off" });
    await flushMicrotasks(4);
    const off = live(h, "song").volume;
    assert.ok(Math.abs(normal / off - Math.pow(10, -5 / 20)) < 0.01, `normal is ~5 dB under off (${normal} vs ${off})`);
    h.engine.useSettings.setState({ loudnessLevel: "quiet" });
    await flushMicrotasks(4);
    assert.ok(live(h, "song").volume < normal, "quiet is quieter than normal");
    h.engine.useSettings.setState({ loudnessLevel: "loud" });
    await flushMicrotasks(4);
    const loud = live(h, "song").volume;
    assert.ok(loud > normal && loud <= off, "loud sits between normal and off");
  } finally {
    h.restore();
  }
});

/** The playing deck's level under Normal leveling, in dB against leveling off. */
async function levelDb(h, id) {
  const normal = live(h, id).volume;
  h.engine.useSettings.setState({ loudnessLevel: "off" });
  await flushMicrotasks(4);
  const off = live(h, id).volume;
  h.engine.useSettings.setState({ loudnessLevel: "normal" });
  await flushMicrotasks(4);
  return 20 * Math.log10(normal / off);
}

test("a stream YouTube reports no loudness for (Piped) levels to its measurement", async () => {
  const h = await boot({ fadeSeconds: 0 });
  try {
    globalThis.__lufs = { p: null };
    setAnalysis("p", { lufs: -8 });
    h.setDuration("p", 200);
    await play(h, [track("p", 200)]);
    await h.advance(500);
    assert.ok(Math.abs((await levelDb(h, "p")) - -6) < 0.1, "measured -8 LUFS plays 6 dB down to -14");
  } finally {
    h.restore();
  }
});

test("YouTube's reported loudness wins over a measurement", async () => {
  const h = await boot({ fadeSeconds: 0, skipSilence: true });
  try {
    globalThis.__lufs = { y: -10 };
    setAnalysis("y", { lufs: -6 });
    h.setDuration("y", 200);
    await play(h, [track("y", 200)]);
    await h.advance(500);
    assert.ok(Math.abs((await levelDb(h, "y")) - -4) < 0.1, "reported -10 LUFS, not the measured -6");
  } finally {
    h.restore();
  }
});

test("a local file levels by its ReplayGain tag, or by a measurement when it has none", async () => {
  const h = await boot({ fadeSeconds: 0 });
  try {
    globalThis.__gainDb = { "local:tagged": -4 };
    setAnalysis("local:untagged", { lufs: -8 });
    h.setDuration("local:untagged", 200);
    h.setDuration("local:tagged", 200);
    await play(h, [track("local:untagged", 200)]);
    await h.advance(500);
    assert.ok(Math.abs((await levelDb(h, "local:untagged")) - -6) < 0.1, "measured -8 LUFS");
    await play(h, [track("local:tagged", 200)]);
    await h.advance(500);
    assert.ok(Math.abs(await levelDb(h, "local:tagged")) < 0.1, "ReplayGain -4 dB means -14 LUFS: no change");
  } finally {
    h.restore();
  }
});

test("a song's silent head is skipped only with Skip silence on", async () => {
  const off = await boot({ fadeSeconds: 0 });
  try {
    setAnalysis("s", { head: 2.0 });
    off.setDuration("s", 200);
    await play(off, [track("s", 200)]);
    await off.advance(300);
    assert.ok(live(off, "s").currentTime < 1, "no trim with Skip silence off");
  } finally {
    off.restore();
  }
  const on = await boot({ fadeSeconds: 0, skipSilence: true });
  try {
    setAnalysis("s", { head: 2.0 });
    on.setDuration("s", 200);
    await play(on, [track("s", 200)]);
    await on.advance(300);
    assert.ok(live(on, "s").currentTime >= 2, "trimmed with it on");
  } finally {
    on.restore();
  }
});

/* ------------- a level that lands on a song being heard glides ------------- */

/** The deck's volume every 25 ms for `ms`. */
async function sample(h, id, ms) {
  const out = [];
  for (let t = 0; t < ms; t += 25) {
    await h.advance(25);
    out.push(h.elements.find((e) => e.src === `fake:${id}`)?.volume ?? NaN);
  }
  return out;
}
const largestStep = (v) => v.slice(1).reduce((m, x, i) => Math.max(m, Math.abs(x - v[i])), 0);

test("a local file whose measurement fails keeps the fallback level, and its next play measures it", async () => {
  const h = await boot({ fadeSeconds: 0 });
  try {
    h.setDuration("local:x", 200);
    h.setDuration("B", 200);
    await play(h, [track("local:x", 200)]); // no ReplayGain, and the analysis fails
    await h.advance(500);
    assert.ok(Math.abs((await levelDb(h, "local:x")) - -5) < 0.1, "the -9 LUFS fallback, as for a stream (not its own level)");
    await play(h, [track("B", 200)]);
    await h.advance(300);
    setAnalysis("local:x", { lufs: -8 });
    await play(h, [track("local:x", 200)]);
    await h.advance(500);
    assert.ok(Math.abs((await levelDb(h, "local:x")) - -6) < 0.1, "measured on the next play: -8 LUFS plays 6 dB down");
  } finally {
    h.restore();
  }
});

test("a measurement that lands while a song plays glides there instead of stepping", async () => {
  const h = await boot({ fadeSeconds: 0 });
  try {
    h.setDuration("local:y", 200);
    setAnalysis("local:y", { lufs: -20 }); // quieter than -14: plays untouched (gain 1)
    globalThis.__analysisDelay = { "local:y": 3000 };
    await play(h, [track("local:y", 200)]);
    const v = await sample(h, "local:y", 6000);
    const fallback = 0.8 * Math.pow(10, -5 / 20);
    assert.ok(Math.abs(v[110] - fallback) < 1e-3, `the fallback until the measurement lands (${v[110]})`);
    assert.ok(Math.abs(v.at(-1) - 0.8) < 1e-9, `the measured level at the end (${v.at(-1)})`);
    assert.ok(largestStep(v) < 0.03 * (0.8 - fallback), `no step: largest 25 ms change ${largestStep(v)}`);
    const reached = v.findIndex((x) => Math.abs(x - 0.8) < 1e-9) * 25;
    assert.ok(reached >= 4800 && reached <= 5200, `about 2 s from landing to the new level (${reached} ms)`);
  } finally {
    h.restore();
  }
});

test("a level that lands before the song is heard applies at once", async () => {
  const h = await boot({ fadeSeconds: 0 });
  try {
    globalThis.__gainDb = { "local:t": -4 }; // ReplayGain: -14 LUFS, no attenuation
    globalThis.__lufs = { s: -8 }; // YouTube's report: 6 dB down
    for (const [id, want] of [["local:t", 0.8], ["s", 0.8 * Math.pow(10, -6 / 20)]]) {
      h.setDuration(id, 200);
      await play(h, [track(id, 200)]);
      const v = await sample(h, id, 100);
      assert.ok(Math.abs(v[0] - want) < 1e-9, `${id} starts at its level (${v[0]} vs ${want})`);
    }
  } finally {
    h.restore();
  }
});

test("the volume slider moves at once during a glide, and the glide carries on", async () => {
  const h = await boot({ fadeSeconds: 0 });
  try {
    h.setDuration("local:y", 200);
    setAnalysis("local:y", { lufs: -20 });
    globalThis.__analysisDelay = { "local:y": 1000 };
    await play(h, [track("local:y", 200)]);
    await h.advance(2000); // half way along the glide
    const before = live(h, "local:y").volume;
    h.engine.usePlayer.getState().setVolume(0.4);
    await flushMicrotasks(4);
    const after = live(h, "local:y").volume;
    assert.ok(Math.abs(after / before - 0.5) < 0.02, `halved at once (${before} -> ${after})`);
    await h.advance(1500);
    assert.ok(Math.abs(live(h, "local:y").volume - 0.4) < 1e-9, "and the glide ends at the new volume times the measured level");
  } finally {
    h.restore();
  }
});

test("changing the leveling setting during a glide applies at once, with nothing gliding on", async () => {
  const h = await boot({ fadeSeconds: 0 });
  try {
    h.setDuration("local:y", 200);
    setAnalysis("local:y", { lufs: -20 });
    globalThis.__analysisDelay = { "local:y": 1000 };
    await play(h, [track("local:y", 200)]);
    await h.advance(2000); // half way along the glide
    assert.ok(live(h, "local:y").volume < 0.79, "still gliding");
    h.engine.useSettings.setState({ loudnessLevel: "off" });
    await flushMicrotasks(4);
    assert.ok(Math.abs(live(h, "local:y").volume - 0.8) < 1e-9, `as mastered at once (${live(h, "local:y").volume})`);
    const v = await sample(h, "local:y", 500);
    assert.ok(v.every((x) => Math.abs(x - 0.8) < 1e-9), "and it stays there");
  } finally {
    h.restore();
  }
});

test("a measurement that lands mid-blend rides the blend's curve without a step", async () => {
  const h = await boot({ fadeSeconds: 2 });
  try {
    h.setDuration("A", 6.0);
    h.setDuration("local:z", 60);
    setAnalysis("local:z", { lufs: -20 });
    globalThis.__analysisDelay = { "local:z": 4500 }; // lands about a second into the blend
    await play(h, [track("A", 6.0), track("local:z", 60)]);
    const v = await sample(h, "local:z", 7000);
    const blend = v.filter((x) => x > 0);
    assert.ok(blend.length > 40, "the incoming deck was heard");
    // The fade alone moves at most v * sin'(theta) per tick: 0.8 * (pi/2) * 25/2000 ≈ 0.0157.
    assert.ok(largestStep(v) < 0.03, `no step on top of the fade: largest 25 ms change ${largestStep(v)}`);
    assert.ok(Math.abs(v.at(-1) - 0.8) < 1e-9, "the promoted song ends at its measured level");
  } finally {
    h.restore();
  }
});

// A repeat change makes another song next without touching the queue, so nothing warms it ahead:
// the blend itself must look up a local file's ReplayGain, as it does a stream's loudness.
for (const [name, before, start, after] of [
  ["repeat-all turned on during the last song", [], 2, ["cycleRepeat"]],
  ["shuffle and repeat-all turned on during the last song", [], 2, ["toggleShuffle", "cycleRepeat"]],
  ["repeat-one turned off", ["cycleRepeat", "cycleRepeat"], 0, ["cycleRepeat"]],
]) {
  test(`a local song blended into after ${name} plays at its ReplayGain level`, async () => {
    const h = await boot({ fadeSeconds: 1 });
    try {
      const p = h.engine.usePlayer;
      const ids = ["local:a", "local:b", "local:c"];
      globalThis.__gainDb = Object.fromEntries(ids.map((id) => [id, -4])); // ReplayGain: -14 LUFS, plays untouched
      for (const id of ids) h.setDuration(id, 6);
      for (const action of before) p.getState()[action]();
      await play(h, ids.map((id) => track(id, 6)), start); // loaded with nothing next to warm
      await h.advance(500);
      for (const action of after) p.getState()[action]();
      const from = read(h).id;
      const to = h.engine.upNext(p.getState()).id;
      await h.advance(7000);
      assert.equal(read(h).id, to);
      assert.ok(firstSoundAt(h, to) < endedAt(h, from), "blended in, not reloaded");
      assert.ok(Math.abs(live(h, to).volume - 0.8) < 1e-9, `${to} plays at its level, not the fallback (${live(h, to).volume})`);
    } finally {
      h.restore();
    }
  });
}
