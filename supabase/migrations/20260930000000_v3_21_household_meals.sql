-- v3.21: a meal plan is the household's again, one row per member.
--
-- v3.15 made meals personal because the id was `meal~date~slot` with nobody
-- in it: two people planning the same slot wrote the same row and one lunch
-- replaced the other. The client now writes `meal~date~slot~userId`, so there
-- is nothing to collide. Hiding the row from the other member was the leftover
-- of that fix, and it is what "Maria scheduled dinner and I could not see it"
-- is. Grocery already works this way — one row each, everyone reads them.
--
-- So `meal` leaves the personal list. A peer can see and cook from another
-- member's plan; they still cannot write onto that row. Existing meals carry
-- no `shared` flag and become visible, which is what a household dinner is.
-- Breakfast and lunch travel the same way: they are the week's food, not a
-- diary. A Home Screen widget is not this change.

-- ------------------------------------------------------------ posts policy
-- The 20260928000000 body, with 'meal' dropped from the kinds a peer never sees.
drop policy if exists "household access" on public.posts;
create policy "household access" on public.posts
  for all to authenticated
  using (
    user_id = auth.uid()
    or (
      user_id in (select public.household_user_ids())
      and coalesce(data ->> 'kind', 'task') not in ('journal', 'review', 'calendar', 'habit', 'routine', 'garment', 'outfit', 'wear')
      and (coalesce(data ->> 'kind', 'task') <> 'note' or coalesce(data ->> 'shared', 'false') = 'true')
      and (coalesce(data ->> 'kind', 'task') <> 'task' or coalesce(data ->> 'shared', 'true') = 'true')
    )
  )
  with check (
    user_id in (select public.household_user_ids())
    and (
      user_id = auth.uid()
      or (
        (coalesce(data ->> 'kind', 'task') <> 'note' or coalesce(data ->> 'shared', 'false') = 'true')
        and (coalesce(data ->> 'kind', 'task') <> 'task' or coalesce(data ->> 'shared', 'true') = 'true')
      )
    )
  );

-- ------------------------------------------------------------ account deletion
-- The 20260929000000 body; `personal` loses 'meal', so an heir inherits the
-- week's food the same way they inherit the grocery list.
create or replace function public.admin_prepare_user_deletion(target uuid, heir uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  personal constant text[] := array['journal', 'review', 'calendar', 'habit', 'routine', 'garment', 'outfit', 'wear'];
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

  private_tasks := array(
    select p.id from public.posts p
     where p.user_id = target
       and coalesce(p.data ->> 'kind', 'task') = 'task'
       and coalesce(p.data ->> 'shared', 'true') <> 'true');

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
