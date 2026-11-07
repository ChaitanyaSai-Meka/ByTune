/**
 * Rooms on the player's side (src/lib/rooms.ts) with the real player, room and UI stores and a fake
 * room server standing in for main: the room drives the player (its song, queue, moment, a start
 * anchored ahead), and what the listener does in a room goes to the room (another song, play, pause,
 * a seek, the queue), with host-only rooms and songs from this computer refused. Entering sets the
 * listener's own queue aside; leaving, or being removed, brings it back.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const code = build({
  stdin: {
    contents: `export * from "./src/lib/rooms"; export { usePlayer } from "./src/stores/player";
      export { useRoom, stopHere } from "./src/stores/room"; export { useUI } from "./src/stores/ui";`,
    resolveDir: fileURLToPath(new URL("..", import.meta.url)),
    sourcefile: "rooms-player-entry.ts",
    loader: "ts",
  },
  bundle: true, platform: "node", format: "esm", write: false,
}).then((r) => r.outputFiles[0].text);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const song = (id, title = `Song ${id}`) => ({ id: id.padEnd(11, "x").slice(0, 11), title, artist: "Artist", duration: 200, thumb: "" });
const ME = "8d2f2a44-0000-4000-8000-00000000000a";
const OTHER = "8d2f2a44-0000-4000-8000-00000000000b";

/** A fake main: a room server that answers like supabase/migrations/0002-rooms.sql. */
function fakeMain() {
  const sent = [];
  let stash = null;
  let onState = () => undefined;
  const room = {
    id: "room-1", code: "ABC234", hostId: ME, hostOnly: false, track: null, positionMs: 0, anchorMs: 0, playing: false,
    queue: [], activity: [], members: [{ userId: ME, name: "me", lastSeenMs: Date.now() }, { userId: OTHER, name: "sam", lastSeenMs: Date.now() }], seq: 0,
  };
  const view = (inRoom = true) => ({ state: inRoom ? structuredClone(room) : null, me: ME, offsetMs: 0 });
  const bridge = {
    readData: async () => null,
    writeData: async () => undefined,
    roomCurrent: async () => ({ state: null, me: ME, offsetMs: 0 }),
    roomCreate: async () => view(),
    roomJoin: async () => view(),
    roomLeave: async () => {
      setTimeout(() => onState(view(false)));
      return view(false);
    },
    roomUpdate: async (change) => {
      sent.push(change);
      if (room.hostOnly && room.hostId !== ME) throw new Error("Error invoking remote method 'room:update': Error: Only the host can control this room");
      if (change.baseSeq !== room.seq) return view();
      Object.assign(room, {
        track: change.track, positionMs: change.positionMs, playing: change.playing, queue: change.queue,
        anchorMs: Date.now() + (change.lead ? 600 : 0), seq: room.seq + 1,
      });
      return view();
    },
    roomStash: async (s) => { stash = structuredClone(s); },
    roomUnstash: async () => { const s = stash; stash = null; return s; },
    roomTakeInvite: async () => null,
    onRoomState: (cb) => { onState = cb; return () => undefined; },
    onRoomInvite: () => () => undefined,
  };
  return {
    bridge, room, sent,
    stashed: () => stash,
    /** The server's state changed by someone else: broadcast it. */
    broadcast(patch) {
      Object.assign(room, patch, { seq: room.seq + 1 });
      onState(view());
    },
    end(problem) {
      onState({ state: null, me: ME, offsetMs: 0, ...(problem ? { problem } : {}) });
    },
  };
}

