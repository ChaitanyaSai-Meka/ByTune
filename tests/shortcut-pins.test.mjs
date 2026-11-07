/**
 * Your Library's shortcut pins (src/stores/library.ts isPinned / togglePinSingle, and the sync
 * merge): Liked, Spotify and Replay are pinned by default, Downloads and Local Music not. A pin set
 * saved before that (no `v2`) said "pinned" for every row by default, so only its unpins still count.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { mergeLibrary } from "../.test-build/sync-merge.mjs";

const store = build({
  entryPoints: [fileURLToPath(new URL("../src/stores/library.ts", import.meta.url))],
  bundle: true, platform: "node", format: "esm", write: false,
}).then((r) => import(`data:text/javascript;base64,${Buffer.from(r.outputFiles[0].text).toString("base64")}`));

const pinsOf = (isPinned, pins) => Object.fromEntries(["liked", "spotify", "replay", "downloads", "local"].map((k) => [k, isPinned(pins, k)]));
const NEW_DEFAULTS = { liked: true, spotify: true, replay: true, downloads: false, local: false };

test("a new install: Liked, Spotify and Replay pinned; Downloads and Local Music not", async () => {
  const { isPinned, useLibrary, SINGLE_KEYS } = await store;
  assert.deepEqual(SINGLE_KEYS, ["liked", "spotify", "replay", "downloads", "local"], "the sidebar's order");
  assert.deepEqual(pinsOf(isPinned, useLibrary.getState().pinnedSingles), NEW_DEFAULTS);
  assert.deepEqual(pinsOf(isPinned, undefined), NEW_DEFAULTS);
});

test("an older install's saved pins: its 'all pinned' default gives way, its unpins stay", async () => {
  const { isPinned } = await store;
  assert.deepEqual(pinsOf(isPinned, { liked: true, downloads: true, local: true }), NEW_DEFAULTS);
  assert.deepEqual(pinsOf(isPinned, { liked: false, downloads: true, local: true }), { ...NEW_DEFAULTS, liked: false });
});

test("toggling writes the whole set as chosen, from then on taken as it is", async () => {
  const { isPinned, useLibrary } = await store;
  useLibrary.setState({ pinnedSingles: { liked: true, downloads: true, local: true } });
  useLibrary.getState().togglePinSingle("local");
  const pins = useLibrary.getState().pinnedSingles;
  assert.equal(pins.v2, true);
  assert.deepEqual(pinsOf(isPinned, pins), { ...NEW_DEFAULTS, local: true });
  useLibrary.getState().togglePinSingle("spotify");
  assert.deepEqual(pinsOf(isPinned, useLibrary.getState().pinnedSingles), { ...NEW_DEFAULTS, local: true, spotify: false });
});

test("sync: this device's pins win, but an old 'all pinned' set loses to a chosen set from the cloud", () => {
  const lib = (pinnedSingles) => ({ state: { liked: [], playlists: [], folders: [], followedArtists: [], history: [], downloads: {}, pinnedSingles }, version: 1 });
  const chosen = { liked: true, spotify: false, replay: true, downloads: true, local: false, v2: true };
  const old = { liked: true, downloads: true, local: true };
  assert.deepEqual(mergeLibrary(lib(old), lib(chosen), {}).state.pinnedSingles, chosen, "the cloud's chosen set over this device's old one");
  const mine = { ...chosen, replay: false };
  assert.deepEqual(mergeLibrary(lib(mine), lib(chosen), {}).state.pinnedSingles, mine, "two chosen sets: this device's");
  assert.deepEqual(mergeLibrary(lib(mine), lib(old), {}).state.pinnedSingles, { ...old, ...mine }, "an old cloud set never overrides a chosen one");
  assert.deepEqual(mergeLibrary(lib(undefined), lib(undefined), {}).state.pinnedSingles, {}, "nothing saved: the defaults apply when read");
});
