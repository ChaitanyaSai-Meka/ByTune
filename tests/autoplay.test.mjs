import test from "node:test";
import assert from "node:assert/strict";
import { boot, flushMicrotasks, play, read, track } from "./automix-harness.mjs";

/** YouTube-shaped ids (11 characters): only those have a radio. */
const Y = (name) => name.padEnd(11, "_");
const yt = (name, seconds) => track(Y(name), seconds);

/** A radio page of distinct artists, so per-artist caps don't trim the test data. */
const page = (names, next = null) => ({
  tracks: names.map((n) => ({ ...yt(n, 180), title: `Song ${n}`, artist: `Artist ${n}`, videoType: "song" })),
  next,
  seed: { artist: "Test" },
});

async function settle(h, rounds = 30) {
  for (let i = 0; i < rounds; i++) await flushMicrotasks(4);
}

const ids = (h) => h.engine.usePlayer.getState().queue.map((t) => t.id.replace(/_+$/, ""));
const tail = (h) => h.engine.autoplayTail(h.engine.usePlayer.getState());

test("a song played on its own gets its radio queued right after it", async () => {
  const h = await boot({ autoplay: true, fadeSeconds: 0 });
  try {
    const calls = [];
    globalThis.__radio = async (id, token) => {
      calls.push([id, token ?? null]);
      return page(["r1", "r2", "r3", "r4", "r5", "r6"], "tok1");
    };
    h.setDuration(Y("seed"), 30);
    await play(h, [yt("seed", 30)]);
    await settle(h);
    assert.deepEqual(calls[0], [Y("seed"), null]);
    assert.deepEqual(ids(h), ["seed", "r1", "r2", "r3", "r4", "r5", "r6"]);
    assert.equal(tail(h), 6);
    assert.equal(read(h).id?.replace(/_+$/, ""), "seed", "queuing suggestions never restarts or changes the song playing");
  } finally {
    await settle(h);
    h.restore();
  }
});

test("when the song ends, the first suggestion plays with no stop", async () => {
  const h = await boot({ autoplay: true, fadeSeconds: 0 });
  try {
    globalThis.__radio = async () => page(["r1", "r2", "r3", "r4", "r5", "r6"]);
    h.setDuration(Y("seed"), 2);
    h.setDuration(Y("r1"), 120);
    await play(h, [yt("seed", 2)]);
    await settle(h);
    await h.advance(2600);
    await settle(h);
    assert.equal(read(h).id?.replace(/_+$/, ""), "r1");
    assert.equal(read(h).playing, true);
  } finally {
    await settle(h);
    h.restore();
  }
});

test("Next at the end waits for AutoPlay instead of stopping or wrapping, then plays what it found", async () => {
  const h = await boot({ autoplay: true, fadeSeconds: 0 });
  try {
    let answer = page([]);
    globalThis.__radio = async () => answer;
    h.setDuration(Y("seed"), 60);
    h.setDuration(Y("r1"), 120);
    await play(h, [yt("seed", 60)]);
    await settle(h);
    assert.deepEqual(ids(h), ["seed"], "nothing found yet");
    answer = page(["r1", "r2"]);
    h.engine.usePlayer.getState().next(true);
    assert.equal(h.engine.usePlayer.getState().awaitingAutoplay, true);
    await settle(h);
    assert.equal(read(h).id?.replace(/_+$/, ""), "r1");
    assert.equal(read(h).playing, true);
    assert.equal(h.engine.usePlayer.getState().awaitingAutoplay, false);
  } finally {
    await settle(h);
    h.restore();
  }
});

test("with nothing to find, the queue stops at its end instead of waiting forever", async () => {
  const h = await boot({ autoplay: true, fadeSeconds: 0 });
  try {
    globalThis.__radio = async () => page([]);
    globalThis.__home = [];
    h.setDuration(Y("seed"), 60);
    await play(h, [yt("seed", 60)]);
    await settle(h);
    h.engine.usePlayer.getState().next(false);
    await settle(h);
    const s = h.engine.usePlayer.getState();
    assert.equal(s.awaitingAutoplay, false);
    assert.equal(s.playing, false);
    assert.equal(read(h).id?.replace(/_+$/, ""), "seed");
  } finally {
    await settle(h);
    h.restore();
  }
});

