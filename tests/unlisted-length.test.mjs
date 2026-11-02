// Songs listed without a length (Home cards, podcast episodes, M3U imports without #EXTINF) are
// analysed with their deck's own length, so the analysis length gate and decode rate still apply.
import test from "node:test";
import assert from "node:assert/strict";
import { boot, flushMicrotasks, play, read, setAnalysis, track } from "./automix-harness.mjs";

async function settle(h, rounds = 20) {
  for (let i = 0; i < rounds; i++) await flushMicrotasks(4);
}

test("a song listed without its length is analysed with its deck's length", async () => {
  const h = await boot({ skipSilence: true, fadeSeconds: 0 });
  try {
    h.setDuration("u", 200); // what the element reports
    setAnalysis("u", { head: 2.0 });
    await play(h, [track("u", 0)]);
    await h.advance(300);
    const calls = globalThis.__analysisCalls.filter((c) => c.id === "u");
    assert.ok(calls.length >= 1, "analysed");
    assert.ok(calls.every((c) => c.duration === 200), `always with a length: ${JSON.stringify(calls)}`);
    assert.ok(h.elements.find((e) => e.src === "fake:u").currentTime >= 2, "its silent head was skipped");
  } finally {
    await settle(h);
    h.restore();
  }
});

test("a song blended into without a listed length is analysed once it is promoted", async () => {
  const h = await boot({ skipSilence: true });
  try {
    h.setDuration("A", 3.0);
    h.setDuration("v", 30);
    await play(h, [track("A", 3.0), track("v", 0)]);
    await h.advance(3500);
    assert.equal(read(h).id, "v");
    const calls = globalThis.__analysisCalls.filter((c) => c.id === "v");
    assert.ok(calls.some((c) => c.duration === 30), `analysed with the deck's length: ${JSON.stringify(calls)}`);
    // The blend planner's look-ahead still asks with the listing (0): analyseTrack refuses that without fetching.
    assert.ok(calls.filter((c) => c.duration > 0).every((c) => c.duration === 30));
  } finally {
    await settle(h);
    h.restore();
  }
});
