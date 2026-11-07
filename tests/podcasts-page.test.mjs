/**
 * Explore's podcasts section against a REAL YouTube Music podcasts page
 * (browseId FEmusic_non_music_audio, anonymous session, India catalog,
 * trimmed to five of its shelves). Shows must open the show page the
 * music:podcast channel accepts; episodes must carry the episode mark that
 * keeps them out of Replay, the taste profile and AutoPlay.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parsePodcastShelves } from "../.test-build/ytm.mjs";

const raw = JSON.parse(readFileSync(new URL("./fixtures/podcasts-page.json", import.meta.url), "utf8"));
const [showsShelf, episodesShelf] = raw.contents.singleColumnBrowseResultsRenderer.tabs[0].tabRenderer.content.sectionListRenderer.contents.map(
  (c) => c.musicCarouselShelfRenderer
);
const page = (header, contents) => ({ contents: [{ musicCarouselShelfRenderer: { header, contents } }] });

test("the page's shelves come out in YouTube's order, shows and episodes apart", () => {
  assert.deepEqual(
    parsePodcastShelves(raw).map((s) => [s.title, s.shows.length, s.episodes.length]),
    [
      ["Popular shows", 4, 0],
      ["Popular episodes", 0, 4],
      ["Economics", 0, 3],
      ["Finances", 0, 2],
      ["Public speaking", 0, 2],
    ]
  );
});

test("show cards carry the MPSP page the show view opens", () => {
  const { shows } = parsePodcastShelves(raw)[0];
  for (const show of shows) {
    assert.match(show.id, /^MPSP[A-Za-z0-9_-]{8,80}$/, "the id music:podcast accepts");
    assert.ok(show.title && show.author, show.id);
    assert.match(show.thumb, /^https:\/\//, show.id);
  }
  assert.deepEqual(
    { id: shows[0].id, title: shows[0].title, author: shows[0].author },
    { id: "MPSPPLE0Jo6NF_JYO5-phess8GKafKMtPv3tfZ", title: "Figuring Out With Raj Shamani", author: "Raj Shamani" }
  );
});

test("episode rows play as podcast episodes, credited to their show", () => {
  const episodes = parsePodcastShelves(raw).flatMap((s) => s.episodes);
  assert.equal(episodes.length, 11);
  for (const ep of episodes) {
    assert.match(ep.id, /^[A-Za-z0-9_-]{11}$/, "a bare video id music:stream plays");
    assert.equal(ep.episode, true, "kept out of Replay, taste and AutoPlay");
    assert.ok(ep.title && ep.artist && ep.thumb, ep.id);
    assert.equal(ep.album, ep.artist, "the show, as on the show page");
  }
  const first = episodes[0];
  assert.deepEqual(
    { id: first.id, artist: first.artist, thumb: first.thumb, published: first.published },
    { id: "P2SXYS7a9GU", artist: "Mid Day Mudda", thumb: "https://i.ytimg.com/vi/P2SXYS7a9GU/hq720.jpg", published: "1d ago" }
  );
});

test("episode lengths come off the row's printed duration", () => {
  const lengths = Object.fromEntries(parsePodcastShelves(raw).map((s) => [s.title, s.episodes.map((e) => e.duration)]));
  assert.deepEqual(lengths["Popular episodes"], [37 * 60, 39 * 60, 22 * 60, 16 * 60]);
  assert.deepEqual(lengths.Economics, [96 * 60, 8 * 60 + 58, 148 * 60]); // 1 hr 36 min, 8 min 58 sec, 2 hr 28 min
  assert.deepEqual(lengths.Finances, [4 * 3600, 3600 + 60]); // 4 hr, 1 hr 1 min
  assert.deepEqual(lengths["Public speaking"], [89, 43]); // 1 min 29 sec, 43 sec
});

test("a length printed in another language lists 0, for the player to learn", () => {
  const row = structuredClone(episodesShelf.contents[0]);
  row.musicMultiRowListItemRenderer.playbackProgress.musicPlaybackProgressRenderer.durationText = {
    runs: [{ text: " • " }, { text: "1 Std. 5 Min." }],
  };
  const [shelf] = parsePodcastShelves(page(episodesShelf.header, [row]));
  assert.equal(shelf.episodes[0].duration, 0);
  assert.equal(shelf.episodes[0].episode, true);
});

test("cards that don't open a show and rows without a video are left out", () => {
  const album = structuredClone(showsShelf.contents[0]);
  album.musicTwoRowItemRenderer.navigationEndpoint.browseEndpoint.browseId = "MPREb_abcdefghijk";
  const silent = structuredClone(episodesShelf.contents[0]);
  delete silent.musicMultiRowListItemRenderer.onTap;
  assert.deepEqual(parsePodcastShelves(page(showsShelf.header, [album, silent])), [], "an emptied shelf is dropped");
  assert.deepEqual(parsePodcastShelves(null), []);
  assert.deepEqual(parsePodcastShelves({}), []);
});