test("a late answer for a song you moved past is dropped", async () => {
  const h = await boot({ autoplay: true, fadeSeconds: 0 });
  try {
    let release;
    const gate = new Promise((r) => (release = r));
    globalThis.__radio = async (id) => {
      if (id === Y("aaa")) {
        await gate;
        return page(["fromA1", "fromA2"]);
      }
      return page(["fromB1", "fromB2"]);
    };
    h.setDuration(Y("aaa"), 60);
    h.setDuration(Y("bbb"), 60);
    await play(h, [yt("aaa", 60)]);
    await settle(h, 5);
    await play(h, [yt("bbb", 60)]);
    release();
    await settle(h);
    await h.advance(300);
    await settle(h);
    assert.ok(!ids(h).some((id) => id.startsWith("fromA")), `A's radio leaked into B's queue: ${ids(h)}`);
    assert.deepEqual(ids(h), ["bbb", "fromB1", "fromB2"]);
  } finally {
    await settle(h);
    h.restore();
  }
});

test("Add to queue and Play next go before the suggestions; Clear keeps the suggestions", async () => {
  const h = await boot({ autoplay: true, fadeSeconds: 0 });
  try {
    globalThis.__radio = async () => page(["r1", "r2", "r3", "r4", "r5", "r6"]);
    h.setDuration(Y("seed"), 60);
    await play(h, [yt("seed", 60)]);
    await settle(h);
    const p = h.engine.usePlayer.getState();
    p.addToQueue(yt("mine", 60));
    assert.deepEqual(ids(h).slice(0, 3), ["seed", "mine", "r1"]);
    h.engine.usePlayer.getState().addToQueue(yt("soon", 60), true);
    assert.deepEqual(ids(h).slice(0, 4), ["seed", "soon", "mine", "r1"]);
    assert.equal(tail(h), 6);
    h.engine.usePlayer.getState().clearUpcoming();
    assert.deepEqual(ids(h), ["seed", "r1", "r2", "r3", "r4", "r5", "r6"]);
  } finally {
    await settle(h);
    h.restore();
  }
});

test("Don't play this removes a suggestion; jumping to one plays it in place", async () => {
  const h = await boot({ autoplay: true, fadeSeconds: 0 });
  try {
    globalThis.__radio = async () => page(["r1", "r2", "r3", "r4", "r5", "r6"]);
    h.setDuration(Y("seed"), 60);
    h.setDuration(Y("r4"), 60);
    await play(h, [yt("seed", 60)]);
    await settle(h);
    h.engine.dontPlay(2);
    assert.deepEqual(ids(h), ["seed", "r1", "r3", "r4", "r5", "r6"]);
    assert.equal(tail(h), 5);
    h.engine.usePlayer.getState().jumpTo(3);
    await settle(h);
    assert.equal(read(h).id?.replace(/_+$/, ""), "r4");
    assert.deepEqual(ids(h).slice(0, 6), ["seed", "r1", "r3", "r4", "r5", "r6"], "jumping never rebuilds the queue");
  } finally {
    await settle(h);
    h.restore();
  }
});

test("turning AutoPlay off, or repeat on, removes the suggestions", async () => {
  const h = await boot({ autoplay: true, fadeSeconds: 0 });
  try {
    globalThis.__radio = async () => page(["r1", "r2", "r3", "r4", "r5", "r6"]);
    h.setDuration(Y("seed"), 60);
    await play(h, [yt("seed", 60)]);
    await settle(h);
    h.engine.useSettings.getState().setAutoplay(false);
    assert.deepEqual(ids(h), ["seed"]);
    h.engine.useSettings.getState().setAutoplay(true);
    await settle(h);
    assert.equal(tail(h), 6, "switching it back on refills");
    h.engine.usePlayer.getState().cycleRepeat();
    assert.equal(h.engine.usePlayer.getState().repeat, "all");
    assert.deepEqual(ids(h), ["seed"]);
  } finally {
    await settle(h);
    h.restore();
  }
});

test("Previous on the first song wraps to your last song, never a suggestion", async () => {
  const h = await boot({ autoplay: false, fadeSeconds: 0 });
  try {
    const { usePlayer } = h.engine;
    await play(h, [track("a", 60), track("b", 60)]);
    usePlayer.getState().appendAutoplay([track("s1", 60), track("s2", 60)]);
    usePlayer.getState().prev();
    assert.equal(read(h).id?.replace(/_+$/, ""), "b");
  } finally {
    await settle(h);
    h.restore();
  }
});

