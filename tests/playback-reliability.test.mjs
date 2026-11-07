import test from "node:test";
import assert from "node:assert/strict";
import { boot, createEngine, flushMicrotasks, play, read, track } from "./automix-harness.mjs";

async function settle(h, rounds = 20) {
  for (let i = 0; i < rounds; i++) await flushMicrotasks(4);
}
const live = (h, id) => h.elements.find((e) => e.src === `fake:${id}` && !e.paused);

test("a stream that fails mid-song resumes where it was, not from 0:00", async () => {
  const h = await boot({ fadeSeconds: 0 });
  try {
    h.setDuration("a", 200);
    await play(h, [track("a", 200)]);
    await h.advance(30_000);
    const deck = live(h, "a");
    assert.ok(deck && deck.currentTime >= 29, "playing at about 0:30");
    deck.pause();
    deck.emit("error");
    await settle(h);
    const again = live(h, "a");
    assert.ok(again, "the song is playing again");
    assert.ok(again.currentTime >= 29, `resumed at ${again.currentTime.toFixed(1)}s, not from the start`);
  } finally {
    await settle(h);
    h.restore();
  }
});

test("repeat-all on a one-song queue loops instead of stalling at the end", async () => {
  const h = await boot({ fadeSeconds: 0 });
  try {
    h.setDuration("solo", 2);
    await play(h, [track("solo", 2)]);
    h.engine.usePlayer.setState({ repeat: "all" });
    await h.advance(2600);
    await settle(h);
    const deck = live(h, "solo");
    assert.ok(deck, "still playing after the end");
    assert.ok(deck.currentTime < 1, "started over");
    assert.equal(read(h).playing, true);
  } finally {
    await settle(h);
    h.restore();
  }
});

test("a song that fails while blending in is dropped from the blend, and plays normally next", async () => {
  const h = await boot({ fadeSeconds: 0.6 });
  try {
    h.setDuration("a", 3);
    h.setDuration("b", 120);
    await play(h, [track("a", 3), track("b", 120)]);
    await h.advance(1500);
    const level = live(h, "a").volume; // before the blend starts
    await h.advance(1050); // b is fading in on the standby deck
    const standby = live(h, "b");
    assert.ok(standby, "the blend had started");
    assert.ok(live(h, "a").volume < level, "a was fading out");
    standby.pause();
    standby.emit("error"); // its stream died
    const outgoing = live(h, "a");
    assert.ok(outgoing && outgoing.volume >= level - 0.01, "the outgoing song is back at its own level");
    await h.advance(150); // the next ticks must not start the same blend again
    await settle(h, 5);
    assert.equal(live(h, "b"), undefined, "no second blend into the song that just failed");
    assert.ok(live(h, "a").volume >= level - 0.01, "the outgoing song plays out at its own level");
    await h.advance(1500);
    await settle(h);
    assert.equal(read(h).id, "b");
    assert.ok(live(h, "b"), "b plays (reloaded), not a silent dead deck");
  } finally {
    await settle(h);
    h.restore();
  }
});

test("a long song that fails again after playing on for 30 s gets another retry", async () => {
  const h = await boot({ fadeSeconds: 0 });
  try {
    h.setDuration("a", 600);
    await play(h, [track("a", 600)]);
    await h.advance(30_000);
    let deck = live(h, "a");
    deck.pause();
    deck.emit("error");
    await settle(h);
    assert.ok(live(h, "a"), "the first retry");
    await h.advance(40_000);
    deck = live(h, "a");
    assert.ok(deck.currentTime >= 69);
    deck.pause();
    deck.emit("error");
    await settle(h);
    const again = live(h, "a");
    assert.ok(again && again.currentTime >= 69, "retried again, where it was");
    assert.equal(read(h).id, "a");
  } finally {
    await settle(h);
    h.restore();
  }
});

