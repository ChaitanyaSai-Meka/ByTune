/**
 * The onboarding's drum of covers, as data (src/lib/coverDrum.ts): every ring is full, each cover
 * shows once and is real album art, the songs are the ones asked for (mostly English, Spanish and
 * phonk, a few Indian, every ring a mix), and the place facing the viewer follows a ring's turn,
 * both ways round.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL("../src/lib/coverDrum.ts", import.meta.url))],
  bundle: true, platform: "node", format: "cjs", write: false, logLevel: "silent",
});
const module = { exports: {} };
new Function("require", "module", "exports", outputFiles[0].text)(require, module, module.exports);
const { DRUM, RINGS, PER_RING, STEP, frontTile } = module.exports;

const all = DRUM.flat();

test("every ring is full, and each cover is real album art, shown once", () => {
  assert.equal(RINGS, 5);
  assert.equal(DRUM.length, RINGS);
  for (const ring of DRUM) assert.equal(ring.length, PER_RING);
  assert.equal(new Set(all.map((c) => c.art)).size, all.length, "no cover twice");
  assert.equal(new Set(all.map((c) => `${c.title}|${c.artist}`)).size, all.length, "no song twice");
  for (const c of all) {
    // Square album art at the app's cover size; a music video's frame (i.ytimg.com) would be 16:9.
    assert.match(c.art, /^https:\/\/yt3\.googleusercontent\.com\/[\w-]+=w544-h544(-[a-z0-9]+)*$/, c.title);
    assert.ok(c.title.trim() && c.artist.trim(), "named");
  }
});

test("the songs are mostly English, Spanish and phonk, with a few Indian, and every ring mixes them", () => {
  const count = (kind) => all.filter((c) => c.kind === kind).length;
  const indian = count("indian");
  assert.ok(indian >= 4 && indian <= all.length * 0.15, `${indian} Indian`);
  assert.equal(count("english") + count("spanish") + count("phonk") + indian, all.length, "nothing else");
  assert.ok(count("english") > count("spanish") && count("spanish") >= 10 && count("phonk") >= 10);
  for (const [r, ring] of DRUM.entries()) {
    assert.ok(new Set(ring.map((c) => c.kind)).size >= 3, `ring ${r} mixes them`);
  }
});

test("the place facing the viewer follows the ring's turn, both ways round", () => {
  assert.equal(frontTile(0), 0);
  assert.equal(frontTile(-STEP), 1, "turned back one step: the next place comes round");
  assert.equal(frontTile(STEP), PER_RING - 1);
  assert.equal(frontTile(-STEP * 0.4), 0, "less than half a step: still the same one");
  assert.equal(frontTile(-STEP * 0.6), 1);
  assert.equal(frontTile(-360 - STEP * 2), 2, "whole turns don't matter");
  assert.equal(frontTile(3600 + STEP * 3), PER_RING - 3);
});
