/**
 * Getting into and out of Settings (src/stores/ui.ts): the profile button opens Settings and closes it
 * again, back to where you were; switching a Settings category adds no history step, so Back and the
 * profile button leave Settings in one step, and coming back lands on the category you left; opening
 * Settings while it's already open never stacks a second Settings entry.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL("../src/stores/ui.ts", import.meta.url))],
  bundle: true, platform: "node", format: "cjs", write: false, logLevel: "silent",
  external: ["zustand"],
});
const module = { exports: {} };
new Function("require", "module", "exports", outputFiles[0].text)(require, module, module.exports);
const { useUI } = module.exports;

const fresh = () => useUI.setState({ view: { name: "home" }, navPast: [], navFuture: [], lyricsCenter: false, pendingScroll: null });
const where = () => {
  const { view } = useUI.getState();
  return view.param ? `${view.name}/${view.param}` : view.name;
};

test("the profile button opens Settings, and pressing it again goes back to where you were", () => {
  fresh();
  useUI.getState().navigate({ name: "liked" });
  useUI.getState().toggleSettings();
  assert.equal(where(), "settings");
  useUI.getState().toggleSettings();
  assert.equal(where(), "liked", "closed, back on the page it was opened from");
  assert.equal(useUI.getState().navFuture[0]?.view.name, "settings", "and Forward can bring it back");
});

test("switching categories adds no history: one press of the profile button still leaves Settings", () => {
  fresh();
  useUI.getState().navigate({ name: "search" });
  useUI.getState().toggleSettings();
  const depth = useUI.getState().navPast.length;
  useUI.getState().replaceView({ name: "settings", param: "sound" });
  useUI.getState().replaceView({ name: "settings", param: "display" });
  assert.equal(useUI.getState().navPast.length, depth, "no new history steps");
  assert.equal(useUI.getState().pendingScroll, 0, "a category opens at its top");
  useUI.getState().toggleSettings();
  assert.equal(where(), "search");
});

test("Back from a page opened from Settings returns to the category you left", () => {
  fresh();
  useUI.getState().openSettings();
  useUI.getState().replaceView({ name: "settings", param: "library" });
  useUI.getState().navigate({ name: "local" });
  useUI.getState().goBack();
  assert.equal(where(), "settings/library");
});

test("opening Settings when it's already open never stacks a second entry", () => {
  fresh();
  useUI.getState().openSettings();
  useUI.getState().replaceView({ name: "settings", param: "sound" });
  const past = useUI.getState().navPast.length;
  useUI.getState().openSettings();
  assert.equal(where(), "settings/sound", "stays on the category you're in");
  useUI.getState().openSettings("account");
  assert.equal(where(), "settings/account", "or moves to the one asked for");
  assert.equal(useUI.getState().navPast.length, past);
  useUI.getState().toggleSettings();
  assert.equal(where(), "home", "so one press still leaves");
});

test("with the lyrics covering Settings, the profile button shows Settings instead of leaving it", () => {
  fresh();
  useUI.getState().openSettings();
  useUI.setState({ lyricsCenter: true });
  useUI.getState().toggleSettings();
  assert.equal(where(), "settings");
  assert.equal(useUI.getState().lyricsCenter, false);
});

test("with nowhere to go back to, closing Settings goes home", () => {
  fresh();
  useUI.setState({ view: { name: "settings" } });
  useUI.getState().toggleSettings();
  assert.equal(where(), "home");
});
