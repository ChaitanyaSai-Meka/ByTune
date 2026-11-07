/**
 * The Spotify pages (src/views/SpotifyView.tsx, MatchedPlaylistView.tsx) in jsdom with the real stores
 * and a mocked bridge, after their redesign into ByTune's collection pages:
 * - connected, the page leads with Spotify's own mark and a light of its green, names the account,
 *   and shows the playlists as stacks of their covers, Liked Songs first on a sleeve of its own; a stack
 *   opens its playlist, and its menu (and the header's) reach Spotify and the connection;
 * - not connected, it offers to connect;
 * - a Spotify playlist's page has its name before its songs arrive, then its songs' covers on the wall,
 *   lit rows with what YouTube Music had, the matching in the header, and Open in Spotify;
 * - an imported list keeps its own, unbranded look.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import React, { act } from "react";

// React DOM reads the environment when first loaded.
const environment = new JSDOM("<div></div>", { url: "http://localhost" });
globalThis.window = environment.window;
globalThis.document = environment.window.document;
globalThis.bytune = { readData: async () => null, writeData: async () => undefined };
const { createRoot } = await import("react-dom/client");

const require = createRequire(import.meta.url);
const { outputFiles } = await build({
  stdin: {
    contents: [
      `export { SpotifyView } from "./src/views/SpotifyView";`,
      `export { MatchedPlaylistView } from "./src/views/MatchedPlaylistView";`,
      `export { useSpotify } from "./src/lib/spotify";`,
      `export { importFromText } from "./src/lib/importSongs";`,
      `export { useUI } from "./src/stores/ui";`,
      `export { usePlayer } from "./src/stores/player";`,
    ].join("\n"),
    resolveDir: fileURLToPath(new URL("..", import.meta.url)),
    loader: "tsx",
  },
  bundle: true, platform: "node", format: "cjs", write: false, logLevel: "silent",
  loader: { ".svg": "text" },
  external: ["react", "react/jsx-runtime", "react-dom", "lucide-react"],
});
const module = { exports: {} };
new Function("require", "module", "exports", outputFiles[0].text)(require, module, module.exports);
const { SpotifyView, MatchedPlaylistView, useSpotify, importFromText, useUI, usePlayer } = module.exports;

globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 16);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

const HINDI = "37i9dQZF1DX0XUfTFmNBRM";
const SUII = "1A2B3C4D5E6F7G8H9I0JKL";
const ACCOUNT = { connected: true, name: "Rishi" };
const PLAYLISTS = [
  { id: "liked", name: "Liked Songs" },
  { id: HINDI, name: "Hindi", owner: "Rishi", thumb: "https://i.scdn.co/image/hindi" },
  { id: SUII, name: "Suii..", owner: "Someone", thumb: "https://i.scdn.co/image/suii" },
];
const song = (n) => ({ title: `Song ${n}`, artist: `Artist ${n}`, duration: 200, thumb: `https://i.scdn.co/image/song${n}` });
const track = (n) => ({ id: `yt${n}`, title: `Song ${n}`, artist: `Artist ${n}`, duration: 200, thumb: `https://lh3.googleusercontent.com/song${n}=w120-h120` });

const settle = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 30));
  });

async function mount(node, { status = ACCOUNT, playlists = PLAYLISTS, bridge = {} } = {}) {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost", pretendToBeVisual: true });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const opened = [];
  window.open = (url) => {
    opened.push(url);
    return null;
  };
  window.bytune = {
    ...globalThis.bytune,
    spotifyStatus: async () => status,
    spotifyPlaylists: async () => playlists,
    ...bridge,
  };
  useSpotify.setState({ status, playlists, connecting: false });
  useUI.setState({ dialog: null, contextMenu: null });
  const root = createRoot(document.getElementById("root"));
  await act(async () => root.render(node));
  await settle();
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => [...document.querySelectorAll(sel)];
  return {
    $,
    $$,
    opened,
    press: (el) => act(async () => el.click()),
    /** Picks an item of the open context menu by its label. */
    pick: async (label) => {
      const item = useUI.getState().contextMenu?.items.find((i) => i.label === label);
      assert.ok(item, `the menu has "${label}" (it has ${useUI.getState().contextMenu?.items.map((i) => i.label).join(", ")})`);
      await act(async () => item.action());
    },
    menuLabels: () => useUI.getState().contextMenu?.items.map((i) => i.label) ?? [],
    close: async () => {
      await act(async () => root.unmount());
      dom.window.close();
    },
  };
}

