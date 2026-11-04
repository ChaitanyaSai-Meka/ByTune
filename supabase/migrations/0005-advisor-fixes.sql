-- ============================================================
-- Migration 0005 — the database advisors' findings (2026-11-04)
-- ============================================================
-- Paste into Supabase → SQL Editor → Run. Safe to re-run. It changes
-- permissions, policy expressions, one index and two policies; no row of
-- data is read or changed.

-- 1. Security Advisor: "Public Can Execute SECURITY DEFINER Function" and
--    "Signed-In Users Can Execute SECURITY DEFINER Function" for
--    public.rls_auto_enable(). It isn't one of ByTune's migrations; by its
--    name it's the helper that turns RLS on for new tables. Like every new
--    function, anyone could execute it through /rest/v1/rpc, and nothing
--    should. An event trigger runs its function whoever may execute it, so
--    new tables still get RLS. Skipped where the function doesn't exist.
do $$
begin
  if to_regprocedure('public.rls_auto_enable()') is not null then
    revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
  end if;
end
$$;

-- 2. Performance Advisor: "Auth RLS Initialization Plan". These policies
--    called auth.uid() again for every row they checked; written as
--    (select auth.uid()) it's worked out once per query and reused. Who may
--    read or write what is unchanged: same comparisons, same columns.
alter policy "insert own profile" on public.profiles
  with check ((select auth.uid()) = id);

alter policy "update own profile" on public.profiles
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);

alter policy "read own data" on public.user_data
  using ((select auth.uid()) = user_id);

alter policy "insert own data" on public.user_data
  with check ((select auth.uid()) = user_id);

alter policy "update own data" on public.user_data
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- 3. Performance Advisor: "Unindexed foreign keys" for rooms.host_id.
--    Deleting an account deletes the rooms it hosts (the foreign key
--    cascades), which finds rooms by host_id: with an index that's a lookup
--    instead of a read through every room.
create index if not exists rooms_host_id_idx on public.rooms (host_id);

-- 4. Security Advisor (Info): "RLS Enabled No Policy" for rooms and
--    room_members. That's on purpose: only the room_* functions read and
--    write these tables, never the API. Supabase recommends saying so with
--    a policy that lets no one in, so access stays exactly as it was.
drop policy if exists "only through the room functions" on public.rooms;
create policy "only through the room functions" on public.rooms
  for all to anon, authenticated using (false) with check (false);

drop policy if exists "only through the room functions" on public.room_members;
create policy "only through the room functions" on public.room_members
  for all to anon, authenticated using (false) with check (false);

-- Left as they are, on purpose:
--  * "Signed-In Users Can Execute SECURITY DEFINER Function" for the room_*
--    functions. They are the Rooms API: signed-in users must call them, and
--    each checks who is calling and what they send (membership, the host,
--    room codes, songs, queue size). Signed-out callers already can't (0002).
--  * "Leaked Password Protection Disabled": the HaveIBeenPwned check is a
--    Pro-plan setting (Authentication → Sign In / Providers → Email).
