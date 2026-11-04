/**
 * The folder page (src/views/FolderView.tsx) with the real library, player and UI stores, in jsdom:
 * it shows the playlists filed in the folder and offers the rest, Add files one in with a click (so a
 * new, empty folder has something to do), Play plays every song in the folder in order as the folder,
 * and a folder deleted while open says so instead of showing an empty page.
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
    contents: `export { FolderView } from "./src/views/FolderView"; export { useLibrary } from "./src/stores/library"; export { usePlayer } from "./src/stores/player";`,
    resolveDir: fileURLToPath(new URL("..", import.meta.url)),
    loader: "tsx",
  },
  bundle: true, platform: "node", format: "cjs", write: false, logLevel: "silent",
  external: ["react", "react/jsx-runtime", "react-dom", "lucide-react"],
});
const module = { exports: {} };
new Function("require", "module", "exports", outputFiles[0].text)(require, module, module.exports);
const { FolderView, useLibrary, usePlayer } = module.exports;

// What jsdom leaves out (FitText measures and animates its titles).
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(0), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

const song = (id) => ({ id, title: `Song ${id}`, artist: "Artist", duration: 180, thumb: `https://covers.example/${id}.jpg` });
const seed = (filed) =>
  useLibrary.setState({
    folders: [{ id: "f1", name: "Road trip", createdAt: 1 }],
    playlists: [
      { id: "p1", name: "Morning", tracks: [song("a"), song("b")], createdAt: 1, ...(filed ? { folderId: "f1" } : {}) },
      { id: "p2", name: "Night", tracks: [song("c")], createdAt: 2, ...(filed ? { folderId: "f1" } : {}) },
      { id: "p3", name: "Gym", tracks: [song("d")], createdAt: 3 },
    ],
  });

async function mount(folderId) {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost" });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  window.bytune = globalThis.bytune;
  const root = createRoot(document.getElementById("root"));
  await act(async () => root.render(React.createElement(FolderView, { folderId })));
  return {
    section: (label) => document.querySelector(`section[aria-label="${label}"]`),
    click: (label) => act(async () => document.querySelector(`[aria-label="${label}"]`).click()),
    close: async () => {
      await act(async () => root.unmount());
      dom.window.close();
    },
  };
}

test("a folder's page shows the playlists filed in it, and offers the rest", async () => {
  seed(true);
  const h = await mount("f1");
  try {
    const inside = h.section("Playlists in Road trip").textContent;
    assert.match(inside, /Morning/);
    assert.match(inside, /Night/);
    assert.doesNotMatch(inside, /Gym/, "not one that isn't filed here");
    assert.match(h.section("Add to Road trip").textContent, /Gym/);
  } finally {
    await h.close();
  }
});

test("an empty folder offers your playlists, and Add files one in", async () => {
  seed(false);
  const h = await mount("f1");
  try {
    assert.match(h.section("Add to Road trip").textContent, /Gym/);
    await h.click("Add Gym to Road trip");
    assert.equal(useLibrary.getState().playlists.find((p) => p.id === "p3").folderId, "f1");
    assert.match(h.section("Playlists in Road trip").textContent, /Gym/, "and it shows in the folder");
  } finally {
    await h.close();
  }
});

test("Play plays every song in the folder, in order, as the folder", async () => {
  seed(true);
  usePlayer.setState({ queue: [], index: 0, playing: false, playingFrom: null });
  const h = await mount("f1");
  try {
    await h.click("Play Road trip");
    const s = usePlayer.getState();
    assert.deepEqual(s.queue.map((t) => t.id), ["a", "b", "c"]);
    assert.equal(s.playingFrom, "f1");
  } finally {
    await h.close();
  }
});

test("a folder deleted while open says so", async () => {
  seed(true);
  const h = await mount("gone");
  try {
    assert.match(document.body.textContent, /isn't here anymore/);
  } finally {
    await h.close();
  }
});
