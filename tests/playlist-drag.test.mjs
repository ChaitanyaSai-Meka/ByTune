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

const bundled = {};
/** `dev`: React's development build, whose StrictMode mounts every component twice (as `npm run dev` does). */
async function harnessCode(dev = false) {
  bundled[dev] ??= build({
    stdin: {
      contents: `
        import { StrictMode, useRef } from "react";
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
                    <button data-btn={i} onClick={() => window.__clicks.push(i)}>artist</button>
                  </div>
                ))}
              </div>
            );
          }
          flushSync(() => createRoot(container).render(window.__strict ? <StrictMode><List /></StrictMode> : <List />));
        };
        // The queue's kind of list: plain rows the hook moves itself (rowProps).
        window.__mountRows = (container, n, commits) => {
          function Rows() {
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
                  // Draggable like the queue's rows, which also carry their song out to playlists.
                  <div key={i} data-row={i} draggable style={s.styleFor(i)} {...s.rowProps(i)}>
                    song {i} <button data-btn={i} onClick={() => window.__clicks.push(i)}>like</button>
                  </div>
                ))}
              </div>
            );
          }
          flushSync(() => createRoot(container).render(window.__strict ? <StrictMode><Rows /></StrictMode> : <Rows />));
        };`,
      resolveDir: root,
      sourcefile: "playlist-drag-harness.tsx",
      loader: "tsx",
    },
    bundle: true,
    format: "iife",
    write: false,
    jsx: "automatic",
    define: { "process.env.NODE_ENV": dev ? '"development"' : '"production"' },
  }).then((r) => r.outputFiles[0].text);
  return bundled[dev];
}

