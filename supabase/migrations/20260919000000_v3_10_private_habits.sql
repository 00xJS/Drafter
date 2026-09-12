-- v3.10: habits and routines become owner-only at the database, like journal,
-- review and calendar.
--
-- v3.9 (20260918) added both kinds to the sync_posts allowlist and left these
-- policies alone on purpose: the client already filters them with isMine, and
-- there was one account. But a household peer's device still RECEIVED the
-- rows — a sync pull or a direct select handed over another member's habits
-- and routines, and only the app's own filter kept them off the screen.
--
-- Both policies are 20260915's text with the two kinds added; nothing else
-- changes. The list is PERSONAL_KINDS in shared/kinds.mjs (a test holds the two
-- together). A peer's rows of these kinds already cached on a device go stale
-- rather than vanishing — the delta sync simply never sends them again — and
-- the app already hides them.
drop policy if exists "household access" on public.posts;
create policy "household access" on public.posts
  for all to authenticated
  using (
    user_id = auth.uid()
    or (user_id in (select public.household_user_ids()) and coalesce(data ->> 'kind', 'task') not in ('journal', 'review', 'calendar', 'habit', 'routine'))
  )
  with check (user_id in (select public.household_user_ids()));

drop policy if exists "household history select" on public.posts_history;
create policy "household history select" on public.posts_history
  for select to authenticated
  using (
    user_id = auth.uid()
    or (user_id in (select public.household_user_ids()) and coalesce(data ->> 'kind', 'task') not in ('journal', 'review', 'calendar', 'habit', 'routine'))
  );
