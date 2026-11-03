import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
const require = createRequire(import.meta.url);

/**
 * The taste profile must personalize from the account's own library, not only
 * from listening stats. Stats live on the device that recorded them, so a
 * restored account (cleared app data, new machine, or any build older than
 * stats sync) used to read as "cold" and the Home feed fell back to YouTube's
 * generic shelves — exactly what "the feed is resetting" reported.
 */
async function loadProfile() {
  const { outputFiles } = await build({
    entryPoints: [fileURLToPath(new URL("../src/lib/recs/profile.ts", import.meta.url))],
    bundle: true, platform: "node", format: "cjs", write: false, external: ["electron"],
  });
  const module = { exports: {} };
  vm.runInNewContext(outputFiles[0].text, {
    module, exports: module.exports, console, Buffer, setTimeout, clearTimeout, require,
    process: { env: {}, version: "v0" }, global: {},
  });
  return module.exports;
}

const track = (id, artist, extra = {}) => ({
  id, title: `t-${id}`, artist, duration: 210, thumb: "", ...extra,
});
const now = Date.now();

// A month of plays, as the stats summary would report them.
const statsSummary = (plays) => ({
  totalMs: plays * 210_000, plays,
  tracks: plays > 0 ? [{ id: "s1", title: "s", artist: "Stats Artist", thumb: "", ms: 210_000 * plays, plays, lastAt: now }] : [],
  artists: plays > 0 ? [{ name: "Stats Artist", ms: 210_000 * plays, plays }] : [],
  albums: [],
  hours: new Array(24).fill(0),
  days: [],
  period: "all",
  months: [],
});

const library = {
  history: [track("h1", "Arijit Singh"), track("h2", "Arijit Singh"), track("h3", "The Weeknd"), track("h4", "The Weeknd"), track("h5", "Lana Del Rey")],
  liked: [track("l1", "Lana Del Rey"), track("l2", "Lana Del Rey"), track("l3", "Kendrick Lamar")],
  playlists: [],
};

test("a restored library personalizes the feed even with zero listening stats", async () => {
  const { computeTasteProfile } = await loadProfile();
  const p = computeTasteProfile({
    all: statsSummary(0), month: statsSummary(0),
    ...library, searches: [], skips: {}, now,
  });
  const names = p.artists.map((a) => String(a.name));
  assert.deepEqual([...new Set(names)].sort(), ["Arijit Singh", "Kendrick Lamar", "Lana Del Rey", "The Weeknd"].sort());
  // A like is a preference, but a play is what builds listening time.
  const arijit = p.artists.find((a) => a.name === "Arijit Singh");
  const lana = p.artists.find((a) => a.name === "Lana Del Rey");
  const kendrick = p.artists.find((a) => a.name === "Kendrick Lamar");
  assert.equal(arijit.playsAll, 2);
  assert.equal(arijit.msAll, 2 * 210_000, "history entries carry listening time");
  assert.equal(lana.playsAll, 1, "history play credited once even when also liked");
  assert.equal(lana.likedTracks, 2);
  assert.equal(kendrick.playsAll, 0, "likes are never counted as plays");
  assert.equal(kendrick.msAll, 0);
  assert.equal(kendrick.likedTracks, 1);
  assert.ok(kendrick.score > 0, "a like alone still puts an artist on the feed");
  // Never mistaken for a brand-new listener.
  assert.equal(p.maturity, "light");
  assert.equal(p.recentlyPlayed.length, 5);
});

test("library signals never double count artists stats already cover", async () => {
  const { computeTasteProfile } = await loadProfile();
  const stats = statsSummary(40); // "Stats Artist" only
  const p = computeTasteProfile({
    all: stats, month: stats,
    history: [...library.history, track("h9", "Stats Artist")],
    liked: [...library.liked, track("l9", "Stats Artist")],
    playlists: [], searches: [], skips: {}, now,
  });
  const statsArtist = p.artists.find((a) => a.name === "Stats Artist");
  // 40 plays from stats — the library's extra play/like must not be added on top.
  assert.equal(statsArtist.playsAll, 40);
  assert.equal(statsArtist.likedTracks, 1, "likes still count as the like signal");
  assert.equal(p.artists.find((a) => a.name === "Arijit Singh").playsAll, 2);
});
test("an account with no data at all is still cold", async () => {
  const { computeTasteProfile } = await loadProfile();
  const p = computeTasteProfile({
    all: statsSummary(0), month: statsSummary(0),
    history: [], liked: [], playlists: [], searches: [], skips: {}, now,
  });
  assert.equal(p.maturity, "cold");
  assert.deepEqual([...p.artists], []);
});

