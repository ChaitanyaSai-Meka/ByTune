-- ============================================================
-- Migration 0003 — display names
-- ============================================================
-- Paste into Supabase → SQL Editor → Run, after 0002-rooms.sql. Safe to re-run.
--
-- A display name is what people see: in Rooms and around the app. The
-- username stays the name you sign in with (the app shows it only in
-- Settings).
--
-- Why a table of its own: public.profiles can be read by anyone (the app
-- checks whether a username is taken before signing up). A display name is
-- often a real name, so it lives here, where only its owner can read or
-- change it. Rooms reads it through its own functions, so only the people
-- in a room with you see it.
--
-- What it adds, in the order below:
--   1. the table, display_names: one name per account
--   2. Row Level Security: each signed-in user reads and sets only their own
--   3. Rooms: members are shown by their display name (their username until
--      they have one), and a new name reaches the room they're in at once

-- ---------------------------------------------------------------
-- 1. The table
-- ---------------------------------------------------------------
create table if not exists public.display_names (
  user_id uuid primary key references auth.users(id) on delete cascade,
  -- 1 to 30 characters, no spaces at either end, no control characters
  -- (line breaks, tabs). Any language and emoji are fine; it needn't be unique.
  name text not null
    constraint display_name_length check (char_length(name) between 1 and 30)
    constraint display_name_trimmed check (name = btrim(name))
    constraint display_name_printable check (name !~ '[[:cntrl:]]')
);

-- ---------------------------------------------------------------
-- 2. Row Level Security: your own name only
-- ---------------------------------------------------------------
alter table public.display_names enable row level security;

drop policy if exists "read own display name" on public.display_names;
create policy "read own display name" on public.display_names
  for select to authenticated using ((select auth.uid()) = user_id);

drop policy if exists "add own display name" on public.display_names;
create policy "add own display name" on public.display_names
  for insert to authenticated with check ((select auth.uid()) = user_id);

drop policy if exists "change own display name" on public.display_names;
create policy "change own display name" on public.display_names
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- Signed out: no access at all. Signed in: read, add and change (the
-- policies above narrow that to your own row). Nobody deletes one: an
-- account's name goes when the account does.
revoke all on public.display_names from anon, authenticated;
grant select, insert, update on public.display_names to authenticated;

-- ---------------------------------------------------------------
-- 3. Rooms
-- ---------------------------------------------------------------
-- A member's name in a room: their display name, else their username.
create or replace function public.room_member_name(p_user uuid) returns text
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select name from public.display_names where user_id = p_user),
    (select username from public.profiles where id = p_user),
    'Someone');
$$;
revoke all on function public.room_member_name(uuid) from public, anon, authenticated;

-- A room keeps each member's name from when they joined. A new display name
-- replaces it in the room they're in, and the room hears it right away.
create or replace function public.display_name_to_rooms() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  changed uuid;
begin
  for changed in
    update public.room_members set name = new.name where user_id = new.user_id returning room_id
  loop
    perform public.room_broadcast(changed);
  end loop;
  return new;
end $$;
revoke all on function public.display_name_to_rooms() from public, anon, authenticated;

drop trigger if exists display_name_to_rooms on public.display_names;
create trigger display_name_to_rooms
  after insert or update of name on public.display_names
  for each row execute function public.display_name_to_rooms();
