import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { parseSearchSuggestions, withSearchRows } from "../.test-build/ytm.mjs";

// A real /music/get_search_suggestions answer for "taylor swift" (hl=en, gl=IN):
// six completions, then an artist, two songs, an album and a third song.
const FIXTURE = JSON.parse(fs.readFileSync(new URL("./fixtures/search-suggestions.json", import.meta.url), "utf8"));
const QUERY = "taylor swift";

const song = (id, title, artist) => ({ id, title, artist, duration: 200, thumb: "" });
const browse = (browseId, title, type, subtitle = "") => ({ browseId, title, subtitle, thumb: "", type });

test("up to 3 completions, never the typed query echoed back", () => {
  const texts = parseSearchSuggestions(FIXTURE, QUERY).filter((s) => !s.kind);
  assert.deepEqual(
    texts.map((s) => s.text),
    ["taylor swift songs", "taylor swift love story", "taylor swift ophelia"],
    "the echo row is dropped and the other five are capped at three",
  );
});

test("rich rows: a song plays, an artist and an album open, each with YouTube's own line", () => {
  const rich = parseSearchSuggestions(FIXTURE, QUERY).filter((s) => s.kind);
  assert.deepEqual(rich.map((s) => [s.kind, s.text]), [
    ["artist", "Taylor Swift"],
    ["song", "Love Story"],
    ["song", "The Fate of Ophelia"],
    ["album", "Lover"],
    ["song", "I Knew You Were Trouble (Taylor's Version)"],
  ]);

  const [artist, loveStory, , lover] = rich;
  assert.equal(loveStory.id, "aZ1hziFhj1o");
  assert.equal(loveStory.subtitle, "Song • Taylor Swift • 1.2B plays");
  assert.deepEqual(
    [loveStory.track.id, loveStory.track.title, loveStory.track.artist, loveStory.track.artistId],
    ["aZ1hziFhj1o", "Love Story", "Taylor Swift", "UCPC0L1d253x-KuMNwa05TpA"],
  );
  assert.ok(loveStory.thumb.startsWith("https://"));

  // The typeahead prints only the audience for an artist; the row leads with the kind.
  assert.equal(artist.subtitle, "Artist • 424M monthly audience");
  assert.deepEqual([artist.id, artist.browse.browseId, artist.browse.type], ["UCPC0L1d253x-KuMNwa05TpA", "UCPC0L1d253x-KuMNwa05TpA", "artist"]);

  assert.equal(lover.subtitle, "Album • Taylor Swift • 2019");
  assert.deepEqual([lover.id, lover.browse.type, lover.track], ["MPREb_6oiqzmwuS9F", "album", undefined]);
});

test("the echo check folds case and Unicode normal form", () => {
  const row = (t) => ({ searchSuggestionRenderer: { suggestion: { runs: [{ text: t }] } } });
  const response = { contents: [{ searchSuggestionsSectionRenderer: { contents: [row("Beyoncé"), row("beyoncé halo"), row("BEYONCÉ HALO")] } }] };
  // Typed decomposed (e + combining acute) and upper-case: still the same text.
  const texts = parseSearchSuggestions(response, "BEYONCÉ").map((s) => s.text);
  assert.deepEqual(texts, ["beyoncé halo"], "the echo goes, and a case-only repeat counts once");
});

test("the same row twice is listed once", () => {
  const doubled = { contents: [...FIXTURE.contents, ...FIXTURE.contents] };
  assert.deepEqual(parseSearchSuggestions(doubled, QUERY), parseSearchSuggestions(FIXTURE, QUERY));
});

test("search rows top the rich rows up to 12, skipping ids already listed", () => {
  const items = parseSearchSuggestions(FIXTURE, QUERY);
  const rows = [
    { kind: "top", song: song("aZ1hziFhj1o", "Love Story", "Taylor Swift") }, // already a suggestion
    { kind: "browse", item: browse("UCPC0L1d253x-KuMNwa05TpA", "Taylor Swift", "artist") }, // already a suggestion
    { kind: "browse", item: browse("UCprofile00000000000000", "Some profile", "other") }, // no page to open
    { kind: "browse", item: browse("MPREb_reputation", "reputation", "album", "Album • Taylor Swift • 2017") },
    ...Array.from({ length: 20 }, (_, i) => ({ kind: "track", song: song(`extra${String(i).padStart(6, "0")}`, `Extra ${i}`, "Taylor Swift") })),
  ];
  const merged = withSearchRows(items, rows);

  assert.deepEqual(merged.slice(0, items.length), items, "suggestions keep their place, appended to never reordered");
  const rich = merged.filter((s) => s.kind);
  assert.equal(rich.length, 12, "capped at 12 rich rows");
  assert.equal(merged.filter((s) => !s.kind).length, 3, "text rows untouched");
  assert.equal(new Set(rich.map((s) => s.id)).size, 12, "every id once");
  assert.ok(!rich.some((s) => s.id === "UCprofile00000000000000"));

  const [reputation, extra0] = rich.slice(5);
  assert.deepEqual([reputation.kind, reputation.subtitle], ["album", "Album • Taylor Swift • 2017"]);
  assert.deepEqual([extra0.kind, extra0.subtitle, extra0.track.id], ["song", "Song • Taylor Swift", "extra000000"]);
});

test("one recording under two ids (its song and its video) is listed once", () => {
  const rows = [
    { kind: "track", song: song("songIdAAAAA", "We Don't Talk Anymore (feat. Selena Gomez)", "Charlie Puth") },
    { kind: "track", song: song("videoIdBBBB", "We Don't Talk Anymore (feat. Selena Gomez)", "Charlie Puth") },
    { kind: "track", song: song("remixIdCCCC", "We Don't Talk Anymore (Remix)", "Charlie Puth") },
  ];
  const ids = withSearchRows([], rows).map((s) => s.id);
  assert.deepEqual(ids, ["songIdAAAAA", "remixIdCCCC"]);
});
