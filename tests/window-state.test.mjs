/**
 * Window state (electron/window-state.ts): the main window reopens at the size and place it was closed at,
 * maximized only if it was (#11), and never off screen: a saved window stays on the display it mostly covers,
 * inside its work area, or opens as on a first launch when no display shows enough of it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { placeOnScreen, readWindowState } from "../.test-build/window-state.mjs";

// A 1920×1080 primary display with a 48 px taskbar, and a bigger monitor to its right.
const PRIMARY = { x: 0, y: 0, width: 1920, height: 1032 };
const RIGHT = { x: 1920, y: 0, width: 2560, height: 1392 };

test("reads a saved state, and nothing from a missing or damaged one", () => {
  assert.deepEqual(readWindowState({ x: 200.4, y: 150, width: 1100, height: 700.6, maximized: true }), { x: 200, y: 150, width: 1100, height: 701, maximized: true });
  assert.equal(readWindowState({ x: 0, y: 0, width: 1280, height: 820 }).maximized, false, "maximized only when saved as true");
  const damaged = [
    null, undefined, "x", 42, [], {},
    { x: 0, y: 0, width: 1280 },
    { x: "0", y: 0, width: 1280, height: 820 },
    { x: NaN, y: 0, width: 1280, height: 820 },
    { x: 0, y: 0, width: Infinity, height: 820 },
    { x: 0, y: 0, width: 0, height: 820 },
    { x: 0, y: 0, width: 1280, height: -5 },
  ];
  for (const raw of damaged) assert.equal(readWindowState(raw), null, String(JSON.stringify(raw)));
});

test("a window that fits reopens exactly where it was, on whichever display", () => {
  const onPrimary = { x: 200, y: 150, width: 1100, height: 700 };
  assert.deepEqual(placeOnScreen(onPrimary, [PRIMARY, RIGHT]), onPrimary);
  const onRight = { x: 2300, y: 100, width: 1600, height: 1000 };
  assert.deepEqual(placeOnScreen(onRight, [PRIMARY, RIGHT]), onRight, "not dragged back to the primary display");
  const onLeft = { x: -1700, y: 80, width: 1280, height: 820 };
  assert.deepEqual(placeOnScreen(onLeft, [{ x: -1920, y: 0, width: 1920, height: 1040 }, PRIMARY]), onLeft, "a display left of the primary has negative x");
});

test("a window whose display is gone, or that barely shows, opens where a first launch would", () => {
  assert.equal(placeOnScreen({ x: 2300, y: 100, width: 1600, height: 1000 }, [PRIMARY]), null, "its monitor was unplugged");
  assert.equal(placeOnScreen({ x: 1880, y: 100, width: 1280, height: 820 }, [PRIMARY]), null, "only 40 px on screen");
  assert.equal(placeOnScreen({ x: 100, y: 1000, width: 1280, height: 820 }, [PRIMARY]), null, "only 32 px above the taskbar");
});

test("a window partly off screen or under the taskbar moves back inside its display", () => {
  assert.deepEqual(placeOnScreen({ x: 1500, y: 100, width: 1280, height: 820 }, [PRIMARY]), { x: 640, y: 100, width: 1280, height: 820 });
  assert.deepEqual(placeOnScreen({ x: 300, y: 400, width: 1280, height: 820 }, [PRIMARY]), { x: 300, y: 212, width: 1280, height: 820 }, "the player bar never opens under the taskbar");
  assert.deepEqual(placeOnScreen({ x: -200, y: -30, width: 1280, height: 820 }, [PRIMARY]), { x: 0, y: 0, width: 1280, height: 820 }, "its top bar stays reachable");
});

test("a window bigger than its display now (from a big monitor back to a laptop) shrinks to fit", () => {
  const laptop = { x: 0, y: 0, width: 1536, height: 816 };
  assert.deepEqual(placeOnScreen({ x: 100, y: 50, width: 2400, height: 1400 }, [laptop]), laptop);
});

test("a window across two displays lands on the one it mostly covers", () => {
  // 1180 px of it on the primary display, 300 px on the right one.
  assert.deepEqual(placeOnScreen({ x: 740, y: 100, width: 1480, height: 900 }, [PRIMARY, RIGHT]), { x: 440, y: 100, width: 1480, height: 900 });
});
