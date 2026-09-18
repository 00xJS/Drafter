-- v3.20: what the review of v3.19 found in the paths that outlive a task.
--
-- One fix, in the function that hands an account's records to an heir.
--
-- v3.19 deleted a private task's history along with the row, on the grounds
-- that posts_history's select policy is `user_id = auth.uid()` — so once the
-- versions change hands the heir can read every one of them, and a private
-- task's drafts are as private as the task. It asked the wrong question: which
-- tasks are private NOW. A task that was private for a fortnight and shared
-- yesterday keeps every version written during that fortnight, and each of
-- those rows carries `shared:false` in its own data. They moved to the heir.
--
-- So each VERSION is judged on itself, as well as by the row it belongs to.
-- A task shared all its life still passes its history on: that is the
-- household's record of household work, and v3.19 was right to keep it.
create or replace function public.admin_prepare_user_deletion(target uuid, heir uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  personal constant text[] := array['journal', 'review', 'calendar', 'habit', 'routine', 'garment', 'outfit', 'wear', 'meal'];
  private_tasks text[];
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

  -- read before the delete below takes the rows away
  private_tasks := array(
    select p.id from public.posts p
     where p.user_id = target
       and coalesce(p.data ->> 'kind', 'task') = 'task'
       and coalesce(p.data ->> 'shared', 'true') <> 'true');

  -- every version of every note goes, shared or not: a draft's audience was
  -- never decided, and deciding it now is what v3.15 refused to do. A task's
  -- versions go when the task is private now (`private_tasks`) OR when the
  -- version itself was written while it was — the fortnight a task spent
  -- withheld does not become the heir's because it is shared again today.
  delete from public.posts_history h
   where h.user_id = target
     and (coalesce(h.data ->> 'kind', 'task') = any (personal)
          or coalesce(h.data ->> 'kind', 'task') = 'note'
          or h.id = any (private_tasks)
          or (coalesce(h.data ->> 'kind', 'task') = 'task' and coalesce(h.data ->> 'shared', 'true') <> 'true'));
  get diagnostics history_removed = row_count;
  update public.posts_history h set user_id = heir where h.user_id = target;
  get diagnostics history_moved = row_count;

  delete from public.posts p
   where p.user_id = target
     and (coalesce(p.data ->> 'kind', 'task') = any (personal)
          or (coalesce(p.data ->> 'kind', 'task') = 'note' and coalesce(p.data ->> 'shared', 'false') <> 'true')
          or (coalesce(p.data ->> 'kind', 'task') = 'task' and coalesce(p.data ->> 'shared', 'true') <> 'true'));
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