test("a long session keeps 100 played songs and never touches the one playing", async () => {
  const h = await boot({ autoplay: false, fadeSeconds: 0 });
  try {
    const { usePlayer } = h.engine;
    const many = Array.from({ length: 150 }, (_, i) => track(`t${i}`, 200));
    await play(h, many, 140);
    usePlayer.setState({ position: 42 });
    usePlayer.getState().appendAutoplay([track("next1", 200)]);
    const s = usePlayer.getState();
    assert.equal(s.queue.length, 111);
    assert.equal(s.queue[s.index].id, "t140");
    assert.equal(s.index, 100);
    assert.equal(s.position, 42);
    assert.equal(h.engine.autoplayTail(s), 1);
  } finally {
    await settle(h);
    h.restore();
  }
});

test("playing a song on an empty queue plays it (it used to land on an empty slot)", async () => {
  const h = await boot({ autoplay: false, fadeSeconds: 0 });
  try {
    h.setDuration(Y("solo"), 60);
    h.engine.usePlayer.getState().playTrack(yt("solo", 60));
    await settle(h);
    const s = h.engine.usePlayer.getState();
    assert.deepEqual(ids(h), ["solo"]);
    assert.equal(s.index, 0);
    assert.equal(read(h).playing, true);
    assert.ok(h.elements.some((e) => e.src === `fake:${Y("solo")}` && !e.paused));
  } finally {
    await settle(h);
    h.restore();
  }
});

test("a crossfade into a song that also sits earlier in the queue lands on the later copy", async () => {
  const h = await boot({ autoplay: false, fadeSeconds: 0.6 });
  try {
    h.setDuration("x", 10);
    h.setDuration("a", 5);
    await play(h, [track("x", 10), track("a", 5), track("x", 10)], 1);
    await h.advance(6500);
    await settle(h);
    assert.equal(h.engine.usePlayer.getState().index, 2, "the index must not jump back to the first copy");
  } finally {
    await settle(h);
    h.restore();
  }
});

test("a suggestion whose stream is dead is skipped to the next one", async () => {
  const h = await boot({ autoplay: true, fadeSeconds: 0 });
  try {
    globalThis.__radio = async () => page(["r1", "r2", "r3", "r4", "r5", "r6"]);
    globalThis.__failIds = new Set([Y("r1")]);
    h.setDuration(Y("seed"), 2);
    h.setDuration(Y("r2"), 120);
    await play(h, [yt("seed", 2)]);
    await settle(h);
    await h.advance(2600);
    await settle(h);
    assert.equal(read(h).id?.replace(/_+$/, ""), "r2");
    assert.equal(read(h).playing, true);
  } finally {
    await settle(h);
    h.restore();
  }
});

/* ---------------- review findings ---------------- */

const short = (h) => read(h).id?.replace(/_+$/, "");

test("songs added while a suggestion plays are yours, and survive AutoPlay switching off", async () => {
  const h = await boot({ autoplay: true, fadeSeconds: 0 });
  try {
    globalThis.__radio = async () => page(["r1", "r2", "r3", "r4", "r5", "r6"]);
    h.setDuration(Y("seed"), 2);
    h.setDuration(Y("r1"), 120);
    await play(h, [yt("seed", 2)]);
    await settle(h);
    await h.advance(2600);
    await settle(h);
    assert.equal(short(h), "r1");
    h.engine.usePlayer.getState().addToQueue(yt("mine", 60));
    assert.deepEqual(ids(h).slice(0, 3), ["seed", "r1", "mine"]);
    h.engine.useSettings.getState().setAutoplay(false);
    assert.deepEqual(ids(h), ["seed", "r1", "mine"], "only the suggestions go; the added song stays");
  } finally {
    await settle(h);
    h.restore();
  }
});

test("a song added while the next suggestion fades in plays next instead of being skipped", async () => {
  const h = await boot({ autoplay: true, fadeSeconds: 0.6 });
  try {
    globalThis.__radio = async () => page(["r1", "r2", "r3", "r4", "r5", "r6"]);
    h.setDuration(Y("seed"), 3);
    for (const n of ["r1", "r2", "mine"]) h.setDuration(Y(n), 120);
    await play(h, [yt("seed", 3)]);
    await settle(h);
    await h.advance(2550);
    h.engine.usePlayer.getState().addToQueue(yt("mine", 120));
    await h.advance(1500);
    await settle(h);
    assert.equal(short(h), "mine");
    assert.equal(read(h).playing, true);
  } finally {
    await settle(h);
    h.restore();
  }
});