test("connected: Spotify's mark, the account and its playlists as stacks, Liked Songs first on its own sleeve", async () => {
  const h = await mount(React.createElement(SpotifyView));
  try {
    const hero = h.$(".collection-hero");
    assert.equal(hero.querySelector("h1").textContent, "Spotify");
    assert.ok(hero.querySelector(".collection-hero-text svg"), "Spotify's own icon leads the header");
    assert.ok(hero.querySelector(".collection-light"), "with a light of its green");
    assert.match(hero.textContent, /Connected as Rishi/);
    assert.match(hero.textContent, /2 playlists and your Liked Songs/);
    const tiles = h.$$(".cover-wall-tile").map((t) => t.style.backgroundImage);
    assert.ok(tiles.some((b) => b.includes("hindi")) && tiles.some((b) => b.includes("suii")), "the wall is the playlists' covers");

    const stacks = h.$$(".stack-card");
    assert.deepEqual(stacks.map((s) => s.querySelector(".stack-open").getAttribute("aria-label")), ["Open Liked Songs", "Open Hindi", "Open Suii.."]);
    assert.deepEqual(stacks.map((s) => s.querySelector("span.block").textContent), ["Liked on Spotify", "By you", "By Someone"]);
    assert.match(stacks[0].querySelector(".stack-sleeve").style.backgroundImage, /data:image\/svg\+xml/, "Liked Songs gets ByTune's own sleeve");

    await h.press(stacks[1].querySelector(".stack-open"));
    assert.deepEqual(useUI.getState().view, { name: "spotify", param: HINDI });

    await h.press(stacks[2].querySelector(".stack-menu"));
    await h.pick("Open in Spotify");
    assert.deepEqual(h.opened, [`https://open.spotify.com/playlist/${SUII}`]);
    await h.press(stacks[0].querySelector(".stack-menu"));
    await h.pick("Open in Spotify");
    assert.equal(h.opened[1], "https://open.spotify.com/collection/tracks", "Liked Songs opens your likes");

    await h.press(hero.querySelector("[aria-label='More options']"));
    assert.deepEqual(h.menuLabels(), ["Open Spotify", "Spotify in Settings", "Disconnect Spotify"]);
    await h.pick("Disconnect Spotify");
    assert.equal(useUI.getState().dialog?.title, "Disconnect Spotify?", "asks first");
    assert.ok(h.$$("p").some((p) => /isn't an official Spotify feature/.test(p.textContent)), "and says what reading Spotify this way means");
  } finally {
    useUI.setState({ dialog: null, contextMenu: null });
    await h.close();
  }
});

test("not connected: the page offers to connect, with nothing else on it", async () => {
  const h = await mount(React.createElement(SpotifyView), { status: { connected: false }, playlists: [] });
  try {
    assert.equal(h.$("h1").textContent, "Spotify");
    assert.match(h.$(".collection-hero").textContent, /Not connected/);
    assert.ok(h.$$(".collection-hero button").some((b) => b.textContent === "Connect Spotify"));
    assert.equal(h.$$(".stack-card").length, 0);
  } finally {
    await h.close();
  }
});

test("a Spotify playlist: its name before its songs, then their covers, lit rows, the matching and Open in Spotify", async () => {
  let deliver;
  const queued = [];
  usePlayer.setState({ playQueue: (q, i) => queued.push([q.map((t) => t.id), i]) });
  const h = await mount(React.createElement(MatchedPlaylistView, { spotifyId: HINDI }), {
    bridge: {
      spotifyPlaylist: () => new Promise((r) => (deliver = r)),
      matchSong: async (s) => (s.title === "Song 2" ? null : track(Number(s.title.slice(5)))),
    },
  });
  try {
    const hero = h.$(".collection-hero");
    assert.equal(hero.querySelector("h1").textContent, "Hindi", "named from the library before the songs arrive");
    assert.match(hero.textContent, /Spotify playlist/);
    assert.ok(hero.querySelector(".collection-hero-text svg") && hero.querySelector(".collection-light"));
    assert.match(hero.textContent, /Reading the playlist from Spotify/);

    await act(async () => deliver({ name: "Hindi", owner: "Rishi", thumb: "https://i.scdn.co/image/hindi", songs: [song(1), song(2), song(3)], total: 3 }));
    await settle();
    await settle();
    assert.match(hero.textContent, /3 songs · By you/);
    assert.match(hero.textContent, /2 of 3 songs found on YouTube Music\. 1 isn't there\./);
    assert.ok(h.$$(".cover-wall-tile").some((t) => t.style.backgroundImage.includes("song2")), "the songs' covers fill the wall");

    const rows = h.$$(".tl-row");
    assert.equal(rows.length, 3);
    assert.match(rows[1].textContent, /Not on YouTube Music/);
    assert.ok(rows[1].className.includes("opacity-45"), "what YouTube Music lacks stays listed, dimmed");
    assert.ok(h.$(".tl-light"), "the list's own light");

    await h.press(h.$$(".collection-hero button").find((b) => b.textContent === "Play"));
    assert.deepEqual(queued, [[["yt1", "yt3"], 0]], "Play plays what was found");
    await h.press(hero.querySelector("[aria-label='More options']"));
    await h.pick("Open in Spotify");
    assert.deepEqual(h.opened, [`https://open.spotify.com/playlist/${HINDI}`]);
  } finally {
    useUI.setState({ contextMenu: null });
    await h.close();
  }
});

test("an imported list keeps its own look: no Spotify mark or light", async () => {
  await importFromText("Artist A - Song A\nArtist B - Song B", "Road trip");
  const id = useUI.getState().view.param;
  const h = await mount(React.createElement(MatchedPlaylistView, { spotifyId: null, importId: id }), {
    bridge: { matchSong: async (s) => ({ id: `yt-${s.title}`, title: s.title, artist: s.artist, duration: 180, thumb: "" }) },
  });
  try {
    const hero = h.$(".collection-hero");
    assert.equal(hero.querySelector("h1").textContent, "Road trip");
    assert.match(hero.textContent, /Imported list/);
    assert.ok(!hero.querySelector(".collection-light"), "no Spotify light");
    assert.ok(!hero.querySelector(".collection-hero-text > div > svg[style]"), "no Spotify mark");
    assert.equal(h.$$(".tl-row").length, 2);
  } finally {
    await h.close();
  }
});
