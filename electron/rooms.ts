/**
 * Rooms (listen together), the network side, all in main: the functions of
 * supabase/migrations/0002-rooms.sql, and the room's private Realtime channel "room:<id>". The page
 * gets the room's state (checked by lib/roomSync) and this computer's clock offset to the server's,
 * and asks for changes through IPC; it never talks to Supabase.
 *
 * While in a room: the clock is measured on entering and on waking from sleep; a ping every 30 s
 * keeps presence, the clock and any missed update fresh; a dropped channel re-subscribes with
 * backoff (1 s doubling to 30 s) and reads the room again. Nothing runs outside a room.
 *
 * The listener's own queue is set aside while in a room (store "room-stash", main-only, written by
 * the page). If ByTune quits or crashes in a room, the next start leaves that room and the page
 * puts the queue back.
 */
import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";
import * as persist from "./persist";
import * as auth from "./supabase";
import { clockOffset, MAX_ROOM_QUEUE, roomState, roomTrack, type ClockSample } from "../src/lib/roomSync";
import type { RoomChange, RoomState, RoomView, Track } from "../src/types";

const STASH = "room-stash";
const PING_MS = 30_000;
/** The server takes up to 128 KB of queue (0004); this leaves room for how Postgres writes JSON out. */
const QUEUE_BYTES = 120_000;
/** What a server still on 0002 takes. */
const OLD_MAX_QUEUE = 25;
/** Unheard from for this long, a member has been let go (0004: after 3 minutes without a check-in). */
const AWAY_MS = 2 * 60_000;

let state: RoomState | null = null;
let problem: string | undefined;
let channel: RealtimeChannel | null = null;
let samples: ClockSample[] = [];
let offsetMs = 0;
let pingTimer: ReturnType<typeof setInterval> | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryMs = 1000;
/** When the room last answered this listener as one of its members. */
let lastHeard = 0;
let publish: (view: RoomView) => void = () => undefined;

/** Out of the room: after being out of touch long enough, that was for being away. */
const outOfRoom = (otherwise: string): string =>
  Date.now() - lastHeard > AWAY_MS ? "You were away too long and left the room." : otherwise;

/** Where the room's changes go (main sends them to the page). */
export function onRoomChange(send: (view: RoomView) => void): void {
  publish = send;
}

export function roomView(): RoomView {
  return { state, me: auth.sessionInfo().userId, offsetMs, ...(problem ? { problem } : {}) };
}

function client(): SupabaseClient {
  const c = auth.getClient();
  if (!c || auth.sessionInfo().mode !== "account") throw new Error("Rooms need a ByTune account: sign in first.");
  return c;
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** One of the room functions. Its own errors read as they are ("No room with that code"). */
async function rpc(fn: string, args?: Record<string, unknown>): Promise<unknown> {
  const { data, error } = await client().rpc(fn, args);
  if (!error) return data;
  // The migration isn't on the server yet: PostgREST can't find the function.
  if (/schema cache|could not find the function|does not exist/i.test(error.message)) {
    throw new Error("Rooms aren't set up on ByTune's server yet.");
  }
  throw new Error(error.message);
}

function addSample(sentAt: number, receivedAt: number, serverMs: unknown): void {
  if (typeof serverMs !== "number" && typeof serverMs !== "string") return;
  samples = [...samples, { sentAt, receivedAt, serverMs: Number(serverMs) }].slice(-12);
  offsetMs = clockOffset(samples) ?? offsetMs;
}

/** Five readings of the server's clock, one after another; the quickest round trip wins. */
async function measureClock(): Promise<void> {
  samples = [];
  for (let i = 0; i < 5; i++) {
    const sentAt = Date.now();
    const serverMs = await rpc("room_clock");
    addSample(sentAt, Date.now(), serverMs);
  }
}

/** Takes a state the server sent (an answer or a broadcast) if it's this room's and not older. */
function take(raw: unknown, timing?: { sentAt: number; receivedAt: number }): void {
  const next = roomState(raw);
  if (!next) return;
  if (timing) addSample(timing.sentAt, timing.receivedAt, (raw as { serverMs?: unknown }).serverMs);
  if (state && next.id === state.id && next.seq < state.seq) return; // overtaken on the way
  if (!next.members.some((m) => m.userId === auth.sessionInfo().userId)) {
    end(outOfRoom("You were removed from the room."));
    return;
  }
  state = next;
  lastHeard = Date.now();
  problem = undefined;
  publish(roomView());
}

async function listen(roomId: string): Promise<void> {
  const c = client();
  await stopListening();
  // Private channels authorize with the signed-in user's token (the realtime.messages policy).
  await c.realtime.setAuth();
  const ch = c.channel(`room:${roomId}`, { config: { private: true } });
  ch.on("broadcast", { event: "state" }, (msg) => take(msg.payload));
  channel = ch;
  ch.subscribe((status) => {
    if (channel !== ch) return; // an old channel closing
    if (status === "SUBSCRIBED") {
      retryMs = 1000;
      void ping(); // catch up on anything sent while connecting
    } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
      reconnect();
    }
  });
}

function reconnect(): void {
  if (!state || retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    if (state) void listen(state.id).catch(() => reconnect());
  }, retryMs);
  retryMs = Math.min(retryMs * 2, 30_000);
}

async function stopListening(): Promise<void> {
  const ch = channel;
  channel = null;
  if (ch) await auth.getClient()?.removeChannel(ch).catch(() => undefined);
}

