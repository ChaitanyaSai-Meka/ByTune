import test from "node:test";
import assert from "node:assert/strict";
import { createSwipeNav, swipeLine, SWIPE_GAP_MS, SWIPE_LIFT_MS } from "../.test-build/swipeNav.mjs";

const WIDTH = 1000; // the line sits at 225 px
const never = () => false;
const always = () => true;
/** One gesture's wheel events, 16 ms apart, from `t0`. */
const events = (t0, deltas) =>
  deltas.map(([deltaX, deltaY], i) => ({ deltaX, deltaY, deltaMode: 0, ctrlKey: false, timeStamp: t0 + i * 16 }));
/** Momentum after the fingers lift: each frame a steady 6% smaller, like Chrome's fling curve. */
const coast = (t0, from, n) => events(t0, Array.from({ length: n }, (_, k) => [from * 0.94 ** (k + 1), 0]));
const feed = (nav, evs, { scrolls = never, can = always } = {}) =>
  evs.map((e) => nav.wheel(e, scrolls, can, WIDTH)).filter(Boolean);
const end = (evs) => evs[evs.length - 1].timeStamp;
const kinds = (updates) => updates.map((u) => (u.kind === "track" ? "track" : `${u.kind}${u.dir ? `:${u.dir}` : ""}`));
const steps = (updates) => updates.filter((u) => u.kind === "commit").map((u) => u.dir);

test("the line sits halfway between Chrome's (30% of the window, at least 180 px) and the old 150 px", () => {
  assert.equal(swipeLine(1000), 225);
  assert.equal(swipeLine(1600), 315);
  assert.equal(swipeLine(400), 165);
});

test("a slight drag only brings the arrow out a little, then puts it away", () => {
  const nav = createSwipeNav();
  const evs = events(0, Array(5).fill([-20, 0])); // 100 px
  const ups = feed(nav, evs);
  assert.ok(ups.length > 0 && ups.every((u) => u.kind === "track" && u.dir === "back" && u.progress < 0.5));
  assert.deepEqual(nav.quiet(end(evs) + SWIPE_LIFT_MS), { kind: "cancel" });
});

test("a swipe past the line goes back once the fingers stop, and only once", () => {
  const nav = createSwipeNav();
  const evs = events(0, Array(20).fill([-20, 1])); // 400 px
  const ups = feed(nav, evs);
  assert.deepEqual(steps(ups), [], "nothing happens while the fingers are still moving");
  assert.ok(ups[ups.length - 1].progress >= 1, "the arrow reaches the line");
  assert.equal(nav.quiet(end(evs) + SWIPE_LIFT_MS - 1), null, "a moment's stillness isn't a lift yet");
  assert.deepEqual(nav.quiet(end(evs) + SWIPE_LIFT_MS), { kind: "commit", dir: "back" });
  assert.equal(nav.quiet(end(evs) + SWIPE_LIFT_MS + 50), null);
});

test("fingers moving left go forward", () => {
  const nav = createSwipeNav();
  const evs = events(0, Array(20).fill([20, -1]));
  feed(nav, evs);
  assert.deepEqual(nav.quiet(end(evs) + SWIPE_LIFT_MS), { kind: "commit", dir: "forward" });
});

test("sliding back under the line before letting go cancels", () => {
  const nav = createSwipeNav();
  const evs = [...events(0, Array(20).fill([-20, 0])), ...events(20 * 16, Array(12).fill([20, 0]))]; // 400, then back to 160
  const ups = feed(nav, evs);
  assert.ok(ups.some((u) => u.progress >= 1) && ups[ups.length - 1].progress < 1);
  assert.deepEqual(nav.quiet(end(evs) + SWIPE_LIFT_MS), { kind: "cancel" });
});

test("momentum after a short swipe never carries it over the line", () => {
  const nav = createSwipeNav();
  const fingers = events(0, Array(8).fill([-20, 0])); // 160 px
  const evs = [...fingers, ...coast(end(fingers) + 16, -20, 40)]; // would add ~300 px
  const ups = feed(nav, evs);
  assert.deepEqual(steps(ups), []);
  assert.equal(kinds(ups).at(-1), "cancel", "the arrow goes away as soon as the coasting shows");
  assert.equal(nav.quiet(end(evs) + SWIPE_LIFT_MS), null);
});

test("coasting never moves the arrow over the line or turns it white", () => {
  const nav = createSwipeNav();
  const fingers = events(0, Array(10).fill([-20, 0])); // 200 px, just short of the line
  const evs = [...fingers, ...coast(end(fingers) + 16, -20, 40)];
  const ups = feed(nav, evs);
  assert.ok(ups.every((u) => u.kind !== "track" || u.progress < 1), "never white");
  assert.deepEqual(steps(ups), []);
  assert.equal(kinds(ups).at(-1), "cancel");
});

