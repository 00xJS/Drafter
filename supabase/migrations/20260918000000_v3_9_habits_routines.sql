-- v3.9: habits and routines (kind = 'habit', kind = 'routine').
--
-- Both landed on the client without a server change, and sync_posts rejects
-- any kind it has not been told about. The client keeps those ids dirty
-- (RETRY_KINDS in src/store.ts) and re-pushes them on every sync, so each
-- habit and routine sat on the phone looking saved, never reached the laptop
-- or a backup, and was gone on reinstall — the exact failure the v3.8 header
-- warned about. Ship this BEFORE the client build that writes them; nothing
-- on the client changes, the retried rows simply go through.
--
-- Both kinds are OWNER-ONLY, like journal and review: the store filters them
-- to the account that made them, so the server only has to accept the rows.
--
-- Everything below is the v3.8 body with the two kinds added to the allowlist.

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
           and kind in ('task', 'project', 'calendar', 'person', 'place', 'review', 'template', 'recipe', 'meal', 'grocery', 'journal', 'event', 'habit', 'routine')
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
