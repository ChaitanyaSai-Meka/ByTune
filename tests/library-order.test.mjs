/**
 * Your Library's row order (src/lib/libraryOrder.ts): the dragged order holds, and rows it doesn't
 * know yet go where they would by default, right after their default neighbour.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const mod = build({
  entryPoints: [fileURLToPath(new URL("../src/lib/libraryOrder.ts", import.meta.url))],
  bundle: true, platform: "node", format: "esm", write: false,
}).then((r) => import(`data:text/javascript;base64,${Buffer.from(r.outputFiles[0].text).toString("base64")}`));

const DEFAULTS = ["artist:a", "artist:b", "playlist:chills", "folder:f", "single:downloads", "single:local"];

test("nothing dragged yet: the default order", async () => {
  const { arrange } = await mod;
  assert.deepEqual(arrange(DEFAULTS, []), DEFAULTS);
});

test("a dragged order holds", async () => {
  const { arrange } = await mod;
  const mine = ["playlist:chills", "single:downloads", "artist:a", "artist:b", "folder:f", "single:local"];
  assert.deepEqual(arrange(DEFAULTS, mine), mine);
});

test("rows it doesn't know go after their default neighbour; gone rows drop out", async () => {
  const { arrange } = await mod;
  const mine = ["playlist:chills", "single:downloads", "artist:a", "folder:f", "single:local"];
  // A new playlist (after chills by default), an artist removed, a row unpinned (Spotify, after Local).
  const defaults = ["artist:a", "playlist:chills", "playlist:new", "folder:f", "single:downloads", "single:local", "single:spotify"];
  assert.deepEqual(arrange(defaults, [...mine, "artist:gone"]), [
    "playlist:chills", "playlist:new", "single:downloads", "artist:a", "folder:f", "single:local", "single:spotify",
  ]);
  // A new first row by default goes to the top.
  assert.deepEqual(arrange(["artist:new", ...DEFAULTS], DEFAULTS), ["artist:new", ...DEFAULTS]);
  // A saved order with repeats keeps each row once.
  assert.deepEqual(arrange(DEFAULTS, ["single:local", "single:local", ...DEFAULTS]), ["single:local", ...DEFAULTS.filter((k) => k !== "single:local")]);
});

test("moving one row", async () => {
  const { moveKey } = await mod;
  assert.deepEqual(moveKey(["a", "b", "c", "d"], 3, 0), ["d", "a", "b", "c"]);
  assert.deepEqual(moveKey(["a", "b", "c", "d"], 0, 2), ["b", "c", "a", "d"]);
  assert.deepEqual(moveKey(["a", "b"], 1, 1), ["a", "b"]);
});
