/**
 * In a room, what stops playback on one computer stays on that computer (lib/audio + lib/sleepTimer
 * → stores/room stopHere; lib/rooms keeps the room playing): the output going away, the sleep timer,
 * a song that won't play here. The real engine runs in the automix harness, put "in a room" through
 * the room store (all the engine asks is whether there is one).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { boot, flushMicrotasks, play, read, track } from "./automix-harness.mjs";

async function settle(h, rounds = 20) {
  for (let i = 0; i < rounds; i++) await flushMicrotasks(4);
}
const live = (h, id) => h.elements.find((e) => e.src === `fake:${id}` && !e.paused);

/** Puts the engine in a room and records, for each stop, whether it was this computer's alone. */
function inARoom(h) {
  h.engine.useRoom.setState({ view: { state: { id: "room-1" }, me: "me", offsetMs: 0 } });
  const stops = [];
  h.engine.usePlayer.subscribe((p, prev) => {
    if (prev.playing && !p.playing) stops.push(h.engine.stoppingHere());
  });
  return stops;
}

test("in a room, a song that won't play on this computer stops it here; the room's song isn't skipped", async () => {
  const h = await boot({ fadeSeconds: 0 });
  try {
    h.setDuration("a", 600);
    h.setDuration("b", 600);
    const stops = inARoom(h);
    await play(h, [track("a", 600), track("b", 600)]);
    await h.advance(30_000);
    let deck = live(h, "a");
    deck.pause();
    deck.emit("error");
    await settle(h);
    await h.advance(2_000);
    deck = live(h, "a");
    deck.pause();
    deck.emit("error"); // again straight after its retry
    await settle(h);
    assert.equal(read(h).id, "a", "not skipped: the room decides what plays");
    assert.equal(read(h).playing, false);
    assert.deepEqual(stops, [{ until: "next song", song: "a" }], "stopped here only, for this song");
    assert.match(h.engine.useUI.getState().toasts.at(-1).message, /on this computer\. The room plays on/);
  } finally {
    await settle(h);
    h.restore();
  }
});

test("in a room, the sleep timer stops only this computer", async () => {
  const h = await boot({ fadeSeconds: 0 });
  try {
    h.setDuration("long", 600);
    const stops = inARoom(h);
    await play(h, [track("long", 600)]);
    await h.advance(1000);
    h.engine.useSleepTimer.getState().start(1);
    await h.advance(61_000);
    await settle(h);
    assert.equal(read(h).playing, false);
    assert.deepEqual(stops, [{ until: "play" }]);
  } finally {
    await settle(h);
    h.restore();
  }
});

test("in a room, 'end of this song' stops only this computer", async () => {
  const h = await boot({ fadeSeconds: 0 });
  try {
    h.setDuration("a", 3);
    h.setDuration("b", 120);
    const stops = inARoom(h);
    await play(h, [track("a", 3), track("b", 120)]);
    h.engine.useSleepTimer.getState().startEndOfSong();
    await h.advance(3600);
    await settle(h);
    assert.equal(read(h).playing, false);
    assert.deepEqual(stops, [{ until: "play" }]);
  } finally {
    await settle(h);
    h.restore();
  }
});

test("in a room, losing the output (headphones unplugged) stops only this computer", async () => {
  const out = (deviceId, groupId) => ({ kind: "audiooutput", deviceId, groupId });
  const headphones = [out("default", "g-bt"), out("phys-bt", "g-bt"), out("phys-speakers", "g-speakers")];
  const speakersOnly = [out("default", "g-speakers"), out("phys-speakers", "g-speakers")];
  const devices = { list: headphones };
  const listeners = [];
  const real = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { mediaDevices: { enumerateDevices: async () => devices.list, addEventListener: (_type, fn) => listeners.push(fn) } },
  });
  const h = await boot({ fadeSeconds: 0 });
  try {
    h.setDuration("a", 600);
    const stops = inARoom(h);
    await play(h, [track("a", 600)]);
    await h.advance(2000);
    await settle(h);
    devices.list = speakersOnly; // the headphones are gone
    for (const fn of listeners) fn();
    await settle(h);
    assert.equal(read(h).playing, false, "paused rather than blaring out of the speakers");
    assert.deepEqual(stops, [{ until: "play" }]);
  } finally {
    await settle(h);
    h.restore();
    if (real) Object.defineProperty(globalThis, "navigator", real);
    else delete globalThis.navigator;
  }
});
