import test from "node:test";
import assert from "node:assert/strict";
import { boot, endedAt, firstSoundAt, flushMicrotasks, play, read, restartedFrom, sounding, startsOf, track } from "./automix-harness.mjs";

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
    // Your order on from the song playing; "a" already played.
    const order = ["a", "b", "c", "d", "e", "f"];
    const k = order.indexOf(playing);
    const onFrom = [...order.slice(k + 1), ...order.slice(0, k)].filter((n) => n !== "a");
    assert.deepEqual(rest.slice(1, -1), onFrom, "the rest in your order, on from the song playing");
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
    assert.deepEqual(p.getState().unshuffled, ["d", "e", "a", "b", "c"], "your order, read from the chosen song");
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
    assert.deepEqual(s.unshuffled, ["b", "c", "d", "e", "f", "a"], "your order, read from the song playing");
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

/* ---------------- shuffle off continues your order (S2) ---------------- */

const order = ["a", "b", "c", "d", "e", "f"];
/** Your order on from `name`, round past the end, without `played`. */
const onFrom = (name, played = []) => {
  const k = order.indexOf(name);
  return [...order.slice(k + 1), ...order.slice(0, k)].filter((n) => !played.includes(n));
};

test("played from d with shuffle on, shuffle off continues e, f, then a, b, c", async () => {
  const h = await boot({ fadeSeconds: 0 });
  try {
    const p = h.engine.usePlayer;
    p.setState({ shuffle: true });
    await play(h, songs(order), 3);
    p.getState().toggleShuffle();
    assert.deepEqual(ids(h), ["d", "e", "f", "a", "b", "c"]);
    p.setState({ shuffle: true });
    await play(h, songs(order), 3);
    p.getState().next(true);
    const second = read(h).id;
    p.getState().toggleShuffle();
    assert.deepEqual(ids(h), ["d", second, ...onFrom(second, ["d"])], "on from the song playing, nothing lost");
    assert.equal(p.getState().index, 1);
  } finally {
    await settle(h);
    h.restore();
  }
});

test("a song dragged to the top of Up next while shuffled stays next when shuffle goes off", async () => {
  const h = await boot({ fadeSeconds: 0 });
  try {
    const p = h.engine.usePlayer;
    await play(h, songs(order), 2);
    p.getState().toggleShuffle();
    // f: the last of your songs, so it is next only because it was dragged there.
    if (ids(h)[3] === "f") p.getState().moveUpcoming(3, 5);
    p.getState().moveUpcoming(ids(h).indexOf("f"), 3); // right after the song playing (c)
    assert.equal(ids(h)[3], "f");
    p.getState().toggleShuffle();
    assert.deepEqual(ids(h), ["a", "b", "c", "f", "d", "e"]);
  } finally {
    await settle(h);
    h.restore();
  }
});

test("a song dragged while shuffled goes right after the song it was dropped after, in your order too", async () => {
  const h = await boot({ fadeSeconds: 0 });
  try {
    const p = h.engine.usePlayer;
    await play(h, songs(order));
    p.getState().toggleShuffle();
    const q = ids(h);
    // Drop the song now third in Up next right after the one now first.
    const dragged = q[3];
    const before = q[1];
    p.getState().moveUpcoming(3, 2);
    assert.deepEqual(ids(h).slice(1, 3), [before, dragged]);
    p.getState().toggleShuffle();
    const rest = ids(h).slice(1);
    assert.equal(rest[rest.indexOf(before) + 1], dragged, "right after it in your order");
    assert.deepEqual([...rest].sort(), ["b", "c", "d", "e", "f"], "nothing lost or doubled");
    assert.deepEqual(rest.filter((n) => n !== dragged), onFrom("a", ["a", dragged]), "the others keep your order");
  } finally {
    await settle(h);
    h.restore();
  }
});