test("removing the suggestion that is fading in moves on to the next one", async () => {
  const h = await boot({ autoplay: true, fadeSeconds: 0.6 });
  try {
    globalThis.__radio = async () => page(["r1", "r2", "r3", "r4", "r5", "r6"]);
    h.setDuration(Y("seed"), 3);
    for (const n of ["r1", "r2"]) h.setDuration(Y(n), 120);
    await play(h, [yt("seed", 3)]);
    await settle(h);
    await h.advance(2550);
    h.engine.dontPlay(1);
    await h.advance(1500);
    await settle(h);
    assert.equal(short(h), "r2");
    assert.equal(read(h).playing, true, "never left 'playing' over silence");
    assert.ok(!h.elements.some((e) => e.src === `fake:${Y("r1")}` && !e.paused), "the removed song is not left sounding");
  } finally {
    await settle(h);
    h.restore();
  }
});

test("Don't play this also keeps out another upload of the same song", async () => {
  const h = await boot({ autoplay: true, fadeSeconds: 0 });
  try {
    let call = 0;
    globalThis.__radio = async () => {
      call += 1;
      if (call === 1) return page(["r1", "r2", "r3", "r4", "r5"]);
      const video = { ...yt("r2video", 200), title: "Song r2 (Official Video)", artist: "Artist r2", videoType: "song" };
      return { ...page(["r6"]), tracks: [video, ...page(["r6"]).tracks] };
    };
    h.setDuration(Y("seed"), 60);
    await play(h, [yt("seed", 60)]);
    await settle(h);
    h.engine.dontPlay(2);
    await settle(h);
    assert.ok(call >= 2, "a refill ran after the removal");
    assert.ok(!ids(h).includes("r2video"), `the same song came back: ${ids(h)}`);
    assert.ok(ids(h).includes("r6"));
  } finally {
    await settle(h);
    h.restore();
  }
});

test("when the radio has nothing new: the playing song's radio, then the Home feed", async () => {
  const h = await boot({ autoplay: true, fadeSeconds: 0 });
  try {
    const calls = [];
    globalThis.__radio = async (id) => {
      calls.push(id.replace(/_+$/, ""));
      return page([]);
    };
    globalThis.__home = [{ title: "Home", items: [{ kind: "track", track: { ...yt("home1", 200), artist: "H" } }] }];
    h.setDuration(Y("a"), 60);
    h.setDuration(Y("b"), 60);
    await play(h, [yt("a", 60), yt("b", 60)]);
    await settle(h);
    assert.deepEqual(calls, ["b", "a"], "the queue's newest song first, then the one playing");
    assert.deepEqual(ids(h), ["a", "b", "home1"], "the Home feed is the last resort");
  } finally {
    await settle(h);
    h.restore();
  }
});

test("after an empty refill AutoPlay backs off while playing, but answers at once when the queue runs out", async () => {
  const h = await boot({ autoplay: true, fadeSeconds: 0 });
  try {
    let calls = 0;
    globalThis.__radio = async () => {
      calls += 1;
      return page([]);
    };
    globalThis.__home = [];
    h.setDuration(Y("seed"), 60);
    await play(h, [yt("seed", 60)]);
    await settle(h);
    const first = calls;
    assert.ok(first >= 1);
    await h.advance(3000); // position ticks keep changing the store
    await settle(h);
    assert.equal(calls, first, "no request storm while nothing new turns up");
    h.engine.usePlayer.getState().next(true);
    await settle(h);
    assert.ok(calls > first, "a waiting queue asks again straight away");
  } finally {
    await settle(h);
    h.restore();
  }
});

test("pausing while AutoPlay fetches cancels the wait, and a late answer doesn't start playing", async () => {
  const h = await boot({ autoplay: true, fadeSeconds: 0 });
  try {
    let release;
    const gate = new Promise((r) => (release = r));
    globalThis.__radio = async () => {
      await gate;
      return page(["r1", "r2"]);
    };
    h.setDuration(Y("seed"), 60);
    await play(h, [yt("seed", 60)]);
    await settle(h, 5);
    const p = h.engine.usePlayer;
    p.getState().next(true);
    assert.equal(p.getState().awaitingAutoplay, true);
    p.getState().toggle();
    assert.equal(p.getState().awaitingAutoplay, false);
    release();
    await settle(h);
    assert.equal(p.getState().playing, false, "the pause sticks");
    assert.equal(short(h), "seed");
    assert.deepEqual(ids(h), ["seed", "r1", "r2"], "the suggestions still arrive for later");
  } finally {
    await settle(h);
    h.restore();
  }
});

