import test from "node:test";
import assert from "node:assert/strict";
import { parsePlaylistContinuation, parsePlaylistShelf, parseRemotePlaylistPage } from "../.test-build/ytm.mjs";

const row = (n) => ({
  musicResponsiveListItemRenderer: {
    playlistItemData: { videoId: `vid${String(n).padStart(8, "0")}` },
    flexColumns: [
      { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: `Song ${n}` }] } } },
      { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: `Artist ${n} • 3:30` }] } } },
    ],
  },
});
const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => row(from + i));

test("a playlist's later pages parse from both shapes YouTube sends", () => {
  const legacy = {
    continuationContents: {
      musicPlaylistShelfContinuation: {
        contents: range(101, 200),
        continuations: [{ nextContinuationData: { continuation: "TOKEN-3" } }],
      },
    },
  };
  const page2 = parsePlaylistContinuation(legacy);
  assert.equal(page2.songs.length, 100);
  assert.equal(page2.songs[0].title, "Song 101");
  assert.equal(page2.continuation, "TOKEN-3");

  const modern = {
    onResponseReceivedActions: [
      {
        appendContinuationItemsAction: {
          continuationItems: [
            ...range(201, 250),
            { continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: "TOKEN-4" } } } },
          ],
        },
      },
    ],
  };
  const page3 = parsePlaylistContinuation(modern);
  assert.equal(page3.songs.length, 50);
  assert.equal(page3.songs[49].title, "Song 250");
  assert.equal(page3.continuation, "TOKEN-4");

  const last = parsePlaylistContinuation({ onResponseReceivedActions: [{ appendContinuationItemsAction: { continuationItems: range(251, 260) } }] });
  assert.equal(last.continuation, null, "the final page ends the loop");
});

test("songs on a later album page keep the album's artist", () => {
  // Album rows print no artist; a later page has no header to borrow it from.
  const bare = (n) => ({
    musicResponsiveListItemRenderer: {
      playlistItemData: { videoId: `trk${String(n).padStart(8, "0")}` },
      flexColumns: [{ musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: `Track ${n}` }] } } }],
    },
  });
  const page = parsePlaylistContinuation(
    { continuationContents: { musicPlaylistShelfContinuation: { contents: [bare(101), bare(102)] } } },
    { artistId: "UCband", artistName: "The Band", albumId: "MPREb_album", albumName: "Big Album" },
  );
  assert.deepEqual(
    page.songs.map((s) => [s.title, s.artist, s.artistId, s.albumId]),
    [
      ["Track 101", "The Band", "UCband", "MPREb_album"],
      ["Track 102", "The Band", "UCband", "MPREb_album"],
    ],
  );
});

test("a playlist page counts and lists every page, not just the first 100", () => {
  const first = {
    header: {
      musicResponsiveHeaderRenderer: {
        title: { runs: [{ text: "Big Mix" }] },
        subtitle: { runs: [{ text: "Playlist • 2024" }] },
      },
    },
    contents: {
      twoColumnBrowseResultsRenderer: {
        secondaryContents: {
          sectionListRenderer: {
            contents: [
              {
                musicPlaylistShelfRenderer: {
                  contents: [...range(1, 100), { continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: "TOKEN-2" } } } }],
                },
              },
            ],
          },
        },
      },
    },
  };
  assert.equal(parsePlaylistShelf(first).continuation, "TOKEN-2", "the first page hands over the next token");
  const more = parsePlaylistContinuation({
    continuationContents: { musicPlaylistShelfContinuation: { contents: [row(100), ...range(101, 180)] } },
  }).songs;
  const page = parseRemotePlaylistPage(first, "VLbig", more);
  assert.equal(page.tracks.length, 180, "the repeated row 100 is kept once");
  assert.equal(page.tracks[179].title, "Song 180");
  assert.match(page.meta, /180 TRACKS/);
});