test("Add to queue while shuffled stays after your songs, and a song dragged after it goes with it", async () => {
  const h = await boot({ fadeSeconds: 0 });
  try {
    const p = h.engine.usePlayer;
    await play(h, songs(["a", "b", "c", "d"]));
    p.getState().toggleShuffle();
    p.getState().addToQueue(track("y", 120));
    p.getState().addToQueue(track("z", 120));
    const q = ids(h);
    assert.deepEqual(q.slice(-2), ["y", "z"]);
    const dragged = q[1];
    p.getState().moveUpcoming(1, q.indexOf("y")); // dropped right after y
    p.getState().toggleShuffle();
    assert.deepEqual(ids(h), ["a", ...["b", "c", "d"].filter((n) => n !== dragged), "y", dragged, "z"]);
  } finally {
    await settle(h);
    h.restore();
  }
});

test("a song that played and is added again goes after your songs when shuffle goes off", async () => {
  const h = await boot({ fadeSeconds: 0 });
  try {
    const p = h.engine.usePlayer;
    await play(h, songs(order));
    p.getState().toggleShuffle();
    p.getState().next(true);
    const played = ids(h)[0]; // "a"
    p.getState().addToQueue(track(played, 120));
    p.getState().toggleShuffle();
    assert.equal(ids(h).at(-1), played);
  } finally {
    await settle(h);
    h.restore();
  }
});

test("a song removed while shuffled and added back goes after your songs", async () => {
  const h = await boot({ fadeSeconds: 0 });
  try {
    const p = h.engine.usePlayer;
    await play(h, songs(order));
    p.getState().toggleShuffle();
    const gone = ids(h)[2];
    p.getState().removeAt(2);
    p.getState().addToQueue(track(gone, 120));
    p.getState().toggleShuffle();
    assert.deepEqual(ids(h), ["a", ...onFrom("a", ["a", gone]), gone]);
  } finally {
    await settle(h);
    h.restore();
  }
});

test("a song queued twice keeps both of its places when shuffle goes off", async () => {
  const h = await boot({ fadeSeconds: 0 });
  try {
    const p = h.engine.usePlayer;
    const list = ["a", "b", "x", "c", "x", "d"];
    p.setState({ shuffle: true });
    await play(h, songs(list), 0);
    p.getState().toggleShuffle();
    assert.deepEqual(ids(h), list);
    p.setState({ shuffle: true });
    await play(h, songs(list), 4); // from the second x
    p.getState().toggleShuffle();
    assert.deepEqual(ids(h), ["x", "d", "a", "b", "x", "c"]);
  } finally {
    await settle(h);
    h.restore();
  }
});

test("Play next on the song playing while shuffled stays next when shuffle goes off", async () => {
  const h = await boot({ fadeSeconds: 0 });
  try {
    const p = h.engine.usePlayer;
    p.setState({ shuffle: true });
    await play(h, songs(order), 2);
    p.getState().addToQueue(track("c", 120), true);
    p.getState().toggleShuffle();
    assert.deepEqual(ids(h), ["c", "c", ...onFrom("c")]);
  } finally {
    await settle(h);
    h.restore();
  }
});

test("with a suggestion playing, the songs you add and drag keep their order when shuffle goes off", async () => {
  const h = await boot({ fadeSeconds: 0 });
  try {
    const p = h.engine.usePlayer;
    p.setState({ shuffle: true });
    await play(h, songs(["a", "b"]));
    p.getState().appendAutoplay(songs(["s1", "s2", "s3"]));
    p.getState().jumpTo(2); // s1 plays: your order doesn't hold it
    p.getState().addToQueue(track("y", 120));
    p.getState().addToQueue(track("z", 120));
    p.getState().addToQueue(track("w", 120), true);
    assert.deepEqual(ids(h).slice(2), ["s1", "w", "y", "z", "s2", "s3"]);
    p.getState().moveUpcoming(5, 3); // z to the top of Up next
    p.getState().toggleShuffle();
    assert.deepEqual(ids(h).slice(2), ["s1", "z", "w", "y", "s2", "s3"], "the suggestions stay last");
    assert.equal(h.engine.autoplayTail(p.getState()), 2);
  } finally {
    await settle(h);
    h.restore();
  }
});

