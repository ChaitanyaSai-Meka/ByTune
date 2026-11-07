/**
 * The Rooms and display-name migrations (supabase/migrations/0002-rooms.sql, 0003-display-names.sql)
 * run on real Postgres (PGlite), with stand-ins for what Supabase provides: the anon/authenticated
 * roles, auth.uid() from the request's user, and realtime.send/topic writing to and reading
 * realtime.messages. Every call is made as a signed-in user would make it, through the authenticated
 * role, so the access rules are what's tested, not a superuser's view.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const MIGRATION = readFileSync(new URL("../supabase/migrations/0002-rooms.sql", import.meta.url), "utf8");
const NAMES = readFileSync(new URL("../supabase/migrations/0003-display-names.sql", import.meta.url), "utf8");
const LONGER = readFileSync(new URL("../supabase/migrations/0004-room-queue-and-away.sql", import.meta.url), "utf8");
const SUPABASE = `
  create role anon nologin;
  create role authenticated nologin;
  grant usage on schema public to anon, authenticated;
  -- Supabase's defaults: tables in public are granted to both roles; RLS decides the rows.
  alter default privileges in schema public grant all on tables to anon, authenticated;
  create schema auth;
  create table auth.users (id uuid primary key);
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema auth to anon, authenticated;
  create schema realtime;
  create table realtime.messages (id bigserial primary key, topic text not null, extension text not null,
    payload jsonb, event text, private boolean);
  alter table realtime.messages enable row level security;
  grant usage on schema realtime to authenticated;
  grant select on realtime.messages to authenticated;
  create function realtime.topic() returns text language sql stable as $$ select current_setting('realtime.topic', true) $$;
  create function realtime.send(payload jsonb, event text, topic text, private boolean default true) returns void
    language sql as $$ insert into realtime.messages (topic, extension, payload, event, private) values (topic, 'broadcast', payload, event, private) $$;
  create table public.profiles (id uuid primary key references auth.users(id), username text unique not null);
`;
const ALICE = "00000000-0000-4000-8000-00000000000a";
const BOB = "00000000-0000-4000-8000-00000000000b";
const CAROL = "00000000-0000-4000-8000-00000000000c";
const song = (id, title = `Song ${id}`) => ({ id, title, artist: "Artist", duration: 200, thumb: "" });
const YT = (n) => `yt${String(n).padStart(9, "0")}`;

async function database() {
  const db = new PGlite();
  await db.exec(SUPABASE);
  for (const [id, name] of [[ALICE, "alice"], [BOB, "bob"], [CAROL, "carol"]]) {
    await db.query("insert into auth.users (id) values ($1)", [id]);
    await db.query("insert into public.profiles (id, username) values ($1, $2)", [id, name]);
  }
  await db.exec(MIGRATION);
  await db.exec(NAMES);
  await db.exec(LONGER);
  // Runs one statement as a signed-in user (or signed out with user null), as Supabase's API would.
  const as = async (user, sql, params = [], topic = "") => {
    await db.query("select set_config('request.jwt.claim.sub', $1, false), set_config('realtime.topic', $2, false)", [user ?? "", topic]);
    await db.exec(`set role ${user ? "authenticated" : "anon"}`);
    try {
      return (await db.query(sql, params)).rows;
    } finally {
      await db.exec("reset role");
    }
  };
  const call = async (user, fn, args = []) => {
    const list = args.map((_, i) => `$${i + 1}`).join(", ");
    const [row] = await as(user, `select public.${fn}(${list}) as r`, args);
    return row.r;
  };
  return { db, as, call };
}

test("starting and joining a room; a signed-out caller can do neither", async () => {
  const { call } = await database();
  await assert.rejects(call(null, "room_create"), /permission denied/, "signed out: the function isn't even callable");
  const room = await call(ALICE, "room_create");
  assert.match(room.code, /^[A-HJKMNP-Z2-9]{6}$/);
  assert.equal(room.hostId, ALICE);
  assert.deepEqual(room.members.map((m) => m.name), ["alice"]);
  assert.equal(room.activity[0].text, "alice started the room");
  const joined = await call(BOB, "room_join", [` ${room.code.toLowerCase()} `]);
  assert.deepEqual(joined.members.map((m) => m.name), ["alice", "bob"]);
  assert.equal(joined.activity[0].text, "bob joined");
  assert.ok(Math.abs(joined.serverMs - Date.now()) < 5000, "the server's clock comes with every state");
  await assert.rejects(call(BOB, "room_join", ["ZZZZZZ"]), /No room with that code/);
});

test("no direct access to the tables, and the helpers aren't callable", async () => {
  const { as, call } = await database();
  const room = await call(ALICE, "room_create");
  assert.deepEqual(await as(ALICE, "select * from public.rooms"), [], "not even the host reads the table directly");
  assert.deepEqual(await as(ALICE, "select * from public.room_members"), []);
  await assert.rejects(as(BOB, "insert into public.rooms (code, host_id) values ('ABCDEF', $1)", [BOB]), /row-level security/);
  await assert.rejects(as(BOB, "insert into public.room_members (room_id, user_id, name) values ($1, $2, 'bob')", [room.id, BOB]), /row-level security/);
  for (const helper of ["room_state($1::uuid)", "room_drop($1::uuid, $1::uuid, 'x')", "room_broadcast($1::uuid)", "room_note($1::uuid, 'x')"]) {
    await assert.rejects(as(BOB, `select public.${helper}`, [room.id]), /permission denied/, helper);
  }
  await assert.rejects(call(CAROL, "room_ping", [room.id]), /not in this room/, "outsiders get nothing back");
});

test("playback changes: seq guards against stale updates, starts are anchored ahead, input is checked", async () => {
  const { call } = await database();
  const room = await call(ALICE, "room_create");
  await call(BOB, "room_join", [room.code]);
  const now = Date.now();
  const played = await call(ALICE, "room_update", [room.id, room.seq + 1, song(YT(1)), 0, true, [song(YT(2))], true, "played Song 1"]);
  // room.seq + 1: bob's join bumped it once.
  assert.equal(played.track.id, YT(1));
  assert.equal(played.playing, true);
  assert.equal(played.queue.length, 1);
  assert.ok(played.anchorMs - now >= 550 && played.anchorMs - now < 3000, `a start is anchored ~600 ms ahead (${played.anchorMs - now})`);
  assert.equal(played.activity[0].text, "alice played Song 1");
  // Bob acts on the state before alice's: refused, nothing changes, he gets the current state back.
  const stale = await call(BOB, "room_update", [room.id, room.seq + 1, song(YT(9)), 0, true, [], true, "played x"]);
  assert.equal(stale.stale, true);
  assert.equal(stale.track.id, YT(1));
  // A song that just ended and moved on isn't anchored ahead.
  const next = await call(BOB, "room_update", [room.id, played.seq, song(YT(2)), 0, true, [], false, ""]);
  assert.ok(Math.abs(next.anchorMs - Date.now()) < 1000);
  assert.equal(next.activity[0].text, "alice played Song 1", "no note, no activity line");
  for (const [track, pos, queue, message] of [
    [{ id: "../etc/passwd" }, 0, [], "Not a song"],
    [song(YT(3)), 0, Array.from({ length: 101 }, (_, i) => song(YT(100 + i))), "Not a queue"],
    [song(YT(3)), 0, [{ id: 1 }], "Not a queue"],
    [song(YT(3)), -5, [], "Not a position"],
  ]) {
    await assert.rejects(call(BOB, "room_update", [room.id, next.seq, track, pos, true, queue, true, ""]), new RegExp(message));
  }
  await assert.rejects(call(CAROL, "room_update", [room.id, next.seq, song(YT(3)), 0, true, [], true, ""]), /not in this room/);
});

test("the host decides: only-host control, handing over, removing someone", async () => {
  const { call } = await database();
  const room = await call(ALICE, "room_create");
  let s = await call(BOB, "room_join", [room.code]);
  await assert.rejects(call(BOB, "room_set_host_only", [room.id, true]), /Only the host/);
  s = await call(ALICE, "room_set_host_only", [room.id, true]);
  assert.equal(s.hostOnly, true);
  await assert.rejects(call(BOB, "room_update", [room.id, s.seq, song(YT(1)), 0, true, [], true, ""]), /Only the host can control/);
  s = await call(ALICE, "room_update", [room.id, s.seq, song(YT(1)), 0, true, [], true, ""]);
  assert.equal(s.track.id, YT(1), "the host still can");
  s = await call(ALICE, "room_make_host", [room.id, BOB]);
  assert.equal(s.hostId, BOB);
  await assert.rejects(call(ALICE, "room_set_host_only", [room.id, false]), /Only the host/, "alice isn't host anymore");
  await assert.rejects(call(BOB, "room_make_host", [room.id, CAROL]), /aren't in this room/);
  await assert.rejects(call(BOB, "room_remove", [room.id, BOB]), /Leave the room instead/);
  s = await call(BOB, "room_remove", [room.id, ALICE]);
  assert.deepEqual(s.members.map((m) => m.name), ["bob"]);
  assert.equal(s.activity[0].text, "alice was removed");
  await assert.rejects(call(ALICE, "room_ping", [room.id]), /not in this room/);
});

test("leaving: the host hands over, the last one out closes the room, one room at a time", async () => {
  const { call, db } = await database();
  const room = await call(ALICE, "room_create");
  await call(BOB, "room_join", [room.code]);
  await call(CAROL, "room_join", [room.code]);
  await call(ALICE, "room_leave", [room.id]);
  let s = await call(BOB, "room_ping", [room.id]);
  assert.equal(s.hostId, BOB, "whoever joined first after the host");
  assert.deepEqual(s.activity.slice(0, 2).map((a) => a.text), ["bob is the host now", "alice left"]);
  // Bob starts a room of his own: he leaves this one.
  const other = await call(BOB, "room_create");
  s = await call(CAROL, "room_ping", [room.id]);
  assert.deepEqual(s.members.map((m) => m.name), ["carol"]);
  assert.equal(s.hostId, CAROL);
  await call(CAROL, "room_leave", [room.id]);
  assert.equal((await db.query("select count(*)::int as n from public.rooms where id = $1", [room.id])).rows[0].n, 0, "the empty room is gone");
  // Full and expired rooms can't be joined.
  await db.query("update public.rooms set max_members = 2 where id = $1", [other.id]);
  await call(ALICE, "room_join", [other.code]);
  await assert.rejects(call(CAROL, "room_join", [other.code]), /full/);
  await db.query("update public.rooms set expires_at = now() - interval '1 minute' where id = $1", [other.id]);
  await assert.rejects(call(CAROL, "room_join", [other.code]), /No room with that code/);
});

test("live updates reach the room's members only", async () => {
  const { as, call } = await database();
  const room = await call(ALICE, "room_create");
  await call(BOB, "room_join", [room.code]);
  const topic = `room:${room.id}`;
  const heard = async (user) => (await as(user, "select payload from realtime.messages where topic = $1", [topic], topic)).length;
  assert.ok((await heard(BOB)) > 0, "bob's join was broadcast, and bob may hear it");
  assert.ok((await heard(ALICE)) > 0);
  assert.equal(await heard(CAROL), 0, "an outsider hears nothing, even naming the topic");
  const [last] = await as(BOB, "select payload, event, private from realtime.messages where topic = $1 order by id desc limit 1", [topic], topic);
  assert.equal(last.event, "state");
  assert.equal(last.private, true);
  assert.deepEqual(last.payload.members.map((m) => m.name), ["alice", "bob"]);
});

test("the clock: signed-in users can read it, signed-out can't", async () => {
  const { call } = await database();
  const ms = Number(await call(ALICE, "room_clock"));
  assert.ok(Math.abs(ms - Date.now()) < 5000);
  await assert.rejects(call(null, "room_clock"), /permission denied/);
});

test("the migration runs twice without trouble", async () => {
  const { db, call } = await database();
  await call(ALICE, "room_create");
  await db.exec(MIGRATION);
  await db.exec(NAMES);
  await db.exec(LONGER);
  const again = await call(BOB, "room_create");
  assert.match(again.code, /^[A-HJKMNP-Z2-9]{6}$/);
});

/* ---------------- display names (0003) ---------------- */

