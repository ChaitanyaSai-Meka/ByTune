import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

/**
 * Home's algorithm: how a listen ends, how votes fade, who you're into
 * lately, heavy rotation, back-to-back pairs, old favourites, taste-ranked
 * playlists, the sides of your taste, and how the feed turns all of it into
 * rows — learned order, pinned rows, "Not interested".
 */
async function load(entry) {
  const { outputFiles } = await build({
    entryPoints: [fileURLToPath(new URL(entry, import.meta.url))],
    bundle: true, platform: "node", format: "cjs", write: false,
  });
  // This realm, so its arrays and maps deep-equal the test's own.
  const module = { exports: {} };
  vm.runInThisContext(`(function (module, exports) {${outputFiles[0].text}\n})`)(module, module.exports);
  return module.exports;
}
const taste = await load("../src/lib/recs/taste.ts");
const { findSides } = await load("../src/lib/recs/sides.ts");
const { buildHomeSections } = await load("../src/lib/recs/sections.ts");

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 3, 12);
const song = (id, artist, extra = {}) => ({ id, title: `t-${id}`, artist, duration: 200, thumb: `https://img/${id}`, ...extra });
const listen = (id, artist, daysAgo, out = "done") => ({ track: song(id, artist), at: NOW - daysAgo * DAY, heard: 150, out });

test("a listen ends as a skip, a part or a finish", () => {
  const { outcomeOf } = taste;
  assert.equal(outcomeOf(3, 200), null, "a click-through means nothing");
  assert.equal(outcomeOf(20, 200), "skip");
  assert.equal(outcomeOf(60, 200), "skip", "under 40% of the song is still walking away");
  assert.equal(outcomeOf(100, 200), "part");
  assert.equal(outcomeOf(150, 200), "done", "70% heard is a finish (crossfades end songs early)");
  assert.equal(outcomeOf(130, 0), "done", "unknown length: two minutes is a finish");
  assert.equal(outcomeOf(60, 0), "part");
});

test("lately: today's finishes outweigh last month's, and skips count against", () => {
  const entries = [
    ...Array.from({ length: 5 }, (_, i) => listen(`old${i}`, "Old Flame", 21 + i)),
    listen("n1", "New Crush", 0.2),
    listen("n2", "New Crush", 0.1),
    listen("s1", "Skipped Act", 0.1, "skip"),
    listen("s2", "Skipped Act", 0.05, "skip"),
  ];
  const lately = taste.latelyByArtist(entries, NOW);
  assert.ok(lately.get("new crush") > lately.get("old flame"), "two plays today beat five three weeks ago");
  assert.ok(lately.get("skipped act") < 0, "early skips are votes against");
  assert.ok(Math.abs(taste.fade(3 * DAY, 3 * DAY) - 0.5) < 1e-9, "a half-life halves");
});

test("heavy rotation: two real listens or more, recent, and not being skipped", () => {
  const entries = [
    listen("a", "A", 1), listen("a", "A", 0.5), listen("a", "A", 0.1),
    listen("b", "B", 2), listen("b", "B", 1),
    listen("once", "C", 0.1),
    listen("sour", "D", 3), listen("sour", "D", 2.5), listen("sour", "D", 0.2, "skip"), listen("sour", "D", 0.1, "skip"), listen("sour", "D", 0.05, "skip"),
    listen("stale", "E", 30), listen("stale", "E", 29),
  ];
  const ids = taste.heavyRotation(entries, NOW).map((r) => r.track.id);
  assert.deepEqual(ids, ["a", "b"], "once is not a habit; a song you now skip falls off; three weeks out of the window");
  assert.equal(taste.heavyRotation(entries, NOW)[0].listens, 3);
});

test("back to back: consecutive listens within half an hour, never across a skip", () => {
  const at = (min) => NOW - 120 * 60_000 + min * 60_000;
  const e = (id, artist, min, out = "done") => ({ track: song(id, artist), at: at(min), heard: 150, out });
  const pairs = taste.backToBack([e("1", "Sid Sriram", 0), e("2", "Anirudh", 4), e("3", "Sid Sriram", 8), e("4", "Anirudh", 12, "skip"), e("5", "Thaman S", 16), e("6", "Arijit Singh", 70)]);
  assert.equal(pairs.get(taste.pairKey("sid sriram", "anirudh")), 2);
  assert.equal(pairs.get(taste.pairKey("anirudh", "thaman s")), undefined, "a skip breaks the run");
  assert.equal(pairs.get(taste.pairKey("thaman s", "arijit singh")), undefined, "54 minutes apart is a new session");
});

