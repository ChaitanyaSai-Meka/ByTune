/**
 * Your playlist pages, Downloads and Local Music (src/views/PlaylistView, DownloadsView, LocalMusicView)
 * with the real stores, in jsdom, through their redesign: what each page says about its songs, that Play
 * plays what the page holds and as that page, that a download in progress shows how far it has come and
 * can be cancelled (a failed one retried), and that Local Music keeps its folders, its missing-folder
 * warning and its rename/remove-in-ByTune options. The main-process bridge is a stub serving a small
 * local library.
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
      `export { PlaylistView } from "./src/views/PlaylistView";`,
      `export { DownloadsView } from "./src/views/DownloadsView";`,
      `export { LocalMusicView } from "./src/views/LocalMusicView";`,
      `export { useLibrary } from "./src/stores/library";`,
      `export { usePlayer } from "./src/stores/player";`,
      `export { useUI } from "./src/stores/ui";`,
    ].join("\n"),
    resolveDir: fileURLToPath(new URL("..", import.meta.url)),
    loader: "tsx",
  },
  bundle: true, platform: "node", format: "cjs", write: false, logLevel: "silent",
  external: ["react", "react/jsx-runtime", "react-dom", "lucide-react"],
});
const module = { exports: {} };
new Function("require", "module", "exports", outputFiles[0].text)(require, module, module.exports);
const { PlaylistView, DownloadsView, LocalMusicView, useLibrary, usePlayer, useUI } = module.exports;

// What jsdom leaves out (FitText measures and animates its titles).
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(0), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

const ENGLISH = "D:\\Music\\ENGLISH";
const PHONK = "D:\\Music\\PHONK";
const local = (id, title, folder) => ({ id: `local:${id}`, path: `${folder}\\${title}.mp3`, title, artist: "Artist", album: "Album", duration: 180, size: 1, mtime: 1, art: `localart://${id}` });
const LIBRARY = {
  folders: [
    { path: ENGLISH, name: "ENGLISH", addedAt: 1 },
    { path: PHONK, name: "PHONK", addedAt: 2 },
  ],
  scannedAt: Date.UTC(2026, 9, 6),
  tracks: [local("a", "Alpha", ENGLISH), local("c", "Charlie", ENGLISH), local("b", "Bravo", ENGLISH), local("d", "Delta", PHONK), local("e", "Echo", PHONK)],
};
const song = (id, duration, extra = {}) => ({ id, title: `Song ${id}`, artist: "Artist", duration, thumb: `https://covers.example/${id}.jpg`, ...extra });
const queued = () => usePlayer.getState().queue.map((t) => t.id);
const freshPlayer = () => usePlayer.setState({ queue: [], index: 0, playing: false, playingFrom: null });

async function mount(element) {
  // pretendToBeVisual: window.requestAnimationFrame / cancelAnimationFrame (the playlist's sorting uses them).
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost", pretendToBeVisual: true });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  window.bytune = {
    ...globalThis.bytune,
    localLibrary: async () => LIBRARY,
    libraryFolderStatuses: async () => [
      { path: ENGLISH, exists: true },
      { path: PHONK, exists: false },
    ],
    openedFiles: async () => [],
  };
  const root = createRoot(document.getElementById("root"));
  await act(async () => root.render(element));
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20)); // the bridge's answers land
  });
  return {
    text: () => document.body.textContent,
    click: (label) => act(async () => document.querySelector(`[aria-label="${label}"]`).click()),
    close: async () => {
      await act(async () => root.unmount());
      dom.window.close();
    },
  };
}

const DOWNLOADS = {
  d: { track: song("d", 100, { title: "Delta" }), path: "C:\\dl\\d.m4a", status: "done", progress: 1, downloaded: 0, total: 0 },
  b: { track: song("b", 100, { title: "Bravo" }), path: null, status: "downloading", progress: 0.42, downloaded: 42, total: 100 },
  c: { track: song("c", 100, { title: "Charlie" }), path: null, status: "failed", progress: 0, downloaded: 0, total: 0 },
  a: { track: song("a", 100, { title: "Alpha" }), path: "C:\\dl\\a.m4a", status: "done", progress: 1, downloaded: 0, total: 0 },
};

test("a playlist's page says how many songs and how long, and Play plays it from the top as that playlist", async () => {
  useLibrary.setState({ playlists: [{ id: "p1", name: "Mix", tracks: [song("a", 200), song("b", 230), song("c", 0)], createdAt: 1 }] });
  freshPlayer();
  const h = await mount(React.createElement(PlaylistView, { playlistId: "p1" }));
  try {
    assert.match(h.text(), /3 songs · 7 min/);
    await h.click("Play Mix");
    assert.deepEqual(queued(), ["a", "b", "c"]);
    assert.equal(usePlayer.getState().playingFrom, "p1");
  } finally {
    await h.close();
  }
});

test("a playlist with songs from this computer says they stay on this device", async () => {
  useLibrary.setState({ playlists: [{ id: "p2", name: "Mixed", tracks: [song("local:x", 100), song("y", 100)], createdAt: 1 }] });
  const h = await mount(React.createElement(PlaylistView, { playlistId: "p2" }));
  try {
    assert.match(h.text(), /1 song is from this computer and stays on this device/);
  } finally {
    await h.close();
  }
});

test("an empty playlist offers ways to find songs", async () => {
  useLibrary.setState({ playlists: [{ id: "p3", name: "New", tracks: [], createdAt: 1 }] });
  const h = await mount(React.createElement(PlaylistView, { playlistId: "p3" }));
  try {
    assert.match(h.text(), /Search for songs/);
    assert.match(h.text(), /Browse Explore/);
  } finally {
    await h.close();
  }
});

test("Downloads: Play plays the saved songs only, in the page's order, as Downloads", async () => {
  useLibrary.setState({ downloads: DOWNLOADS });
  freshPlayer();
  const h = await mount(React.createElement(DownloadsView));
  try {
    await h.click("Play Downloads");
    assert.deepEqual(queued(), ["a", "d"]);
    assert.equal(usePlayer.getState().playingFrom, "__downloads__");
  } finally {
    await h.close();
  }
});

test("a song downloading fills its cover as it comes in; a failed one can be retried, a running one cancelled", async () => {
  useLibrary.setState({ downloads: DOWNLOADS });
  const h = await mount(React.createElement(DownloadsView));
  try {
    const fills = [...document.querySelectorAll(".dl-cover")].map((c) => c.style.getPropertyValue("--fill"));
    assert.ok(fills.includes("42%"), fills.join(" "));
    assert.ok(document.querySelector('[title="Retry download"]'));
    assert.ok(document.querySelector('[title="Cancel download"]'));
  } finally {
    await h.close();
  }
});

test("Local Music lists All songs and each folder with its song count, and warns of a missing one", async () => {
  useUI.setState({ view: { name: "local" } });
  const h = await mount(React.createElement(LocalMusicView));
  try {
    const t = h.text();
    assert.match(t, /All songs/);
    assert.match(t, /ENGLISH/);
    assert.match(t, /3 songs/);
    assert.match(t, /PHONK/);
    assert.match(t, /Folder missing/);
  } finally {
    await h.close();
  }
});

test("opening a local folder: Play plays its songs in the order shown, as Local Music", async () => {
  useUI.setState({ view: { name: "local", param: ENGLISH } });
  freshPlayer();
  const h = await mount(React.createElement(LocalMusicView));
  try {
    await h.click("Play ENGLISH");
    assert.deepEqual(queued(), ["local:a", "local:b", "local:c"]);
    assert.equal(usePlayer.getState().playingFrom, "__local__");
  } finally {
    await h.close();
  }
});

test("a local folder's options rename and remove it in ByTune only", async () => {
  useUI.setState({ view: { name: "local", param: ENGLISH }, contextMenu: null, dialog: null });
  const h = await mount(React.createElement(LocalMusicView));
  try {
    await h.click("Folder options");
    const items = useUI.getState().contextMenu.items;
    assert.deepEqual(items.map((i) => i.label), ["Rename in ByTune", "Remove from ByTune"]);
    await act(async () => items[0].action());
    assert.equal(useUI.getState().dialog.title, 'Rename "ENGLISH"');
  } finally {
    await h.close();
  }
});
