-- ============================================================
-- Migration 0002 — Rooms: listen together
-- ============================================================
-- Paste into Supabase → SQL Editor → Run. Safe to re-run.
--
-- What it adds, in the order below:
--   1. two tables: rooms, and who is in them (room_members)
--   2. Row Level Security with NO policies on them: nobody reads or writes
--      them directly, not even signed-in users
--   3. functions ("RPCs") the app calls instead. Each one runs as the table
--      owner (SECURITY DEFINER), so it can reach the tables, and checks for
--      itself that the caller is signed in and in the room
--   4. live updates: after every change a function broadcasts the room's new
--      state on the Realtime topic "room:<id>"; a policy on realtime.messages
--      lets only that room's members listen
--
-- How the app keeps everyone at the same moment of a song: a room stores
-- where the song is (position_ms) at a moment of the SERVER's clock
-- (anchor_ms). Each app measures how far its own clock is from the server's
-- (room_clock) and works out where the song should be now. A start or a seek
-- is anchored 600 ms ahead, so every app has time to load and start together.

-- ---------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------
create table if not exists public.rooms (
  id uuid primary key default gen_random_uuid(),
  -- What people type to join: 6 characters, no look-alikes (no 0/O, 1/I/L).
  code text not null unique check (code ~ '^[A-HJKMNP-Z2-9]{6}$'),
  host_id uuid not null references auth.users(id) on delete cascade,
  -- On: only the host can play, pause, skip, seek or change the queue.
  host_only boolean not null default false,
  max_members int not null default 10 check (max_members between 2 and 50),
  track jsonb,                                 -- the song playing (null: none yet)
  position_ms bigint not null default 0,       -- where that song is at anchor_ms...
  anchor_ms bigint not null default 0,         -- ...a moment of the server's clock (ms)
  playing boolean not null default false,
  queue jsonb not null default '[]'::jsonb,    -- up next, at most 25 songs
  activity jsonb not null default '[]'::jsonb, -- the last 20 things that happened
  -- Bumps on every change. An update must say which seq it was based on; a
  -- stale one (someone else changed the room first) is refused, not merged.
  seq bigint not null default 0,
  created_at timestamptz not null default now(),
  -- A room nobody touches for 6 hours is gone (cleared when a room is created).
  expires_at timestamptz not null default now() + interval '6 hours'
);

