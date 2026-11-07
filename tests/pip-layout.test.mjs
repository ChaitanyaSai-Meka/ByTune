/**
 * Miniplayer layout (src/pip/layout.ts): the square layout at every size the miniplayer always had, the
 * one-row bar (PR #10) only below BAR_MAX_H, its cover as tall as the row allows, and its buttons kept
 * in order of need as the window narrows.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { BAR_BUTTONS, BAR_MAX_H, pipLayout } from "../.test-build/pip-layout.mjs";

test("the square layout from BAR_MAX_H up, wide windows included", () => {
  assert.deepEqual(pipLayout(352, 353), { mode: "square" }, "the default size");
  assert.deepEqual(pipLayout(578, 233), { mode: "square" }, "the old miniplayer's widest, shortest window");
  assert.deepEqual(pipLayout(440, 200), { mode: "square" }, "wide but tall enough: no one-row bar floating in an empty box");
  assert.deepEqual(pipLayout(300, BAR_MAX_H), { mode: "square" });
  assert.equal(pipLayout(300, BAR_MAX_H - 1).mode, "bar");
});

test("the bar's cover fills the row's height, up to a quarter of the width", () => {
  assert.equal(pipLayout(600, 120).cover, 103, "120 px tall: 7 px above and below, the 3 px seek strip");
  assert.equal(pipLayout(320, 110).cover, 80, "a quarter of 320");
  assert.equal(pipLayout(200, 75).cover, 50, "the smallest window");
  for (const [w, h] of [[200, 75], [220, 80], [320, 110], [440, 150], [640, 174]]) {
    const { cover } = pipLayout(w, h);
    assert.ok(cover <= h - 17 && cover <= w / 4 + 0.5 && cover >= 32, `${w}x${h}: cover ${cover}`);
  }
});

test("the bar keeps the buttons that fit, most needed first", () => {
  assert.deepEqual(pipLayout(220, 80).buttons, ["play"], "the smallest bar: play only");
  assert.deepEqual(pipLayout(320, 110).buttons, ["play", "next", "like", "prev"]);
  assert.deepEqual(pipLayout(600, 120).buttons, [...BAR_BUTTONS], "a wide bar: every button");
  let last = 0;
  for (let w = 200; w <= 640; w += 20) {
    const { buttons } = pipLayout(w, 110);
    assert.deepEqual(buttons, BAR_BUTTONS.slice(0, buttons.length), `${w} px: always the first N, in order`);
    assert.ok(buttons.length >= last, `${w} px: a wider window never loses a button`);
    last = buttons.length;
  }
});
