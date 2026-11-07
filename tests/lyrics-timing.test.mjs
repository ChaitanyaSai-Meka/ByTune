import test from "node:test";
import assert from "node:assert/strict";
import { boot } from "./automix-harness.mjs";

test("a song's lyrics nudge moves in steps, drops at zero and stays within limits", async () => {
  const h = await boot({ fadeSeconds: 0 });
  try {
    const { nextNudges, describeLyricsShift } = h.engine;
    let n = nextNudges({}, "song", 0.25);
    n = nextNudges(n, "song", 0.25);
    assert.deepEqual(n, { song: 0.5 });
    assert.equal(describeLyricsShift(n.song), "0.5 s later");
    assert.equal(describeLyricsShift(-1), "1 s earlier");
    assert.equal(describeLyricsShift(0), "In sync");
    assert.deepEqual(nextNudges(n, "song", -0.5), {}, "back to zero forgets the song");
    assert.deepEqual(nextNudges({}, "far", 99), { far: 10 }, "capped at 10 s");
  } finally {
    h.restore();
  }
});

test("only the latest 500 songs keep their nudge", async () => {
  const h = await boot({ fadeSeconds: 0 });
  try {
    const { nextNudges } = h.engine;
    let n = {};
    for (let i = 0; i < 501; i++) n = nextNudges(n, `s${i}`, 0.25);
    assert.equal(Object.keys(n).length, 500);
    assert.equal(n.s0, undefined, "the oldest went first");
    n = nextNudges(n, "s1", 0.25);
    assert.equal(Object.keys(n).at(-1), "s1", "touching a song makes it the newest");
  } finally {
    h.restore();
  }
});
