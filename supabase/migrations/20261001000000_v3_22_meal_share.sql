-- v3.22: a breakfast, lunch or dinner can be kept to yourself.
--
-- v3.21 made every meal the household's so Maria's dinner could be seen.
-- Sharing is now an option on the slot, the way a task is: absent stays
-- shared (every meal already written), and only `shared = false` withholds
-- one. Either member can turn sharing on; only the owner can turn it off
-- (the with-check half refuses a peer write that withholds the row).
--
-- The cook task is a client write, not this migration.

-- ------------------------------------------------------------ posts policy
-- The 20260930000000 body, with a meal's audience the same as a task's.
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
      and (coalesce(data ->> 'kind', 'task') <> 'meal' or coalesce(data ->> 'shared', 'true') = 'true')
    )
  )
  with check (
    user_id in (select public.household_user_ids())
    and (
      user_id = auth.uid()
      or (
        (coalesce(data ->> 'kind', 'task') <> 'note' or coalesce(data ->> 'shared', 'false') = 'true')
        and (coalesce(data ->> 'kind', 'task') <> 'task' or coalesce(data ->> 'shared', 'true') = 'true')
        and (coalesce(data ->> 'kind', 'task') <> 'meal' or coalesce(data ->> 'shared', 'true') = 'true')
      )
    )
  );

-- A write that does not mention `shared` leaves a stored `false` on a meal
-- the way it does on a task. An older Kitchen build that has never heard of
-- the field would otherwise publish a private breakfast by saving a side.
create or replace function public.posts_private_flag()
returns trigger
language plpgsql
as $$
begin
  if coalesce(old.data ->> 'kind', 'task') in ('task', 'meal')
     and coalesce(new.data ->> 'kind', 'task') = coalesce(old.data ->> 'kind', 'task')
     and old.data ->> 'shared' = 'false'
     and not (new.data ? 'shared') then
    new.data := jsonb_set(new.data, '{shared}', 'false'::jsonb);
  end if;
  return new;
end;
$$;

-- ------------------------------------------------------------ account deletion
-- A meal kept to yourself was never the household's, so it goes with the
-- private tasks rather than to the heir.
create or replace function public.admin_prepare_user_deletion(target uuid, heir uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  personal constant text[] := array['journal', 'review', 'calendar', 'habit', 'routine', 'garment', 'outfit', 'wear'];
  private_rows text[];
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

  private_rows := array(
    select p.id from public.posts p
     where p.user_id = target
       and coalesce(p.data ->> 'kind', 'task') in ('task', 'meal')
       and coalesce(p.data ->> 'shared', 'true') <> 'true');

  delete from public.posts_history h
   where h.user_id = target
     and (coalesce(h.data ->> 'kind', 'task') = any (personal)
          or coalesce(h.data ->> 'kind', 'task') = 'note'
          or h.id = any (private_rows)
          or (coalesce(h.data ->> 'kind', 'task') in ('task', 'meal') and coalesce(h.data ->> 'shared', 'true') <> 'true'));
  get diagnostics history_removed = row_count;
  update public.posts_history h set user_id = heir where h.user_id = target;
  get diagnostics history_moved = row_count;

  delete from public.posts p
   where p.user_id = target
     and (coalesce(p.data ->> 'kind', 'task') = any (personal)
          or (coalesce(p.data ->> 'kind', 'task') = 'note' and coalesce(p.data ->> 'shared', 'false') <> 'true')
          or (coalesce(p.data ->> 'kind', 'task') in ('task', 'meal') and coalesce(p.data ->> 'shared', 'true') <> 'true'));
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
