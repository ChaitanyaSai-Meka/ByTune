import test from "node:test";
import assert from "node:assert/strict";
import { boot, endedAt, firstSoundAt, flushMicrotasks, play, read, sounding, startsOf, track } from "./automix-harness.mjs";

const ids = (h) => h.engine.usePlayer.getState().queue.map((t) => t.id);
const songs = (names, seconds = 120) => names.map((n) => track(n, seconds));

async function settle(h, rounds = 20) {
  for (let i = 0; i < rounds; i++) await flushMicrotasks(4);
}

test("shuffle mixes only your upcoming songs: what played, the song playing and AutoPlay's suggestions stay put", async () => {
  const h = await boot({ fadeSeconds: 0 });
  try {
    const p = h.engine.usePlayer;
    await play(h, songs(["a", "b", "c", "d", "e", "f", "g", "h"]), 2);
    p.getState().appendAutoplay(songs(["s1", "s2"]));
    p.getState().toggleShuffle();
    const q = ids(h);
    assert.deepEqual(q.slice(0, 3), ["a", "b", "c"]);
    assert.equal(p.getState().index, 2);
    assert.deepEqual([...q.slice(3, 8)].sort(), ["d", "e", "f", "g", "h"]);
    assert.deepEqual(q.slice(8), ["s1", "s2"]);
    assert.equal(h.engine.autoplayTail(p.getState()), 2);
  } finally {
    await settle(h);
    h.restore();
  }
});

test("shuffled, the queue is the play order: Next walks it and Previous walks back", async () => {
  const h = await boot({ fadeSeconds: 0 });
  try {
    const p = h.engine.usePlayer;
    await play(h, songs(["a", "b", "c", "d", "e"]));
    p.getState().toggleShuffle();
    const order = ids(h);
    const seen = [read(h).id];
    for (let i = 0; i < 4; i++) {
      p.getState().next(true);
      seen.push(read(h).id);
    }
    assert.deepEqual(seen, order);
    for (let i = 3; i >= 0; i--) {
      p.getState().prev();
      assert.equal(read(h).id, order[i], "Previous retraces what played");
    }
  } finally {
    await settle(h);
    h.restore();
  }
});

test("shuffle off puts what's left back in your order; Play next stays next, Add to queue stays after", async () => {
  const h = await boot({ fadeSeconds: 0 });
  try {
    const p = h.engine.usePlayer;
    await play(h, songs(["a", "b", "c", "d", "e", "f"]));
    p.getState().toggleShuffle();
    p.getState().next(true);
    const playing = read(h).id;
    p.getState().addToQueue(track("x", 120), true);
    p.getState().addToQueue(track("y", 120));
    p.getState().toggleShuffle();
    const q = ids(h);
    const i = p.getState().index;
    assert.equal(q[i], playing, "the song playing stays");
    const rest = q.slice(i + 1);
    assert.equal(rest[0], "x", "Play next while shuffled stays next");
    assert.equal(rest.at(-1), "y", "Add to queue while shuffled stays after");
    assert.deepEqual(rest.slice(1, -1), ["b", "c", "d", "e", "f"].filter((n) => n !== playing), "the rest in your order");
    assert.equal(p.getState().unshuffled, null);
  } finally {
    await settle(h);
    h.restore();
  }
});

test("playing a list with shuffle on starts on the chosen song and shuffles the rest", async () => {
  const h = await boot({ fadeSeconds: 0 });
  try {
    const p = h.engine.usePlayer;
    p.setState({ shuffle: true });
    await play(h, songs(["a", "b", "c", "d", "e"]), 3);
    const q = ids(h);
    assert.equal(p.getState().index, 0);
    assert.equal(q[0], "d");
    assert.deepEqual([...q.slice(1)].sort(), ["a", "b", "c", "e"]);
    assert.deepEqual(p.getState().unshuffled, ["a", "b", "c", "d", "e"]);
  } finally {
    await settle(h);
    h.restore();
  }
});

