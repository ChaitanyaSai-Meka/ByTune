/**
 * Reading a cover's colours (src/lib/coverColor.ts): what the panels that wear a cover's colour get
 * (palette.ts → the Home wash, album/playlist pages, lyrics, Now Playing). Covers here are made of
 * colour areas, with JPEG-like noise where it matters. A grey cover must stay grey, the colour that
 * covers most of a cover beats a small loud one, and warm covers mustn't turn to mud.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const mod = build({
  entryPoints: [fileURLToPath(new URL("../src/lib/coverColor.ts", import.meta.url))],
  bundle: true, format: "esm", platform: "node", write: false, logLevel: "silent",
}).then((r) => import(`data:text/javascript;base64,${Buffer.from(r.outputFiles[0].text).toString("base64")}`));

const SIZE = 64;
/** A cover of colour areas, top to bottom, each [rgb, share]; `noise` adds ±n per channel. */
function cover(areas, { noise = 0 } = {}) {
  const data = new Uint8ClampedArray(SIZE * SIZE * 4);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  const pixels = [];
  for (const [rgb, share] of areas) for (let i = 0; i < Math.round(share * SIZE * SIZE); i++) pixels.push(rgb);
  while (pixels.length < SIZE * SIZE) pixels.push(areas.at(-1)[0]);
  for (let i = 0; i < SIZE * SIZE; i++) {
    const [r, g, b] = pixels[i];
    data[i * 4] = r + rnd() * noise;
    data[i * 4 + 1] = g + rnd() * noise;
    data[i * 4 + 2] = b + rnd() * noise;
    data[i * 4 + 3] = 255;
  }
  return data;
}
const palette = async (areas, options) => {
  const { readCover, coverPalette } = await mod;
  return coverPalette(readCover(cover(areas, options), SIZE, SIZE));
};
/** How far apart a colour's channels are: 0 for a true grey. */
const spread = (rgb) => Math.max(...rgb) - Math.min(...rgb);
/** HSV hue in degrees and saturation, worked out here, apart from the code under test. */
function hsv([r, g, b]) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: (h * 60 + 360) % 360, s: max ? d / max : 0, v: max / 255 };
}
const valid = (rgb) => rgb.length === 3 && rgb.every((c) => Number.isInteger(c) && c >= 0 && c <= 255);

test("a black-and-white cover gets grey everywhere, never a red or brown tint", async () => {
  const p = await palette([[[108, 108, 108], 0.5], [[28, 28, 28], 0.3], [[222, 222, 222], 0.2]], { noise: 6 });
  for (const key of ["background", "wash", "elevated"]) assert.ok(spread(p[key]) <= 3, `${key} is grey: ${p[key]}`);
  assert.ok(Math.min(...p.accent) >= 200 && spread(p.accent) <= 3, `the accent is white: ${p.accent}`);
});

test("a warm cast on a black-and-white photo still reads as grey", async () => {
  const p = await palette([[[136, 130, 124], 0.6], [[40, 37, 34], 0.25], [[230, 226, 220], 0.15]], { noise: 5 });
  assert.ok(spread(p.elevated) <= 6, `elevated ${p.elevated}`);
  assert.ok(spread(p.background) <= 6, `background ${p.background}`);
});

test("a faint tint in a black-and-white photo (like Bloody Mary's) stays grey", async () => {
  // OKLab chroma about 0.037: above where colour clearly starts, far below a pale sky's 0.06.
  const p = await palette([[[98, 131, 129], 0.2], [[118, 118, 118], 0.5], [[30, 30, 30], 0.3]], { noise: 2 });
  assert.ok(spread(p.elevated) <= 4, `grey, not teal: ${p.elevated}`);
});

test("the colour covering most of a cover wins over a small skin tone and a logo", async () => {
  const p = await palette([
    [[150, 185, 215], 0.45], // a pale sky
    [[205, 150, 120], 0.2], // skin
    [[200, 30, 40], 0.03], // a red logo
    [[25, 25, 30], 0.32],
  ], { noise: 4 });
  const { h } = hsv(p.elevated);
  assert.ok(h > 180 && h < 250, `the wash is the sky's blue: ${p.elevated} (hue ${Math.round(h)})`);
});

