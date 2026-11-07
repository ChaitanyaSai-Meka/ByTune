/**
 * Your Library (src/views/LibraryView.tsx) with the real stores, in jsdom: it shows your collections
 * (Liked Songs, Downloads, Local Music), your folders and the playlists not filed in one; Liked Songs
 * and Downloads play from it as themselves; a collection can be pinned or unpinned from its menu; the
 * Create button opens the create menu; and an empty library says how to start.
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
    contents: `export { LibraryView } from "./src/views/LibraryView"; export { useLibrary } from "./src/stores/library"; export { usePlayer } from "./src/stores/player"; export { useUI } from "./src/stores/ui";`,
    resolveDir: fileURLToPath(new URL("..", import.meta.url)),
    loader: "tsx",
  },
  bundle: true, platform: "node", format: "cjs", write: false, logLevel: "silent",
  external: ["react", "react/jsx-runtime", "react-dom", "lucide-react"],
});
const module = { exports: {} };
new Function("require", "module", "exports", outputFiles[0].text)(require, module, module.exports);
const { LibraryView, useLibrary, usePlayer, useUI } = module.exports;

// What jsdom leaves out (FitText measures and animates its titles).
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(0), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

const song = (id) => ({ id, title: `Song ${id}`, artist: "Artist", duration: 180, thumb: `https://covers.example/${id}.jpg` });
const seed = () => {
  useLibrary.setState({
    liked: [song("l1"), song("l2")],
    downloads: { d1: { track: song("d1"), path: "C:\\dl\\d1.m4a", status: "done", progress: 1, downloaded: 0, total: 0 } },
    folders: [{ id: "f1", name: "Road trip", createdAt: 1 }],
    playlists: [
      { id: "p1", name: "Morning", tracks: [song("a")], createdAt: 1, folderId: "f1" },
      { id: "p2", name: "Gym", tracks: [song("b")], createdAt: 2 },
    ],
    pinnedSingles: {},
  });
  useUI.setState({ view: { name: "library" }, contextMenu: null });
  usePlayer.setState({ queue: [], index: 0, playing: false, playingFrom: null });
};

async function mount() {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost", pretendToBeVisual: true });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  window.bytune = { ...globalThis.bytune, localLibrary: async () => ({ folders: [], scannedAt: 0, tracks: [] }) };
  const root = createRoot(document.getElementById("root"));
  await act(async () => root.render(React.createElement(LibraryView)));
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
  return {
    section: (label) => document.querySelector(`section[aria-label="${label}"]`)?.textContent ?? "",
    click: (label) => act(async () => document.querySelector(`[aria-label="${label}"]`).click()),
    close: async () => {
      await act(async () => root.unmount());
      dom.window.close();
    },
  };
}

test("Your Library shows your collections, your folders, and the playlists not in a folder", async () => {
  seed();
  const h = await mount();
  try {
    const collections = h.section("Collections");
    assert.match(collections, /Liked Songs/);
    assert.match(collections, /Downloads/);
    assert.match(collections, /Local Music/);
    assert.match(h.section("Folders"), /Road trip/);
    assert.match(h.section("Playlists"), /Gym/);
    assert.doesNotMatch(h.section("Playlists"), /Morning/, "a filed playlist lives in its folder");
  } finally {
    await h.close();
  }
});

test("Liked Songs and Downloads play from the Library page, as themselves", async () => {
  seed();
  const h = await mount();
  try {
    await h.click("Play Liked Songs");
    assert.deepEqual(usePlayer.getState().queue.map((t) => t.id), ["l1", "l2"]);
    assert.equal(usePlayer.getState().playingFrom, "__liked__");
    await h.click("Play Downloads");
    assert.deepEqual(usePlayer.getState().queue.map((t) => t.id), ["d1"]);
    assert.equal(usePlayer.getState().playingFrom, "__downloads__");
  } finally {
    await h.close();
  }
});

test("a collection is pinned or unpinned from its menu", async () => {
  seed();
  const h = await mount();
  try {
    await h.click("Options for Downloads");
    const pin = useUI.getState().contextMenu.items.find((i) => /pin/i.test(i.label ?? ""));
    assert.equal(pin.label, "Pin to top");
    await act(async () => pin.action());
    await h.click("Options for Downloads");
    assert.equal(useUI.getState().contextMenu.items.find((i) => /pin/i.test(i.label ?? "")).label, "Unpin");
  } finally {
    await h.close();
  }
});

test("Create opens the create menu", async () => {
  seed();
  const h = await mount();
  try {
    await h.click("Create playlist or folder");
    const items = useUI.getState().contextMenu?.items ?? [];
    assert.deepEqual(items.map((i) => i.label), ["Playlist", "Folder", "Import from Spotify or a list", "Import a file"]);
    assert.match(items[0].note, /Create a playlist with songs/);
    assert.match(items[1].note, /Organize your playlists/);
    await h.click("Create playlist or folder");
    assert.equal(useUI.getState().contextMenu, null, "the same button closes it");
  } finally {
    await h.close();
  }
});

test("an empty library says how to start", async () => {
  seed();
  useLibrary.setState({ folders: [], playlists: [] });
  const h = await mount();
  try {
    assert.match(document.body.textContent, /No playlists yet/);
  } finally {
    await h.close();
  }
});