create table if not exists public.room_members (
  room_id uuid not null references public.rooms(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,                          -- the username, for the member list
  joined_at timestamptz not null default now(),
  last_seen timestamptz not null default now(), -- refreshed by room_ping every 30 s
  primary key (room_id, user_id)
);
create index if not exists room_members_user_idx on public.room_members (user_id);

-- ---------------------------------------------------------------
-- 2. Row Level Security: on, with no policies = no direct access at all
-- ---------------------------------------------------------------
alter table public.rooms enable row level security;
alter table public.room_members enable row level security;

-- ---------------------------------------------------------------
-- 3. Functions
-- ---------------------------------------------------------------
-- Helpers first. They are for the functions below only: revoked from
-- everyone at the end of this file, so the app can't call them itself.

-- The server's clock in milliseconds.
create or replace function public.room_now_ms() returns bigint
language sql volatile set search_path = public as $$
  select (extract(epoch from clock_timestamp()) * 1000)::bigint;
$$;

-- A member's display name: their username.
create or replace function public.room_member_name(p_user uuid) returns text
language sql stable security definer set search_path = public as $$
  select coalesce((select username from public.profiles where id = p_user), 'Someone');
$$;

-- Everything a member needs to show the room, as one JSON object.
create or replace function public.room_state(p_room uuid) returns jsonb
language sql volatile security definer set search_path = public as $$
  select jsonb_build_object(
    'id', r.id, 'code', r.code, 'hostId', r.host_id, 'hostOnly', r.host_only,
    'track', r.track, 'positionMs', r.position_ms, 'anchorMs', r.anchor_ms, 'playing', r.playing,
    'queue', r.queue, 'activity', r.activity, 'seq', r.seq,
    'members', coalesce((
      select jsonb_agg(jsonb_build_object(
        'userId', m.user_id, 'name', m.name,
        'lastSeenMs', (extract(epoch from m.last_seen) * 1000)::bigint
      ) order by m.joined_at)
      from public.room_members m where m.room_id = r.id), '[]'::jsonb),
    'serverMs', public.room_now_ms()
  )
  from public.rooms r where r.id = p_room;
$$;

-- Adds a line to the room's activity, keeping the newest 20.
create or replace function public.room_note(p_room uuid, p_text text) returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.rooms set activity = (
    select coalesce(jsonb_agg(e order by n), '[]'::jsonb) from (
      select e, n from jsonb_array_elements(
        jsonb_build_array(jsonb_build_object('atMs', public.room_now_ms(), 'text', left(p_text, 140))) || activity
      ) with ordinality as t(e, n)
      order by n limit 20
    ) newest)
  where id = p_room;
end $$;

-- Sends the room's state to everyone listening on "room:<id>". If Realtime
-- is down the change still stands: members catch up on their next call.
create or replace function public.room_broadcast(p_room uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform realtime.send(public.room_state(p_room), 'state', 'room:' || p_room::text, true);
exception when others then
  raise warning 'room broadcast failed: %', sqlerrm;
end $$;

-- Takes a member out. The last one out closes the room; a leaving host
-- hands over to whoever joined first.
create or replace function public.room_drop(p_room uuid, p_user uuid, p_why text) returns void
language plpgsql security definer set search_path = public as $$
declare
  next_host uuid;
begin
  delete from public.room_members where room_id = p_room and user_id = p_user;
  if not found then return; end if;
  select user_id into next_host from public.room_members where room_id = p_room order by joined_at limit 1;
  if next_host is null then
    delete from public.rooms where id = p_room;
    return;
  end if;
  perform public.room_note(p_room, p_why);
  if (select host_id from public.rooms where id = p_room) = p_user then
    update public.rooms set host_id = next_host where id = p_room;
    perform public.room_note(p_room, public.room_member_name(next_host) || ' is the host now');
  end if;
  update public.rooms set seq = seq + 1 where id = p_room;
  perform public.room_broadcast(p_room);
end $$;

-- A JSON song as the app sends it: an object with an 11-character YouTube id.
create or replace function public.room_song_ok(p_song jsonb) returns boolean
language sql immutable set search_path = public as $$
  select jsonb_typeof(p_song) = 'object'
     and coalesce(p_song->>'id', '') ~ '^[A-Za-z0-9_-]{11}$'
     and octet_length(p_song::text) <= 4096;
$$;

-- The functions the app calls --------------------------------------

-- The server's clock, for the app to measure its own clock's offset. (It runs
-- as the caller, who can't call the room_now_ms helper, so it reads the clock itself.)
create or replace function public.room_clock() returns bigint
language sql volatile set search_path = public as $$
  select (extract(epoch from clock_timestamp()) * 1000)::bigint;
$$;

-- Starts a room with the caller as host (leaving any room they were in).
create or replace function public.room_create() returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  new_code text;
  new_id uuid;
  bytes bytea;
  old record;
begin
  if me is null then raise exception 'Sign in to start a room'; end if;
  for old in select room_id from public.room_members where user_id = me loop
    perform public.room_drop(old.room_id, me, public.room_member_name(me) || ' left');
  end loop;
  delete from public.rooms where expires_at < now();
  loop
    -- 6 characters from a random UUID's bytes (gen_random_uuid is cryptographically random).
    bytes := uuid_send(gen_random_uuid());
    new_code := '';
    for i in 0..5 loop
      new_code := new_code || substr(alphabet, 1 + get_byte(bytes, i) % length(alphabet), 1);
    end loop;
    begin
      insert into public.rooms (code, host_id) values (new_code, me) returning id into new_id;
      exit;
    exception when unique_violation then
      -- that code is in use: draw another
    end;
  end loop;
  insert into public.room_members (room_id, user_id, name) values (new_id, me, public.room_member_name(me));
  perform public.room_note(new_id, public.room_member_name(me) || ' started the room');
  return public.room_state(new_id);
end $$;

-- Joins the room with this code (leaving any other room).
create or replace function public.room_join(p_code text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  r public.rooms;
  old record;
begin
  if me is null then raise exception 'Sign in to join a room'; end if;
  select * into r from public.rooms where code = upper(trim(p_code)) and expires_at > now();
  if not found then raise exception 'No room with that code'; end if;
  if not exists (select 1 from public.room_members where room_id = r.id and user_id = me) then
    if (select count(*) from public.room_members where room_id = r.id) >= r.max_members then
      raise exception 'That room is full';
    end if;
    for old in select room_id from public.room_members where user_id = me loop
      perform public.room_drop(old.room_id, me, public.room_member_name(me) || ' left');
    end loop;
    insert into public.room_members (room_id, user_id, name) values (r.id, me, public.room_member_name(me));
    perform public.room_note(r.id, public.room_member_name(me) || ' joined');
    update public.rooms set seq = seq + 1 where id = r.id;
    perform public.room_broadcast(r.id);
  end if;
  return public.room_state(r.id);
end $$;

-- Leaves the room.
create or replace function public.room_leave(p_room uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  perform public.room_drop(p_room, auth.uid(), public.room_member_name(auth.uid()) || ' left');
end $$;

-- "I'm still here", every 30 s: returns the room, so members and clock stay fresh.
create or replace function public.room_ping(p_room uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  update public.room_members set last_seen = now() where room_id = p_room and user_id = auth.uid();
  if not found then raise exception 'You''re not in this room'; end if;
  return public.room_state(p_room);
end $$;

-- What's playing changed: a new song, play/pause, a seek, or the queue.
-- p_seq is the seq the change was based on: if the room moved on meanwhile,
-- nothing changes and the current state comes back marked stale.
-- p_lead anchors the start 600 ms ahead (a start or a seek); a song that
-- simply ended and moved on doesn't need it.
create or replace function public.room_update(
  p_room uuid, p_seq bigint, p_track jsonb, p_position_ms bigint, p_playing boolean,
  p_queue jsonb, p_lead boolean, p_note text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  r public.rooms;
begin
  select * into r from public.rooms where id = p_room;
  if not found or not exists (select 1 from public.room_members where room_id = p_room and user_id = me) then
    raise exception 'You''re not in this room';
  end if;
  if r.host_only and r.host_id <> me then raise exception 'Only the host can control this room'; end if;
  if p_seq <> r.seq then return public.room_state(p_room) || '{"stale": true}'::jsonb; end if;
  if p_track is not null and not public.room_song_ok(p_track) then raise exception 'Not a song'; end if;
  if jsonb_typeof(p_queue) <> 'array' or jsonb_array_length(p_queue) > 25 or octet_length(p_queue::text) > 65536
     or exists (select 1 from jsonb_array_elements(p_queue) s where not public.room_song_ok(s)) then
    raise exception 'Not a queue';
  end if;
  if p_position_ms is null or p_position_ms < 0 or p_position_ms > 86400000 then raise exception 'Not a position'; end if;
  update public.rooms set
    track = p_track, position_ms = p_position_ms, playing = coalesce(p_playing, false), queue = p_queue,
    anchor_ms = public.room_now_ms() + (case when p_lead then 600 else 0 end),
    seq = seq + 1, expires_at = now() + interval '6 hours'
  where id = p_room;
  if coalesce(trim(p_note), '') <> '' then
    perform public.room_note(p_room, public.room_member_name(me) || ' ' || p_note);
  end if;
  perform public.room_broadcast(p_room);
  return public.room_state(p_room);
end $$;

-- Host: let only the host control playback, or everyone.
create or replace function public.room_set_host_only(p_room uuid, p_on boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.rooms where id = p_room and host_id = auth.uid()) then
    raise exception 'Only the host can do that';
  end if;
  update public.rooms set host_only = coalesce(p_on, false), seq = seq + 1 where id = p_room;
  perform public.room_note(p_room, case when p_on then 'Only the host controls the music now' else 'Everyone can control the music now' end);
  perform public.room_broadcast(p_room);
  return public.room_state(p_room);
end $$;

-- Host: hand the room to another member.
create or replace function public.room_make_host(p_room uuid, p_user uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.rooms where id = p_room and host_id = auth.uid()) then
    raise exception 'Only the host can do that';
  end if;
  if not exists (select 1 from public.room_members where room_id = p_room and user_id = p_user) then
    raise exception 'They aren''t in this room';
  end if;
  update public.rooms set host_id = p_user, seq = seq + 1 where id = p_room;
  perform public.room_note(p_room, public.room_member_name(p_user) || ' is the host now');
  perform public.room_broadcast(p_room);
  return public.room_state(p_room);
end $$;

-- Host: remove someone from the room.
create or replace function public.room_remove(p_room uuid, p_user uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.rooms where id = p_room and host_id = auth.uid()) then
    raise exception 'Only the host can do that';
  end if;
  if p_user = auth.uid() then raise exception 'Leave the room instead'; end if;
  perform public.room_drop(p_room, p_user, public.room_member_name(p_user) || ' was removed');
  return public.room_state(p_room);
end $$;

-- Realtime: may the signed-in caller listen on this topic? Only to their own
-- room's. SECURITY DEFINER so it can read room_members past its RLS.
create or replace function public.room_topic_ok(p_topic text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.room_members m
    where m.user_id = auth.uid() and 'room:' || m.room_id::text = p_topic
  );
$$;

-- ---------------------------------------------------------------
-- 4. Live updates: who may hear a room's broadcasts
-- ---------------------------------------------------------------
-- The app listens on a PRIVATE channel "room:<id>"; Realtime asks this policy
-- whether the listener may receive its messages.
drop policy if exists "room members hear their room" on realtime.messages;
create policy "room members hear their room" on realtime.messages
  for select to authenticated
  using (realtime.messages.extension = 'broadcast' and public.room_topic_ok(realtime.topic()));

-- ---------------------------------------------------------------
-- Who may call what. New functions are callable by everyone by default;
-- these lines narrow that: helpers by no one, the app's functions by
-- signed-in users only (anon = signed out).
-- ---------------------------------------------------------------
revoke all on function public.room_now_ms() from public, anon, authenticated;
revoke all on function public.room_member_name(uuid) from public, anon, authenticated;
revoke all on function public.room_state(uuid) from public, anon, authenticated;
revoke all on function public.room_note(uuid, text) from public, anon, authenticated;
revoke all on function public.room_broadcast(uuid) from public, anon, authenticated;
revoke all on function public.room_drop(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.room_song_ok(jsonb) from public, anon, authenticated;

revoke all on function public.room_clock() from public, anon;
revoke all on function public.room_create() from public, anon;
revoke all on function public.room_join(text) from public, anon;
revoke all on function public.room_leave(uuid) from public, anon;
revoke all on function public.room_ping(uuid) from public, anon;
revoke all on function public.room_update(uuid, bigint, jsonb, bigint, boolean, jsonb, boolean, text) from public, anon;
revoke all on function public.room_set_host_only(uuid, boolean) from public, anon;
revoke all on function public.room_make_host(uuid, uuid) from public, anon;
revoke all on function public.room_remove(uuid, uuid) from public, anon;
revoke all on function public.room_topic_ok(text) from public, anon;

grant execute on function public.room_clock() to authenticated;
grant execute on function public.room_create() to authenticated;
grant execute on function public.room_join(text) to authenticated;
grant execute on function public.room_leave(uuid) to authenticated;
grant execute on function public.room_ping(uuid) to authenticated;
grant execute on function public.room_update(uuid, bigint, jsonb, bigint, boolean, jsonb, boolean, text) to authenticated;
grant execute on function public.room_set_host_only(uuid, boolean) to authenticated;
grant execute on function public.room_make_host(uuid, uuid) to authenticated;
grant execute on function public.room_remove(uuid, uuid) to authenticated;
grant execute on function public.room_topic_ok(text) to authenticated;