test("real listening stats outrank library fallback for the same artist", async () => {
  const { computeTasteProfile } = await loadProfile();
  const stats = statsSummary(120);
  const withStats = computeTasteProfile({
    all: stats, month: stats, ...library,
    searches: [], skips: {}, now,
  });
  const statsArtist = [...withStats.artists].find((a) => a.name === "Stats Artist");
  assert.ok(statsArtist, "stats-driven artist present");
  assert.ok(statsArtist.score > withStats.artists.find((a) => a.name === "Arijit Singh").score);
});

test("followed artists join the taste profile with their own page id", async () => {
  const { computeTasteProfile } = await loadProfile();
  const p = computeTasteProfile({
    all: statsSummary(0), month: statsSummary(0),
    ...library, searches: [], skips: {}, now,
    followed: [{ id: "UCanirudh", name: "Anirudh Ravichander", thumb: "https://x/a.jpg" }],
  });
  const anirudh = p.artists.find((a) => a.name === "Anirudh Ravichander");
  assert.ok(anirudh, "a followed artist is in the profile before any play");
  assert.equal(anirudh.artistId, "UCanirudh");
  assert.ok(anirudh.score > 0, "and is scored onto the feed");
});

test("the journal moves who you're into lately; old skips fade; 'Not interested' pushes an artist back", async () => {
  const { computeTasteProfile } = await loadProfile();
  const base = { all: statsSummary(0), month: statsSummary(0), ...library, searches: [], now };
  const hour = 3_600_000;
  const done = (id, artist, hoursAgo) => ({ track: track(id, artist), at: now - hoursAgo * hour, heard: 200, out: "done" });

  // Kendrick Lamar is only a like in the library; three finished listens today put him on top.
  const before = computeTasteProfile({ ...base, skips: {} });
  const after = computeTasteProfile({ ...base, skips: {}, journal: [done("k1", "Kendrick Lamar", 3), done("k1", "Kendrick Lamar", 2), done("k2", "Kendrick Lamar", 1)] });
  assert.notEqual(before.artists[0].name, "Kendrick Lamar");
  assert.equal(after.artists[0].name, "Kendrick Lamar");
  assert.equal(after.lately[0].name, "Kendrick Lamar");
  assert.deepEqual(Array.from(after.heavyRotation, (r) => r.track.id), ["k1"], "played twice today: heavy rotation");
  assert.ok(after.playedTrackIds.has("k2"), "journal listens count as played");

  // Four skips of Arijit four months ago barely matter now; four this morning do.
  const day = 86_400_000;
  const oldSkips = computeTasteProfile({ ...base, skips: { "arijit singh": { count: 4, updatedAt: now - 120 * day } } });
  const newSkips = computeTasteProfile({ ...base, skips: { "arijit singh": { count: 4, updatedAt: now - hour } } });
  const score = (p) => p.artists.find((a) => a.name === "Arijit Singh").score;
  assert.ok(score(oldSkips) - score(newSkips) > 25, `${score(oldSkips)} vs ${score(newSkips)}`);

  // Two "Not interested" marks on The Weeknd's songs drop him below Lana Del Rey.
  const order = (p) => p.artists.map((a) => a.name);
  const plain = computeTasteProfile({ ...base, skips: {} });
  const hidden = computeTasteProfile({ ...base, skips: {}, hiddenArtists: { "the weeknd": { n: 2, at: now } } });
  assert.ok(order(plain).indexOf("The Weeknd") < order(plain).indexOf("Lana Del Rey"));
  assert.ok(order(hidden).indexOf("The Weeknd") > order(hidden).indexOf("Lana Del Rey"));
});