test("a song that fails again straight after its retry is skipped, not retried in a loop", async () => {
  const h = await boot({ fadeSeconds: 0 });
  try {
    h.setDuration("a", 600);
    h.setDuration("b", 600);
    await play(h, [track("a", 600), track("b", 600)]);
    await h.advance(30_000);
    let deck = live(h, "a");
    deck.pause();
    deck.emit("error");
    await settle(h);
    await h.advance(2_000);
    deck = live(h, "a");
    deck.pause();
    deck.emit("error");
    await settle(h);
    assert.equal(read(h).id, "b", "skipped to the next song");
  } finally {
    await settle(h);
    h.restore();
  }
});

/* ---------------- the saved resume point (S3b) ---------------- */

/** Boot like the app: the saved state hydrates first, then engineBoot loads the song. */
async function bootWithSaved(state) {
  const h = await createEngine();
  const { usePlayer, useSettings, useLibrary } = h.engine;
  useSettings.setState({ crossfadeSeconds: 0, smartFade: false, skipSilence: false, autoplay: false, playbackSpeed: 1 });
  useLibrary.setState({ history: [] });
  while (!usePlayer.persist.hasHydrated()) await flushMicrotasks(2);
  const saved = [];
  globalThis.__storage.setItem = async (_name, value) => {
    saved.push(value.state.position);
  };
  globalThis.__storage.getItem = async () => ({ state, version: 0 });
  await usePlayer.persist.rehydrate();
  return { h, saved };
}

test("a resume point whose song can't load yet stays saved, and the song resumes there once it can", async () => {
  const { h, saved } = await bootWithSaved({ queue: [track("gone", 200), track("b", 200)], index: 0, position: 30, volume: 0.8, muted: false, shuffle: false, repeat: "off", autoplayCount: 0 });
  try {
    const p = h.engine.usePlayer;
    globalThis.__failIds = new Set(["gone"]); // offline at launch
    h.setDuration("gone", 200);
    h.engine.engineBoot();
    await settle(h);
    assert.equal(p.getState().position, 30, "the store keeps the resume point");
    assert.ok(!saved.includes(0), `nothing handed storage a 0: ${JSON.stringify(saved)}`);
    globalThis.__failIds = new Set(); // back online: the listener presses play
    p.getState().setPlaying(true);
    await settle(h);
    await h.advance(500);
    assert.ok(live(h, "gone")?.currentTime >= 30, "resumed at 0:30");
  } finally {
    await settle(h);
    h.restore();
  }
});


test("a seek before the song has loaded is where it starts", async () => {
  const { h } = await bootWithSaved({ queue: [track("slow", 200)], index: 0, position: 30, volume: 0.8, muted: false, shuffle: false, repeat: "off", autoplayCount: 0 });
  try {
    const p = h.engine.usePlayer;
    globalThis.__failIds = new Set(["slow"]);
    h.setDuration("slow", 200);
    h.engine.engineBoot();
    await settle(h);
    p.getState().seek(0); // back to the start before it could load
    globalThis.__failIds = new Set();
    p.getState().setPlaying(true);
    await settle(h);
    await h.advance(500);
    assert.ok(live(h, "slow")?.currentTime < 1, "from the start, as asked");
  } finally {
    await settle(h);
    h.restore();
  }
});

test("removing the song playing starts the next one from the top", async () => {
  const h = await boot({ fadeSeconds: 0 });
  try {
    const p = h.engine.usePlayer;
    h.setDuration("a", 200);
    h.setDuration("b", 200);
    await play(h, [track("a", 200), track("b", 200)]);
    await h.advance(30_000);
    p.getState().removeAt(0);
    for (let i = 0; i < 20; i++) await flushMicrotasks(4);
    await h.advance(300);
    const deck = h.elements.find((e) => e.src === "fake:b" && !e.paused);
    assert.ok(deck && deck.currentTime < 1);
  } finally {
    for (let i = 0; i < 10; i++) await flushMicrotasks(4);
    h.restore();
  }
});
