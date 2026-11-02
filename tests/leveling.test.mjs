import test from "node:test";
import assert from "node:assert/strict";
import { boot, flushMicrotasks, play, setAnalysis, track } from "./automix-harness.mjs";

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
