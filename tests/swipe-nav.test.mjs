import test from "node:test";
import assert from "node:assert/strict";
import { createSwipeNav, SWIPE_GAP_MS } from "../.test-build/swipeNav.mjs";

const never = () => false;
/** One gesture's wheel events, 16 ms apart, from `t0`. */
const events = (t0, deltas) =>
  deltas.map(([deltaX, deltaY], i) => ({ deltaX, deltaY, deltaMode: 0, ctrlKey: false, timeStamp: t0 + i * 16 }));
const feed = (nav, evs, scrolls = never) => evs.map((e) => nav(e, scrolls)).filter(Boolean);

test("fingers moving right go back, once per gesture; fingers moving left go forward", () => {
  const nav = createSwipeNav();
  assert.deepEqual(feed(nav, events(0, Array(20).fill([-20, 1]))), ["back"]);
  assert.deepEqual(feed(nav, events(1000, Array(20).fill([20, -1]))), ["forward"]);
});

test("a vertical scroll that drifts sideways never navigates", () => {
  const nav = createSwipeNav();
  assert.deepEqual(feed(nav, events(0, Array(40).fill([-6, 12]))), []);
});

test("a swipe that something scrolls belongs to it, even once it reaches its edge", () => {
  const nav = createSwipeNav();
  let room = 3;
  assert.deepEqual(feed(nav, events(0, Array(30).fill([-20, 0])), () => room-- > 0), []);
});

test("a pinch zoom is ignored, and a pause splits two short swipes", () => {
  const nav = createSwipeNav();
  const pinch = events(0, Array(20).fill([-30, 0])).map((e) => ({ ...e, ctrlKey: true }));
  assert.deepEqual(feed(nav, pinch), []);
  assert.deepEqual(feed(nav, events(1000, Array(5).fill([-20, 0]))), []);
  assert.deepEqual(feed(nav, events(1000 + 4 * 16 + SWIPE_GAP_MS + 1, Array(5).fill([-20, 0]))), []);
});
