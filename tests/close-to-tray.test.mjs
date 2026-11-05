/**
 * Close to tray (electron/close-to-tray.ts): what closing the main window does on each platform, and the
 * Windows tray icon's menu. main.ts acts on these ("tray": hide and pause the music); the window coming back is
 * the same one, page loaded, so the launch intro only plays after a real quit.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTrayMenu, closeAction } from "../.test-build/close-to-tray.mjs";

const OPEN = { quitting: false, fullScreen: false, closeToTray: true, trayShown: true };

test("a real quit always closes the window, everywhere", () => {
  for (const platform of ["win32", "darwin", "linux"]) {
    assert.equal(closeAction({ ...OPEN, platform, quitting: true }), "close", platform);
    assert.equal(closeAction({ ...OPEN, platform, quitting: true, fullScreen: true }), "close", `${platform}, fullscreen`);
  }
});

test("macOS hides the window (the music plays on), and leaves native fullscreen first rather than hide it there", () => {
  assert.equal(closeAction({ ...OPEN, platform: "darwin" }), "hide");
  assert.equal(closeAction({ ...OPEN, platform: "darwin", fullScreen: true }), "leave-fullscreen");
  // The Windows setting and tray icon don't apply: the Dock brings it back.
  assert.equal(closeAction({ ...OPEN, platform: "darwin", closeToTray: false, trayShown: false }), "hide");
});

test("Windows closes to the tray, music paused, only while the setting is on and the tray icon is there", () => {
  assert.equal(closeAction({ ...OPEN, platform: "win32" }), "tray");
  assert.equal(closeAction({ ...OPEN, platform: "win32", fullScreen: true }), "tray", "fullscreen too: no Spaces on Windows");
  assert.equal(closeAction({ ...OPEN, platform: "win32", closeToTray: false }), "close", "setting off: close quits, as before");
  assert.equal(closeAction({ ...OPEN, platform: "win32", trayShown: false }), "close", "no tray icon: nothing could bring it back or quit");
  assert.equal(closeAction({ ...OPEN, platform: "linux" }), "close", "no tray anywhere else");
});

test("the tray menu: open, Play or Pause as it stands, next, previous, quit, each one wired", () => {
  const calls = [];
  const wiring = {
    sendCommand: (c) => calls.push(`command:${c}`),
    showMainWindow: () => calls.push("show"),
    quit: () => calls.push("quit"),
  };
  const paused = buildTrayMenu({ playing: false, shuffle: false, repeat: "off" }, wiring);
  const items = paused.filter((i) => i.type !== "separator");
  assert.deepEqual(items.map((i) => i.label), ["Open ByTune", "Play", "Next", "Previous", "Quit ByTune"]);
  assert.equal(buildTrayMenu({ playing: true, shuffle: false, repeat: "off" }, wiring)[2].label, "Pause");
  for (const item of items) item.click();
  assert.deepEqual(calls, ["show", "command:play-pause", "command:next", "command:previous", "quit"]);
  assert.ok(items.every((i) => !i.accelerator), "no accelerators: they'd be app-wide");
  assert.deepEqual(paused.map((i) => i.type ?? "item"), ["item", "separator", "item", "item", "item", "separator", "item"]);
});