const SAVE_NAME = "insert into public.display_names (user_id, name) values ($1, $2) on conflict (user_id) do update set name = excluded.name";

test("a display name is private: each user reads and sets only their own, signed out nothing", async () => {
  const { as } = await database();
  await as(ALICE, SAVE_NAME, [ALICE, "Alice Liddell"]);
  assert.deepEqual(await as(ALICE, "select name from public.display_names"), [{ name: "Alice Liddell" }]);
  assert.deepEqual(await as(BOB, "select name from public.display_names"), [], "not someone else's");
  await assert.rejects(as(null, "select name from public.display_names"), /permission denied/, "signed out: not readable at all");
  await assert.rejects(as(BOB, SAVE_NAME, [ALICE, "Not Alice"]), /row-level security/, "not for someone else");
  await as(BOB, "update public.display_names set name = 'Not Alice' where user_id = $1", [ALICE]);
  await assert.rejects(as(BOB, "delete from public.display_names"), /permission denied/);
  assert.deepEqual(await as(ALICE, "select name from public.display_names"), [{ name: "Alice Liddell" }], "untouched by bob");
  await as(ALICE, SAVE_NAME, [ALICE, "Alice"]);
  assert.deepEqual(await as(ALICE, "select name from public.display_names"), [{ name: "Alice" }], "changed by its owner");
});

