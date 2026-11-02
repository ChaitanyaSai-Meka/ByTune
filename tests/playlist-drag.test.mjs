/**
 * Playlist drag (useSortable's native mode) in a real React tree on jsdom: the floating copy and the
 * release must agree. Over the list's column the copy shows a slot and the release lands there,
 * even over the page header or under the last row; off the column the copy turns into the compact
 * card and the page's own targets get the drop. jsdom has no layout or DragEvent, so rectangles
 * are stubbed and drag events are plain Events carrying clientX/clientY/dataTransfer.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const root = fileURLToPath(new URL("..", import.meta.url));
const ROW = 64;
const N = 5;
// The page scrolls between y 50 and 800; the list is x 100–700, from y 300.
const RECTS = {
  scroller: { left: 0, right: 1000, top: 50, bottom: 800 },
  header: { left: 0, right: 1000, top: 60, bottom: 280 },
  list: { left: 100, right: 700, top: 300, bottom: 300 + N * ROW },
  padding: { left: 0, right: 100, top: 300, bottom: 620 },
};

let bundled = null;
async function harnessCode() {
  bundled ??= build({
    stdin: {
      contents: `
        import { useRef } from "react";
        import { createRoot } from "react-dom/client";
        import { flushSync } from "react-dom";
        import { useSortable } from "./src/lib/useSortable";
        import { draggingFromPlaylist, useDrag } from "./src/lib/dnd";
        window.__draggingFrom = draggingFromPlaylist;
        window.__mountSources = (container) => {
          const song = (id) => ({ id, title: id, artist: "x", duration: 1, thumb: "" });
          function Sources() {
            const own = useDrag({ track: song("a"), fromPlaylist: "pl_1" });
            const other = useDrag({ track: song("b") });
            return (<><div id="own" {...own.props}>a</div><div id="other" {...other.props}>b</div></>);
          }
          flushSync(() => createRoot(container).render(<Sources />));
        };
        window.__mount = (container, n, commits) => {
          function List() {
            const listRef = useRef(null);
            const scrollRef = useRef(document.getElementById("scroller"));
            const s = useSortable({
              signature: "same", listRef, scrollRef,
              clamp: (_from, target) => target, canDrag: () => true,
              onCommit: (from, to) => commits.push(from + ">" + to),
            });
            return (
              <div id="list" ref={listRef}>
                {Array.from({ length: n }, (_, i) => (
                  <div key={i} data-row={i} draggable style={s.styleFor(i)} {...s.dragProps(i)}>
                    <span data-ghost-hide>{i + 1}</span> song {i}
                  </div>
                ))}
              </div>
            );
          }
          flushSync(() => createRoot(container).render(<List />));
        };`,
      resolveDir: root,
      sourcefile: "playlist-drag-harness.tsx",
      loader: "tsx",
    },
    bundle: true,
    format: "iife",
    write: false,
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
  }).then((r) => r.outputFiles[0].text);
  return bundled;
}

async function page() {
  const dom = new JSDOM(
    `<!doctype html><html class="reduce-motion"><body><main id="panel"><div id="scroller"><div id="header">Playlist</div><div id="padding"></div><div id="mount"></div></div></main><div id="sources"></div></body></html>`,
    { pretendToBeVisual: true, runScripts: "outside-only" },
  );
  const { window } = dom;
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    const row = this.getAttribute("data-row");
    const r = row !== null && !this.parentElement?.isSameNode(window.document.body)
      ? { left: 100, right: 700, top: 300 + Number(row) * ROW, bottom: 300 + (Number(row) + 1) * ROW }
      : RECTS[this.id] ?? { left: 0, right: 0, top: 0, bottom: 0 };
    return { ...r, x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top };
  };
  window.eval(await harnessCode());
  const commits = [];
  window.__mount(window.document.getElementById("mount"), N, commits);
  // What the page's own "drop to add" target (App's panel) would hear.
  const panel = { over: 0, drops: 0 };
  const main = window.document.getElementById("panel");
  main.addEventListener("dragover", (e) => { panel.over++; e.preventDefault(); });
  main.addEventListener("drop", (e) => { panel.drops++; e.preventDefault(); });
  const dt = { effectAllowed: "uninitialized", dropEffect: "none", types: [], setData() {}, setDragImage() {} };
  const settle = () => new Promise((r) => setTimeout(r, 20));
  const fire = async (type, target, x, y, extra = {}) => {
    const e = new window.Event(type, { bubbles: true, cancelable: true });
    for (const [k, v] of Object.entries({ clientX: x, clientY: y, dataTransfer: dt, ...extra })) Object.defineProperty(e, k, { value: v });
    target.dispatchEvent(e);
    await settle();
    return e;
  };
  const el = (sel) => window.document.querySelector(sel);
  const row = (i) => el(`#list [data-row="${i}"]`);
  const ghost = () => [...window.document.body.children].find((c) => c.style.position === "fixed") ?? null;
  return { window, commits, panel, dt, fire, el, row, ghost, settle };
}

test("released over the header, the song lands in the first slot the copy showed", async () => {
  const p = await page();
  await p.fire("dragstart", p.row(2), 300, 300 + 2 * ROW + 32);
  const over = await p.fire("dragover", p.el("#header"), 300, 120);
  assert.equal(over.defaultPrevented, true, "the list takes the drag over its column");
  assert.equal(p.panel.over, 0, "the page's own drop target never hears it");
  assert.equal(p.dt.dropEffect, "move");
  assert.equal(p.ghost().style.width, "600px", "full width: it shows a slot");
  assert.match(p.ghost().style.transform, /translate\(0px, -128px\)/, "parked at the first slot");
  const drop = await p.fire("drop", p.el("#header"), 300, 120);
  assert.equal(drop.defaultPrevented, true);
  assert.equal(p.panel.drops, 0, "no 'Already in …' from the page");
  await p.fire("dragend", p.row(2), 300, 120);
  assert.deepEqual(p.commits, ["2>0"]);
  assert.equal(p.ghost(), null, "the copy is gone once it lands");
});

test("released under the last row, the song lands in the last slot", async () => {
  const p = await page();
  await p.fire("dragstart", p.row(1), 300, 300 + ROW + 32);
  await p.fire("dragover", p.el("#scroller"), 300, 700);
  assert.equal(p.panel.over, 0);
  await p.fire("drop", p.el("#scroller"), 300, 700);
  await p.fire("dragend", p.row(1), 300, 700);
  assert.deepEqual(p.commits, [`1>${N - 1}`]);
});

test("off the column the copy is the compact card and the page under it gets the drop", async () => {
  const p = await page();
  await p.fire("dragstart", p.row(1), 300, 300 + ROW + 32);
  await p.fire("dragover", p.el("#padding"), 50, 400);
  assert.equal(p.panel.over, 1, "whatever is under the pointer decides");
  assert.equal(p.ghost().style.width, "320px", "compact card");
  assert.equal(p.ghost().querySelector("[data-ghost-hide]").style.display, "none");
  await p.fire("drop", p.el("#padding"), 50, 400);
  assert.equal(p.panel.drops, 1);
  p.dt.dropEffect = "copy";
  await p.fire("dragend", p.row(1), 50, 400);
  assert.deepEqual(p.commits, [], "nothing moves in the list");
  assert.equal(p.ghost(), null);
});

test("above the page (the top bar) is off the column too", async () => {
  const p = await page();
  await p.fire("dragstart", p.row(3), 300, 300 + 3 * ROW + 32);
  await p.fire("dragover", p.window.document.body, 300, 20);
  assert.equal(p.ghost().style.width, "320px");
  p.dt.dropEffect = "none";
  await p.fire("dragend", p.row(3), 300, 20);
  assert.deepEqual(p.commits, [], "let go where nothing takes it: it glides home");
});

// The window-exit card waits 100 ms in useSortable: a cancel sends the same dragleave just before its dragend.
const pastAwayWait = () => new Promise((r) => setTimeout(r, 150));

test("leaving the window turns the copy into the card; back over the list it shows the slot again", async () => {
  const p = await page();
  await p.fire("dragstart", p.row(0), 300, 332);
  await p.fire("dragover", p.row(3), 300, 300 + 3 * ROW + 40);
  assert.equal(p.ghost().style.width, "600px");
  // Blink sends a window exit as a dragleave with relatedTarget null and no points.
  await p.fire("dragleave", p.row(3), 0, 0, { relatedTarget: null });
  await pastAwayWait();
  assert.equal(p.ghost().style.width, "320px", "out of the window nothing takes the release");
  await p.fire("dragenter", p.row(3), 300, 300 + 3 * ROW + 40, { relatedTarget: null });
  assert.equal(p.ghost().style.width, "600px", "back over the list");
  await p.fire("dragleave", p.row(3), 0, 0, { relatedTarget: null });
  await p.fire("dragenter", p.row(3), 300, 300 + 3 * ROW + 40, { relatedTarget: null });
  await pastAwayWait();
  assert.equal(p.ghost().style.width, "600px", "out and straight back in: the card never shows");
  p.dt.dropEffect = "none";
  await p.fire("dragend", p.row(0), 300, 300 + 3 * ROW + 40);
  assert.deepEqual(p.commits, [], "let go where nothing takes it: back home");
});

test("Escape while the copy shows a slot glides it home from that slot", async () => {
  const p = await page();
  await p.fire("dragstart", p.row(0), 300, 332);
  await p.fire("dragover", p.row(3), 300, 300 + 3 * ROW + 40);
  const slot = p.ghost().style.transform;
  assert.match(slot, /^translate\(0px, 200px\)/);
  // Chromium cancels a drag (Escape) with a dragleave whose relatedTarget is null, then the source's dragend.
  await p.fire("dragleave", p.row(3), 0, 0, { relatedTarget: null });
  const g = p.ghost();
  assert.equal(g.style.width, "600px", "still full width when dragend arrives: the glide starts at the slot");
  assert.equal(g.style.transform, slot, "not shifted sideways to the card's place");
  assert.equal(g.querySelector("[data-ghost-hide]").style.display, "", "its number still shows");
  p.dt.dropEffect = "none";
  await p.fire("dragend", p.row(0), 0, 0);
  assert.deepEqual(p.commits, [], "no drop: back home");
  await pastAwayWait();
  assert.equal(p.ghost(), null, "landed home, and the copy stays gone");
});

test("released over a row, the song lands in that row's slot (control)", async () => {
  const p = await page();
  await p.fire("dragstart", p.row(4), 300, 300 + 4 * ROW + 32);
  await p.fire("dragenter", p.row(1), 300, 300 + ROW + 10, { relatedTarget: p.row(4) });
  await p.fire("dragover", p.row(1), 300, 300 + ROW + 10);
  const drop = await p.fire("drop", p.row(1), 300, 300 + ROW + 10);
  assert.equal(drop.defaultPrevented, true);
  await p.fire("dragend", p.row(4), 300, 300 + ROW + 10);
  assert.deepEqual(p.commits, ["4>1"]);
  assert.equal(p.panel.over + p.panel.drops, 0);
});

test("a playlist's own song is marked as such for the length of its drag only", async () => {
  const p = await page();
  const from = (id) => p.window.__draggingFrom(id);
  p.window.__mountSources(p.el("#sources"));
  await p.fire("dragstart", p.el("#own"), 10, 10);
  assert.equal(from("pl_1"), true, "its page and its sidebar row refuse it");
  assert.equal(from("pl_2"), false, "every other playlist still takes it");
  await p.fire("dragend", p.el("#own"), 10, 10);
  assert.equal(from("pl_1"), false, "cleared when the drag ends");
  await p.fire("dragstart", p.el("#own"), 10, 10);
  await p.fire("dragstart", p.el("#other"), 10, 10); // even without its dragend, the next drag starts clean
  assert.equal(from("pl_1"), false);
});
