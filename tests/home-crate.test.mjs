import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

/**
 * Home's "Playlists for you" crate: the market feed's playlists, YouTube
 * Music's own (RDCLAK5uy_ ids) ahead of community uploads, right under Jump
 * back in for every listener, and never repeated as a row of the same shelf.
 */
async function loadSections() {
  const { outputFiles } = await build({
    entryPoints: [fileURLToPath(new URL("../src/lib/recs/sections.ts", import.meta.url))],
    bundle: true, platform: "node", format: "cjs", write: false,
  });
  // This realm, so its arrays deep-equal the test's own.
  const module = { exports: {} };
  vm.runInThisContext(`(function (module, exports) {${outputFiles[0].text}\n})`)(module, module.exports);
  return module.exports;
}

const track = (id) => ({ id, title: `t-${id}`, artist: "Someone", duration: 200, thumb: "" });
const pl = (id) => ({ kind: "playlist", playlist: { id, title: `p-${id}`, thumb: "" } });
const profile = (maturity, plays) => ({
  maturity, artists: [], recentlyPlayed: plays.map(track), playedTrackIds: new Set(), liked: [], topTracks: [],
  searches: [], hours: new Array(24).fill(0), hourEnergy: 0.5, daySeed: 1,
  lately: [], heavyRotation: [], dustOff: [], pairs: new Map(),
});
const market = [
  { title: "Quick picks", items: ["q1", "q2", "q3"].map((id) => ({ kind: "track", track: track(id) })) },
  { title: "Trending community playlists", items: [pl("VLPLa"), pl("VLPLb"), pl("VLPLc")] },
  { title: "Romance Right Now", items: [pl("VLRDCLAK5uy_1"), pl("VLRDCLAK5uy_2"), pl("VLPLa"), pl("VLRDCLAK5uy_3"), pl("VLRDCLAK5uy_4")] },
];

test("the crate sits right under Jump back in, YouTube's own playlists first, each once", async () => {
  const { buildHomeSections } = await loadSections();
  const sections = buildHomeSections({ profile: profile("strong", ["a", "b", "c", "d", "e"]), bundles: new Map(), ytShelves: null, market });
  assert.deepEqual(sections.slice(0, 2).map((s) => s.id), ["jump-back-in", "playlists-for-you"]);
  const crate = sections[1];
  assert.equal(crate.layout, "crate");
  assert.equal(crate.title, "Playlists for you");
  assert.deepEqual(crate.playlists.map((p) => p.id), ["VLRDCLAK5uy_1", "VLRDCLAK5uy_2", "VLRDCLAK5uy_3", "VLRDCLAK5uy_4", "VLPLa", "VLPLb", "VLPLc"]);
});

test("no crate with fewer than six playlists, or without the market feed", async () => {
  const { buildHomeSections } = await loadSections();
  const thin = [{ title: "Few", items: ["VLPL1", "VLPL2", "VLPL3", "VLPL4", "VLPL5"].map(pl) }];
  for (const m of [thin, null, undefined]) {
    const sections = buildHomeSections({ profile: profile("strong", ["a", "b", "c", "d"]), bundles: new Map(), ytShelves: null, market: m });
    assert.ok(!sections.some((s) => s.layout === "crate"), `no crate for ${JSON.stringify(m)?.slice(0, 20)}`);
  }
});

test("a new listener's market rows skip the playlist shelves the crate already holds", async () => {
  const { buildHomeSections } = await loadSections();
  const withCrate = buildHomeSections({ profile: profile("cold", []), bundles: new Map(), ytShelves: market, market });
  assert.equal(withCrate[0].id, "playlists-for-you", "with nothing to jump back into, the crate leads");
  assert.deepEqual(withCrate.filter((s) => s.layout === "yt-shelf").map((s) => s.title), ["Quick picks"]);

  // Without a crate, the playlist shelves stay rows as before.
  const thin = [market[0], market[1]];
  const noCrate = buildHomeSections({ profile: profile("cold", []), bundles: new Map(), ytShelves: thin, market: thin });
  assert.deepEqual(noCrate.filter((s) => s.layout === "yt-shelf").map((s) => s.title), ["Quick picks", "Trending community playlists"]);
});