test("a vivid red cover gets a red wash and a light red accent", async () => {
  const p = await palette([[[200, 20, 40], 0.8], [[20, 20, 20], 0.2]]);
  const wash = hsv(p.elevated);
  assert.ok(wash.h > 330 || wash.h < 20, `red: ${p.elevated}`);
  assert.ok(wash.s > 0.5, `and clearly red, not grey: ${p.elevated}`);
  const accent = hsv(p.accent);
  assert.ok((accent.h > 330 || accent.h < 25) && accent.v > 0.75, `a light red to read on the dark page: ${p.accent}`);
});

test("a pale cream cover gets a soft warm grey, not olive", async () => {
  const p = await palette([[[238, 231, 188], 0.7], [[220, 60, 50], 0.05], [[90, 140, 70], 0.05], [[240, 240, 235], 0.2]], { noise: 3 });
  assert.ok(hsv(p.elevated).s < 0.3, `not a strong olive: ${p.elevated}`);
});

test("a golden cover stays golden: warm, clearly coloured, not drained to mud", async () => {
  const p = await palette([[[205, 135, 30], 0.7], [[30, 20, 10], 0.3]], { noise: 4 });
  const { h, s } = hsv(p.elevated);
  assert.ok(h > 18 && h < 50, `orange-gold: ${p.elevated} (hue ${Math.round(h)})`);
  assert.ok(s > 0.55, `rich, not muddy: ${p.elevated}`);
});

test("the accent is the cover's most vivid colour, which needn't be its main one", async () => {
  const p = await palette([[[30, 45, 90], 0.7], [[240, 120, 20], 0.08], [[15, 15, 18], 0.22]], { noise: 3 });
  const wash = hsv(p.elevated);
  const accent = hsv(p.accent);
  assert.ok(wash.h > 200 && wash.h < 260, `the wash is the navy: ${p.elevated}`);
  assert.ok(accent.h > 15 && accent.h < 45, `the accent is the orange: ${p.accent}`);
});

test("a mostly grey cover with a small coloured detail gets only a hint of it", async () => {
  const p = await palette([[[120, 120, 120], 0.55], [[30, 30, 30], 0.4], [[210, 20, 30], 0.05]], { noise: 4 });
  assert.ok(hsv(p.elevated).s < 0.35, `a hint, not a red wash: ${p.elevated}`);
});

test("the Home glow is dimmed more for a light cover, so white text stays readable on it", async () => {
  const { readCover, glowBrightness } = await mod;
  const light = glowBrightness(readCover(cover([[[240, 236, 220], 1]]), SIZE, SIZE));
  const dark = glowBrightness(readCover(cover([[[30, 40, 90], 1]]), SIZE, SIZE));
  assert.ok(255 * light <= 128, `white comes out at most mid-grey under white text: ${light}`);
  assert.equal(dark, 0.62, "a dark cover keeps its glow");
  assert.equal(glowBrightness(null), 0.62, "not read yet: the usual glow");
});

test("every colour comes out as whole numbers in range, whatever the cover", async () => {
  const { readCover, coverPalette } = await mod;
  for (const areas of [
    [[[0, 0, 0], 1]],
    [[[255, 255, 255], 1]],
    [[[0, 255, 0], 1]],
    [[[0, 0, 255], 0.5], [[255, 255, 0], 0.5]],
  ]) {
    const p = coverPalette(readCover(cover(areas), SIZE, SIZE));
    for (const key of ["background", "wash", "elevated", "accent"]) assert.ok(valid(p[key]), `${key} ${p[key]}`);
  }
  // Nothing readable (fully transparent): the neutral palette.
  const clear = new Uint8ClampedArray(SIZE * SIZE * 4);
  const p = coverPalette(readCover(clear, SIZE, SIZE));
  assert.ok(spread(p.elevated) <= 3 && spread(p.background) <= 3);
});
