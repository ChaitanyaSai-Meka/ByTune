-- ============================================================
-- Migration 0004 — Rooms: a longer queue, and people who drop off
-- ============================================================
-- Paste into Supabase → SQL Editor → Run, after 0002 and 0003. Safe to re-run.
--
-- What it changes:
--   1. a room's queue holds up to 100 songs (was 25), and up to 128 KB of
--      them. A room's whole state goes out on every change, and Realtime on
--      the free plan carries at most 256 KB a message, so this stays well
--      inside it.
--   2. someone whose app hasn't checked in for 3 minutes (it does every
--      30 s) is taken out of the room, as if they had left: the room hears
--      "<name> left", and the host role passes on if it was theirs.

-- ---------------------------------------------------------------
-- 1. The queue: room_update as in 0002, with the new limits
-- ---------------------------------------------------------------
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
  if jsonb_typeof(p_queue) <> 'array' or jsonb_array_length(p_queue) > 100 or octet_length(p_queue::text) > 131072
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

-- ---------------------------------------------------------------
-- 2. People who drop off
-- ---------------------------------------------------------------
-- Takes out everyone in the room who hasn't checked in for 3 minutes, the
-- way leaving does (room_drop: a note, the host role handed on, everyone told).
create or replace function public.room_drop_away(p_room uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  gone uuid;
begin
  for gone in
    select user_id from public.room_members
    where room_id = p_room and last_seen < now() - interval '3 minutes'
    order by joined_at
  loop
    perform public.room_drop(p_room, gone, public.room_member_name(gone) || ' left');
  end loop;
end $$;

-- "I'm still here", every 30 s, as in 0002: and now each check-in also
-- takes out anyone in the room who stopped checking in.
create or replace function public.room_ping(p_room uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  update public.room_members set last_seen = now() where room_id = p_room and user_id = auth.uid();
  if not found then raise exception 'You''re not in this room'; end if;
  perform public.room_drop_away(p_room);
  return public.room_state(p_room);
end $$;

-- Who may call what (as in 0002): the helper is for the functions above only.
revoke all on function public.room_drop_away(uuid) from public, anon, authenticated;
revoke all on function public.room_ping(uuid) from public, anon;
revoke all on function public.room_update(uuid, bigint, jsonb, bigint, boolean, jsonb, boolean, text) from public, anon;
grant execute on function public.room_ping(uuid) to authenticated;
grant execute on function public.room_update(uuid, bigint, jsonb, bigint, boolean, jsonb, boolean, text) to authenticated;