test("turning repeat-all on while AutoPlay waits loops your queue right away", async () => {
  const h = await boot({ autoplay: true, fadeSeconds: 0 });
  try {
    globalThis.__radio = () => new Promise(() => {});
    h.setDuration(Y("a"), 60);
    h.setDuration(Y("b"), 60);
    await play(h, [yt("a", 60), yt("b", 60)], 1);
    await settle(h, 5);
    const p = h.engine.usePlayer;
    p.getState().next(true);
    assert.equal(p.getState().awaitingAutoplay, true);
    p.getState().cycleRepeat();
    await settle(h);
    assert.equal(short(h), "a");
    assert.equal(read(h).playing, true);
  } finally {
    await settle(h);
    h.restore();
  }
});

test("with shuffle and AutoPlay, every one of your songs plays before any suggestion", async () => {
  const h = await boot({ autoplay: true, fadeSeconds: 0 });
  try {
    globalThis.__radio = async () => page([]);
    globalThis.__home = [];
    const own = ["a", "b", "c", "d", "e"];
    for (const n of [...own, "s1", "s2"]) h.setDuration(Y(n), 120);
    const p = h.engine.usePlayer;
    p.setState({ shuffle: true });
    await play(h, own.map((n) => yt(n, 120)), 0);
    p.getState().appendAutoplay([yt("s1", 120), yt("s2", 120)]);
    const visited = [short(h)];
    for (let i = 0; i < own.length - 1; i++) {
      p.getState().next(true);
      visited.push(short(h));
    }
    assert.deepEqual([...visited].sort(), own, "each of your songs exactly once");
    p.getState().next(true);
    assert.equal(short(h), "s1", "then AutoPlay carries on");
  } finally {
    await settle(h);
    h.restore();
  }
});

test("Next pressed mid-blend into a repeated song keeps the later copy", async () => {
  const h = await boot({ autoplay: false, fadeSeconds: 0.6 });
  try {
    h.setDuration("x", 10);
    h.setDuration("b", 10);
    h.setDuration("a", 3);
    h.setDuration("c", 10);
    await play(h, [track("x", 10), track("b", 10), track("a", 3), track("x", 10), track("c", 10)], 2);
    await h.advance(2550);
    h.engine.usePlayer.getState().next(true);
    await settle(h);
    assert.equal(h.engine.usePlayer.getState().index, 3);
  } finally {
    await settle(h);
    h.restore();
  }
});

/* ---------------- the one-time offer ---------------- */

function fakeStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}

async function bootOffer() {
  globalThis.localStorage = fakeStorage();
  const h = await boot({ autoplay: false, fadeSeconds: 0 });
  h.engine.initAutoplay();
  h.setDuration(Y("seed"), 2);
  return h;
}

test("an install with AutoPlay off is offered it once, when a song plays to the end", async () => {
  const h = await bootOffer();
  try {
    globalThis.__radio = async () => page(["r1", "r2", "r3", "r4", "r5", "r6"]);
    h.setDuration(Y("r1"), 120);
    await play(h, [yt("seed", 2)]);
    await h.advance(2600);
    await settle(h);
    const dialog = h.engine.useUI.getState().dialog;
    assert.equal(dialog?.title, "Keep the music going?");
    assert.equal(globalThis.localStorage.getItem("bytune.autoplayOffered"), "1");
    // Accepting turns AutoPlay on and carries straight on from where the queue ended.
    h.engine.useUI.getState().closeDialog();
    dialog.onConfirm("");
    await settle(h);
    assert.equal(h.engine.useSettings.getState().autoplay, true);
    assert.equal(short(h), "r1");
    assert.equal(read(h).playing, true);
  } finally {
    await settle(h);
    h.restore();
    delete globalThis.localStorage;
  }
});

test("the offer never covers an open dialog, and never shows to someone who chose", async () => {
  const h = await bootOffer();
  try {
    const ui = h.engine.useUI;
    ui.getState().openDialog({ title: "Rename playlist", onConfirm() {} });
    await play(h, [yt("seed", 2)]);
    await h.advance(2600);
    await settle(h);
    assert.equal(ui.getState().dialog?.title, "Rename playlist", "the open dialog is untouched");
    assert.equal(globalThis.localStorage.getItem("bytune.autoplayOffered"), null, "still offered later");
    ui.getState().closeDialog();
    // The listener switches AutoPlay on and off themselves: that is a choice.
    h.engine.useSettings.getState().setAutoplay(true);
    h.engine.useSettings.getState().setAutoplay(false);
    await play(h, [yt("seed", 2)]);
    await h.advance(2600);
    await settle(h);
    assert.equal(ui.getState().dialog, null);
  } finally {
    await settle(h);
    h.restore();
    delete globalThis.localStorage;
  }
});

