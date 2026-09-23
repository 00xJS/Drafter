-- v3.30: live updates — a change made on one device reaches the other within
-- seconds instead of on the next minute's poll.
--
-- The app subscribes to postgres_changes on public.posts (src/realtime.ts) and
-- treats each INSERT or UPDATE as a nudge to run its ordinary sync_posts round.
-- It never applies what the message carries, so every change still reaches a
-- device one way: the delta round, with its merge, cursor and revocations.
--
-- Realtime reads changes from the `supabase_realtime` publication, so posts has
-- to be in it, and that is all this does. Who hears a change is the table's
-- SELECT policy — "household access", last written in 20261004000000 — which
-- Realtime checks for each subscriber before it delivers an INSERT or UPDATE:
-- your own rows, and a household member's unless the kind is personal
-- (journal, review, calendar, habit, routine, garment, outfit, wear, snooze,
-- chat) or the record withholds itself (an unshared note, a private task, a
-- meal kept to its owner). The app does not listen for DELETE: Realtime cannot
-- check a policy against a row that is gone, and sends every subscriber its id.
--
-- Replica identity stays DEFAULT: a change carries the new row only. FULL would
-- write every old row into the WAL for nothing the app reads.
--
-- Idempotent. A no-op where there is no such publication (the plain Postgres of
-- scripts/db-smoke.sh), or where it already carries posts — a publication FOR
-- ALL TABLES among them, which cannot take ADD TABLE. Apply it with (or before)
-- the client build that subscribes. Until it is applied the channel hears
-- nothing: Realtime answers the subscription with an error, and the app keeps
-- its one-minute poll rather than slowing to five.
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    return;
  end if;
  if exists (
    select 1
      from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'posts'
  ) then
    return;
  end if;
  alter publication supabase_realtime add table public.posts;
end $$;