test("a shuffled repeat-all queue starts each pass in a new order, never with the song that just ended", async () => {
  const h = await boot({ fadeSeconds: 0 });
  try {
    const p = h.engine.usePlayer;
    p.setState({ shuffle: true, repeat: "all" });
    await play(h, songs(["a", "b", "c", "d"]));
    for (let i = 0; i < 3; i++) p.getState().next(true);
    assert.equal(p.getState().index, 3);
    const last = read(h).id;
    const expected = h.engine.nextPass(p.getState().queue).map((t) => t.id);
    assert.deepEqual(h.engine.nextPass(p.getState().queue).map((t) => t.id), expected, "the next pass is known ahead");
    p.getState().next(true);
    assert.equal(p.getState().index, 0);
    assert.deepEqual(ids(h), expected);
    assert.notEqual(read(h).id, last);
    assert.deepEqual([...ids(h)].sort(), ["a", "b", "c", "d"]);
  } finally {
    await settle(h);
    h.restore();
  }
});

test("shuffle doesn't stop blends: the last of your songs crossfades into AutoPlay's first", async () => {
  const h = await boot({ fadeSeconds: 0.6 });
  try {
    const p = h.engine.usePlayer;
    h.setDuration("a", 3.0);
    h.setDuration("s1", 4.0);
    h.setDuration("s2", 4.0);
    p.setState({ shuffle: true });
    await play(h, [track("a", 3.0)]);
    p.getState().appendAutoplay([track("s1", 4.0), track("s2", 4.0)]);
    await h.advance(2900);
    assert.ok(firstSoundAt(h, "s1") < endedAt(h, "a"), "the blend into the first suggestion starts before a ends");
    assert.equal(firstSoundAt(h, "s2"), Infinity);
  } finally {
    await settle(h);
    h.restore();
  }
});

test("a queue saved with shuffle on by an older build is shuffled once on load", async () => {
  const h = await boot({ fadeSeconds: 0 });
  try {
    const p = h.engine.usePlayer;
    globalThis.__storage.getItem = async () => ({
      state: { queue: songs(["a", "b", "c", "d", "e", "f"]), index: 1, shuffle: true, autoplayCount: 0 },
      version: 0,
    });
    await p.persist.rehydrate();
    const s = p.getState();
    assert.deepEqual(s.queue.slice(0, 2).map((t) => t.id), ["a", "b"], "what played and the song playing stay");
    assert.deepEqual([...s.queue.slice(2).map((t) => t.id)].sort(), ["c", "d", "e", "f"]);
    assert.deepEqual(s.unshuffled, ["a", "b", "c", "d", "e", "f"]);
    const order = s.queue.map((t) => t.id);
    globalThis.__storage.getItem = async () => ({
      state: { queue: s.queue, index: 1, shuffle: true, unshuffled: s.unshuffled, autoplayCount: 0 },
      version: 0,
    });
    await p.persist.rehydrate();
    assert.deepEqual(ids(h), order, "saved with its order: no second shuffle");
  } finally {
    await settle(h);
    h.restore();
  }
});

test("Play next on the playing song plays it again from the top, then moves on", async () => {
  const h = await boot({ fadeSeconds: 0 });
  try {
    const p = h.engine.usePlayer;
    h.setDuration("A", 2);
    h.setDuration("B", 60);
    await play(h, [track("A", 2), track("B", 60)]);
    p.getState().addToQueue(track("A", 2), true);
    assert.deepEqual(ids(h), ["A", "A", "B"]);
    await h.advance(2600);
    await settle(h);
    assert.equal(p.getState().index, 1);
    assert.equal(startsOf(h, "A").length, 2, "a second play of A");
    assert.equal(sounding(h).length, 1, "one deck sounding");
    assert.ok(sounding(h)[0].currentTime < 1, "from the top");
    await h.advance(2600);
    await settle(h);
    assert.equal(read(h).id, "B");
  } finally {
    await settle(h);
    h.restore();
  }
});

test("a second copy of a song restarts it, and never blends into itself", async () => {
  const h = await boot({ fadeSeconds: 0.6 });
  try {
    const p = h.engine.usePlayer;
    h.setDuration("A", 3.0);
    await play(h, [track("A", 3.0), track("A", 3.0), track("B", 4.0)]);
    await h.advance(2800);
    assert.equal(sounding(h).length, 1, "no blend into its own copy");
    await h.advance(700);
    await settle(h);
    assert.equal(p.getState().index, 1);
    assert.ok(sounding(h)[0].currentTime < 1, "the copy plays from the top");
    p.getState().jumpTo(0);
    await settle(h);
    await h.advance(300);
    assert.equal(p.getState().index, 0);
    assert.ok(sounding(h)[0].currentTime < 1, "jumping back to the other copy restarts it too");
  } finally {
    await settle(h);
    h.restore();
  }
});
