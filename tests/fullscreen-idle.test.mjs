/**
 * The fullscreen player's idle rule (src/lib/useIdle.ts) in a real React tree on jsdom, under
 * StrictMode's double mount as `npm run dev` runs it. YouTube's rule: once the pointer rests, the
 * controls and the cursor go; a real move brings them back. A "move" to the very spot the pointer
 * already holds is the browser re-checking hover after a repaint, not the user. Nothing goes idle
 * while a button is held, while keyboard focus sits in the controls, or while the view says so
 * (paused, a menu open). The delay is shortened here; timers are real.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const root = fileURLToPath(new URL("..", import.meta.url));
const DELAY = 100;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const code = build({
  stdin: {
    contents: `
      import { StrictMode, useState } from "react";
      import { createRoot } from "react-dom/client";
      import { flushSync } from "react-dom";
      import { useIdle } from "./src/lib/useIdle";
      window.__mount = (container) => {
        function View() {
          const [enabled, setEnabled] = useState(true);
          window.__enable = (on) => flushSync(() => setEnabled(on));
          const idle = useIdle(enabled, ${DELAY}, ".keep");
          return (
            <div id="view" data-idle={idle ? "yes" : "no"}>
              <button id="control" className="keep">Play</button>
              <button id="line">A lyric line</button>
            </div>
          );
        }
        flushSync(() => createRoot(container).render(<StrictMode><View /></StrictMode>));
      };
    `,
    resolveDir: root,
    loader: "tsx",
  },
  bundle: true,
  format: "iife",
  write: false,
  jsx: "automatic",
  logLevel: "silent",
  define: { "process.env.NODE_ENV": '"development"' },
}).then((r) => r.outputFiles[0].text);

async function page() {
  const dom = new JSDOM(`<!doctype html><html><body><div id="mount"></div></body></html>`, {
    pretendToBeVisual: true,
    runScripts: "outside-only",
  });
  const { window } = dom;
  // jsdom never matches :focus-visible; here focus "came from the keyboard" while this flag is up.
  let keyboard = false;
  const matches = window.Element.prototype.matches;
  window.Element.prototype.matches = function (selector) {
    if (selector === ":focus-visible") return keyboard && this === window.document.activeElement;
    return matches.call(this, selector);
  };
  window.eval(await code);
  window.__mount(window.document.getElementById("mount"));
  const doc = window.document;
  const fire = async (type, target, init = {}) => {
    const Ctor = type.startsWith("pointer") ? window.PointerEvent : type === "wheel" ? window.WheelEvent : window.Event;
    target.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, ...init }));
    await wait(5); // React flushes updates from native listeners on its own tick
  };
  const line = doc.getElementById("line");
  return {
    window,
    idle: () => doc.getElementById("view").dataset.idle === "yes",
    move: (x, y, target = line) => fire("pointermove", target, { clientX: x, clientY: y }),
    down: (x, y) => fire("pointerdown", line, { clientX: x, clientY: y, buttons: 1 }),
    up: (x, y) => fire("pointerup", line, { clientX: x, clientY: y }),
    wheel: () => fire("wheel", line, { deltaY: 100 }),
    keyboardFocus: async (el) => {
      keyboard = true;
      el.focus();
      await wait(5);
    },
    mouseFocus: async (el) => {
      keyboard = false;
      el.focus();
      await wait(5);
    },
    el: (id) => doc.getElementById(id),
  };
}

test("rests into idle after the delay; a real move wakes it at once and starts the wait over", async () => {
  const p = await page();
  assert.equal(p.idle(), false, "awake on entry");
  await wait(DELAY * 2);
  assert.equal(p.idle(), true, "the pointer rested past the delay");
  await p.move(10, 10);
  assert.equal(p.idle(), false, "a move wakes it");
  await wait(DELAY / 2);
  await p.move(30, 12);
  await wait(DELAY / 2 + 15);
  assert.equal(p.idle(), false, "each move starts the wait over");
  await wait(DELAY);
  assert.equal(p.idle(), true, "and rests again");
});

test("a move to the spot the pointer already holds (a repaint's hover check) does not wake it", async () => {
  const p = await page();
  await p.move(200, 150);
  await wait(DELAY * 2);
  assert.equal(p.idle(), true);
  await p.move(200, 150);
  assert.equal(p.idle(), true, "the same spot again is not the user");
  await p.move(201, 150);
  assert.equal(p.idle(), false, "one pixel is");
});

test("nothing goes idle while a button is held; the release starts the wait over", async () => {
  const p = await page();
  await p.down(50, 50);
  await wait(DELAY * 3);
  assert.equal(p.idle(), false, "a held button (a slider drag) keeps it up");
  await p.up(50, 50);
  await wait(DELAY / 2);
  assert.equal(p.idle(), false, "the wait starts at the release");
  await wait(DELAY);
  assert.equal(p.idle(), true);
});

test("a press or a wheel turn wakes it as well as a move", async () => {
  const p = await page();
  await wait(DELAY * 2);
  assert.equal(p.idle(), true);
  await p.down(5, 5);
  assert.equal(p.idle(), false, "a press wakes it");
  await p.up(5, 5);
  await wait(DELAY * 2);
  assert.equal(p.idle(), true);
  await p.wheel();
  assert.equal(p.idle(), false, "a wheel turn wakes it");
});

test("turned off it wakes at once and stays up; turned back on it rests again", async () => {
  const p = await page();
  await wait(DELAY * 2);
  assert.equal(p.idle(), true);
  p.window.__enable(false);
  assert.equal(p.idle(), false, "pausing, or a menu opening, brings the controls back in the same render");
  await wait(DELAY * 3);
  assert.equal(p.idle(), false, "and keeps them up");
  p.window.__enable(true);
  await wait(DELAY / 2);
  assert.equal(p.idle(), false, "playing again starts a fresh wait");
  await wait(DELAY);
  assert.equal(p.idle(), true);
});

test("keyboard focus in the controls keeps them up and Tab into them wakes them; mouse focus does not", async () => {
  const p = await page();
  await wait(DELAY * 2);
  assert.equal(p.idle(), true);
  await p.keyboardFocus(p.el("control"));
  assert.equal(p.idle(), false, "Tab reaching a control wakes the controls");
  await wait(DELAY * 3);
  assert.equal(p.idle(), false, "and they stay while it holds focus");
  await p.keyboardFocus(p.el("line"));
  await wait(DELAY * 2);
  assert.equal(p.idle(), true, "focus leaving the controls lets them go");
  await p.mouseFocus(p.el("control"));
  await wait(DELAY * 2);
  assert.equal(p.idle(), true, "a clicked button keeps focus, but the mouse's focus never holds them up");
});
