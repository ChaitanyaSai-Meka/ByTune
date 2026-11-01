import test from "node:test";
import assert from "node:assert/strict";
import { boot, flushMicrotasks, play, read, track } from "./automix-harness.mjs";

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
