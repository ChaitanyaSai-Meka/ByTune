import test from "node:test";
import assert from "node:assert/strict";
import { boot, flushMicrotasks, play, track } from "./automix-harness.mjs";

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