test("shuffle switched on and off over and over keeps your order", async () => {
  const h = await boot({ fadeSeconds: 0 });
  try {
    const p = h.engine.usePlayer;
    await play(h, songs(order), 1);
    for (let i = 0; i < 4; i++) {
      p.getState().toggleShuffle();
      p.getState().toggleShuffle();
      assert.deepEqual(ids(h), order);
    }
    p.getState().toggleShuffle();
    p.getState().next(true);
    const now = read(h).id;
    p.getState().toggleShuffle();
    p.getState().toggleShuffle();
    p.getState().toggleShuffle();
    assert.deepEqual(ids(h).slice(3), onFrom(now, ["a", "b"]));
  } finally {
    await settle(h);
    h.restore();
  }
});

test("a queue saved by an older build turns shuffle off back into your order", async () => {
  const h = await boot({ fadeSeconds: 0 });
  try {
    const p = h.engine.usePlayer;
    globalThis.__storage.getItem = async () => ({
      state: { queue: songs(order), index: 3, shuffle: true, autoplayCount: 0 },
      version: 0,
    });
    await p.persist.rehydrate();
    p.getState().toggleShuffle();
    assert.deepEqual(ids(h), order);
  } finally {
    await settle(h);
    h.restore();
  }
});

/* ---------------- the shuffled repeat-all wrap blends (S1) ---------------- */

test("shuffled repeat-all: upNext names the next pass's first song, and the wrap plays exactly that pass", async () => {
  const h = await boot({ fadeSeconds: 0 });
  try {
    const p = h.engine.usePlayer;
    p.setState({ shuffle: true, repeat: "all" });
    await play(h, songs(["a", "b", "c", "d"]));
    for (let i = 0; i < 3; i++) p.getState().next(true);
    const pass = h.engine.nextPass(p.getState().queue);
    assert.equal(h.engine.upNext(p.getState())?.id, pass[0].id);
    p.getState().next(false);
    assert.deepEqual(ids(h), pass.map((t) => t.id));
    assert.equal(p.getState().index, 0);
  } finally {
    await settle(h);
    h.restore();
  }
});

test("shuffled repeat-all: the last song blends into the next pass's first, which plays on in that pass", async () => {
  const h = await boot({ fadeSeconds: 0.6 });
  try {
    const p = h.engine.usePlayer;
    for (const n of ["a", "b", "c"]) h.setDuration(n, 3);
    // Shuffle on with the last song playing leaves nothing to move: a fixed queue, not a random one.
    await play(h, songs(["a", "b", "c"], 3), 2);
    p.getState().toggleShuffle();
    p.setState({ repeat: "all" });
    await settle(h);
    const last = read(h).id;
    const pass = h.engine.nextPass(p.getState().queue).map((t) => t.id);
    assert.notDeepEqual(pass, ids(h), "precondition: the next pass is a new order, so a wrap that doesn't install it shows");
    const startsBefore = startsOf(h, pass[0]).length;
    h.trace.length = 0;
    (h.elements.emits ?? []).length = 0;
    h.record();
    await h.advance(3500);
    await settle(h);
    assert.ok(firstSoundAt(h, pass[0]) < endedAt(h, last), "the next pass's first came in under the last song");
    assert.deepEqual(ids(h), pass, "that pass, in that order");
    assert.equal(p.getState().index, 0);
    assert.equal(read(h).id, pass[0]);
    assert.equal(restartedFrom(h, pass[0]), false, "promoted, not restarted");
    assert.equal(startsOf(h, pass[0]).length, startsBefore + 1, "started once at the wrap");
  } finally {
    await settle(h);
    h.restore();
  }
});

test("shuffled repeat-all: Next pressed during the wrap's blend lands on the song fading in", async () => {
  const h = await boot({ fadeSeconds: 0.6 });
  try {
    const p = h.engine.usePlayer;
    for (const n of ["a", "b", "c"]) h.setDuration(n, 3);
    p.setState({ shuffle: true, repeat: "all" });
    await play(h, songs(["a", "b", "c"], 3));
    p.getState().next(true);
    p.getState().next(true);
    await settle(h);
    const pass = h.engine.nextPass(p.getState().queue).map((t) => t.id);
    h.trace.length = 0;
    h.record();
    await h.advance(2700); // mid-blend
    assert.ok(firstSoundAt(h, pass[0]) < Infinity, "the next pass's first is fading in");
    p.getState().next(true);
    await settle(h);
    await h.advance(300);
    assert.deepEqual(ids(h), pass);
    assert.equal(read(h).id, pass[0]);
    assert.equal(restartedFrom(h, pass[0]), false);
    assert.equal(sounding(h).length, 1);
  } finally {
    await settle(h);
    h.restore();
  }
});

