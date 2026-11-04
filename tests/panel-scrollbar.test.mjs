/**
 * The middle panel's scrollbar (src/components/PanelScrollbar.tsx), in jsdom. The panel's native
 * scrollbar is hidden so full-bleed covers can reach its right edge; this thumb, drawn over the page,
 * is the only scrollbar left. It must size and move like the native one, keep a grabbable size on long
 * pages, hide when nothing scrolls, drag the page, pass the wheel on, and follow a new page's height.
 * jsdom has no layout, ResizeObserver or animation frames, so the scroller's sizes, the resize
 * notifications and the frames are faked; the component and React are real.
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
const { createRoot } = await import("react-dom/client");

const require = createRequire(import.meta.url);
const { outputFiles } = await build({
  stdin: {
    contents: `export { PanelScrollbar } from "./src/components/PanelScrollbar";`,
    resolveDir: fileURLToPath(new URL("..", import.meta.url)),
    loader: "tsx",
  },
  bundle: true, platform: "node", format: "cjs", write: false, logLevel: "silent",
  external: ["react", "react/jsx-runtime", "react-dom", "lucide-react"],
});
const module = { exports: {} };
new Function("require", "module", "exports", outputFiles[0].text)(require, module, module.exports);
const { PanelScrollbar } = module.exports;

// Animation frames run when the test says so.
let nextFrame = 1;
const frames = new Map();
globalThis.requestAnimationFrame = (cb) => {
  frames.set(nextFrame, cb);
  return nextFrame++;
};
globalThis.cancelAnimationFrame = (id) => frames.delete(id);
const flush = () => {
  const due = [...frames.values()];
  frames.clear();
  due.forEach((f) => f(0));
};

// A resize reaches only the observers watching that element.
const observers = new Set();
globalThis.ResizeObserver = class {
  constructor(cb) {
    this.cb = cb;
    this.targets = new Set();
    observers.add(this);
  }
  observe(el) { this.targets.add(el); }
  unobserve(el) { this.targets.delete(el); }
  disconnect() { this.targets.clear(); }
};
const resized = (el) => {
  for (const o of observers) if (o.targets.has(el)) o.cb([{ target: el }], o);
};

const near = (actual, expected, what) => assert.ok(Math.abs(actual - expected) < 0.01, `${what}: ${actual} vs ${expected}`);

async function mount({ client, height }) {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost" });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.MutationObserver = dom.window.MutationObserver;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  dom.window.HTMLElement.prototype.setPointerCapture = () => {};
  dom.window.HTMLElement.prototype.releasePointerCapture = () => {};

  // The scroller, sized like a browser would: scrollTop stays within the page and fires "scroll".
  const size = { client, height };
  const el = document.createElement("div");
  let page = document.createElement("div");
  el.append(page);
  let top = 0;
  Object.defineProperties(el, {
    clientHeight: { get: () => size.client },
    scrollHeight: { get: () => size.height },
    scrollTop: {
      get: () => top,
      set: (v) => {
        const next = Math.max(0, Math.min(v, size.height - size.client));
        if (next === top) return;
        top = next;
        el.dispatchEvent(new dom.window.Event("scroll"));
      },
    },
  });
  el.scrollBy = (o) => { el.scrollTop = top + (o.top ?? 0); };
  document.body.append(el);

  const root = createRoot(document.getElementById("root"));
  await act(async () => root.render(React.createElement(PanelScrollbar, { target: { current: el } })));
  flush();
  const thumb = () => document.querySelector(".panel-scrollbar-thumb");
  return {
    el,
    size,
    thumb,
    page: () => page,
    /** The thumb's height and how far down the track it sits, in px. */
    box: () => {
      const t = thumb();
      return { height: parseFloat(t.style.height), top: parseFloat(t.style.transform.match(/translateY\(([-\d.]+)px\)/)?.[1] ?? "NaN") };
    },
    swapPage: () => {
      page = document.createElement("div");
      el.replaceChildren(page);
    },
    pointer: (type, clientY) => thumb().dispatchEvent(new dom.window.MouseEvent(type, { clientY, button: 0, bubbles: true })),
    unmount: () => act(async () => root.unmount()),
    close: () => dom.window.close(),
  };
}

