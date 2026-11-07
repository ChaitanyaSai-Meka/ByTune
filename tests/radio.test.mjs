import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { parseRadioPage, parseResponsiveListItem } from "../.test-build/ytm.mjs";

// Captured 2026-11-01 from YouTube Music (`next` on RDAMVM<id>, seed "Cool for
// the Summer" by Demi Lovato), trimmed to the queue panel.
const SEED = "QLj6W87lWII";
const load = (name) => JSON.parse(fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));

const artistRun = (text, id) => ({
  text,
  navigationEndpoint: {
    browseEndpoint: {
      browseId: id,
      browseEndpointContextSupportedConfigs: { browseEndpointContextMusicConfig: { pageType: "MUSIC_PAGE_TYPE_ARTIST" } },
    },
  },
});
const albumRun = (text, id) => ({
  text,
  navigationEndpoint: {
    browseEndpoint: {
      browseId: id,
      browseEndpointContextSupportedConfigs: { browseEndpointContextMusicConfig: { pageType: "MUSIC_PAGE_TYPE_ALBUM" } },
    },
  },
});
const panelRow = (videoId, title, type, extra = {}) => ({
  videoId,
  title: { runs: [{ text: title }] },
  longBylineText: { runs: [artistRun("Band", "UCband"), { text: " • " }, albumRun("Record", "MPRErec"), { text: " • " }, { text: "2020" }] },
  lengthText: { runs: [{ text: "3:30" }] },
  thumbnail: { thumbnails: [{ url: "https://lh3.googleusercontent.com/x=w544-h544", width: 544, height: 544 }] },
  navigationEndpoint: {
    watchEndpoint: {
      videoId,
      watchEndpointMusicSupportedConfigs: { watchEndpointMusicConfig: { musicVideoType: type } },
    },
  },
  ...extra,
});
const firstPage = (contents) => ({
  contents: {
    singleColumnMusicWatchNextResultsRenderer: {
      tabbedRenderer: {
        watchNextTabbedResultsRenderer: {
          tabs: [{ tabRenderer: { content: { musicQueueRenderer: { content: { playlistPanelRenderer: { contents } } } } } }],
        },
      },
    },
  },
});

test("first radio page: catalogue songs with credits, the seed's own credits, and the next token", () => {
  const page = parseRadioPage(load("radio-first.json"), SEED);
  assert.equal(page.tracks.length, 15, "16 rows minus the seed");
  assert.ok(page.tracks.every((t) => t.videoType === "song"));
  assert.ok(!page.tracks.some((t) => t.id === SEED), "the seed itself never comes back as a suggestion");
  assert.equal(new Set(page.tracks.map((t) => t.id)).size, page.tracks.length);
  assert.deepEqual(page.seed, { artist: "Demi Lovato", artistId: "UCwem2sj-QUJCiWiPAo9JuAw" });
  assert.equal(typeof page.next, "string");
  assert.ok(page.next.length > 10);
  const [heart] = page.tracks;
  assert.equal(heart.id, "8DmPZaCLMcE");
  assert.equal(heart.title, "Heart Attack");
  assert.equal(heart.artist, "Demi Lovato");
  assert.equal(heart.artistId, "UCwem2sj-QUJCiWiPAo9JuAw");
  assert.equal(heart.album, "Demi");
  assert.equal(heart.duration, 211);
  assert.match(heart.thumb, /^https:\/\//);
  const duet = page.tracks.find((t) => t.id === "9jdLnFYQh4s");
  assert.equal(duet.artist, "Kendrick Lamar & SZA", "the byline keeps every credited artist");
});

test("continuation page parses from continuationContents and carries the next token on", () => {
  const page = parseRadioPage(load("radio-continuation.json"), SEED);
  assert.equal(page.tracks.length, 12);
  assert.equal(page.seed, null, "later pages don't repeat the seed row");
  assert.equal(typeof page.next, "string");
  assert.ok(page.tracks.every((t) => t.title && t.artist && t.duration > 0));
});

test("a song/video pair keeps the song; unplayable rows, the seed and the automix preview are skipped", () => {
  const res = firstPage([
    { playlistPanelVideoRenderer: panelRow("seedSEEDsee", "Seed song", "MUSIC_VIDEO_TYPE_ATV", { selected: true }) },
    {
      playlistPanelVideoWrapperRenderer: {
        primaryRenderer: { playlistPanelVideoRenderer: panelRow("videoVIDEOv", "Tune (Official Video)", "MUSIC_VIDEO_TYPE_OMV") },
        counterpart: [{ counterpartRenderer: { playlistPanelVideoRenderer: panelRow("songSONGson", "Tune", "MUSIC_VIDEO_TYPE_ATV") } }],
      },
    },
    { playlistPanelVideoRenderer: panelRow("deadDEADdea", "Gone", "MUSIC_VIDEO_TYPE_ATV", { unplayableText: { runs: [{ text: "Unavailable" }] } }) },
    { playlistPanelVideoRenderer: panelRow("longLONGlon", "Mix", "MUSIC_VIDEO_TYPE_UGC", { lengthText: { runs: [{ text: "1:02:33" }] } }) },
    { automixPreviewVideoRenderer: { content: {} } },
  ]);
  const page = parseRadioPage(res, "seedSEEDsee");
  assert.deepEqual(page.tracks.map((t) => t.id), ["songSONGson", "longLONGlon"]);
  assert.equal(page.tracks[0].videoType, "song");
  assert.equal(page.tracks[1].videoType, "upload");
  assert.equal(page.tracks[1].duration, 3753, "h:mm:ss lengths parse");
  assert.deepEqual(page.seed, { artist: "Band", artistId: "UCband" });
  assert.equal(page.next, null);
  assert.equal(page.tracks[0].albumId, "MPRErec");
});

test("search rows: hour-long lengths parse, and artist/album links come from the column text runs", () => {
  const row = parseResponsiveListItem({
    playlistItemData: { videoId: "abcdefghijk" },
    flexColumns: [
      { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: "Long Mix" }] } } },
      {
        musicResponsiveListItemFlexColumnRenderer: {
          text: {
            runs: [
              artistRun("Artist A", "UCaaa"),
              { text: " & " },
              { text: "Artist B" },
              { text: " • " },
              albumRun("Album X", "MPREbbb"),
              { text: " • " },
              { text: "1:02:33" },
            ],
          },
        },
      },
    ],
  });
  assert.equal(row.duration, 3753);
  assert.equal(row.artist, "Artist A & Artist B", "display keeps every credited artist");
  const clockAlbum = parseResponsiveListItem({
    playlistItemData: { videoId: "abcdefghijk" },
    flexColumns: [
      { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: "Kill Jay Z" }] } } },
      { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: "JAY-Z • 4:44 • 2:58" }] } } },
    ],
  });
  assert.equal(clockAlbum.duration, 178, "an album named like a clock is not the length");
  assert.equal(row.artistId, "UCaaa");
  assert.equal(row.albumId, "MPREbbb");
  assert.equal(row.album, "Album X");
});