async function page(mode = "native", { strict = false } = {}) {
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
  window.HTMLElement.prototype.setPointerCapture = function () {};
  window.__strict = strict;
  window.eval(await harnessCode(strict));
  const commits = [];
  window.__clicks = [];
  (mode === "rows" ? window.__mountRows : window.__mount)(window.document.getElementById("mount"), N, commits);
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

/* ---------------- a finger: hold still, then drag (TOUCH_HOLD_MS) ---------------- */

const HOLD = 450; // past useSortable's TOUCH_HOLD_MS
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const finger = { pointerType: "touch", pointerId: 7, button: 0, buttons: 1 };
const mouse = { pointerType: "mouse", pointerId: 1, button: 0, buttons: 1 };
const mid = (i) => 300 + i * ROW + 32;

test("a finger that holds still drags a playlist row to the slot it shows, and doesn't scroll the list", async () => {
  const p = await page();
  const from = p.row(3);
  await p.fire("pointerdown", from, 300, mid(3), finger);
  assert.equal(from.draggable, false, "no native drag under a finger");
  await wait(HOLD);
  const tm = await p.fire("touchmove", from, 300, mid(3));
  assert.equal(tm.defaultPrevented, true, "once held, the finger's moves don't scroll the list");
  for (const y of [mid(3) - 12, mid(2), 300 + ROW + 10]) await p.fire("pointermove", from, 300, y, finger);
  assert.equal(p.ghost(), null, "the row itself lifts, no floating copy");
  await p.fire("pointerup", from, 300, 300 + ROW + 10, finger);
  await p.settle();
  assert.deepEqual(p.commits, ["3>1"]);
  assert.equal(from.draggable, true, "its native drag is back");
});

test("a finger that moves before the hold scrolls: nothing lifts", async () => {
  const p = await page();
  const from = p.row(3);
  await p.fire("pointerdown", from, 300, mid(3), finger);
  await p.fire("pointermove", from, 300, mid(3) - 30, finger);
  const tm = await p.fire("touchmove", from, 300, mid(3) - 30);
  assert.equal(tm.defaultPrevented, false, "the list scrolls");
  await wait(HOLD);
  await p.fire("pointermove", from, 300, mid(1), finger);
  await p.fire("pointerup", from, 300, mid(1), finger);
  await p.settle();
  assert.deepEqual(p.commits, []);
  assert.equal(from.draggable, true);
});

test("a finger that holds and lets go without moving keeps the row's long-press menu", async () => {
  const p = await page();
  const from = p.row(2);
  await p.fire("pointerdown", from, 300, mid(2), finger);
  await wait(HOLD);
  await p.fire("pointerup", from, 300, mid(2), finger);
  const menu = await p.fire("contextmenu", from, 300, mid(2));
  assert.equal(menu.defaultPrevented, false);
  assert.deepEqual(p.commits, []);
});

test("the pointercancel a native mouse drag starts with doesn't end that drag", async () => {
  const p = await page();
  await p.fire("pointerdown", p.row(4), 300, mid(4), mouse);
  await p.fire("dragstart", p.row(4), 300, mid(4));
  await p.fire("pointercancel", p.row(4), 300, mid(4), mouse);
  await p.fire("dragenter", p.row(1), 300, 300 + ROW + 10, { relatedTarget: p.row(4) });
  await p.fire("dragover", p.row(1), 300, 300 + ROW + 10);
  const drop = await p.fire("drop", p.row(1), 300, 300 + ROW + 10);
  assert.equal(drop.defaultPrevented, true);
  await p.fire("dragend", p.row(4), 300, 300 + ROW + 10);
  assert.deepEqual(p.commits, ["4>1"]);
});

test("queue rows: a finger drags after its hold, and a quick swipe scrolls", async () => {
  const p = await page("rows");
  const from = p.row(4);
  await p.fire("pointerdown", from, 300, mid(4), finger);
  await p.fire("pointermove", from, 300, mid(4) - 40, finger);
  await p.fire("pointerup", from, 300, mid(4) - 40, finger);
  await p.settle();
  assert.deepEqual(p.commits, [], "a swipe moves nothing");
  await p.fire("pointerdown", from, 300, mid(4), finger);
  await wait(HOLD);
  assert.equal((await p.fire("touchmove", from, 300, mid(4))).defaultPrevented, true);
  for (const y of [mid(4) - 12, mid(2), 330]) await p.fire("pointermove", from, 300, y, finger);
  await p.fire("pointerup", from, 300, 330, finger);
  await p.settle();
  assert.deepEqual(p.commits, ["4>0"]);
});

test("queue rows: a mouse still drags at once, with no hold", async () => {
  const p = await page("rows");
  const from = p.row(4);
  await p.fire("pointerdown", from, 300, mid(4), mouse);
  for (const y of [mid(4) - 12, mid(2), 330]) await p.fire("pointermove", from, 300, y, mouse);
  await p.fire("pointerup", from, 300, 330, mouse);
  await p.settle();
  assert.deepEqual(p.commits, ["4>0"]);
});

test("a finger's hold lifts the row at once, before it moves, and letting go puts it back", async () => {
  for (const mode of ["native", "rows"]) {
    const p = await page(mode);
    const from = p.row(2);
    await p.fire("pointerdown", from, 300, mid(2), finger);
    assert.equal(from.style.zIndex, "", `${mode}: not lifted before the hold`);
    await wait(HOLD);
    assert.equal(from.style.zIndex, "20", `${mode}: lifted as soon as the hold completes`);
    assert.match(from.style.transform, /scale\(1\.02\)/, `${mode}: drawn lifted`);
    const menu = await p.fire("contextmenu", from, 300, mid(2));
    assert.equal(menu.defaultPrevented, false, `${mode}: a still hold may still open the long-press menu`);
    await p.fire("pointerup", from, 300, mid(2), finger);
    await p.settle();
    assert.deepEqual(p.commits, [], `${mode}: let go in place, nothing moves`);
    assert.equal(from.style.zIndex, "", `${mode}: back down`);
  }
});

test("a finger holding a row's button or link picks the row up; a tap still presses it", async () => {
  for (const mode of ["native", "rows"]) {
    const p = await page(mode);
    const btn = p.el('#list [data-row="3"] [data-btn]');
    await p.fire("pointerdown", btn, 300, mid(3), finger);
    await p.fire("pointerup", btn, 300, mid(3), finger);
    await p.fire("click", btn, 300, mid(3));
    assert.deepEqual(p.window.__clicks, [3], `${mode}: the tap pressed it`);
    await p.fire("pointerdown", btn, 300, mid(3), finger);
    await wait(HOLD);
    for (const y of [mid(3) - 12, mid(2), 300 + ROW + 10]) await p.fire("pointermove", btn, 300, y, finger);
    const menu = await p.fire("contextmenu", btn, 300, 300 + ROW + 10);
    assert.equal(menu.defaultPrevented, true, `${mode}: a row being dragged doesn't open its menu`);
    await p.fire("pointerup", btn, 300, 300 + ROW + 10, finger);
    await p.settle();
    assert.deepEqual(p.commits, ["3>1"], `${mode}: the hold moved the row`);
  }
});

test("a mouse on a row's button presses it and never drags the row", async () => {
  const p = await page("rows");
  const btn = p.el('#list [data-row="3"] [data-btn]');
  await p.fire("pointerdown", btn, 300, mid(3), mouse);
  for (const y of [mid(3) - 12, mid(2), 300 + ROW + 10]) await p.fire("pointermove", btn, 300, y, mouse);
  await p.fire("pointerup", btn, 300, 300 + ROW + 10, mouse);
  await p.settle();
  assert.deepEqual(p.commits, []);
});

test("a queue row's own native drag is off while a finger is down, and back after", async () => {
  const p = await page("rows");
  const row = p.row(2);
  await p.fire("pointerdown", row, 300, mid(2), finger);
  assert.equal(row.draggable, false, "a long press can't start the native drag");
  await p.fire("pointerup", row, 300, mid(2), finger);
  assert.equal(row.draggable, true);
});

test("under React's StrictMode (the dev build) a held drag still keeps the list from scrolling, and moves the row", async () => {
  for (const mode of ["native", "rows"]) {
    const p = await page(mode, { strict: true });
    const from = p.row(3);
    await p.fire("pointerdown", from, 300, mid(3), finger);
    await wait(HOLD);
    const tm = await p.fire("touchmove", from, 300, mid(3) - 12);
    assert.equal(tm.defaultPrevented, true, `${mode}: a held drag's finger moves must not scroll the list`);
    for (const y of [mid(3) - 12, mid(2), 300 + ROW + 10]) await p.fire("pointermove", from, 300, y, finger);
    await p.fire("pointerup", from, 300, 300 + ROW + 10, finger);
    await p.settle();
    assert.deepEqual(p.commits, ["3>1"], `${mode}: the row moved`);
  }
});
