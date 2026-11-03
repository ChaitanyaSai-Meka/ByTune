import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseMoodCovers, parseMoods } from "../.test-build/ytm.mjs";

const read = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
const page = read("moods-page.json");
const category = read("mood-category-page.json");

test("the moods page keeps its own headings, in its own order", () => {
  const moods = parseMoods(page);
  assert.deepEqual([...new Set(moods.map((m) => m.section))], ["Moods & moments", "Genres"]);
  assert.equal(moods.filter((m) => m.section === "Moods & moments").length, 12);
  assert.ok(moods.filter((m) => m.section === "Genres").length >= 30);
  for (const m of moods) {
    assert.equal(m.browseId, "FEmusic_moods_and_genres_category");
    assert.match(m.params ?? "", /^[A-Za-z0-9_%=-]{1,300}$/, `${m.title}: params the IPC check lets through`);
    assert.ok(m.color === null || /^#[0-9a-f]{6}$/.test(m.color), `${m.title}: color`);
  }
});

test("a category page gives its first two playlist covers", () => {
  const covers = parseMoodCovers(category);
  assert.equal(covers.length, 2);
  assert.ok(covers.every((u) => u.startsWith("https://")));
  assert.notEqual(covers[0], covers[1]);
  assert.deepEqual(parseMoodCovers({}), []);
  assert.deepEqual(parseMoodCovers(null), []);
});

test("a category page gives its title and every shelf in order, without its music videos", async () => {
  const { parseMoodPage } = await import("../.test-build/ytm.mjs");
  const page = parseMoodPage(read("mood-telugu-page.json"));
  assert.equal(page.title, "Telugu");
  assert.deepEqual(page.shelves.map((s) => s.title), ["Featured playlists", "Community playlists", "Albums"]);
  const [featured, , albums] = page.shelves;
  assert.ok(featured.items.every((i) => i.kind === "playlist" && i.playlist.id && i.playlist.thumb.startsWith("https://")));
  assert.ok(albums.items.every((i) => i.kind === "album" && i.album.id.startsWith("MPREb")));
  assert.deepEqual(parseMoodPage({}), { title: "", shelves: [] });
});
