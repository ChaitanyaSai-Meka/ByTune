import test from "node:test";
import assert from "node:assert/strict";
import { boot } from "./automix-harness.mjs";

test("auto headroom lowers the level only by what a boost would clip at this volume", async () => {
  const h = await boot({ fadeSeconds: 0 });
  try {
    const { headroomDb, compressorMakeupDb } = h.engine;
    assert.equal(headroomDb(0, 1), 0, "no boost, no headroom");
    assert.equal(headroomDb(6, 1), 6, "full volume: the whole boost");
    assert.equal(headroomDb(6, 0.5), 0, "half volume (-6 dB) already covers a 6 dB boost");
    assert.ok(Math.abs(headroomDb(9, 0.5) - (9 + 20 * Math.log10(0.5))) < 1e-9, "only the part past full scale");
    assert.equal(headroomDb(3, 0.5), 0, "a small boost at half volume needs nothing");
    assert.equal(headroomDb(6, 0), 0, "silence needs nothing");
    assert.equal(headroomDb(NaN, 1), 0, "a broken measurement never reaches the gain node");
    // Spec makeup gain for the -0.5 dB / 20:1 limiter: 0.6 × 0.475 dB.
    assert.ok(Math.abs(compressorMakeupDb(-0.5, 20) - 0.285) < 1e-9);
  } finally {
    h.restore();
  }
});
