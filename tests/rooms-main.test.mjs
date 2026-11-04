/**
 * Rooms in main (electron/rooms.ts) against a fake Supabase: a room's queue is sent within the
 * server's limits (100 songs and 128 KB on 0004, falling back to 0002's 25 songs), and a listener
 * who drops out of a room for being away is told that, not that they were removed.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

const bundle = build({
  entryPoints: [fileURLToPath(new URL("../electron/rooms.ts", import.meta.url))],
  bundle: true, platform: "node", format: "cjs", write: false, logLevel: "silent",
  plugins: [{
    name: "stub-persist-auth",
    setup(b) {
      b.onResolve({ filter: /^\.\/persist$|^\.\/supabase$/ }, (a) => ({ path: a.path, namespace: "stub" }));
      b.onLoad({ filter: /.*/, namespace: "stub" }, (a) => ({
        contents: a.path === "./persist" ? "module.exports = globalThis.__persistStub;" : "module.exports = globalThis.__authStub;",
        loader: "js",
      }));
    },
  }],
}).then((r) => r.outputFiles[0].text);

const ME = "8d2f2a44-0000-4000-8000-00000000000a";
const song = (n, extra = {}) => ({ id: `yt${String(n).padStart(9, "0")}`, title: `Song ${n}`, artist: "Artist", duration: 200, thumb: "", ...extra });

/** A fake Supabase answering the room functions; `oldServer` takes 25 songs at most, like 0002. */
function fakeSupabase() {
  const s = { calls: [], oldServer: false, member: true, now: () => Date.now() };
  const state = (extra = {}) => ({
    id: "room-1", code: "ABC234", hostId: ME, hostOnly: false, track: null, positionMs: 0, anchorMs: 0, playing: false,
    queue: [], activity: [], seq: 1, serverMs: s.now(),
    members: s.member ? [{ userId: ME, name: "me", lastSeenMs: s.now() }] : [],
    ...extra,
  });
  s.client = {
    async rpc(fn, args) {
      s.calls.push({ fn, args });
      if (fn === "room_clock") return { data: s.now(), error: null };
      if (fn === "room_ping" && !s.member) return { data: null, error: { message: "You're not in this room" } };
      if (fn === "room_update") {
        if (s.oldServer && args.p_queue.length > 25) return { data: null, error: { message: "Not a queue" } };
        return { data: state({ track: args.p_track, queue: args.p_queue, seq: 2 }), error: null };
      }
      return { data: state(), error: null };
    },
    channel() {
      const ch = { on: () => ch, subscribe: () => ch };
      return ch;
    },
    realtime: { setAuth: async () => undefined },
    removeChannel: async () => undefined,
  };
  return s;
}

async function load() {
  const server = fakeSupabase();
  const files = new Map();
  globalThis.__persistStub = {
    readData: (n) => (files.has(n) ? JSON.parse(files.get(n)) : null),
    writeData: async (n, v) => { files.set(n, JSON.stringify(v)); },
  };
  globalThis.__authStub = {
    getClient: () => server.client,
    sessionInfo: () => ({ mode: "account", userId: ME }),
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bytune-rooms-main-"));
  const file = path.join(dir, "rooms.cjs");
  fs.writeFileSync(file, await bundle);
  const rooms = require(file);
  const views = [];
  rooms.onRoomChange((view) => views.push(view));
  return {
    rooms, server, views,
    updates: () => server.calls.filter((c) => c.fn === "room_update"),
    cleanup: async () => { await rooms.leaveRoom().catch(() => undefined); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

const change = (queue) => ({ baseSeq: 1, track: song(1), positionMs: 0, playing: true, queue, lead: true, note: "" });

test("a room's queue goes up to 100 songs", async () => {
  const h = await load();
  try {
    await h.rooms.createRoom();
    const view = await h.rooms.updateRoom(change(Array.from({ length: 120 }, (_, i) => song(100 + i))));
    assert.equal(h.updates().at(-1).args.p_queue.length, 100);
    assert.equal(view.state.queue.length, 100);
  } finally { await h.cleanup(); }
});

test("a server that still takes 25 songs gets the first 25 instead of refusing the change", async () => {
  const h = await load();
  try {
    h.server.oldServer = true;
    await h.rooms.createRoom();
    const view = await h.rooms.updateRoom(change(Array.from({ length: 30 }, (_, i) => song(100 + i))));
    assert.deepEqual(h.updates().map((c) => c.args.p_queue.length), [30, 25], "asked again with 25");
    assert.equal(view.state.queue.length, 25);
    assert.equal(view.state.track.id, song(1).id, "the change itself went through");
  } finally { await h.cleanup(); }
});

test("songs with very long details: the queue is cut to what the server takes (128 KB)", async () => {
  const h = await load();
  try {
    await h.rooms.createRoom();
    const heavy = Array.from({ length: 100 }, (_, i) => song(100 + i, { thumb: `https://example.com/${"x".repeat(1980)}` }));
    await h.rooms.updateRoom(change(heavy));
    const sent = h.updates().at(-1).args.p_queue;
    assert.ok(sent.length > 0 && sent.length < 100, `cut (${sent.length} songs)`);
    assert.ok(Buffer.byteLength(JSON.stringify(sent)) <= 120_000, "with room to spare under 128 KB");
  } finally { await h.cleanup(); }
});

test("dropped for being away (asleep, offline): told so, not that you were removed", async () => {
  const h = await load();
  try {
    await h.rooms.createRoom();
    const realNow = Date.now;
    let skew = 0;
    Date.now = () => realNow() + skew;
    try {
      skew = 4 * 60_000; // the laptop slept for 4 minutes; the room let this member go
      h.server.member = false;
      h.rooms.resync(); // what waking up does
      for (let i = 0; i < 20 && h.views.at(-1)?.state; i++) await new Promise((r) => setTimeout(r, 10));
      assert.equal(h.views.at(-1).state, null);
      assert.equal(h.views.at(-1).problem, "You were away too long and left the room.");
    } finally {
      Date.now = realNow;
    }
  } finally { await h.cleanup(); }
});

test("taken out while checking in all along: that was the host", async () => {
  const h = await load();
  try {
    await h.rooms.createRoom();
    h.server.member = false;
    await h.rooms.updateRoom(change([])).catch(() => undefined);
    assert.equal(h.views.at(-1).state, null);
    assert.equal(h.views.at(-1).problem, "You were removed from the room.");
  } finally { await h.cleanup(); }
});
