# Account deletion (to build)

Parked on 2026-11-07, to come back to later, like the music videos next door. Nothing here is built: this note is the reminder.

## Where things stand

- The app has no **Delete account** button. People can reset their data on the device, but their cloud account stays.
- The website's privacy policy and terms say deletion requests go by direct message (Instagram @rishiteja.21, X @rishiteja21, LinkedIn rishiteja21) and that self-service deletion is in development.
- Until it ships, delete a requested account by hand: Supabase dashboard › Authentication › Users › the user › Delete user. `profiles` and `user_data` go with it (`on delete cascade`). Check that the rooms tables (`supabase/migrations/0002-rooms.sql`, `0004-room-queue-and-away.sql`) do too.
- Background: audit finding H-1 (local `SECURITY_FINDINGS.md`, 2026-09-29).

## What to build

1. **Server.** Deleting the auth user needs the service-role key, which the app must never hold. An Edge Function checks the caller's session (asking them to sign in again first), then calls `auth.admin.deleteUser`. The Supabase side is applied by hand: readable SQL plus dashboard steps, tried on PGlite first.
2. **App.** Settings › Account › **Delete account**, with a clear confirmation: what gets erased, and that it can't be undone. Afterwards, sign out and clear that account's data from the device.
3. **Website.** Update `/privacy` (Data retention and deletion, Contact) and `/terms` §9 to say how to delete from the app.
4. **Check.** Delete a test account and confirm its rows are gone from `auth.users`, `profiles`, `user_data` and the rooms tables.
