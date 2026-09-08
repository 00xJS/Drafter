-- v3.6: journal entries (kind = 'journal') join the posts table.
-- Copy the newest sync_posts body (kitchen), append the kind, and fix the
-- variable name that made the shipped body reject every item (see below).
-- Ship this before any client writes journal rows — unknown kinds are rejected
-- (the client keeps retrying them, but they stay on one device until this runs).

create or replace function public.sync_posts(incoming jsonb, since timestamptz default null)
returns jsonb
language plpgsql
as $$
declare
  item jsonb;
  stamp timestamptz;
  kind text;
  me uuid := coalesce(auth.uid(), public.owner_user_id());
  rejected jsonb := '[]'::jsonb;
  -- not `id`: a PL/pgSQL variable of that name makes `on conflict (id)` ambiguous
  -- and every item lands in `rejected` (the shipped 20260911-14 bodies had this)
  item_id text;
  accepted boolean;
begin
  if jsonb_typeof(incoming) = 'array' then
    for item in select value from jsonb_array_elements(incoming) loop
      item_id := item->>'id';
      accepted := false;
      begin
        kind := coalesce(item->>'kind', 'task');
        if (item ? 'id') and (item ? 'updatedAt')
           and kind in ('task', 'project', 'calendar', 'person', 'place', 'review', 'template', 'recipe', 'meal', 'grocery', 'journal')
           and (not item ? 'status'
                or (kind = 'project' and item->>'status' in ('active','paused','done','archived'))
                or (kind = 'task' and item->>'status' in
                      ('wishlist','todo','doing','blocked','done','canceled',
                       'idea','draft','scheduled','posted'))) then
          stamp := (item->>'updatedAt')::timestamptz;
          if stamp > now() + interval '5 minutes' then
            stamp := now();
            item := jsonb_set(item, '{updatedAt}', to_jsonb(to_char(stamp at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));
          end if;
          item := item - 'ownerId' - 'syncedAt';
          insert into public.posts as p (id, updated_at, synced_at, data, user_id)
          values (item->>'id', stamp, clock_timestamp(), item, me)
          on conflict (id) do update
            set updated_at = excluded.updated_at,
                data = excluded.data,
                synced_at = clock_timestamp()
            where excluded.updated_at > p.updated_at;
          accepted := true;
        end if;
      exception when others then
        accepted := false;
      end;
      if item_id is not null and not accepted then
        rejected := rejected || jsonb_build_array(item_id);
      end if;
    end loop;
  end if;
  return jsonb_build_object(
    'items', coalesce(
      (select jsonb_agg(
                p2.data || jsonb_build_object(
                  'ownerId', p2.user_id,
                  'syncedAt', to_char(p2.synced_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
                )
                order by p2.synced_at
              )
         from public.posts p2
        where since is null or p2.synced_at > since),
      '[]'::jsonb
    ),
    'rejected', rejected
  );
end;
$$;

revoke execute on function public.sync_posts(jsonb, timestamptz) from public, anon;
grant execute on function public.sync_posts(jsonb, timestamptz) to authenticated, service_role;

-- Personal kinds (journal, review, calendar) are visible only to their owner —
-- and so is their history. Every other kind keeps household visibility. Writes
-- are unchanged: a member may still only write rows in their household, and an
-- upsert onto a peer's journal row fails the USING check, which sync_posts
-- reports as a rejected id.
drop policy if exists "household access" on public.posts;
create policy "household access" on public.posts
  for all to authenticated
  using (
    user_id = auth.uid()
    or (user_id in (select public.household_user_ids()) and coalesce(data ->> 'kind', 'task') not in ('journal', 'review', 'calendar'))
  )
  with check (user_id in (select public.household_user_ids()));

drop policy if exists "household history select" on public.posts_history;
create policy "household history select" on public.posts_history
  for select to authenticated
  using (
    user_id = auth.uid()
    or (user_id in (select public.household_user_ids()) and coalesce(data ->> 'kind', 'task') not in ('journal', 'review', 'calendar'))
  );

-- Sunday's unattended review draft reads the week's journal only when the
-- account has opted in (Settings → Reminders); the on-demand summary the user
-- presses for is explicit consent and always may.
alter table public.user_settings
  add column if not exists digest_journal boolean not null default false;