test("a display name is 1-30 characters, trimmed, with no control characters", async () => {
  const { as } = await database();
  for (const bad of ["", " Alice", "Alice ", "a".repeat(31), "Al\nice", "Al\u0007ice"]) {
    await assert.rejects(as(ALICE, SAVE_NAME, [ALICE, bad]), /violates check constraint/, JSON.stringify(bad));
  }
  for (const good of ["A", "a".repeat(30), "Ana María", "リシ", "🎧 Rishi", `${"x".repeat(29)}🎧`]) {
    await as(ALICE, SAVE_NAME, [ALICE, good]);
  }
});

test("Rooms show a member's display name, the username until there is one, and a new name at once", async () => {
  const { as, call } = await database();
  const room = await call(ALICE, "room_create");
  assert.deepEqual(room.members.map((m) => m.name), ["alice"], "no display name yet: the username");
  await as(BOB, SAVE_NAME, [BOB, "Bobby"]);
  const joined = await call(BOB, "room_join", [room.code]);
  assert.deepEqual(joined.members.map((m) => m.name), ["alice", "Bobby"]);
  assert.equal(joined.activity[0].text, "Bobby joined");
  // Alice names herself while in the room: everyone in it hears the new name.
  await as(ALICE, SAVE_NAME, [ALICE, "Alice Liddell"]);
  const topic = `room:${room.id}`;
  const [last] = await as(BOB, "select payload from realtime.messages where topic = $1 order by id desc limit 1", [topic], topic);
  assert.deepEqual(last.payload.members.map((m) => m.name), ["Alice Liddell", "Bobby"]);
  const played = await call(ALICE, "room_update", [room.id, joined.seq, song(YT(1)), 0, true, [], true, "played Song 1"]);
  assert.equal(played.activity[0].text, "Alice Liddell played Song 1");
});

