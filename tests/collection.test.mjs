/**
 * The collection pages' helpers (src/lib/collection.ts): the covers a cover wall shows, the facts
 * under a collection's title, which left-panel row is the page open in the middle panel, and a new
 * folder (it opens in the middle panel, so it can be filled, instead of sitting empty in the list).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const environment = new JSDOM("<div></div>", { url: "http://localhost" });
globalThis.window = environment.window;
globalThis.document = environment.window.document;
globalThis.bytune = { readData: async () => null, writeData: async () => undefined };
window.bytune = globalThis.bytune;

const require = createRequire(import.meta.url);
const { outputFiles } = await build({
  stdin: {
    contents: `export * from "./src/lib/collection"; export { useLibrary } from "./src/stores/library"; export { useUI } from "./src/stores/ui";`,
    resolveDir: fileURLToPath(new URL("..", import.meta.url)),
    loader: "tsx",
  },
  bundle: true, platform: "node", format: "cjs", write: false, logLevel: "silent",
  external: ["react", "react/jsx-runtime", "react-dom", "lucide-react"],
});
const module = { exports: {} };
new Function("require", "module", "exports", outputFiles[0].text)(require, module, module.exports);
const { wallCovers, collectionFacts, rowIsOpen, askForNewFolder, useLibrary, useUI } = module.exports;

let n = 0;
const song = (artist, duration, artistId) => ({ id: `s${++n}`, title: "Song", artist, duration, thumb: "", ...(artistId ? { artistId } : {}) });

test("a cover wall shows each cover once, in order, then goes round again to fill", () => {
  assert.deepEqual(wallCovers(["a", "b", "a", "", null, "c"], 7), ["a", "b", "c", "a", "b", "c", "a"]);
  assert.deepEqual(wallCovers(["a", "b", "c"], 2), ["a", "b"]);
  assert.deepEqual(wallCovers([undefined, ""], 5), [], "no covers, no wall");
});

test("a collection's facts: how many songs, how long, and the artist with the most songs in it", () => {
  // Songs count for their lead artist (the artist id), named as credited alone.
  const tracks = [song("The Weeknd, Daft Punk", 200, "UCw"), song("The Weeknd", 230, "UCw"), song("Lana Del Rey", 301, "UCl"), song("The Weeknd & Ariana Grande", 0, "UCw"), song("Lana Del Rey", 240, "UCl")];
  assert.deepEqual(collectionFacts(tracks), { songs: "5 songs", length: "16 min", topArtist: { name: "The Weeknd", songs: 3 } });
  assert.deepEqual(
    collectionFacts([song("Tyler, The Creator, Kali Uchis", 60, "UCt"), song("Tyler, The Creator", 60, "UCt"), song("Tyler, The Creator", 60, "UCt")]).topArtist,
    { name: "Tyler, The Creator", songs: 3 },
    "a comma inside an artist's own name doesn't cut it",
  );
  assert.deepEqual(collectionFacts([song("A, B", 1), song("A", 1), song("A", 1)]).topArtist, null, "no artist id: only identical credits count together");
  assert.deepEqual(collectionFacts([song("A", 1), song("B", 1), song("A", 1), song("B", 1), song("A", 1), song("B", 1)]).topArtist, { name: "A", songs: 3 }, "a tie goes to the one that came first");
  assert.deepEqual(collectionFacts([song("A", 3000), song("B", 1500)]), { songs: "2 songs", length: "1 hr 15 min", topArtist: null }, "nobody with 3 songs: no top artist");
  assert.equal(collectionFacts([song("A", 7200)]).length, "2 hr");
  assert.deepEqual(collectionFacts([song("A", 0)]), { songs: "1 song", length: null, topArtist: null }, "no known lengths: no length");
});

test("the left-panel row of the page open in the middle panel", () => {
  const liked = { id: "__liked__", kind: "playlist" };
  const downloads = { id: "__downloads__", kind: "downloads" };
  const local = { id: "__local__", kind: "local" };
  const replay = { id: "__replay__", kind: "replay" };
  const spotify = { id: "__spotify__", kind: "spotify" };
  const mix = { id: "pl1", kind: "playlist" };
  const folder = { id: "f1", kind: "folder" };
  const artist = { id: "UCabc", kind: "artist" };
  const artistList = { id: "pl2", kind: "playlist", artistId: "UCabc" };
  const rows = [liked, downloads, local, replay, spotify, mix, folder, artist, artistList];
  const open = (view) => rows.filter((r) => rowIsOpen(r, view));
  assert.deepEqual(open({ name: "library", param: "liked" }), [liked]);
  assert.deepEqual(open({ name: "library", param: "downloaded" }), [downloads]);
  assert.deepEqual(open({ name: "library" }), [], "Your Library itself isn't a row");
  assert.deepEqual(open({ name: "downloads" }), [downloads]);
  assert.deepEqual(open({ name: "local", param: "D:\\Music\\ENGLISH" }), [local], "a folder of local music is still Local Music");
  assert.deepEqual(open({ name: "replay" }), [replay]);
  assert.deepEqual(open({ name: "spotify", param: "liked" }), [spotify]);
  assert.deepEqual(open({ name: "playlist", param: "pl1" }), [mix]);
  assert.deepEqual(open({ name: "folder", param: "f1" }), [folder]);
  assert.deepEqual(open({ name: "artist", param: "UCabc" }), [artist, artistList], "the artist, and the playlist that opens the artist");
  assert.deepEqual(open({ name: "playlist", param: "f1" }), [], "a folder isn't opened as a playlist");
  assert.deepEqual(open({ name: "home" }), []);
});

test("a new folder opens in the middle panel, ready to fill; a blank name keeps the suggested one", () => {
  useLibrary.setState({ folders: [] });
  useUI.setState({ view: { name: "home" } });
  askForNewFolder();
  const dialog = useUI.getState().dialog;
  assert.equal(dialog.initialValue, "New Folder 1");
  dialog.onConfirm("Road trip");
  const made = useLibrary.getState().folders.at(-1);
  assert.equal(made.name, "Road trip");
  assert.deepEqual(useUI.getState().view, { name: "folder", param: made.id });
  askForNewFolder();
  useUI.getState().dialog.onConfirm("   ");
  assert.equal(useLibrary.getState().folders.at(-1).name, "New Folder 2");
});
