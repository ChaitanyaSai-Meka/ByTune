// The gap while a song's stream resolves: the old deck keeps ticking, and the listener can act
// before the new source is on its deck.
import test from "node:test";
import assert from "node:assert/strict";
import { boot, createEngine, flushMicrotasks, play, read, track } from "./automix-harness.mjs";

async function settle(h, rounds = 20) {
  for (let i = 0; i < rounds; i++) await flushMicrotasks(4);
}

test("a level that lands before a skipped-to song is heard applies at once, even after a slow resolve", async () => {
  const h = await boot({ fadeSeconds: 0 });
  try {
    for (const id of ["A", "B", "C"]) h.setDuration(id, 200);
    globalThis.__lufs = { A: -14, B: -14, C: -8 };
    await play(h, [track("A", 200), track("B", 200), track("C", 200)]);
    await h.advance(1000);
    globalThis.__resolveDelay = { C: 600 }; // C was never warmed: its loudness lands after its src is set
    h.engine.usePlayer.getState().jumpTo(2);
    await flushMicrotasks();
    await h.advance(600);
    const deck = () => h.elements.find((e) => e.src === "fake:C");
    for (let i = 0; i < 8 && !deck(); i++) await h.advance(25);
    await h.advance(25);
    assert.ok(Math.abs(deck().volume - 0.8 * Math.pow(10, -6 / 20)) < 1e-6, `C starts at its level (${deck().volume})`);
  } finally {
    await settle(h);
    h.restore();
  }
});

test("play pressed while the saved song's stream still resolves starts it at the saved point, once", async () => {
  const h = await createEngine();
  try {
    const { usePlayer, useSettings, useLibrary } = h.engine;
    useSettings.setState({ crossfadeSeconds: 0, smartFade: false, skipSilence: false, autoplay: false, playbackSpeed: 1 });
    useLibrary.setState({ history: [] });
    while (!usePlayer.persist.hasHydrated()) await flushMicrotasks(2);
    h.setDuration("a", 200);
    globalThis.__resolveDelay = { a: 600 };
    usePlayer.setState({ queue: [track("a", 200)], index: 0, position: 60, playing: false }); // what launch restores
    h.engine.engineBoot();
    await settle(h);
    await h.advance(200);
    usePlayer.getState().setPlaying(true); // pressed while the launch load still resolves
    await settle(h);
    await h.advance(1500);
    await settle(h);
    const decks = h.elements.filter((e) => e.src === "fake:a" && !e.paused);
    assert.equal(decks.length, 1, "one deck plays it");
    assert.ok(decks[0].currentTime >= 60, `from the saved point, not from 0:00 (${decks[0].currentTime})`);
    assert.equal(globalThis.__loads.filter((src) => src === "fake:a").length, 1, "its source was set once");
    assert.equal(read(h).playing, true);
  } finally {
    await settle(h);
    h.restore();
  }
});
