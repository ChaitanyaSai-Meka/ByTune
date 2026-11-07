/**
 * Where a band of the Settings equalizer sits (src/lib/eqScale.ts): its knob is drawn where its native
 * slider puts the thumb, top at +12 dB, bottom at -12 dB, the middle at 0, half a thumb in from each end,
 * every dB the same step.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL("../src/lib/eqScale.ts", import.meta.url))],
  bundle: true, platform: "node", format: "cjs", write: false, logLevel: "silent",
});
const module = { exports: {} };
new Function("require", "module", "exports", outputFiles[0].text)(require, module, module.exports);
const { eqY, EQ_RANGE } = module.exports;

const H = 160;
const T = 16;

test("a band's knob sits where the slider's thumb is: top at the most, bottom at the least, middle at 0", () => {
  assert.equal(eqY(EQ_RANGE, H, T), T / 2);
  assert.equal(eqY(-EQ_RANGE, H, T), H - T / 2);
  assert.equal(eqY(0, H, T), H / 2);
  for (let g = -EQ_RANGE; g < EQ_RANGE; g++) {
    assert.ok(Math.abs(eqY(g, H, T) - eqY(g + 1, H, T) - (H - T) / (2 * EQ_RANGE)) < 1e-9, `a dB is one step, at ${g}`);
  }
  assert.equal(eqY(99, H, T), T / 2, "out of range holds at the edge");
  assert.equal(eqY(-99, H, T), H - T / 2);
});
