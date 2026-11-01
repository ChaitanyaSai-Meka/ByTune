import test from "node:test";
import assert from "node:assert/strict";
import { artistKey, normalizeTitle, pickSuggestions, recordingKey } from "../.test-build/radio-filter.mjs";

const song = (id, title, artist, extra = {}) => ({ id, title, artist, duration: 200, thumb: "", videoType: "song", ...extra });
const opts = (over = {}) => ({ excludeIds: new Set(), excludeKeys: new Set(), limit: 25, ...over });

test("the same recording's uploads share one key", () => {
  const key = recordingKey("Starboy", "The Weeknd");
  for (const title of ["Starboy (feat. Daft Punk)", "STARBOY [Official Video]", "Starboy - Official Audio", "Starboy feat. Daft Punk"]) {
    assert.equal(recordingKey(title, "The Weeknd, Daft Punk"), key, title);
  }
  assert.equal(normalizeTitle('All The Stars (From "Black Panther: The Album")'), "all the stars");
});

test("remix, live and acoustic versions stay separate songs", () => {
  const base = recordingKey("Lean On", "Major Lazer");
  assert.notEqual(recordingKey("Lean On (Remix)", "Major Lazer"), base);
  assert.notEqual(recordingKey("Lean On [Live]", "Major Lazer"), base);
  assert.notEqual(recordingKey("Lean On (Acoustic)", "Major Lazer"), base);
});

test("titles in any script keep their letters and marks", () => {
  for (const title of ["నాటు నాటు", "केसरिया", "夜に駆ける", "봄날", "Дорога"]) {
    assert.ok(normalizeTitle(title).length > 0, title);
  }
  assert.equal(recordingKey('నాటు నాటు (From "RRR")', "Rahul"), recordingKey("నాటు నాటు", "Rahul"));
  assert.notEqual(recordingKey("नाटू नाटू", "Rahul"), recordingKey("నాటు నాటు", "Rahul"));
  assert.equal(recordingKey("(Official Video)", "X"), "", "nothing comparable left: no title dedupe");
  assert.equal(artistKey("Calvin Harris & Ellie Goulding"), "calvin harris");
  assert.equal(artistKey("Lil Nas X"), "lil nas x");
});

test("caps each artist per batch, a little more for the seed's artist", () => {
  const many = (artist, n) => Array.from({ length: n }, (_, i) => song(`${artist}${i}`, `${artist} song ${i}`, artist));
  const picked = pickSuggestions([...many("Demi Lovato", 6), ...many("Taylor Swift", 5), song("k1", "Espresso", "Sabrina Carpenter")], opts({ seedArtist: "demi lovato" }));
  const count = (who) => picked.filter((t) => t.artist === who).length;
  assert.equal(count("Demi Lovato"), 3);
  assert.equal(count("Taylor Swift"), 2);
  assert.equal(count("Sabrina Carpenter"), 1);
});

test("artist ids win over names for the cap, when the radio supplies them", () => {
  const picked = pickSuggestions(
    [
      song("a1", "One", "Band", { artistId: "UCband" }),
      song("a2", "Two", "Band feat. X", { artistId: "UCband" }),
      song("a3", "Three", "The Band", { artistId: "UCband" }),
    ],
    opts()
  );
  assert.equal(picked.length, 2);
});

test("songs first; videos only when few songs survive; uploads only when nothing else does", () => {
  const video = (id) => song(id, `Video ${id}`, `V${id}`, { videoType: "video" });
  const upload = (id) => song(id, `Upload ${id}`, `U${id}`, { videoType: "upload" });
  const plenty = pickSuggestions([song("s1", "A", "a"), song("s2", "B", "b"), song("s3", "C", "c"), video("v1"), upload("u1")], opts());
  assert.deepEqual(plenty.map((t) => t.id), ["s1", "s2", "s3"]);
  const few = pickSuggestions([song("s1", "A", "a"), video("v1"), upload("u1")], opts());
  assert.deepEqual(few.map((t) => t.id), ["s1", "v1"]);
  const onlyUploads = pickSuggestions([upload("u1"), upload("u2")], opts());
  assert.deepEqual(onlyUploads.map((t) => t.id), ["u1", "u2"]);
});

test("drops clips, very long items and episodes; keeps unknown lengths", () => {
  const picked = pickSuggestions(
    [
      song("clip", "Clip", "a", { duration: 40 }),
      song("mix", "Mix", "b", { duration: 16 * 60 }),
      song("ep", "Episode", "c", { videoType: "episode" }),
      song("unknown", "Unknown length", "d", { duration: 0 }),
      song("ok", "Fine", "e", { duration: 230 }),
    ],
    opts()
  );
  assert.deepEqual(picked.map((t) => t.id), ["unknown", "ok"]);
});

test("never repeats what this session already queued, and returns plain tracks", () => {
  const picked = pickSuggestions(
    [song("heard", "Heard", "a"), song("dup", "Heart Attack (Official Video)", "Demi Lovato"), song("new", "New One", "b")],
    opts({ excludeIds: new Set(["heard"]), excludeKeys: new Set([recordingKey("Heart Attack", "Demi Lovato")]) })
  );
  assert.deepEqual(picked.map((t) => t.id), ["new"]);
  assert.equal("videoType" in picked[0], false, "radio-only fields never reach the queue");
});

test("respects the limit and drops duplicates within one batch", () => {
  const picked = pickSuggestions(
    [song("a", "Same", "x"), song("b", "Same (Lyric Video)", "x"), song("c", "Other", "y"), song("d", "Third", "z")],
    opts({ limit: 2 })
  );
  assert.deepEqual(picked.map((t) => t.id), ["a", "c"]);
});
