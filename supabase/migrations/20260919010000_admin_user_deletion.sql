-- Deleting an account that owns records.
--
-- posts.user_id references auth.users ON DELETE SET NULL (20260908030000) but
-- has been NOT NULL since 20260908050000, so deleting any account that owned a
-- single row failed outright: the SET NULL action violates the constraint and
-- Postgres refuses the whole delete. Admin's deleteUser assumed the rows would
-- survive unowned; they never could.
--
-- This hands the account's records over first, in one transaction, so the
-- auth delete that follows has nothing left pointing at it:
--   * shared kinds move to the heir — the owner running Admin — so the
--     household keeps its tasks, projects, people, places, kitchen and events,
--     the same way household.mjs `remove` re-attributes a member's rows;
--   * personal kinds (journal, review, calendar, habit, routine — PERSONAL_KINDS
--     in shared/kinds.mjs) are deleted: they were never anyone else's to read,
--     and an heir must not inherit a diary;
--   * posts_history.user_id has no foreign key, so its rows would outlive the
--     account. History of the personal rows goes with them; history of the
--     shared rows follows those rows to the heir, who can still restore them.
--
-- enforce_lww only guards writes that change data or updated_at, so the
-- ownership update passes it untouched and leaves no history row. synced_at is
-- bumped so every device pulls the new owner on its next delta sync.
--
-- household_members, household_invites (as invitee) and user_settings cascade
-- on the auth delete; households.created_by and household_invites.invited_by
-- are set null. Service role only.

create or replace function public.admin_prepare_user_deletion(target uuid, heir uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  personal constant text[] := array['journal', 'review', 'calendar', 'habit', 'routine'];
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
