// The shuffled repeat-all wrap, beyond tests/shuffle.test.mjs: a next pass that starts with the
// old first song must still be installed, and turning shuffle off during the wrap's blend cancels it.
import test from "node:test";
import assert from "node:assert/strict";
import { boot, decksOf, endedAt, firstSoundAt, flushMicrotasks, play, read, restartedFrom, sounding, track } from "./automix-harness.mjs";

const ids = (h) => h.engine.usePlayer.getState().queue.map((t) => t.id);

async function settle(h, rounds = 20) {
  for (let i = 0; i < rounds; i++) await flushMicrotasks(4);
}

/** Three 3 s songs, in your order, whose next pass satisfies `want(pass ids, queue ids)`. */
function threeSongs(h, want) {
  for (let n = 0; n < 500; n++) {
    const q = [`a${n}`, `b${n}`, `c${n}`].map((id) => track(id, 3));
    if (want(h.engine.nextPass(q).map((t) => t.id), q.map((t) => t.id))) return q;
  }
  assert.fail("no such queue");
}

/** Play `q` on its last song, then turn on shuffle and repeat-all without reordering it. */
async function onLastSong(h, q) {
  for (const t of q) h.setDuration(t.id, 3.0);
  await play(h, q, 2);
  h.engine.usePlayer.setState({ shuffle: true, repeat: "all", unshuffled: q.map((t) => t.id) });
}

test("a next pass that starts with the old first song still takes its new order", async () => {
  const h = await boot();
  try {
    const q = threeSongs(h, (pass, old) => pass[0] === old[0] && pass.join() !== old.join());
    await onLastSong(h, q);
    await h.advance(3500);
    await settle(h);
    assert.equal(read(h).id, q[0].id);
    assert.ok(firstSoundAt(h, q[0].id) < endedAt(h, q[2].id), "blended in under the end of the last song");
    assert.deepEqual(ids(h), h.engine.nextPass(q).map((t) => t.id), "reordered, not just rewound to index 0");
    assert.equal(h.engine.usePlayer.getState().index, 0);
    assert.equal(restartedFrom(h, q[0].id), false, "promoted, not restarted");
    assert.equal(sounding(h).length, 1);
    assert.equal(globalThis.__media.at(-1)?.title, q[0].id, "the OS flyout follows the wrap");
  } finally {
    await settle(h);
    h.restore();
  }
});

test("turning shuffle off during the wrap's blend cancels it, and the wrap follows your order", async () => {
  const h = await boot();
  try {
    const q = threeSongs(h, (pass, old) => pass[0] !== old[0]);
    const pass = h.engine.nextPass(q).map((t) => t.id);
    await onLastSong(h, q);
    while (!decksOf(h, pass[0]).some((d) => d.currentTime > 0.1)) await h.advance(20);
    h.engine.usePlayer.getState().toggleShuffle();
    await flushMicrotasks();
    assert.equal(sounding(h).filter((d) => d.src === `fake:${pass[0]}`).length, 0, "the called-off song stops");
    await h.advance(800);
    await settle(h);
    assert.equal(read(h).id, q[0].id, "your first song, not the next pass's");
    assert.deepEqual(ids(h), q.map((t) => t.id), "your order, no next pass");
    assert.equal(sounding(h).length, 1);
  } finally {
    await settle(h);
    h.restore();
  }
});
