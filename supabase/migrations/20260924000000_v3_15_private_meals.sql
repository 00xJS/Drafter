-- v3.15: a meal belongs to one member, and an edit history is your own.
--
-- Two changes, both about what one household member can see of another's.
--
-- ## Meals become personal
--
-- A meal's row was `meal~<date>~<slot>` and a week's grocery row was
-- `grocery~<week>`, with nobody in them — and `posts.id` is one key for
-- everybody. So those were ONE row per day and ONE row per week for the whole
-- household. Two people planning the same slot wrote the same id; sync_posts
-- keeps the first owner but takes the newer `data`, so one person's lunch
-- silently replaced the other's in the same row, and both then read it as
-- theirs. That is what was reported: "our lunch sections were shared, so
-- Maria's lunches were mine".
--
-- The client now writes `meal~<date>~<slot>~<userId>` and
-- `grocery~<week>~<userId>` for new rows, and keeps the id of any row it is
-- already editing — so nothing is renamed here. Renaming would be a data
-- migration AND a sync problem: another device still holds the old id in its
-- IndexedDB cache and would push it straight back.
--
-- With a row each, `meal` joins the kinds a household does not share. A meal
-- plan is now as private as a journal: you each keep your own week.
--
-- Grocery deliberately does NOT join them. The lists stay visible to the
-- household — "so we could share our grocery lists while we are going out" —
-- they are simply one row each now instead of one row fought over.
--
-- ## An edit history is your own
--
-- `posts_history` let a household member read every earlier version of any
-- shared row, and src/components/taskeditor/VersionsPanel.tsx fetches that
-- table straight from the client with the reader's own JWT. So a note or task
-- edited privately and then shared would hand over every draft it had ever
-- been, and there was no way to share the record without sharing its past.
-- History is now the owner's alone. Nothing in the app reads a peer's history:
-- the Versions panel only ever opens on a record you are editing.

-- ------------------------------------------------------------ posts policy
-- The 20260923000000 body, with 'meal' added to the kinds a peer never sees.
drop policy if exists "household access" on public.posts;
create policy "household access" on public.posts
  for all to authenticated
  using (
    user_id = auth.uid()
    or (user_id in (select public.household_user_ids()) and coalesce(data ->> 'kind', 'task') not in ('journal', 'review', 'calendar', 'habit', 'routine', 'garment', 'outfit', 'wear', 'meal'))
  )
  with check (user_id in (select public.household_user_ids()));

-- --------------------------------------------------------- history policy
-- Your own rows, and nothing else. The kind list is gone rather than extended:
-- a version's audience cannot be decided later without re-deciding every
-- version, and no screen needs a peer's history.
drop policy if exists "household history select" on public.posts_history;
create policy "household history select" on public.posts_history
  for select to authenticated
  using (user_id = auth.uid());

-- ------------------------------------------------------------ account deletion
-- The 20260923000000 body; `personal` gains 'meal', so an heir no longer
-- inherits someone's meal plan any more than their diary. This is the same
-- rule shared/kinds.mjs states, and src/__tests__/srv-kinds.test.ts holds the
-- two together.
create or replace function public.admin_prepare_user_deletion(target uuid, heir uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  personal constant text[] := array['journal', 'review', 'calendar', 'habit', 'routine', 'garment', 'outfit', 'wear', 'meal'];
  moved integer;
  removed integer;
  history_moved integer;
  history_removed integer;
begin
  if target is null or heir is null then
    raise exception 'admin_prepare_user_deletion: target and heir are both required';
  end if;
  if target = heir then
    raise exception 'admin_prepare_user_deletion: an account cannot inherit its own records';
  end if;
  if target = public.owner_user_id() then
    raise exception 'admin_prepare_user_deletion: refusing to prepare the site owner for deletion';
  end if;
  if not exists (select 1 from auth.users u where u.id = heir) then
    raise exception 'admin_prepare_user_deletion: the heir % has no account', heir;
  end if;

  delete from public.posts_history h
   where h.user_id = target and coalesce(h.data ->> 'kind', 'task') = any (personal);
  get diagnostics history_removed = row_count;
  update public.posts_history h set user_id = heir where h.user_id = target;
  get diagnostics history_moved = row_count;

  delete from public.posts p
   where p.user_id = target and coalesce(p.data ->> 'kind', 'task') = any (personal);
  get diagnostics removed = row_count;
  update public.posts p set user_id = heir, synced_at = clock_timestamp() where p.user_id = target;
  get diagnostics moved = row_count;

  return jsonb_build_object(
    'reassigned', moved,
    'deleted', removed,
    'historyReassigned', history_moved,
    'historyDeleted', history_removed
  );
end;
$$;

revoke execute on function public.admin_prepare_user_deletion(uuid, uuid) from public, anon, authenticated;
grant execute on function public.admin_prepare_user_deletion(uuid, uuid) to service_role;
