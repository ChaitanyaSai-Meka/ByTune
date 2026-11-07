/**
 * Auto Mix: the deck that starts during a blend must BECOME the session player,
 * not be rebuilt and restarted.
 *
 * These run the shipped audio engine (src/lib/audio.ts) against fake media
 * elements on a virtual clock, so the whole transition — arming, the equal
 * power blend, the outgoing track's natural `ended` and the promotion of the
 * incoming deck — is exercised as real code, deterministically.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  FADE_SEC,
  boot,
  decksOf,
  endedAt,
  firstAudible,
  firstSoundAt,
  mediaEvents,
  play,
  read,
  restartedFrom,
  setAnalysis,
  sounding,
  startsOf,
  track,
} from "./automix-harness.mjs";

test("automix: the track that starts during the blend becomes active and keeps its position", async (t) => {
  const h = await boot();
  t.after(() => h.restore());
  h.setDuration("A", 3.0);
  // The stream runs out slightly before the duration it reports, so the
  // outgoing element's `ended` lands *before* the blend timer observes
  // completion. That ordering is what the shipping app hits, because the fade
  // timeline starts after an async resolve and a play().
  h.setStreamEnd("A", 2.95);
  h.setDuration("B", 4.0);
  h.setDuration("C", 4.0);
  await play(h, [track("A", 3.0), track("B", 4.0), track("C", 4.0)]);

  await h.advance(4000);

  // Song B really was audible during the blend, on a deck of its own.
  const audible = firstAudible(h, "B");
  assert.equal(audible.size, 1, `song B must reach the standby deck exactly once, saw ${audible.size}`);
  const [blendEl, blendStart] = [...audible][0];

  const s = read(h);
  assert.equal(s.id, "B", "song B must be the active track once the transition completes");
  assert.equal(restartedFrom(h, "B"), false, "song B's playback position must never jump back to zero");

  const decks = decksOf(h, "B");
  assert.equal(decks.length, 1, "song B must exist on exactly one element (no duplicate decks)");
  assert.equal(decks[0].el, blendEl, "the blended deck must be promoted, not recreated");
  assert.ok(
    decks[0].currentTime >= blendStart.currentTime + 0.2,
    `song B must continue from its blended position (~${(blendStart.currentTime + FADE_SEC).toFixed(2)}s), found ${decks[0].currentTime.toFixed(2)}s`
  );
  assert.ok(s.position > 0.2, `store position must track the media clock, found ${s.position}s`);
  assert.ok(Math.abs(s.position - decks[0].currentTime) < 0.25, "store position must follow the element clock");
  assert.equal(startsOf(h, "B").length, 1, "song B must be initialised exactly once");
});

test("automix: holds the incoming position when the blend completes before the outgoing track ends", async (t) => {
  const h = await boot();
  t.after(() => h.restore());
  // Outgoing track outlives the blend: the fade timer observes completion first.
  h.setDuration("A", 3.05);
  h.setDuration("B", 4.0);
  await play(h, [track("A", 3.05), track("B", 4.0)]);

  await h.advance(4000);
  const s = read(h);
  assert.equal(s.id, "B");
  assert.ok(s.position > 0.2, `song B should already be seconds in, got ${s.position}s`);
  assert.equal(restartedFrom(h, "B"), false);
  assert.equal(startsOf(h, "B").length, 1);
});

test("automix: the blended deck is promoted, never reloaded", async (t) => {
  const h = await boot();
  t.after(() => h.restore());
  h.setDuration("A", 3.0);
  h.setStreamEnd("A", 2.95);
  h.setDuration("B", 4.0);
  await play(h, [track("A", 3.0), track("B", 4.0)]);

  await h.advance(4000);
  const bPlays = mediaEvents(h, "B", "playing");
  assert.equal(bPlays.length, 1, `song B must be started exactly once, saw ${bPlays.length}`);
  assert.equal(bPlays[0].currentTime, 0, "song B must start at 0:00 on its own deck");
  assert.ok(endedAt(h, "A") < endedAt(h, "B"), "song A must end before song B");
  assert.equal(sounding(h).length, 1, "only the promoted deck may sound");
});

test("automix off: the next track starts at 0:00 and nothing plays early", async (t) => {
  const h = await boot({ fadeSeconds: 0 });
  t.after(() => h.restore());
  h.setDuration("A", 3.0);
  h.setDuration("B", 4.0);
  await play(h, [track("A", 3.0), track("B", 4.0)]);

  await h.advance(4000);
  assert.ok(firstSoundAt(h, "B") >= endedAt(h, "A"), `song B must not start before song A ends (${firstSoundAt(h, "B")} vs ${endedAt(h, "A")})`);
  const started = startsOf(h, "B");
  assert.equal(started.length, 1);
  assert.ok(started[0].position < 0.2, `song B must start from the top, started at ${started[0].position}s`);
  const s = read(h);
  assert.equal(s.id, "B");
  assert.ok(s.position > 0.2, "song B should be playing after the switch");
  assert.equal(sounding(h).length, 1, "only one deck may sound");
});

test("repeat-all: the last song blends into the first, which starts once and plays on", async (t) => {
  const h = await boot();
  t.after(() => h.restore());
  const { usePlayer } = h.engine;
  h.setDuration("A", 4.0);
  h.setDuration("B", 3.0);
  usePlayer.setState({ repeat: "all" });
  await play(h, [track("A", 4.0), track("B", 3.0)], 1);
  await h.advance(3500);
  assert.equal(read(h).index, 0);
  assert.equal(read(h).id, "A");
  assert.ok(firstSoundAt(h, "A") < endedAt(h, "B"), "A came in under the end of B");
  assert.equal(restartedFrom(h, "A"), false, "promoted, not restarted");
});

test("the incoming song loads once while its blend waits to start, and the OS flyout follows the blend", async (t) => {
  const h = await boot();
  t.after(() => h.restore());
  h.setDuration("A", 3.0);
  h.setDuration("B", 4.0);
  await play(h, [track("A", 3.0), track("B", 4.0)]);
  await h.advance(2300);
  assert.equal(globalThis.__loads.filter((src) => src === "fake:B").length, 1, "one load, not one per timeupdate");
  await h.advance(1200);
  assert.equal(read(h).id, "B");
  assert.equal(globalThis.__media.at(-1)?.title, "B", "the flyout shows the song the blend landed on");
});

test("the screen moves to the incoming song half way through a blend; the queue moves when it ends", async (t) => {
  const h = await boot();
  t.after(() => h.restore());
  const { usePlayer, shownTrack } = h.engine;
  h.setDuration("A", 3.0);
  h.setDuration("B", 4.0);
  await play(h, [track("A", 3.0), track("B", 4.0)]);
  await h.advance(2500);
  assert.equal(usePlayer.getState().blendInto, null, "before the crossover the screen shows A");
  await h.advance(300);
  assert.equal(shownTrack(usePlayer.getState()).id, "B", "past the crossover it shows B");
  assert.equal(read(h).id, "A", "the queue still plays A until the blend completes");
  await h.advance(700);
  assert.equal(read(h).id, "B");
  assert.equal(usePlayer.getState().blendInto, null, "cleared together with the index");
});

test("the blend planner: real edges, and beats in phase when the tempos match", async (t) => {
  const h = await boot();
  t.after(() => h.restore());
  const { planBlend } = h.engine;
  const an = (p) => ({ head: 0, tail: 0, lufs: null, onset: null, intro: null, outro: null, ...p });
  assert.deepEqual(planBlend(null, 200, null, 6, false, false), { outAt: 194, inAt: 0 }, "plain crossfade");
  assert.deepEqual(planBlend(an({ tail: 3 }), 200, an({ head: 1 }), 6, true, false), { outAt: 191, inAt: 1 }, "ends where the sound ends");
  assert.deepEqual(planBlend(an({ tail: 3 }), 200, an({ head: 1 }), 6, false, false), { outAt: 194, inAt: 0 }, "edges off: as before");
  // A's last beat at 2.25 s (120 BPM); B joins at 0.2 s and its first beat is at 0.45 s.
  const out = an({ outro: { bpm: 120, at: 2.25 } });
  const inc = an({ head: 0.2, intro: { bpm: 120, at: 0.45 } });
  const matched = planBlend(out, 3.0, inc, 0.6, true, true);
  assert.ok(Math.abs(matched.outAt - 2.0) < 1e-9 && matched.inAt === 0.2, `B's beat lands on A's: ${JSON.stringify(matched)}`);
  const slow = an({ head: 0.2, intro: { bpm: 100, at: 0.45 } });
  const mismatched = planBlend(out, 3.0, slow, 0.6, true, true);
  assert.ok(Math.abs(mismatched.outAt - 2.25) < 1e-9, "tempos apart: B's first sound lands on an A beat");
});

test("with Automix, B joins at its first sound and A is never heard past the end of its sound", async (t) => {
  const h = await boot({ smartFade: true });
  t.after(() => h.restore());
  h.setDuration("A", 10.0);
  h.setDuration("B", 20.0);
  setAnalysis("A", { tail: 3.0 });
  setAnalysis("B", { head: 1.0 });
  await play(h, [track("A", 10.0), track("B", 20.0)]);
  await h.advance(6700);
  const firstB = h.trace.find((s) => s.src === "fake:B" && s.currentTime > 1.0);
  assert.ok(firstB && firstB.currentTime < 1.4, `B plays on from its first sound (${firstB?.currentTime})`);
  await h.advance(600);
  assert.equal(read(h).id, "B", "the blend is done by the end of A's sound");
  assert.deepEqual(sounding(h).map((d) => d.src), ["fake:B"]);
});
