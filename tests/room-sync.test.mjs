/**
 * Keeping a room together (src/lib/roomSync.ts): the clock offset, where the song should be, when
 * to seek, room codes and invite links, and what a room's state may carry.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const mod = build({
  entryPoints: [fileURLToPath(new URL("../src/lib/roomSync.ts", import.meta.url))],
  bundle: true, platform: "node", format: "esm", write: false,
}).then((r) => import(`data:text/javascript;base64,${Buffer.from(r.outputFiles[0].text).toString("base64")}`));

test("the clock offset comes from the quickest round trip", async () => {
  const { clockOffset } = await mod;
  // Server is 5,000 ms ahead. A slow reading (300 ms trip) is less sure than a fast one (20 ms).
  assert.equal(clockOffset([
    { sentAt: 1000, receivedAt: 1300, serverMs: 6290 },
    { sentAt: 2000, receivedAt: 2020, serverMs: 7010 },
    { sentAt: 3000, receivedAt: 3150, serverMs: 8000 },
  ]), 5000);
  assert.equal(clockOffset([]), null);
  assert.equal(clockOffset([{ sentAt: 10, receivedAt: 5, serverMs: 1 }]), null, "a reading from before it was asked for is nonsense");
});

test("where the room's song is: playing, paused, and a start anchored ahead", async () => {
  const { roomPosition } = await mod;
  assert.deepEqual(roomPosition({ positionMs: 30_000, anchorMs: 1_000_000, playing: true }, 1_002_500), { ms: 32_500, startsInMs: 0 });
  assert.deepEqual(roomPosition({ positionMs: 30_000, anchorMs: 1_000_000, playing: false }, 1_002_500), { ms: 30_000, startsInMs: 0 });
  assert.deepEqual(roomPosition({ positionMs: 0, anchorMs: 1_000_600, playing: true }, 1_000_000), { ms: 0, startsInMs: 600 });
});

test("only a difference past 1.2 s is worth a seek", async () => {
  const { offBy, DRIFT_MS } = await mod;
  assert.equal(DRIFT_MS, 1200);
  assert.equal(offBy(10_000, 11_000), false);
  assert.equal(offBy(10_000, 11_300), true);
  assert.equal(offBy(12_000, 10_000), true);
});

test("room codes: typed, spaced, lower-case or as an invite link", async () => {
  const { roomCodeIn, inviteLink } = await mod;
  assert.equal(roomCodeIn("abc234"), "ABC234");
  assert.equal(roomCodeIn(" ABC-234 "), "ABC234");
  assert.equal(roomCodeIn("bytune://room/HJK789"), "HJK789");
  assert.equal(inviteLink("HJK789"), "bytune://room/HJK789");
  for (const bad of ["ABC23", "ABC2345", "ABCD10", "ABCDEO", "https://evil.example/room/ABC234", "", "bytune://oauth/callback"]) {
    assert.equal(roomCodeIn(bad), null, bad);
  }
});

test("a room carries YouTube songs and their display fields only", async () => {
  const { roomTrack } = await mod;
  assert.deepEqual(
    roomTrack({ id: "dQw4w9WgXcQ", title: "Song", artist: "A", duration: 212, thumb: "https://i.ytimg.com/vi/x/hq.jpg", localPath: "C:\\Users\\me\\x.mp3", album: "Al", explicit: true, evil: "<script>" }),
    { id: "dQw4w9WgXcQ", title: "Song", artist: "A", duration: 212, thumb: "https://i.ytimg.com/vi/x/hq.jpg", album: "Al", explicit: true },
  );
  assert.equal(roomTrack({ id: "local:abc", title: "Mine" }), null, "a song from someone's computer can't be shared");
  assert.equal(roomTrack({ id: "dQw4w9WgXcQ", thumb: "file:///C:/x.jpg" }).thumb, "", "only web artwork");
  assert.equal(roomTrack({ id: "dQw4w9WgXcQ", duration: Infinity }).duration, 0);
  assert.equal(roomTrack(null), null);
});

test("a room's state is checked field by field", async () => {
  const { roomState } = await mod;
  const raw = {
    id: "8d2f2a44-0000-4000-8000-000000000001", code: "ABC234", hostId: "u1", hostOnly: true,
    track: { id: "dQw4w9WgXcQ", title: "Song" }, positionMs: 1500, anchorMs: 1_793_000_000_000, playing: true,
    queue: [{ id: "dQw4w9WgXcQ" }, { id: "bad" }, ...Array.from({ length: 110 }, () => ({ id: "dQw4w9WgXcQ" }))],
    activity: [{ atMs: 1, text: "alice joined" }, { atMs: "x", text: "bad" }],
    members: [{ userId: "u1", name: "alice", lastSeenMs: 5 }, { name: "no id" }],
    seq: 7, serverMs: 1_793_000_000_100, stale: true,
  };
  const s = roomState(raw);
  assert.equal(s.code, "ABC234");
  assert.equal(s.track.id, "dQw4w9WgXcQ");
  assert.equal(s.queue.length, 100, "bad songs dropped, capped at 100");
  assert.deepEqual(s.activity, [{ atMs: 1, text: "alice joined" }]);
  assert.deepEqual(s.members, [{ userId: "u1", name: "alice", lastSeenMs: 5 }]);
  assert.equal("stale" in s, false);
  assert.equal(roomState({ ...raw, code: "abc234" }), null);
  assert.equal(roomState({ ...raw, positionMs: -1 }), null);
  assert.equal(roomState({ ...raw, track: { id: "local:x" } }).track, null);
  assert.equal(roomState("nope"), null);
});
