import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const require = createRequire(import.meta.url);

/** Load the REAL coalescing storage adapter on a fake clock, with a counting bridge. */
async function loadCoalescedStorage({ disk = {}, clone = false } = {}) {
  const { outputFiles } = await build({
    entryPoints: [fileURLToPath(new URL("../src/lib/persist.ts", import.meta.url))],
    bundle: true, platform: "node", format: "cjs", write: false,
    external: ["zustand/middleware"],
  });
  let now = 1_000_000;
  let seq = 0;
  const timers = new Map();
  const advance = (ms) => {
    const end = now + ms;
    for (;;) {
      const next = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      timers.delete(next[0]);
      now = next[1].at;
      next[1].fn();
    }
    now = end;
  };
  const writes = [];
  const windowStub = {
    bytune: {
      readData: async (name) => disk[name] ?? null,
      // `clone` mimics IPC: structured clone throws on functions.
      writeData: async (name, data) => { writes.push({ name, data: clone ? structuredClone(data) : data, at: now }); },
    },
    addEventListener(type, fn) { (windowStub[type] = windowStub[type] || []).push(fn); },
    removeEventListener() {},
  };
  const module = { exports: {} };
  vm.runInNewContext(outputFiles[0].text, {
    module, exports: module.exports, console,
    Date: { now: () => now },
    setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { at: now + ms, fn }); return id; },
    clearTimeout: (id) => timers.delete(id),
    window: windowStub,
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    require: (name) => require(name),
  });
  return {
    coalesced: module.exports.coalescedStorage, writes, advance,
    firePagehide: () => { for (const fn of windowStub.pagehide ?? []) fn(); },
  };
}

const v = (state) => ({ state, version: 0 });

test("coalesced storage: a 4Hz burst of real changes writes at most once per 2s, newest value wins", async () => {
  const h = await loadCoalescedStorage();
  for (let i = 0; i < 32; i++) {
    h.coalesced.setItem("library", v({ rev: i }));
    h.advance(250);
  }
  assert.ok(h.writes.length <= 5, `expected ≤5 writes for 8 s of changes, got ${h.writes.length}`);
  h.advance(2000);
  assert.equal(h.writes.at(-1).data.state.rev, 31, "the newest value is the one persisted");
});

test("coalesced storage: position-only changes write every 10s; a real change still lands within 2s", async () => {
  const h = await loadCoalescedStorage();
  const queue = [{ id: "a" }];
  h.coalesced.setItem("player", v({ queue, position: 1 }));
  assert.equal(h.writes.length, 1, "the first write lands at once");
  for (let s = 1; s <= 36; s++) {
    h.advance(250);
    h.coalesced.setItem("player", v({ queue, position: 1 + s / 4 }));
  }
  assert.equal(h.writes.length, 1, "9 s of position ticks wait for the 10 s window");
  h.advance(1000);
  assert.equal(h.writes.length, 2);
  assert.equal(h.writes[1].data.state.position, 10);
  h.advance(250);
  h.coalesced.setItem("player", v({ queue, position: 10.25 }));
  h.advance(250);
  h.coalesced.setItem("player", v({ queue: [...queue, { id: "b" }], position: 10.5 }));
  h.advance(2000);
  assert.equal(h.writes.length, 3, "a queue change pulls the pending write forward to the 2 s window");
  assert.equal(h.writes[2].data.state.queue.length, 2);
});

test("coalesced storage: pagehide flushes the newest values, stores don't wait on each other, removals are immediate", async () => {
  const h = await loadCoalescedStorage();
  const queue = [];
  h.coalesced.setItem("player", v({ queue, position: 42 }));
  h.coalesced.setItem("player", v({ queue, position: 99 }));
  h.coalesced.setItem("library", v({ downloads: 1 }));
  assert.deepEqual(h.writes.map((w) => w.name), ["player", "library"], "the library doesn't wait behind the player");
  h.firePagehide();
  assert.equal(h.writes.length, 3, "pagehide flushes the pending position");
  assert.equal(h.writes[2].data.state.position, 99);
  await h.coalesced.removeItem("library");
  assert.equal(h.writes.at(-1).data, null, "a removal writes null at once");
});

test("coalesced storage: the saved object comes back as-is and is never written back unchanged", async () => {
  const saved = { state: { queue: [{ id: "a" }], position: 30 }, version: 0 };
  const h = await loadCoalescedStorage({ disk: { player: saved } });
  const got = await h.coalesced.getItem("player");
  assert.equal(got, saved, "no JSON round trip");
  // Boot sets fields the store doesn't save (buffering, duration): persist hands over the same saved ones.
  for (let i = 0; i < 40; i++) {
    h.coalesced.setItem("player", v({ ...got.state }));
    h.advance(1000);
  }
  h.firePagehide();
  assert.equal(h.writes.length, 0, "nothing new to write");
  h.coalesced.setItem("player", v({ ...got.state, position: 30.25 }));
  h.advance(10_000);
  assert.equal(h.writes.length, 1, "the resume seek landing is written");
  assert.equal(h.writes[0].data.state.position, 30.25);
});

test("coalesced storage: changes only to fields a store doesn't save write nothing, and don't hold back a real change", async () => {
  const h = await loadCoalescedStorage();
  const queue = [{ id: "a" }];
  h.coalesced.setItem("player", v({ queue, position: 5 }));
  assert.equal(h.writes.length, 1);
  for (let i = 0; i < 120; i++) {
    h.coalesced.setItem("player", v({ queue, position: 5 })); // buffering, duration, error, blendInto…
    h.advance(250);
  }
  assert.equal(h.writes.length, 1, "30 s of unsaved-field changes: no writes");
  h.coalesced.setItem("player", v({ queue: [...queue, { id: "b" }], position: 5 }));
  assert.equal(h.writes.length, 2, "a real change still lands at once");
  h.coalesced.setItem("player", v({ queue: [{ id: "c" }], position: 5 }));
  h.coalesced.setItem("player", v({ queue: h.writes[1].data.state.queue, position: 5 }));
  h.coalesced.setItem("player", v({ queue: h.writes[1].data.state.queue, position: 5 }));
  h.advance(2000);
  assert.equal(h.writes.length, 3, "the newest value lands when due");
  assert.equal(h.writes[2].data.state.queue, h.writes[1].data.state.queue);
  h.coalesced.setItem("player", { state: { queue: h.writes[1].data.state.queue, position: 5 }, version: 1 });
  h.advance(2000);
  assert.equal(h.writes.length, 4, "a new version is a change");
});

test("coalesced storage: a store's actions never reach the bridge (they can't cross IPC)", async () => {
  const h = await loadCoalescedStorage({ clone: true });
  h.coalesced.setItem("library", v({ liked: [1], toggleLike() {} }));
  assert.equal(h.writes.length, 1, "the write went through the bridge, not the localStorage fallback");
  assert.equal(h.writes[0].data.state.toggleLike, undefined);
  assert.equal(h.writes[0].data.state.liked.length, 1);
});
