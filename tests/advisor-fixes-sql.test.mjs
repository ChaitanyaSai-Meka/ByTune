/**
 * The database advisors' fixes (supabase/migrations/0005-advisor-fixes.sql) on real Postgres (PGlite):
 * the whole schema (schema.sql and migrations 0001–0004) with stand-ins for what Supabase provides,
 * then 0005. Calls are made as the API makes them, through the anon / authenticated roles.
 * - rls_auto_enable(), made outside these migrations, can't be run through the API any more, and the
 *   event trigger it serves still turns RLS on for new tables; without it, 0005 still runs.
 * - The profile and data policies work out auth.uid() once per query, and still keep everyone to
 *   their own rows.
 * - rooms are indexed by their host.
 * - rooms and room_members say in a policy that nobody reads them directly; the room functions still work.
 * - Running 0005 again is harmless.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const file = (p) => readFileSync(new URL(`../supabase/${p}`, import.meta.url), "utf8");
const BEFORE = [
  "schema.sql",
  "migrations/0001-username-charset.sql",
  "migrations/0002-rooms.sql",
  "migrations/0003-display-names.sql",
  "migrations/0004-room-queue-and-away.sql",
];
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
`;
// The kind of helper a project gets for "turn RLS on for every new table": an event trigger function in
// public. Like any new function, PUBLIC (so anon and authenticated) may execute it.
const AUTO_RLS = `
  create function public.rls_auto_enable() returns event_trigger language plpgsql security definer
  set search_path = pg_catalog as $$
  declare cmd record;
  begin
    for cmd in select * from pg_event_trigger_ddl_commands() where command_tag = 'CREATE TABLE' and schema_name = 'public' loop
      execute format('alter table %s enable row level security', cmd.object_identity);
    end loop;
  end $$;
  create event trigger ensure_rls on ddl_command_end when tag in ('CREATE TABLE') execute function public.rls_auto_enable();
`;
const ALICE = "00000000-0000-4000-8000-00000000000a";
const BOB = "00000000-0000-4000-8000-00000000000b";
const CAROL = "00000000-0000-4000-8000-00000000000c";

async function database({ autoRls = false } = {}) {
  const db = new PGlite();
  await db.exec(SUPABASE);
  for (const id of [ALICE, BOB, CAROL]) await db.query("insert into auth.users (id) values ($1)", [id]);
  for (const p of BEFORE) await db.exec(file(p));
  if (autoRls) await db.exec(AUTO_RLS);
  await db.exec(file("migrations/0005-advisor-fixes.sql"));
  // One statement as a signed-in user (or signed out with user null), as Supabase's API runs it.
  const as = async (user, sql, params = []) => {
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [user ?? ""]);
    await db.exec(`set role ${user ? "authenticated" : "anon"}`);
    try {
      return (await db.query(sql, params)).rows;
    } finally {
      await db.exec("reset role");
    }
  };
  const call = async (user, fn, args = []) => {
    const [row] = await as(user, `select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(", ")}) as r`, args);
    return row.r;
  };
  return { db, as, call };
}

test("rls_auto_enable() can't be run through the API any more, and new tables still get RLS from it", async () => {
  const { db, as } = await database({ autoRls: true });
  await assert.rejects(as(null, "select public.rls_auto_enable()"), /permission denied/, "signed out");
  await assert.rejects(as(ALICE, "select public.rls_auto_enable()"), /permission denied/, "signed in");
  // A table made later, by a role that isn't a superuser, still gets RLS turned on by the event trigger.
  await db.exec("create role maker nologin; grant create on schema public to maker; set role maker; create table public.made_later (id int); reset role;");
  const [{ rls }] = (await db.query("select relrowsecurity as rls from pg_class where oid = 'public.made_later'::regclass")).rows;
  assert.equal(rls, true);
});

test("a project without rls_auto_enable() runs 0005 just the same", async () => {
  const { db } = await database({ autoRls: false });
  assert.equal((await db.query("select to_regprocedure('public.rls_auto_enable()') as f")).rows[0].f, null);
});

test("the profile and data policies work out auth.uid() once per query, not once per row", async () => {
  const { db } = await database();
  const rows = (
    await db.query(
      `select policyname, coalesce(qual, '') || ' ' || coalesce(with_check, '') as expr from pg_policies
       where schemaname = 'public' and tablename in ('profiles', 'user_data') and policyname <> 'username lookup is public'
       order by policyname`,
    )
  ).rows;
  assert.deepEqual(rows.map((r) => r.policyname), ["insert own data", "insert own profile", "read own data", "update own data", "update own profile"]);
  for (const r of rows) {
    assert.match(r.expr, /\( SELECT auth\.uid\(\) AS uid\)/, `${r.policyname}: ${r.expr}`);
    assert.doesNotMatch(r.expr.replaceAll("( SELECT auth.uid() AS uid)", ""), /auth\.uid\(\)/, `${r.policyname}: no bare auth.uid() left`);
  }
});

test("...and still keep everyone to their own rows", async () => {
  const { as } = await database();
  await as(ALICE, "insert into public.profiles (id, username) values ($1, 'alice')", [ALICE]);
  await assert.rejects(as(ALICE, "insert into public.profiles (id, username) values ($1, 'bob')", [BOB]), /row-level security/, "not someone else's profile");
  await as(ALICE, "update public.profiles set username = 'alice_2' where id = $1", [ALICE]);
  await as(BOB, "update public.profiles set username = 'taken_over' where id = $1", [ALICE]);
  assert.deepEqual(await as(null, "select username from public.profiles where id = $1", [ALICE]), [{ username: "alice_2" }], "renamed by Alice, not by Bob");

  await as(ALICE, "insert into public.user_data (user_id, store_name, payload) values ($1, 'library', '{\"v\":1}')", [ALICE]);
  await assert.rejects(as(ALICE, "insert into public.user_data (user_id, store_name, payload) values ($1, 'library', '{}')", [BOB]), /row-level security/);
  await as(ALICE, "update public.user_data set payload = '{\"v\":2}' where user_id = $1", [ALICE]);
  await as(BOB, "update public.user_data set payload = '{\"v\":3}' where user_id = $1", [ALICE]);
  assert.deepEqual(await as(ALICE, "select payload from public.user_data"), [{ payload: { v: 2 } }], "Bob's update reached nothing");
  assert.deepEqual(await as(BOB, "select * from public.user_data"), [], "Bob reads none of Alice's");
  await assert.rejects(as(ALICE, "update public.user_data set user_id = $1 where user_id = $2", [BOB, ALICE]), /row-level security/, "a row can't be handed to someone else");
});

test("rooms are indexed by their host", async () => {
  const { db } = await database();
  const defs = (await db.query("select indexdef from pg_indexes where schemaname = 'public' and tablename = 'rooms'")).rows.map((r) => r.indexdef);
  assert.ok(defs.some((d) => /\(host_id\)$/.test(d)), defs.join("\n"));
});

test("rooms and room_members say in a policy that nobody reads them directly; the room functions still work", async () => {
  const { db, as, call } = await database();
  const tables = (await db.query("select distinct tablename from pg_policies where schemaname = 'public' and tablename in ('rooms', 'room_members') order by 1")).rows;
  assert.deepEqual(tables.map((t) => t.tablename), ["room_members", "rooms"]);
  await db.query("insert into public.profiles (id, username) values ($1, 'alice'), ($2, 'bob')", [ALICE, BOB]);
  const room = await call(ALICE, "room_create");
  const joined = await call(BOB, "room_join", [room.code]);
  assert.deepEqual(joined.members.map((m) => m.name), ["alice", "bob"]);
  assert.deepEqual(await as(ALICE, "select * from public.rooms"), [], "not even the host reads the table");
  assert.deepEqual(await as(BOB, "select * from public.room_members"), []);
  await assert.rejects(as(ALICE, "insert into public.rooms (code, host_id) values ('ABCDEF', $1)", [ALICE]), /row-level security/);
});

test("running 0005 again is harmless", async () => {
  const { db } = await database({ autoRls: true });
  await db.exec(file("migrations/0005-advisor-fixes.sql"));
  const policies = (await db.query("select count(*)::int as n from pg_policies where schemaname = 'public' and tablename in ('rooms', 'room_members')")).rows[0].n;
  const indexes = (await db.query("select count(*)::int as n from pg_indexes where schemaname = 'public' and tablename = 'rooms' and indexdef ~ '\\(host_id\\)$'")).rows[0].n;
  assert.deepEqual({ policies, indexes }, { policies: 2, indexes: 1 });
});
