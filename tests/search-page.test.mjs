import test from "node:test";
import assert from "node:assert/strict";
import { parsePodcastEpisodes, parseSearchPage } from "../.test-build/ytm.mjs";

const ARTIST_PAGE = { browseEndpointContextSupportedConfigs: { browseEndpointContextMusicConfig: { pageType: "MUSIC_PAGE_TYPE_ARTIST" } } };
const col = (runs) => ({ musicResponsiveListItemFlexColumnRenderer: { text: { runs } } });
const row = (videoId, columns) => ({ musicResponsiveListItemRenderer: { playlistItemData: { videoId }, flexColumns: columns } });

test("songs under an artist card are credited to that artist", () => {
  // The "All" tab's artist card lists top songs whose rows print only "Song • 3:35".
  const response = {
    contents: [
      {
        musicCardShelfRenderer: {
          title: { runs: [{ text: "Arijit Singh" }] },
          subtitle: { runs: [{ text: "Artist • 658M monthly audience" }] },
          onTap: { browseEndpoint: { browseId: "UCarijit", ...ARTIST_PAGE } },
          contents: [row("haareya0001", [col([{ text: "Haareya" }]), col([{ text: "Song • 3:35" }]), col([{ text: "93M plays" }])])],
        },
      },
      {
        musicShelfRenderer: {
          contents: [
            row("weekend0001", [
              col([{ text: "Weekend (feat. Miguel)" }]),
              col([
                { text: "Song • " },
                { text: "Mac Miller", navigationEndpoint: { browseEndpoint: { browseId: "UCmac", ...ARTIST_PAGE } } },
                { text: " • 3:30" },
              ]),
            ]),
          ],
        },
      },
    ],
  };
  const songs = parseSearchPage(response, false).rows.filter((r) => r.kind === "track").map((r) => r.song);
  assert.deepEqual(
    songs.map((s) => [s.title, s.artist, s.artistId, s.duration]),
    [
      ["Haareya", "Arijit Singh", "UCarijit", 215],
      ["Weekend (feat. Miguel)", "Mac Miller", "UCmac", 210],
    ],
  );
});

test("podcast shows come back as podcasts, and their episodes play flagged as episodes", () => {
  const PODCAST_PAGE = { browseEndpointContextSupportedConfigs: { browseEndpointContextMusicConfig: { pageType: "MUSIC_PAGE_TYPE_PODCAST_SHOW_DETAIL_PAGE" } } };
  const results = parseSearchPage({
    contents: [{
      musicShelfRenderer: { contents: [{ musicResponsiveListItemRenderer: {
        navigationEndpoint: { browseEndpoint: { browseId: "MPSPPLabcdefghij", ...PODCAST_PAGE } },
        flexColumns: [col([{ text: "Huberman Lab" }]), col([{ text: "Andrew Huberman" }])],
      } }] },
    }],
  }, false);
  assert.deepEqual(results.rows.map((r) => [r.kind, r.item?.type, r.item?.title]), [["browse", "podcast", "Huberman Lab"]]);

  const page = {
    contents: [{ musicMultiRowListItemRenderer: {
      title: { runs: [{ text: "Episode one" }] },
      subtitle: { runs: [{ text: "84K views" }, { text: " • " }, { text: "2d ago" }] },
      description: { runs: [{ text: "We talk about sleep." }] },
      onTap: { watchEndpoint: { videoId: "arMMF0ISRRM" } },
    } }],
  };
  const { episodes } = parsePodcastEpisodes(page, { title: "Huberman Lab", author: "Andrew Huberman", thumb: "https://x/show.jpg" });
  assert.deepEqual(episodes.map((e) => [e.id, e.title, e.artist, e.album, e.episode, e.published, e.description, e.thumb]), [
    ["arMMF0ISRRM", "Episode one", "Andrew Huberman", "Huberman Lab", true, "2d ago", "We talk about sleep.", "https://x/show.jpg"],
  ]);
});
