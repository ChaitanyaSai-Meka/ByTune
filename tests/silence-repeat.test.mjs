// Skip silence ends a song at its silent tail: repeat, the sleep timer and moving on must behave
// there exactly as they do when the song reaches its natural end.
import test from "node:test";
import assert from "node:assert/strict";
import { boot, flushMicrotasks, play, read, setAnalysis, track } from "./automix-harness.mjs";

async function settle(h, rounds = 20) {
  for (let i = 0; i < rounds; i++) await flushMicrotasks(4);
}
const live = (h, id) => h.elements.find((e) => e.src === `fake:${id}` && !e.paused);

test("with Skip silence and repeat-one, the song repeats at its silent tail instead of moving on", async () => {
  const h = await boot({ fadeSeconds: 0, skipSilence: true });
  try {
    const p = h.engine.usePlayer;
    for (const id of ["a", "b"]) h.setDuration(id, 20);
    setAnalysis("a", { tail: 5 }); // sound ends at 15 s
    await play(h, [track("a", 20), track("b", 20)]);
    p.setState({ repeat: "one" });
    await h.advance(16_000);
    await settle(h);
    assert.equal(read(h).id, "a", "still on a");
    assert.ok(live(h, "a")?.currentTime < 2, `a started over at its silent tail (${live(h, "a")?.currentTime})`);
    await h.advance(15_000);
    await settle(h);
    assert.equal(read(h).id, "a", "and again on the next pass");
    assert.ok(live(h, "a")?.currentTime < 2, `a started over again (${live(h, "a")?.currentTime})`);
    assert.equal(live(h, "b"), undefined, "b never played");
  } finally {
    await settle(h);
    h.restore();
  }
});

test("with Skip silence and no repeat, the silent tail still moves on to the next song", async () => {
  const h = await boot({ fadeSeconds: 0, skipSilence: true });
  try {
    for (const id of ["a", "b"]) h.setDuration(id, 20);
    setAnalysis("a", { tail: 5 });
    await play(h, [track("a", 20), track("b", 20)]);
    await h.advance(16_000);
    await settle(h);
    assert.equal(read(h).id, "b");
    assert.ok(live(h, "b")?.currentTime < 2, "b plays from its start");
  } finally {
    await settle(h);
    h.restore();
  }
});
