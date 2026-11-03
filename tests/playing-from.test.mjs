import test from "node:test";
import assert from "node:assert/strict";
import { boot, flushMicrotasks, track } from "./automix-harness.mjs";

const songs = (names) => names.map((n) => track(n, 120));

test("the sidebar marks the row a queue was started from, until AutoPlay's suggestions or something else takes over", async () => {
  const h = await boot({ fadeSeconds: 0 });
  try {
    const p = h.engine.usePlayer;
    const row = () => h.engine.playingFromRow(p.getState());
    p.getState().playQueue(songs(["a", "b"]), 0, "pl1");
    assert.equal(row(), "pl1");
    p.getState().toggle();
    assert.equal(row(), null, "paused: no moving bars");
    p.getState().toggle();
    p.getState().appendAutoplay(songs(["s1"]));
    p.getState().jumpTo(2);
    assert.equal(row(), null, "an AutoPlay suggestion isn't the playlist's");
    p.getState().appendAutoplay(songs(["s2"]));
    p.getState().toggleShuffle();
    p.getState().toggleShuffle();
    assert.equal(row(), null, "a refill or shuffle after AutoPlay took over doesn't bring it back");
    p.getState().playQueue(songs(["c"]), 0);
    assert.equal(p.getState().playingFrom, null, "a queue started elsewhere has no row");
    p.getState().playQueue(songs(["d", "e"]), 0, "__liked__");
    p.getState().playTrack(track("x", 120));
    assert.equal(p.getState().playingFrom, null, "playing one song from elsewhere ends it");
  } finally {
    for (let i = 0; i < 20; i++) await flushMicrotasks(4);
    h.restore();
  }
});