test("the thumb is as tall as the share of the page in view, and moves with the scroll", async () => {
  const h = await mount({ client: 500, height: 2000 });
  try {
    assert.equal(h.thumb().hidden, false);
    near(h.box().height, 125, "a quarter of the page in view: a quarter of the track");
    near(h.box().top, 0, "at the top");
    h.el.scrollTop = 750;
    flush();
    near(h.box().top, 187.5, "halfway down the page: halfway down the free track");
    h.el.scrollTop = 1500;
    flush();
    near(h.box().top, 375, "at the bottom: it ends at the bottom");
    await h.unmount();
    h.el.scrollTop = 100;
    assert.equal(frames.size, 0, "once gone, scrolling doesn't wake it");
  } finally {
    h.close();
  }
});

test("a very long page keeps a thumb big enough to grab, and it still reaches the bottom", async () => {
  const h = await mount({ client: 500, height: 100000 });
  try {
    near(h.box().height, 40, "never thinner than 40px");
    h.el.scrollTop = 99500;
    flush();
    near(h.box().top, 460, "at the bottom of the page it sits at the bottom of the track");
  } finally {
    await h.unmount();
    h.close();
  }
});

test("no thumb while the page fits; it comes and goes as the page and the panel change size", async () => {
  const h = await mount({ client: 500, height: 500 });
  try {
    assert.equal(h.thumb().hidden, true, "nothing to scroll");
    h.size.height = 1000;
    resized(h.page());
    flush();
    assert.equal(h.thumb().hidden, false, "the page grew past the panel");
    near(h.box().height, 250, "half the page in view");
    h.size.client = 800;
    resized(h.el);
    flush();
    near(h.box().height, 640, "the panel got taller");
    h.size.height = 800;
    resized(h.page());
    flush();
    assert.equal(h.thumb().hidden, true, "the page fits again");
  } finally {
    await h.unmount();
    h.close();
  }
});

test("dragging the thumb scrolls the page in step, until the button comes up", async () => {
  const h = await mount({ client: 500, height: 1000 });
  try {
    // 250px of free track for 500px of page to scroll: 1px of drag is 2px of page.
    h.pointer("pointerdown", 100);
    h.pointer("pointermove", 150);
    assert.equal(h.el.scrollTop, 100);
    h.pointer("pointermove", 400);
    assert.equal(h.el.scrollTop, 500, "no further than the end of the page");
    h.pointer("pointerup", 400);
    h.pointer("pointermove", 100);
    assert.equal(h.el.scrollTop, 500, "let go: moving the mouse no longer scrolls");
    flush();
    near(h.box().top, 250, "the thumb followed");
  } finally {
    await h.unmount();
    h.close();
  }
});

test("the wheel still scrolls the page with the mouse over the thumb", async () => {
  const h = await mount({ client: 500, height: 1000 });
  try {
    h.thumb().dispatchEvent(new window.WheelEvent("wheel", { deltaY: 120, bubbles: true }));
    assert.equal(h.el.scrollTop, 120);
  } finally {
    await h.unmount();
    h.close();
  }
});

test("a page that settles when an animation or a transition ends: the thumb takes the settled height", async () => {
  // The view's rise-in starts the page 10px low, so it's 10px longer until the animation ends, and
  // nothing changes size when it does.
  const h = await mount({ client: 500, height: 1010 });
  try {
    for (const [type, height, thumb] of [["animationend", 1000, 250], ["transitionend", 1010, 247.525]]) {
      h.size.height = height;
      h.page().dispatchEvent(new window.Event(type, { bubbles: true }));
      flush();
      near(h.box().height, thumb, `after ${type}`);
    }
  } finally {
    await h.unmount();
    h.close();
  }
});

test("a new page: the thumb takes its height, and follows it as it grows", async () => {
  const h = await mount({ client: 500, height: 1000 });
  try {
    h.size.height = 3000;
    h.swapPage();
    await act(async () => {}); // the page swap is noticed
    flush();
    near(h.box().height, 500 * 500 / 3000, "the new page's height");
    h.size.height = 4000;
    resized(h.page());
    flush();
    near(h.box().height, 62.5, "the new page grew (its images came in)");
  } finally {
    await h.unmount();
    h.close();
  }
});
