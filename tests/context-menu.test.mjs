/**
 * ByTune's menus (src/components/ContextMenu.tsx) in jsdom with the real stores:
 * - rows, sentence-case captions and hairlines between groups (never first, never two together); a
 *   destructive row is red, and the menu's one light goes to the row under the pointer, red there too;
 * - a song's menu opens with the song at its top, wherever its builder put it;
 * - a picker's choices are real choices, the chosen one checked at the right; a row with a second line
 *   shows its icon in a tile;
 * - a row's own menu opens beside it, Escape folds it and then closes the menu; the arrow keys walk the
 *   rows past disabled ones, and choosing a row runs it and closes the menu;
 * - a playlist's folder is a choice: the folder it's in checked.
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
      `export { ContextMenu } from "./src/components/ContextMenu";`,
      `export { useUI } from "./src/stores/ui";`,
      `export { useLibrary } from "./src/stores/library";`,
      `export { trackMenuItems, playlistFolderItems, playlistOwnItems } from "./src/lib/trackActions";`,
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
const { ContextMenu, useUI, useLibrary, trackMenuItems, playlistFolderItems, playlistOwnItems } = module.exports;
const { ListPlus, Trash2 } = require("lucide-react");

async function mount() {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost", pretendToBeVisual: true });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  // The menu checks what it's handed against the DOM's own classes, as a page can.
  for (const name of ["HTMLElement", "Element", "Node"]) globalThis[name] = dom.window[name];
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  window.bytune = globalThis.bytune;
  useUI.setState({ contextMenu: null, dialog: null });
  const root = createRoot(document.getElementById("root"));
  await act(async () => root.render(React.createElement(ContextMenu)));
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => [...document.querySelectorAll(sel)];
  const PE = window.PointerEvent ?? window.MouseEvent;
  return {
    $,
    $$,
    open: (items, options) => act(async () => useUI.getState().openContextMenu(40, 40, items, options)),
    row: (label) => $$("[data-menu-row]").find((r) => r.querySelector(".menu-label")?.textContent === label),
    press: (el) => act(async () => el.click()),
    over: (el) => act(async () => el.dispatchEvent(new PE("pointerover", { bubbles: true }))),
    key: (key) => act(async () => window.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true }))),
    close: async () => {
      await act(async () => root.unmount());
      dom.window.close();
    },
  };
}

const kinds = (list) => [...list.children].map((el) => el.className.split(" ")[0]);

test("rows, captions and hairlines (never first, never doubled); a destructive row and the light on it are red", async () => {
  const h = await mount();
  const ran = [];
  try {
    await h.open([
      { label: "First", separatorBefore: true, action: () => ran.push("first") },
      { label: "Sleep timer", header: true },
      { label: "Second", action: () => ran.push("second") },
      { label: "Delete", icon: Trash2, danger: true, separatorBefore: true, action: () => ran.push("delete") },
    ]);
    const list = h.$(".menu .menu-list");
    assert.deepEqual(kinds(list), ["menu-light", "menu-row", "menu-caption", "menu-row", "menu-sep", "menu-row"]);
    assert.equal(h.$(".menu-caption").textContent, "Sleep timer");
    assert.ok(!h.$(".menu-caption").className.includes("uppercase"), "captions in sentence case");
    assert.ok(h.row("Delete").className.includes("is-danger"));

    const light = h.$(".menu-light");
    assert.equal(document.activeElement, h.row("First"), "opened, it focuses its first row");
    assert.ok(!light.classList.contains("is-on"), "without lighting it: no key was pressed");
    await h.over(h.row("Delete"));
    assert.ok(light.classList.contains("is-on") && light.classList.contains("is-danger"), "red on a destructive row");
    await h.over(h.row("Second"));
    assert.ok(light.classList.contains("is-on") && !light.classList.contains("is-danger"));
    await h.over(h.$(".menu-caption"));
    assert.ok(!light.classList.contains("is-on"), "and out off the rows");
    await h.key("End");
    assert.equal(document.activeElement, h.row("Delete"));
    await h.over(h.$(".menu-caption"));
    assert.ok(light.classList.contains("is-on") && light.classList.contains("is-danger"), "but it rests on the keyboard's row");

    await h.press(h.row("Second"));
    assert.deepEqual(ran, ["second"]);
    assert.equal(useUI.getState().contextMenu, null, "choosing a row closes the menu");
  } finally {
    await h.close();
  }
});

test("a song's menu opens with the song at its top, wherever its builder put it", async () => {
  useLibrary.setState({ playlists: [], liked: [], downloads: {} });
  const h = await mount();
  try {
    const song = { id: "abc123", title: "Nicole Kidman", artist: "ADÉLA", duration: 182, thumb: "https://lh3.googleusercontent.com/x=w120-h120" };
    await h.open([{ label: "Remove from this playlist", danger: true, action() {} }, ...trackMenuItems(song)]);
    const list = h.$(".menu .menu-list");
    assert.deepEqual(kinds(list).slice(0, 4), ["menu-light", "menu-subject", "menu-sep", "menu-row"]);
    assert.equal(h.$(".menu-subject-title").textContent, "Nicole Kidman");
    assert.equal(h.$(".menu-subject-sub").textContent, "ADÉLA");
    assert.match(h.$(".menu-subject").style.getPropertyValue("--light"), /googleusercontent/, "lit by its cover");
    assert.equal(h.$(".menu").getAttribute("aria-label"), "Nicole Kidman");
    const order = kinds(list);
    assert.ok(!order.some((k, i) => k === "menu-sep" && order[i + 1] === "menu-sep"), "no two hairlines together");
    assert.equal(h.$$("[data-menu-row]")[0].querySelector(".menu-label").textContent, "Remove from this playlist", "its own rows stay first");
  } finally {
    await h.close();
  }
});

test("a picker's choices are real choices, the chosen one checked at the right; a second line puts the icon in a tile", async () => {
  const h = await mount();
  try {
    await h.open([
      { label: "Low", checked: false, action() {} },
      { label: "High", checked: true, action() {} },
      { label: "Playlist", note: "Create a playlist with songs", icon: ListPlus, action() {} },
    ]);
    const [low, high, rich] = h.$$("[data-menu-row]");
    assert.equal(low.getAttribute("role"), "menuitemradio");
    assert.equal(low.getAttribute("aria-checked"), "false");
    assert.equal(high.getAttribute("aria-checked"), "true");
    assert.ok(!low.querySelector(".menu-check") && high.querySelector(".menu-check"), "only the chosen one carries the check");
    assert.equal(rich.getAttribute("role"), "menuitem");
    assert.ok(rich.className.includes("is-rich") && rich.querySelector(".menu-tile svg"));
    assert.equal(rich.querySelector(".menu-note").textContent, "Create a playlist with songs");
  } finally {
    await h.close();
  }
});

test("a row's own menu opens beside it; Escape folds it, then closes the menu", async () => {
  const h = await mount();
  const ran = [];
  try {
    await h.open([
      { label: "Add to playlist", children: [{ label: "Road trip", action: () => ran.push("road trip") }] },
      { label: "Other", action() {} },
    ]);
    const parent = h.row("Add to playlist");
    assert.equal(parent.getAttribute("aria-haspopup"), "menu");
    await h.press(parent);
    assert.equal(parent.getAttribute("aria-expanded"), "true");
    assert.ok(h.$("[data-menu-portal].menu-sub"), "its own menu, beside it");
    await h.key("Escape");
    assert.ok(!h.$("[data-menu-portal]"), "Escape folds it");
    assert.ok(useUI.getState().contextMenu, "but the menu stays");
    await h.key("Escape");
    assert.equal(useUI.getState().contextMenu, null, "the second Escape closes the menu");

    await h.open([{ label: "Add to playlist", children: [{ label: "Road trip", action: () => ran.push("road trip") }] }]);
    await h.press(h.row("Add to playlist"));
    await h.press(h.row("Road trip"));
    assert.deepEqual(ran, ["road trip"]);
    assert.equal(useUI.getState().contextMenu, null);
  } finally {
    await h.close();
  }
});

test("the arrow keys walk the rows past disabled ones", async () => {
  const h = await mount();
  try {
    await h.open([
      { label: "A", action() {} },
      { label: "B", disabled: true, action() {} },
      { label: "C", action() {} },
    ]);
    await act(async () => new Promise((r) => setTimeout(r, 0)));
    assert.equal(document.activeElement, h.row("A"), "focus starts on the first row");
    await h.key("ArrowDown");
    assert.equal(document.activeElement, h.row("C"), "B is skipped");
    await h.key("ArrowDown");
    assert.equal(document.activeElement, h.row("A"), "and round again");
  } finally {
    await h.close();
  }
});

test("a playlist's folder is a choice: the folder it's in checked, the others move it", async () => {
  useLibrary.setState({ folders: [{ id: "f1", name: "Chill" }, { id: "f2", name: "Gym" }] });
  const items = playlistFolderItems({ id: "p1", name: "Mine", tracks: [], folderId: "f1" });
  assert.deepEqual(
    items.map((i) => [i.label, i.header ? "caption" : i.checked]),
    [["Folder", "caption"], ["Chill", true], ["Gym", false]]
  );
  useLibrary.setState({ folders: [] });
  assert.deepEqual(playlistFolderItems({ id: "p1", name: "Mine", tracks: [] }), [], "no folders, no choice");
});

test("in a folder, Remove from folder (red) sits under Rename and Delete playlist (white) moves to the bottom", async () => {
  useLibrary.setState({ folders: [{ id: "f1", name: "Chill" }, { id: "f2", name: "Gym" }] });
  // Each row as [label, how it reads]: a caption, a folder's check, or the row's colour.
  const rows = (items) =>
    items.filter((i) => !i.subject).map((i) => [i.label, i.header ? "caption" : i.checked ?? (i.danger ? "red" : "white")]);
  const filed = playlistOwnItems({ id: "p1", name: "Mine", tracks: [], folderId: "f1" });
  assert.deepEqual(rows(filed), [
    ["Rename", "white"],
    ["Remove from folder", "red"],
    ["Folder", "caption"],
    ["Chill", true],
    ["Gym", false],
    ["Delete playlist", "white"],
  ]);
  assert.ok(filed.at(-1).separatorBefore, "a hairline sets Delete apart at the bottom");
  assert.ok(filed.some((i) => i.subject), "the playlist still heads the menu");
  assert.deepEqual(
    rows(playlistOwnItems({ id: "p2", name: "Loose", tracks: [] })),
    [["Rename", "white"], ["Delete playlist", "red"], ["Folder", "caption"], ["Chill", false], ["Gym", false]],
    "out of a folder the menu is as it was"
  );
  useLibrary.setState({ folders: [] });
  assert.deepEqual(rows(playlistOwnItems({ id: "p3", name: "Stale", tracks: [], folderId: "gone" })), [
    ["Rename", "white"],
    ["Delete playlist", "red"],
  ], "with no folders left there's nothing to remove it from");
});

test("only the listener's own scrolling closes a menu: the page scrolling by itself leaves it up", async () => {
  const h = await mount();
  try {
    await h.open([{ label: "Add to playlist", action() {} }]);
    const lyrics = document.createElement("div");
    document.body.append(lyrics);
    // Synced lyrics gliding to the next line: a scroll event, with nobody touching the wheel.
    await act(async () => lyrics.dispatchEvent(new window.Event("scroll")));
    assert.ok(useUI.getState().contextMenu, "a scroll the page made on its own leaves the menu up");
    const wheel = (el) => act(async () => el.dispatchEvent(new window.WheelEvent("wheel", { bubbles: true, deltaY: 40 })));
    await wheel(h.row("Add to playlist"));
    assert.ok(useUI.getState().contextMenu, "the wheel over the menu scrolls its own list");
    await wheel(lyrics);
    assert.equal(useUI.getState().contextMenu, null, "the wheel behind it is the listener scrolling: the menu goes");
  } finally {
    await h.close();
  }
});