test("momentum after a long swipe takes the step at once and swallows the rest", () => {
  const nav = createSwipeNav();
  const fingers = events(0, Array(16).fill([-20, 0])); // 320 px, past the line
  const evs = [...fingers, ...coast(end(fingers) + 16, -20, 40)];
  const ups = feed(nav, evs);
  assert.deepEqual(steps(ups), ["back"]);
  assert.equal(kinds(ups).at(-1), "commit:back", "nothing after the step");
  assert.equal(nav.quiet(end(evs) + SWIPE_LIFT_MS), null);
});

test("a swipe that slows smoothly and then goes on isn't cut short", () => {
  const nav = createSwipeNav();
  const evs = [
    ...events(0, Array(6).fill([-20, 0])),
    ...events(6 * 16, [-18, -16.5, -15, -14, -13].map((d) => [d, 0])),
    ...events(11 * 16, Array(15).fill([-20, 0])),
  ];
  const ups = feed(nav, evs);
  assert.ok(kinds(ups).includes("cancel"), "the slowdown read as a lift put the arrow away");
  assert.equal(kinds(ups).at(-1), "track", "going on brought it back");
  assert.deepEqual(nav.quiet(end(evs) + SWIPE_LIFT_MS), { kind: "commit", dir: "back" });
});

test("a pause puts the arrow away and going on brings it back", () => {
  const nav = createSwipeNav();
  const first = events(0, Array(6).fill([-20, 0]));
  feed(nav, first);
  assert.deepEqual(nav.quiet(end(first) + SWIPE_LIFT_MS), { kind: "cancel" });
  const again = events(end(first) + SWIPE_LIFT_MS + 40, Array(12).fill([-20, 0]));
  const ups = feed(nav, again);
  assert.ok(ups[ups.length - 1].progress >= 1);
  assert.deepEqual(nav.quiet(end(again) + SWIPE_LIFT_MS), { kind: "commit", dir: "back" });
});

test("with no history that way there is no arrow and no step", () => {
  const nav = createSwipeNav();
  const evs = events(0, Array(30).fill([-20, 0]));
  const ups = feed(nav, evs, { can: never });
  assert.ok(ups.every((u) => u.kind === "track" && u.progress === 0));
  assert.notEqual(nav.quiet(end(evs) + SWIPE_LIFT_MS)?.kind, "commit");
});

test("after a step nothing more happens until the wheel rests", () => {
  const nav = createSwipeNav();
  const evs = events(0, Array(20).fill([-20, 0]));
  feed(nav, evs);
  assert.equal(nav.quiet(end(evs) + SWIPE_LIFT_MS).kind, "commit");
  assert.deepEqual(feed(nav, events(end(evs) + SWIPE_LIFT_MS + 20, Array(20).fill([-20, 0]))), []);
  const later = events(end(evs) + 2000, Array(20).fill([-20, 0]));
  assert.ok(feed(nav, later).length > 0, "a new gesture after a rest");
});

test("a vertical scroll that drifts sideways never navigates", () => {
  const nav = createSwipeNav();
  const evs = events(0, Array(40).fill([-6, 12]));
  assert.deepEqual(feed(nav, evs), []);
  assert.equal(nav.quiet(end(evs) + SWIPE_LIFT_MS), null);
});

test("a swipe that something scrolls belongs to it, even once it reaches its edge", () => {
  const nav = createSwipeNav();
  let room = 3;
  const evs = events(0, Array(30).fill([-20, 0]));
  assert.deepEqual(feed(nav, evs, { scrolls: () => room-- > 0 }), []);
  assert.equal(nav.quiet(end(evs) + SWIPE_LIFT_MS), null);
});

test("a pinch zoom is ignored, and a long pause splits two short swipes", () => {
  const nav = createSwipeNav();
  const pinch = events(0, Array(20).fill([-30, 0])).map((e) => ({ ...e, ctrlKey: true }));
  assert.deepEqual(feed(nav, pinch), []);
  const one = events(1000, Array(8).fill([-20, 0]));
  feed(nav, one);
  nav.quiet(end(one) + SWIPE_LIFT_MS);
  const two = events(end(one) + SWIPE_GAP_MS + 1, Array(8).fill([-20, 0]));
  const ups = feed(nav, two);
  assert.ok(ups[ups.length - 1].progress < 1, "the second swipe starts from nothing");
  assert.deepEqual(nav.quiet(end(two) + SWIPE_LIFT_MS), { kind: "cancel" });
});