test("shuffled repeat-all: a song added while the wrap's blend waits plays next instead", async () => {
  const h = await boot({ fadeSeconds: 0.6 });
  try {
    const p = h.engine.usePlayer;
    for (const n of ["a", "b", "c", "n"]) h.setDuration(n, 3);
    p.setState({ shuffle: true, repeat: "all" });
    await play(h, songs(["a", "b", "c"], 3));
    p.getState().next(true);
    p.getState().next(true);
    await settle(h);
    const pass = h.engine.nextPass(p.getState().queue).map((t) => t.id);
    await h.advance(2500);
    p.getState().addToQueue(track("n", 3));
    await h.advance(1000);
    await settle(h);
    assert.equal(read(h).id, "n");
    assert.ok(!sounding(h).some((d) => d.src === `fake:${pass[0]}`), "the called-off blend left nothing sounding");
  } finally {
    await settle(h);
    h.restore();
  }
});

test("shuffled repeat-all over copies of one song plays on at the wrap instead of stalling", async () => {
  const h = await boot({ fadeSeconds: 0.6 });
  try {
    const p = h.engine.usePlayer;
    h.setDuration("A", 2);
    p.setState({ shuffle: true, repeat: "all" });
    await play(h, [track("A", 2), track("A", 2)]);
    p.getState().next(true);
    await settle(h);
    assert.equal(h.engine.upNext(p.getState())?.id, "A", "the same song: no blend into itself");
    await h.advance(2600);
    await settle(h);
    assert.equal(p.getState().index, 0);
    assert.equal(sounding(h).length, 1, "it plays again");
    assert.ok(sounding(h)[0].currentTime < 1, "from the top");
  } finally {
    await settle(h);
    h.restore();
  }
});

test("the next pass never starts with the song that just ended while another song is there", async () => {
  const h = await boot({ fadeSeconds: 0 });
  try {
    for (let n = 0; n < 400; n++) {
      const q = [track("A", 1), track(`x${n}`, 1), track("A", 1)];
      assert.notEqual(h.engine.nextPass(q)[0].id, "A", `[A, x${n}, A]`);
    }
    const copies = [track("A", 1), track("A", 1)];
    assert.equal(h.engine.nextPass(copies), copies, "copies of one song stay as they are");
  } finally {
    await settle(h);
    h.restore();
  }
});

test("nothing is looked ahead under repeat-one, at the end without repeat-all, or on a one-song queue", async () => {
  const h = await boot({ fadeSeconds: 0 });
  try {
    const p = h.engine.usePlayer;
    const s = (over) => ({ queue: songs(["a", "b"]), index: 1, repeat: "off", shuffle: true, ...over });
    assert.equal(h.engine.upNext(s({})), null);
    assert.equal(h.engine.upNext(s({ repeat: "one", index: 0 })), null);
    assert.equal(h.engine.upNext(s({ repeat: "all", queue: songs(["a"]), index: 0 })), null);
    assert.equal(h.engine.upNext(s({ repeat: "all", shuffle: false }))?.id, "a");
    assert.equal(p.getState().finishBlend("nope", 1), false);
  } finally {
    await settle(h);
    h.restore();
  }
});

test("shuffle on and off with an empty queue, and after the last song is removed", async () => {
  const h = await boot({ fadeSeconds: 0 });
  try {
    const p = h.engine.usePlayer;
    p.getState().toggleShuffle();
    p.getState().toggleShuffle();
    assert.deepEqual(p.getState().queue, []);
    p.getState().playQueue([track("a", 60)]);
    p.getState().toggleShuffle();
    p.getState().removeAt(0);
    p.getState().addToQueue(track("b", 60), true);
    p.getState().toggleShuffle();
    assert.deepEqual(p.getState().queue.map((t) => t.id), ["b"]);
  } finally {
    for (let i = 0; i < 10; i++) await flushMicrotasks(4);
    h.restore();
  }
});