test("a song waits in the queue once: adding it again is a no-op, Play next moves it up", async () => {
  const h = await boot({ fadeSeconds: 0 });
  try {
    const p = h.engine.usePlayer;
    await play(h, [track(Y("now"), 200), track(Y("a"), 200), track(Y("b"), 200)]);
    assert.equal(p.getState().addToQueue(track(Y("b"), 200)), 0, "already waiting");
    assert.equal(p.getState().addToQueue([track(Y("c"), 200), track(Y("c"), 200)]), 1, "a duplicate in one batch counts once");
    p.getState().addToQueue(track(Y("b"), 200), true);
    assert.deepEqual(p.getState().queue.map((t) => t.id), [Y("now"), Y("b"), Y("a"), Y("c")]);
  } finally {
    await settle(h);
    h.restore();
  }
});

test("AutoPlay never suggests a song already queued, and adding a suggested song makes it yours", async () => {
  const h = await boot({ fadeSeconds: 0 });
  try {
    const p = h.engine.usePlayer;
    await play(h, [track(Y("now"), 200), track(Y("mine"), 200)]);
    p.getState().appendAutoplay([track(Y("mine"), 200), track(Y("s1"), 200), track(Y("s2"), 200)]);
    assert.deepEqual(p.getState().queue.map((t) => t.id), [Y("now"), Y("mine"), Y("s1"), Y("s2")], "the queued song is not suggested again");
    assert.equal(h.engine.autoplayTail(p.getState()), 2);
    p.getState().addToQueue(track(Y("s2"), 200));
    assert.deepEqual(p.getState().queue.map((t) => t.id), [Y("now"), Y("mine"), Y("s2"), Y("s1")]);
    assert.equal(h.engine.autoplayTail(p.getState()), 1, "s2 left the suggestions");
  } finally {
    await settle(h);
    h.restore();
  }
});

test("drag-reorder keeps your songs and AutoPlay's suggestions each on their own side", async () => {
  const h = await boot({ fadeSeconds: 0 });
  try {
    const p = h.engine.usePlayer;
    await play(h, [track(Y("now"), 200), track(Y("a"), 200), track(Y("b"), 200)]);
    p.getState().appendAutoplay([track(Y("s1"), 200), track(Y("s2"), 200)]);
    const ids = () => p.getState().queue.map((t) => t.id);
    p.getState().moveUpcoming(2, 1); // b above a
    assert.deepEqual(ids(), [Y("now"), Y("b"), Y("a"), Y("s1"), Y("s2")]);
    p.getState().moveUpcoming(1, 4); // your song can't sink among the suggestions
    assert.deepEqual(ids(), [Y("now"), Y("a"), Y("b"), Y("s1"), Y("s2")]);
    p.getState().moveUpcoming(4, 1); // a suggestion can't climb among your songs
    assert.deepEqual(ids(), [Y("now"), Y("a"), Y("b"), Y("s2"), Y("s1")]);
    assert.equal(h.engine.autoplayTail(p.getState()), 2, "still two suggestions");
    p.getState().moveUpcoming(0, 2); // the playing song never moves
    assert.deepEqual(ids(), [Y("now"), Y("a"), Y("b"), Y("s2"), Y("s1")]);
  } finally {
    await settle(h);
    h.restore();
  }
});

test("with shuffle, the first song after the queue runs out is AutoPlay's first, not one already played", async () => {
  const h = await boot({ autoplay: true, fadeSeconds: 0 });
  try {
    let release;
    const gate = new Promise((r) => (release = r));
    globalThis.__radio = async () => {
      await gate;
      return page(["s1", "s2"]);
    };
    globalThis.__home = [];
    for (const n of ["a", "b", "c", "s1", "s2"]) h.setDuration(Y(n), 120);
    const p = h.engine.usePlayer;
    p.setState({ shuffle: true });
    await play(h, [yt("a", 120), yt("b", 120), yt("c", 120)], 2);
    await settle(h, 5);
    p.getState().next(true);
    p.getState().next(true); // a and b, in shuffled order
    p.getState().next(true);
    assert.equal(p.getState().awaitingAutoplay, true, "all three played: AutoPlay waits");
    release();
    await settle(h);
    assert.equal(short(h), "s1");
  } finally {
    await settle(h);
    h.restore();
  }
});
