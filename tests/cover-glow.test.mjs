/**
 * The middle panel's glow (src/components/CoverGlow.tsx) with the real UI and player stores, in jsdom:
 * the playing song's cover glows, a hovered card's cover glows in over it and then alone, the glow
 * fades away when there's no cover, and the artist page and Settings have none.
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
globalThis.Image = environment.window.Image;
globalThis.bytune = { readData: async () => null, writeData: async () => undefined };
const { createRoot } = await import("react-dom/client");

const require = createRequire(import.meta.url);
const { outputFiles } = await build({
  stdin: {
    contents: `export { CoverGlow, GLOW_FADE_MS } from "./src/components/CoverGlow"; export { useUI } from "./src/stores/ui"; export { usePlayer } from "./src/stores/player";`,
    resolveDir: fileURLToPath(new URL("..", import.meta.url)),
    loader: "tsx",
  },
  bundle: true, platform: "node", format: "cjs", write: false, logLevel: "silent",
  external: ["react", "react/jsx-runtime", "react-dom", "lucide-react"],
});
const module = { exports: {} };
new Function("require", "module", "exports", outputFiles[0].text)(require, module, module.exports);
const { CoverGlow, GLOW_FADE_MS, useUI, usePlayer } = module.exports;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const A = "https://covers.example/a.jpg";
const B = "https://covers.example/b.jpg";
const song = (thumb) => ({ id: "aaaaaaaaaaa", title: "A", artist: "Artist", duration: 200, thumb });

async function mount() {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost" });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.Image = dom.window.Image;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  window.bytune = globalThis.bytune;
  const root = createRoot(document.getElementById("root"));
  await act(async () => root.render(React.createElement(CoverGlow)));
  return {
    layers: () => [...document.querySelectorAll(".cover-glow-art")].map((e) => ({ url: e.style.backgroundImage, out: e.classList.contains("cover-glow-out") })),
    glow: () => document.querySelector(".cover-glow"),
    close: async () => {
      await act(async () => root.unmount());
      dom.window.close();
    },
  };
}
const wait = (ms) => act(async () => { await sleep(ms); });

test("the playing song's cover glows; a hovered card's glows in over it, then alone", async () => {
  useUI.setState({ view: { name: "home" }, tintThumb: null });
  usePlayer.setState({ queue: [song(A)], index: 0 });
  const h = await mount();
  try {
    assert.deepEqual(h.layers(), [{ url: `url("${A}")`, out: false }]);
    await act(async () => useUI.setState({ tintThumb: B }));
    assert.deepEqual(h.layers().map((l) => l.url), [`url("${A}")`, `url("${B}")`], "the hovered cover over the playing one");
    await wait(GLOW_FADE_MS + 80);
    assert.deepEqual(h.layers(), [{ url: `url("${B}")`, out: false }], "once it has faded in, it alone");
  } finally {
    await h.close();
  }
});

test("with no cover (nothing playing, off the cards) the glow fades away", async () => {
  useUI.setState({ view: { name: "home" }, tintThumb: B });
  usePlayer.setState({ queue: [], index: 0 });
  const h = await mount();
  try {
    assert.equal(h.layers().length, 1);
    await act(async () => useUI.setState({ tintThumb: null }));
    assert.deepEqual(h.layers(), [{ url: `url("${B}")`, out: true }], "fading out");
    await wait(GLOW_FADE_MS + 80);
    assert.deepEqual(h.layers(), [], "then gone");
  } finally {
    await h.close();
  }
});

test("the artist page and Settings have no glow", async () => {
  usePlayer.setState({ queue: [song(A)], index: 0 });
  for (const name of ["artist", "settings"]) {
    useUI.setState({ view: { name }, tintThumb: null });
    const h = await mount();
    try {
      assert.equal(h.glow(), null, name);
    } finally {
      await h.close();
    }
  }
});