test("dust off: real history, rested three weeks, not just skipped", () => {
  const t = (id, plays, daysAgo) => ({ id, title: id, artist: "X", thumb: "", plays, lastAt: NOW - daysAgo * DAY });
  const picked = taste.dustOff([t("loved", 12, 60), t("fresh", 20, 2), t("once", 1, 90), t("skipped", 9, 40), t("liked", 5, 30)], { played: new Set(), skipped: new Set(["skipped"]) }, NOW);
  assert.deepEqual(picked.map((x) => x.id), ["loved", "liked"]);
});

test("playlists rank by how much of their artist line you play", () => {
  assert.deepEqual(taste.artistsInLine("Arijit Singh, Pritam & Shreya Ghoshal and more"), ["arijit singh", "pritam", "shreya ghoshal"]);
  assert.deepEqual(taste.artistsInLine("Shiva Kumar • 15M views"), ["shiva kumar"]);
  assert.deepEqual(taste.artistsInLine("50 Cent, Simon and Garfunkel"), ["50 cent", "simon and garfunkel"], "names keep their digits and their 'and'");
  const lists = [{ id: "1", subtitle: "Diljit Dosanjh, Shubh" }, { id: "2", subtitle: "Arijit Singh, Pritam" }, { id: "3", subtitle: "Someone Else" }, { id: "4", subtitle: "Pritam" }];
  const ranked = taste.rankByTaste(lists, new Map([["arijit singh", 1], ["pritam", 0.4]]));
  assert.deepEqual(ranked.map((l) => l.id), ["2", "4", "1", "3"], "matches first, the rest in the provider's order");
});

test("sides: two scenes stay two sides; a bridging artist can't chain them; a loner gets none", () => {
  const a = (key, id, score) => ({ key, artistId: id, score });
  const artists = [a("sid", "S", 90), a("anirudh", "A", 80), a("thaman", "T", 70), a("arijit", "R", 85), a("pritam", "P", 75), a("shreya", "H", 60), a("bridge", "B", 50), a("loner", "L", 40)];
  const related = {
    S: ["A", "T"], A: ["S", "T", "B"], T: ["S", "A"],
    R: ["P", "H"], P: ["R", "H", "B"], H: ["R", "P"],
    B: ["A", "P"], L: [],
  };
  const sides = findSides(artists, (id) => related[id], new Map());
  const keys = sides.map((s) => s.map((x) => x.key).sort().join(","));
  assert.equal(sides.length, 2);
  assert.ok(keys.includes("anirudh,sid,thaman") || keys.includes("anirudh,bridge,sid,thaman"));
  assert.ok(keys.some((k) => k.startsWith("arijit")), JSON.stringify(keys));
  assert.ok(!keys.some((k) => k.includes("loner")), "a lone artist is no side");
  assert.ok(!keys.some((k) => k.includes("sid") && k.includes("arijit")), "the bridge doesn't merge the scenes");
  // Played back to back three times, two artists the catalogue doesn't link are one side.
  const heard = findSides([a("x", null, 10), a("y", null, 9)], () => null, new Map([[taste.pairKey("x", "y"), 3]]));
  assert.equal(heard.length, 1);
});

/* --------------------------------------------------------------- the feed */