async function setup() {
  const main = fakeMain();
  globalThis.window = globalThis;
  globalThis.addEventListener ??= () => undefined;
  globalThis.removeEventListener ??= () => undefined;
  globalThis.bytune = main.bridge;
  const m = await import(`data:text/javascript;base64,${Buffer.from(`${await code}\n// ${Math.random()}`).toString("base64")}`);
  const stop = m.listenForRooms();
  await sleep(10);
  return { m, main, stop, player: () => m.usePlayer.getState() };
}

test("joining: your queue goes aside, the room's song plays from the room's moment, and leaving brings yours back", async () => {
  const { m, main, stop, player } = await setup();
  try {
    m.usePlayer.getState().playQueue([song("mine1"), song("mine2")], 0);
    m.usePlayer.setState({ shuffle: true, repeat: "all", position: 42 });
    main.room.track = song("roomsong1");
    main.room.queue = [song("roomnext1")];
    main.room.playing = true;
    main.room.positionMs = 30_000;
    main.room.anchorMs = Date.now() - 5_000; // playing for 5 s since
    await m.joinRoom("ABC234");
    assert.deepEqual(main.stashed().queue.map((t) => t.id), [song("mine1").id, song("mine2").id], "your queue, set aside");
    assert.equal(main.stashed().position, 42);
    const p = player();
    assert.deepEqual(p.queue.map((t) => t.id), [song("roomsong1").id, song("roomnext1").id]);
    assert.ok(Math.abs(p.position - 35) < 0.5, `at the room's moment (${p.position})`);
    assert.equal(p.playing, true);
    assert.equal(p.shuffle, false, "a room plays its queue in order");
    assert.equal(p.repeat, "off");
    assert.equal(m.useUI.getState().rightPanel, "room");
    assert.equal(main.sent.length, 0, "joining sends nothing");

    await m.leaveRoom();
    await sleep(20);
    assert.equal(m.useRoom.getState().view.state, null);
    assert.deepEqual(player().queue.map((t) => t.id), [song("mine1").id, song("mine2").id], "yours again");
    assert.equal(player().position, 42);
    assert.equal(player().playing, false, "paused: nothing starts by itself");
    assert.equal(player().shuffle, true);
    assert.equal(player().repeat, "all");
  } finally {
    stop();
  }
});

test("starting a room takes what you're playing", async () => {
  const { m, main, stop, player } = await setup();
  try {
    m.usePlayer.getState().playQueue([song("host1"), song("host2"), { ...song("local"), id: "local:abc" }], 0);
    m.usePlayer.setState({ position: 12 });
    await m.startRoom();
    await sleep(20);
    assert.equal(main.sent.length, 1);
    const [first] = main.sent;
    assert.equal(first.track.id, song("host1").id);
    assert.deepEqual(first.queue.map((t) => t.id), [song("host2").id], "songs from this computer stay out of the room's queue");
    assert.equal(first.positionMs, 12_000);
    assert.equal(first.lead, false);
    assert.equal(main.room.track.id, song("host1").id);
    assert.equal(player().queue[player().index].id, song("host1").id);
  } finally {
    stop();
  }
});

test("the room drives the player: another song, a seek past 1.2 s, the queue, a pause, a start anchored ahead", async () => {
  const { m, main, stop, player } = await setup();
  try {
    main.room.track = song("a");
    main.room.playing = true;
    main.room.anchorMs = Date.now();
    await m.joinRoom("ABC234");
    // Someone else plays another song, starting 150 ms from now.
    main.broadcast({ track: song("b"), queue: [song("c")], positionMs: 0, playing: true, anchorMs: Date.now() + 150 });
    assert.equal(player().queue[0].id, song("b").id);
    assert.equal(player().playing, false, "waiting for the common start");
    await sleep(250);
    assert.equal(player().playing, true, "started with everyone");
    assert.equal(main.sent.length, 0, "the room's own changes are never sent back");
    // A small difference stays; a big one is a seek.
    m.usePlayer.setState({ position: 0.5 });
    main.broadcast({ positionMs: 1000, anchorMs: Date.now() });
    assert.equal(player().position, 0.5, "0.5 s off: left alone");
    main.broadcast({ positionMs: 60_000, anchorMs: Date.now() });
    assert.ok(Math.abs(player().position - 60) < 0.5, "60 s off: seeks there");
    main.broadcast({ queue: [song("d"), song("e")] });
    assert.deepEqual(player().queue.slice(1).map((t) => t.id), [song("d").id, song("e").id]);
    main.broadcast({ playing: false, positionMs: 61_000 });
    assert.equal(player().playing, false);
    assert.equal(main.sent.length, 0);
  } finally {
    stop();
  }
});

test("what you do in a room goes to the room: play, pause, a seek, another song, the queue, a song ending", async () => {
  const { m, main, stop, player } = await setup();
  try {
    main.room.track = song("a");
    main.room.queue = [song("b")];
    main.room.playing = true;
    main.room.anchorMs = Date.now();
    await m.joinRoom("ABC234");
    m.usePlayer.getState().setPlaying(false);
    await sleep(10);
    assert.deepEqual([main.sent.at(-1).playing, main.sent.at(-1).lead, main.sent.at(-1).note], [false, false, "paused"]);
    m.usePlayer.getState().setPlaying(true);
    await sleep(10);
    assert.deepEqual([main.sent.at(-1).playing, main.sent.at(-1).lead], [true, true], "a start is anchored ahead");
    assert.equal(player().playing, false, "...so here it waits for the room's moment");
    await sleep(700);
    assert.equal(player().playing, true);
    m.usePlayer.getState().seek(90);
    await sleep(10);
    assert.deepEqual([main.sent.at(-1).positionMs, main.sent.at(-1).lead], [90_000, true]);
    m.usePlayer.getState().addToQueue(song("q"));
    await sleep(10);
    assert.deepEqual(main.sent.at(-1).queue.map((t) => t.id), [song("b").id, song("q").id]);
    assert.equal(main.sent.at(-1).note, `added ${song("q").title}`);
    m.usePlayer.getState().playQueue([song("new")], 0);
    await sleep(10);
    assert.equal(main.sent.at(-1).track.id, song("new").id);
    assert.equal(main.sent.at(-1).note, `played ${song("new").title}`);
    // A song that ends moves on with everyone: no common start needed.
    await sleep(700);
    m.usePlayer.getState().addToQueue(song("after"));
    await sleep(10);
    m.usePlayer.setState({ duration: 200, position: 199.5 });
    m.usePlayer.getState().next(false);
    await sleep(10);
    assert.deepEqual([main.sent.at(-1).track.id, main.sent.at(-1).lead, main.sent.at(-1).note], [song("after").id, false, ""]);
    // Several changes in one action go as one.
    const before = main.sent.length;
    m.usePlayer.getState().seek(10);
    m.usePlayer.getState().setPlaying(false);
    await sleep(10);
    assert.equal(main.sent.length, before + 1);
  } finally {
    stop();
  }
});

test("refused: a host-only room you don't host, and songs from this computer; the player goes back to the room", async () => {
  const { m, main, stop, player } = await setup();
  try {
    main.room.track = song("a");
    main.room.playing = true;
    main.room.anchorMs = Date.now();
    await m.joinRoom("ABC234");
    main.broadcast({ hostOnly: true, hostId: OTHER });
    m.usePlayer.getState().playQueue([song("mine")], 0);
    await sleep(10);
    assert.equal(main.sent.length, 0, "not even asked");
    assert.equal(player().queue[0].id, song("a").id, "back to the room's song");
    assert.match(m.useUI.getState().toasts.at(-1).message, /Only the host/);
    main.broadcast({ hostOnly: false, hostId: ME });
    m.usePlayer.getState().playQueue([{ ...song("local"), id: "local:abc" }], 0);
    await sleep(10);
    assert.equal(main.sent.length, 0);
    assert.equal(player().queue[0].id, song("a").id);
    assert.match(m.useUI.getState().toasts.at(-1).message, /can't play in a room/);
  } finally {
    stop();
  }
});

test("songs from this computer: a playlist with one plays without a word; adding one says it stays out", async () => {
  const { m, main, stop, player } = await setup();
  try {
    main.room.track = song("a");
    main.room.playing = true;
    main.room.anchorMs = Date.now();
    await m.joinRoom("ABC234");
    const local = { ...song("local"), id: "local:abc", title: "From this computer" };
    const toasts = () => m.useUI.getState().toasts.map((t) => t.message);
    const upNext = () => player().queue.slice(player().index + 1).map((t) => t.id);
    const shown = toasts().length;
    // A YouTube song played from a playlist that has a song from this computer after it.
    m.usePlayer.getState().playQueue([song("chill1"), song("chill2"), local, song("chill3")], 1);
    await sleep(10);
    assert.equal(main.sent.at(-1).track.id, song("chill2").id, "it plays in the room");
    assert.deepEqual(main.sent.at(-1).queue.map((t) => t.id), [song("chill3").id], "the song from this computer stays out");
    assert.equal(main.sent.at(-1).note, `played ${song("chill2").title}`);
    assert.deepEqual(toasts().slice(shown), [], "and nothing pops up");
    assert.deepEqual(upNext(), [song("chill3").id], "up next is the room's queue");
    await sleep(700); // the common start
    // Only a song from this computer added: nothing goes to the room, and it says why.
    const sends = main.sent.length;
    m.usePlayer.getState().addToQueue(local);
    await sleep(10);
    assert.equal(main.sent.length, sends, "nothing to send");
    assert.deepEqual(upNext(), [song("chill3").id], "the queue is the room's again");
    assert.match(toasts().at(-1), /Songs from this computer stay out of the room's queue/);
    // Both kinds at once (Play next): the shared one goes in and is the one named.
    m.usePlayer.getState().addToQueue([local, song("extra")], true);
    await sleep(10);
    assert.deepEqual(main.sent.at(-1).queue.map((t) => t.id), [song("extra").id, song("chill3").id]);
    assert.equal(main.sent.at(-1).note, `added ${song("extra").title}`);
    assert.equal(toasts().filter((t) => /stay out/.test(t)).length, 2);
    assert.equal(player().playing, true);
  } finally {
    stop();
  }
});

test("the room's queue holds 100: a song that doesn't fit is said so and never named as added", async () => {
  const { m, main, stop, player } = await setup();
  try {
    const full = Array.from({ length: 100 }, (_, i) => song(`q${i}`));
    main.room.track = song("a");
    main.room.queue = full;
    main.room.playing = true;
    main.room.anchorMs = Date.now();
    await m.joinRoom("ABC234");
    const toasts = () => m.useUI.getState().toasts.map((t) => t.message);
    const upNext = () => player().queue.slice(player().index + 1).map((t) => t.id);
    const sends = main.sent.length;
    m.usePlayer.getState().addToQueue(song("late"));
    await sleep(10);
    assert.equal(main.sent.length, sends, "nothing new for the room");
    assert.deepEqual(upNext(), full.map((t) => t.id), "the queue is the room's 100 again");
    assert.equal(toasts().at(-1), "The room's queue is full (100 songs)");
    // Play next still works: the song goes first and the farthest one makes room.
    m.usePlayer.getState().addToQueue(song("soon"), true);
    await sleep(10);
    assert.deepEqual(main.sent.at(-1).queue.map((t) => t.id), [song("soon").id, ...full.slice(0, 99).map((t) => t.id)]);
    assert.equal(main.sent.at(-1).note, `added ${song("soon").title}`);
    // Room for one of two: the one that fits is the one named.
    main.broadcast({ queue: full.slice(0, 99) });
    m.usePlayer.getState().addToQueue([song("fits"), song("nofit")]);
    await sleep(10);
    assert.equal(main.sent.at(-1).queue.at(-1).id, song("fits").id);
    assert.equal(main.sent.at(-1).queue.length, 100);
    assert.equal(main.sent.at(-1).note, `added ${song("fits").title}`);
    assert.equal(toasts().at(-1), "The room's queue is full (100 songs)");
  } finally {
    stop();
  }
});

test("waiting for the room's common start: a change then keeps the room playing", async () => {
  const { m, main, stop, player } = await setup();
  try {
    main.room.track = song("a");
    main.room.playing = true;
    main.room.anchorMs = Date.now();
    await m.joinRoom("ABC234");
    // Someone else starts another song, 300 ms from now; the queue changes meanwhile.
    main.broadcast({ track: song("b"), queue: [], positionMs: 0, playing: true, anchorMs: Date.now() + 300 });
    assert.equal(player().playing, false, "waiting for the common start");
    m.usePlayer.getState().addToQueue(song("q"));
    await sleep(10);
    assert.deepEqual([main.sent.at(-1).playing, main.sent.at(-1).note], [true, `added ${song("q").title}`], "the room keeps playing");
    assert.equal(main.room.playing, true);
    assert.equal(player().playing, true, "and starts here with everyone");
    // A seek while waiting is a start from that point.
    main.broadcast({ track: song("c"), queue: [], positionMs: 0, playing: true, anchorMs: Date.now() + 300 });
    m.usePlayer.getState().seek(30);
    await sleep(10);
    assert.deepEqual([main.sent.at(-1).playing, main.sent.at(-1).lead, main.sent.at(-1).positionMs], [true, true, 30_000]);
    await sleep(700);
    assert.equal(player().playing, true);
    // A pause after the start is still a pause.
    m.usePlayer.getState().setPlaying(false);
    await sleep(10);
    assert.deepEqual([main.sent.at(-1).playing, main.sent.at(-1).note], [false, "paused"]);
  } finally {
    stop();
  }
});

test("stopping on this computer only (headphones out, the sleep timer): the room plays on; play joins back in", async () => {
  const { m, main, stop, player } = await setup();
  try {
    main.room.track = song("a");
    main.room.queue = [song("b")];
    main.room.playing = true;
    main.room.anchorMs = Date.now();
    await m.joinRoom("ABC234");
    const sends = main.sent.length;
    m.stopHere({ until: "play" }, () => m.usePlayer.getState().setPlaying(false));
    await sleep(10);
    assert.equal(main.sent.length, sends, "the room isn't told");
    assert.equal(player().playing, false);
    // Adding a song meanwhile changes the room's queue, not whether it plays.
    m.usePlayer.getState().addToQueue(song("q"));
    await sleep(10);
    assert.deepEqual([main.sent.at(-1).playing, main.room.playing], [true, true], "the room keeps playing");
    assert.equal(player().playing, false, "and this computer stays stopped");
    const afterAdd = main.sent.length;
    // The room moves on: this computer follows it, still stopped.
    main.broadcast({ track: song("b"), queue: [], positionMs: 0, playing: true, anchorMs: Date.now() - 30_000 });
    assert.equal(player().queue[player().index].id, song("b").id);
    assert.equal(player().playing, false, "stays stopped until play");
    await sleep(1500);
    // Play: back in at the room's moment (31.5 s by now), without moving the room.
    m.usePlayer.getState().setPlaying(true);
    await sleep(10);
    assert.equal(main.sent.length, afterAdd, "joining back in sends nothing");
    assert.equal(player().playing, true);
    assert.ok(Math.abs(player().position - 31.5) < 0.5, `at the room's moment (${player().position})`);
    // Pausing yourself still pauses the room.
    m.usePlayer.getState().setPlaying(false);
    await sleep(10);
    assert.deepEqual([main.sent.at(-1).playing, main.sent.at(-1).note], [false, "paused"]);
  } finally {
    stop();
  }
});

test("a song this computer can't play: it sits that song out, and plays the room's next one", async () => {
  const { m, main, stop, player } = await setup();
  try {
    main.room.track = song("a");
    main.room.queue = [song("b")];
    main.room.playing = true;
    main.room.anchorMs = Date.now();
    await m.joinRoom("ABC234");
    const sends = main.sent.length;
    m.stopHere({ until: "next song", song: song("a").id }, () => m.usePlayer.setState({ playing: false }));
    await sleep(10);
    assert.equal(main.sent.length, sends, "the room plays on: not skipped for everyone");
    main.broadcast({ positionMs: 60_000, anchorMs: Date.now() }); // someone seeks: still that song
    assert.equal(player().playing, false);
    main.broadcast({ track: song("b"), queue: [], positionMs: 0, playing: true, anchorMs: Date.now() });
    assert.equal(player().playing, true, "the next song plays here again");
  } finally {
    stop();
  }
});

test("the end of the room's queue isn't put down as someone pausing", async () => {
  const { m, main, stop, player } = await setup();
  try {
    main.room.track = song("a");
    main.room.playing = true;
    main.room.anchorMs = Date.now();
    await m.joinRoom("ABC234");
    m.usePlayer.setState({ duration: 200, position: 199.5 });
    m.usePlayer.getState().next(false);
    await sleep(10);
    assert.deepEqual([main.sent.at(-1).playing, main.sent.at(-1).note, player().playing], [false, "", false]);
  } finally {
    stop();
  }
});

test("a song whose time is up with no computer saying so: the room moves on by itself", async () => {
  const { m, main, stop } = await setup();
  try {
    main.room.track = { ...song("a"), duration: 200 };
    main.room.queue = [song("b"), song("c")];
    main.room.playing = true;
    main.room.anchorMs = Date.now() - 215_000; // 15 s past its end: it played nowhere
    await m.joinRoom("ABC234");
    const sends = main.sent.length;
    await sleep(5300); // the next drift check
    assert.equal(main.sent.length, sends + 1, "moved on once");
    const moved = main.sent.at(-1);
    assert.deepEqual(
      [moved.track.id, moved.queue.map((t) => t.id), moved.playing, moved.lead, moved.note],
      [song("b").id, [song("c").id], true, false, ""],
      "like a song ending: no common start, nobody named"
    );
  } finally {
    stop();
  }
});

test("removed from the room: told why, and your queue comes back", async () => {
  const { m, main, stop, player } = await setup();
  try {
    m.usePlayer.getState().playQueue([song("mine1")], 0);
    main.room.track = song("a");
    await m.joinRoom("ABC234");
    main.end("You were removed from the room.");
    await sleep(20);
    assert.equal(m.useRoom.getState().view.state, null);
    assert.equal(player().queue[0].id, song("mine1").id);
    assert.match(m.useUI.getState().toasts.at(-1).message, /removed/);
  } finally {
    stop();
  }
});

test("a join that fails leaves the player alone", async () => {
  const { m, main, stop, player } = await setup();
  try {
    m.usePlayer.getState().playQueue([song("mine1")], 0);
    main.bridge.roomJoin = async () => { throw new Error("Error invoking remote method 'room:join': Error: No room with that code"); };
    await m.joinRoom("ZZZZZZ");
    assert.equal(player().playing, true, "still playing your song");
    assert.equal(player().queue[0].id, song("mine1").id);
    assert.equal(main.stashed(), null, "the copy set aside is gone");
    assert.match(m.useUI.getState().toasts.at(-1).message, /No room with that code/);
  } finally {
    stop();
  }
});