async function ping(): Promise<void> {
  if (!state) return;
  const sentAt = Date.now();
  try {
    take(await rpc("room_ping", { p_room: state.id }), { sentAt, receivedAt: Date.now() });
  } catch (err) {
    if (/not in this room/i.test(message(err))) end(outOfRoom("The room has ended, or you were removed."));
  }
}

/** Stops everything of this room here; `why` is shown when the room ended without the listener leaving. */
function end(why?: string): void {
  if (pingTimer) clearInterval(pingTimer);
  if (retryTimer) clearTimeout(retryTimer);
  pingTimer = null;
  retryTimer = null;
  void stopListening();
  state = null;
  problem = why;
  publish(roomView());
}

async function enter(raw: unknown): Promise<RoomView> {
  end();
  problem = undefined;
  const next = roomState(raw);
  if (!next) throw new Error("The server's answer didn't read as a room.");
  state = next;
  lastHeard = Date.now();
  await persist.writeData(STASH, { ...((persist.readData(STASH) as object | null) ?? {}), roomId: next.id }).catch(() => undefined);
  await measureClock().catch(() => undefined);
  await listen(next.id).catch((err) => console.warn("[bytune] room channel:", message(err)));
  pingTimer = setInterval(() => void ping(), PING_MS);
  publish(roomView());
  return roomView();
}

export async function createRoom(): Promise<RoomView> {
  return enter(await rpc("room_create"));
}

export async function joinRoom(code: string): Promise<RoomView> {
  return enter(await rpc("room_join", { p_code: code }));
}

/** Leaves the room (the server hands host over or closes it). */
export async function leaveRoom(): Promise<RoomView> {
  const id = state?.id;
  end();
  if (id) await rpc("room_leave", { p_room: id }).catch((err) => console.warn("[bytune] room leave:", message(err)));
  return roomView();
}

/** The queue as the server takes it: room songs, as many as fit its limits (100 songs, 128 KB). */
function fitQueue(queue: Track[]): Track[] {
  const fit: Track[] = [];
  let bytes = 2;
  for (const song of queue.map(roomTrack)) {
    if (!song) continue;
    bytes += Buffer.byteLength(JSON.stringify(song)) + 1;
    if (fit.length >= MAX_ROOM_QUEUE || bytes > QUEUE_BYTES) break;
    fit.push(song);
  }
  return fit;
}

/** A change to what's playing. A stale one comes back as the room's current state, which the page applies. */
export async function updateRoom(change: RoomChange): Promise<RoomView> {
  if (!state) throw new Error("You're not in a room.");
  const room = state.id;
  const send = (queue: Track[]): Promise<unknown> =>
    rpc("room_update", {
      p_room: room,
      p_seq: change.baseSeq,
      p_track: change.track ? roomTrack(change.track) : null,
      p_position_ms: Math.max(0, Math.round(change.positionMs)),
      p_playing: change.playing,
      p_queue: queue,
      p_lead: change.lead,
      p_note: change.note.slice(0, 100),
    });
  const queue = fitQueue(change.queue);
  let sentAt = Date.now();
  let raw: unknown;
  try {
    raw = await send(queue);
  } catch (err) {
    // A server still on 0002 takes 25 songs: the change goes through with those.
    if (queue.length <= OLD_MAX_QUEUE || !/Not a queue/.test(message(err))) throw err;
    sentAt = Date.now();
    raw = await send(queue.slice(0, OLD_MAX_QUEUE));
  }
  take(raw, { sentAt, receivedAt: Date.now() });
  return roomView();
}

export async function setHostOnly(on: boolean): Promise<RoomView> {
  if (!state) throw new Error("You're not in a room.");
  take(await rpc("room_set_host_only", { p_room: state.id, p_on: on }));
  return roomView();
}

export async function makeHost(userId: string): Promise<RoomView> {
  if (!state) throw new Error("You're not in a room.");
  take(await rpc("room_make_host", { p_room: state.id, p_user: userId }));
  return roomView();
}

export async function removeMember(userId: string): Promise<RoomView> {
  if (!state) throw new Error("You're not in a room.");
  take(await rpc("room_remove", { p_room: state.id, p_user: userId }));
  return roomView();
}

/** Back from sleep: the clock may have jumped, and updates were missed. */
export function resync(): void {
  if (!state) return;
  void measureClock()
    .catch(() => undefined)
    .then(() => ping());
}

/* ---------------- the listener's own queue, set aside ---------------- */

export async function stash(snapshot: unknown): Promise<void> {
  await persist.writeData(STASH, { snapshot, ...(state ? { roomId: state.id } : {}) });
}

/** The queue set aside, once (null when there's none). */
export async function unstash(): Promise<unknown> {
  const kept = persist.readData(STASH) as { snapshot?: unknown } | null;
  await persist.writeData(STASH, null).catch(() => undefined);
  return kept?.snapshot ?? null;
}

/** At start: a room ByTune quit or crashed in is left (best effort); the page restores the queue. */
export async function recover(): Promise<void> {
  const kept = persist.readData(STASH) as { roomId?: unknown } | null;
  if (typeof kept?.roomId !== "string" || state) return;
  if (auth.sessionInfo().mode === "account") await rpc("room_leave", { p_room: kept.roomId }).catch(() => undefined);
  await persist.writeData(STASH, { snapshot: (kept as { snapshot?: unknown }).snapshot ?? null }).catch(() => undefined);
}