/* ---------------- a longer queue, and people who drop off (0004) ---------------- */

test("a room's queue holds 100 songs, and no more than 128 KB of them", async () => {
  const { call } = await database();
  const room = await call(ALICE, "room_create");
  const hundred = Array.from({ length: 100 }, (_, i) => song(YT(200 + i)));
  const full = await call(ALICE, "room_update", [room.id, room.seq, song(YT(1)), 0, true, hundred, true, ""]);
  assert.equal(full.queue.length, 100);
  await assert.rejects(
    call(ALICE, "room_update", [room.id, full.seq, song(YT(1)), 0, true, [...hundred, song(YT(999))], true, ""]),
    /Not a queue/
  );
  // 40 songs of 3.5 KB each: 140 KB.
  const heavy = Array.from({ length: 40 }, (_, i) => ({ ...song(YT(400 + i)), thumb: `https://example.com/${"x".repeat(3400)}` }));
  await assert.rejects(call(ALICE, "room_update", [room.id, full.seq, song(YT(1)), 0, true, heavy, true, ""]), /Not a queue/);
});

test("someone who stops checking in for 3 minutes leaves the room, and the host role passes on", async () => {
  const { db, call } = await database();
  const room = await call(ALICE, "room_create");
  await call(BOB, "room_join", [room.code]);
  await call(CAROL, "room_join", [room.code]);
  const quiet = (user, minutes) => db.query(`update public.room_members set last_seen = now() - interval '${minutes} minutes' where user_id = $1`, [user]);
  await quiet(ALICE, 4); // the host's laptop went to sleep
  await quiet(CAROL, 2); // carol's last check-in was 2 minutes ago: still here
  const state = await call(BOB, "room_ping", [room.id]);
  assert.deepEqual(state.members.map((m) => m.name), ["bob", "carol"]);
  assert.equal(state.hostId, BOB, "the host role passes to whoever joined first");
  assert.deepEqual(state.activity.slice(0, 2).map((a) => a.text), ["bob is the host now", "alice left"]);
  await assert.rejects(call(ALICE, "room_ping", [room.id]), /not in this room/, "back from sleep: no longer in it");
  await quiet(CAROL, 5);
  const alone = await call(BOB, "room_ping", [room.id]);
  assert.deepEqual(alone.members.map((m) => m.name), ["bob"], "the one checking in stays");
});
