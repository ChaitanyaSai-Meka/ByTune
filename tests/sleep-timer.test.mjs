import test from "node:test";
import assert from "node:assert/strict";
import { boot, flushMicrotasks, play, read, track } from "./automix-harness.mjs";

async function settle(h, rounds = 20) {
  for (let i = 0; i < rounds; i++) await flushMicrotasks(4);
}
const live = (h, id) => h.elements.find((e) => e.src === `fake:${id}` && !e.paused);

test("a timed sleep fades out over its last 10 seconds, then pauses", async () => {
  const h = await boot({ fadeSeconds: 0 });
  try {
    h.setDuration("long", 600);
    await play(h, [track("long", 600)]);
    await h.advance(1000);
    const full = live(h, "long").volume;
    h.engine.useSleepTimer.getState().start(1);
    await h.advance(45_000); // 15 s left: no fade yet
    assert.ok(Math.abs(live(h, "long").volume - full) < 0.01, "full volume until the last 10 seconds");
    await h.advance(10_000); // 5 s left: half way down
    const mid = live(h, "long").volume;
    assert.ok(mid < full * 0.6 && mid > full * 0.4, `about half volume 5 s before the end (${mid.toFixed(2)} of ${full.toFixed(2)})`);
    await h.advance(6000);
    await settle(h);
    assert.equal(read(h).playing, false, "paused when the timer ran out");
    assert.equal(h.engine.useSleepTimer.getState().endsAt, null, "the timer is off afterwards");
    await h.advance(1000);
    assert.equal(h.engine.useSleepTimer.getState().level, 1, "volume is back to normal for the next play");
  } finally {
    await settle(h);
    h.restore();
  }
});

test("'end of this song' stops after the song instead of playing the next one", async () => {
  const h = await boot({ fadeSeconds: 0 });
  try {
    h.setDuration("a", 3);
    h.setDuration("b", 120);
    await play(h, [track("a", 3), track("b", 120)]);
    h.engine.useSleepTimer.getState().startEndOfSong();
    await h.advance(3600);
    await settle(h);
    assert.equal(read(h).playing, false, "stopped at the end of the song");
    assert.equal(read(h).id, "a", "the queue did not move on");
    assert.equal(live(h, "b"), undefined, "the next song never started");
    assert.equal(h.engine.useSleepTimer.getState().endOfSong, false, "the timer is off afterwards");
  } finally {
    await settle(h);
    h.restore();
  }
});

test("'end of this song' keeps a crossfade from blending into the next song", async () => {
  const h = await boot({ fadeSeconds: 0.6 });
  try {
    h.setDuration("a", 3);
    h.setDuration("b", 120);
    await play(h, [track("a", 3), track("b", 120)]);
    h.engine.useSleepTimer.getState().startEndOfSong();
    await h.advance(2700); // inside the crossfade window
    assert.equal(live(h, "b"), undefined, "no blend into the next song");
    await h.advance(1000);
    await settle(h);
    assert.equal(read(h).playing, false);
    assert.equal(read(h).id, "a");
  } finally {
    await settle(h);
    h.restore();
  }
});

test("custom sleep times read as minutes, h:mm or hours and minutes", async () => {
  const h = await boot({ fadeSeconds: 0 });
  try {
    const { parseSleepMinutes, formatSleepLeft } = h.engine;
    assert.equal(parseSleepMinutes("90"), 90);
    assert.equal(parseSleepMinutes("1:30"), 90);
    assert.equal(parseSleepMinutes("1h 30m"), 90);
    assert.equal(parseSleepMinutes("2h"), 120);
    assert.equal(parseSleepMinutes("45 min"), 45);
    assert.equal(parseSleepMinutes("soon"), null);
    assert.equal(parseSleepMinutes(""), null);
    assert.equal(formatSleepLeft(65_000), "1:05");
    assert.equal(formatSleepLeft(3_723_000), "1:02:03");
  } finally {
    h.restore();
  }
});

test("'end of this song' picked during a crossfade calls the blend off", async () => {
  const h = await boot({ fadeSeconds: 0.6 });
  try {
    h.setDuration("a", 3);
    h.setDuration("b", 120);
    await play(h, [track("a", 3), track("b", 120)]);
    await h.advance(2600); // b is already blending in
    assert.ok(live(h, "b"), "the blend had started");
    h.engine.useSleepTimer.getState().startEndOfSong();
    await settle(h, 5);
    assert.equal(live(h, "b"), undefined, "the incoming song is stopped");
    await h.advance(1000);
    await settle(h);
    assert.equal(read(h).playing, false, "the music stops when the song ends");
    assert.equal(read(h).id, "a");
  } finally {
    await settle(h);
    h.restore();
  }
});