const artist = (key, name, id, score, extra = {}) => ({
  key, name, artistId: id, thumb: null, msMonth: 0, playsMonth: 5, msAll: 0, playsAll: 10, lastPlayedAt: NOW - DAY,
  likedTracks: 0, skips: 0, searchHits: 0, lately: 0, score, ...extra,
});
const bundle = (id, name, related, songs) => ({
  artistId: id, name, thumb: null, fetchedAt: NOW, albums: [],
  related: related.map((r) => ({ id: r, name: r, thumb: "" })),
  topSongs: songs.map((s) => song(`${id}-${s}`, name)),
});
function feedProfile(extra = {}) {
  const sid = artist("sid sriram", "Sid Sriram", "S", 90, { lately: 3 });
  const ani = artist("anirudh", "Anirudh", "A", 80);
  const arijit = artist("arijit singh", "Arijit Singh", "R", 85);
  const pritam = artist("pritam", "Pritam", "P", 75);
  const plays = [song("p1", "Sid Sriram"), song("p2", "Anirudh"), song("p3", "Arijit Singh"), song("p4", "Pritam"), song("p5", "Sid Sriram")];
  return {
    maturity: "strong", artists: [sid, arijit, ani, pritam], lately: [sid], recentlyPlayed: plays, liked: [],
    playedTrackIds: new Set(plays.map((p) => p.id)), topTracks: [], searches: [], hours: new Array(24).fill(0), hourEnergy: 0.5, daySeed: 7,
    heavyRotation: plays.slice(0, 5).map((track, i) => ({ track, listens: 5 - i, score: 5 - i })),
    dustOff: ["d1", "d2", "d3", "d4", "d5"].map((id, i) => ({ track: song(id, "Old Favourite"), plays: 10 - i, lastAt: NOW - 60 * DAY })),
    pairs: new Map(), ...extra,
  };
}
const feedBundles = () =>
  new Map(
    [
      bundle("S", "Sid Sriram", ["A", "N1"], ["s1", "s2", "s3", "s4", "s5", "s6"]),
      bundle("A", "Anirudh", ["S", "N1"], ["a1", "a2", "a3", "a4", "a5", "a6"]),
      bundle("R", "Arijit Singh", ["P", "N2"], ["r1", "r2", "r3", "r4", "r5", "r6"]),
      bundle("P", "Pritam", ["R", "N2"], ["q1", "q2", "q3", "q4", "q5", "q6"]),
      bundle("N1", "Telugu Newcomer", ["S"], ["n1", "n2", "n3", "n4"]),
      bundle("N2", "Hindi Newcomer", ["R"], ["m1", "m2", "m3", "m4"]),
    ].map((b) => [b.artistId, b])
  );

test("the feed: your mixes are one per side, then heavy rotation; every mix three parts familiar to one part new", () => {
  const sections = buildHomeSections({ profile: feedProfile(), bundles: feedBundles(), ytShelves: null, now: NOW });
  const ids = sections.map((s) => s.id);
  assert.deepEqual(ids.slice(0, 3), ["jump-back-in", "your-mixes", "heavy-rotation"], ids.join(" → "));
  const mixes = sections[1].items;
  assert.deepEqual(mixes.filter((i) => i.style === "side").map((i) => i.letter), ["A", "B"]);
  const sideA = mixes[0];
  assert.match(sideA.caption, /Sid Sriram|Arijit Singh/);
  const tracks = sideA.source.tracks;
  const newcomer = (t) => /Newcomer/.test(t.artist);
  assert.equal(tracks.filter((t, i) => i % 4 === 3).every(newcomer), true, "every fourth song is new");
  assert.equal(tracks.slice(0, 3).some(newcomer), false, "the mix opens on what you know");
  assert.equal(sideA.fresh, tracks.filter(newcomer).length);
  assert.equal(sections.find((s) => s.id === "heavy-rotation").layout, "list");
  assert.equal(sections.every((s) => typeof s.kind === "string" && s.kind), true, "every row carries its kind");
});

test("the feed: rows you play from rise, but never above the pinned rows", () => {
  const base = buildHomeSections({ profile: feedProfile(), bundles: feedBundles(), ytShelves: null, now: NOW }).map((s) => s.id);
  assert.ok(base.indexOf("stations") > base.indexOf("dust-off"), base.join(" → "));
  const tapped = buildHomeSections({ profile: feedProfile(), bundles: feedBundles(), ytShelves: null, now: NOW, taps: { stations: 20 } }).map((s) => s.id);
  assert.ok(tapped.indexOf("stations") < tapped.indexOf("dust-off"), tapped.join(" → "));
  const eager = buildHomeSections({ profile: feedProfile(), bundles: feedBundles(), ytShelves: null, now: NOW, taps: { "dust-off": 500 } }).map((s) => s.id);
  assert.equal(eager[0], "jump-back-in", "what you just played stays first");
});

test("the feed: a 'Not interested' song is gone from every row and mix", () => {
  const hidden = new Set(["p1", "d1", "S-s1"]);
  const sections = buildHomeSections({ profile: feedProfile(), bundles: feedBundles(), ytShelves: null, now: NOW, hidden });
  const everywhere = sections.flatMap((s) => s.items.flatMap((i) => (i.style === "track" ? [i.track.id] : i.style === "side" ? i.source.tracks.map((t) => t.id) : [])));
  for (const id of hidden) assert.ok(!everywhere.includes(id), `${id} should be hidden`);
});

test("the feed: the artist rows lean on who you're into lately", () => {
  const sections = buildHomeSections({ profile: feedProfile(), bundles: feedBundles(), ytShelves: null, now: NOW });
  const firstMoreLike = sections.find((s) => s.kind === "more-like");
  assert.equal(firstMoreLike.anchorKey, "sid sriram", "lately beats the long-term top artist (Arijit Singh)");
});
