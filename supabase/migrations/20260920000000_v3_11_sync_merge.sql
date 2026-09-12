-- v3.11: sync_posts stops discarding the losing side of a conflict, and purged
-- records stay purged.
--
-- A push no newer than the stored row was skipped by the upsert's WHERE yet
-- reported as accepted, so the client dropped its edit and it was lost
-- everywhere. Such ids now come back in `stale`, each one's winning row is
-- echoed in `items` whatever the cursor, and the loser is kept in posts_history
-- (reason 'lost'). An exact re-push of the stored version (a retry, a full
-- resync) is not a conflict; a stale push onto a row the caller cannot see is
-- rejected, as the same push with a newer stamp already is.
--
-- Purged tombstones are hard-deleted after 90 days, and a device offline longer
-- than that pushed its live copy back on a full resync. Those deletes are now
-- ledgered in purged_ids and such pushes come back in `gone`, never stored —
-- unless the record was created after the purge (meal and grocery ids are
-- deterministic, so re-planning that slot must work) or the id is stored again.
-- Purges before this migration left no trace.
--
-- Response: { items, rejected, stale, gone }; old clients and the MCP server
-- read only the first two. Otherwise this is the v3.9 body, with `kind`
-- renamed: posts has a generated column of that name, the trap `id` was.

-- ------------------------------------------------------------ lost versions
-- Why a version was kept: null when a newer write replaced it (the trigger, as
-- before), 'lost' when a push lost to the stored row and never became current.
alter table public.posts_history add column if not exists reason text;

-- sync_posts runs as the caller and clients may not insert history, so the
-- loser goes in through here. It is filed under the caller's own id, never the
-- row owner's, so a direct call cannot put words in anyone else's history; and
-- only when it really lost to a stored row, and only once.
create or replace function public.posts_history_record_loss(post_id text, lost jsonb)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.posts_history (id, updated_at, user_id, data, replaced_at, reason)
  select p.id, (lost ->> 'updatedAt')::timestamptz, coalesce(auth.uid(), public.owner_user_id()), lost, now(), 'lost'
    from public.posts p
   where p.id = post_id
     and lost ->> 'id' = post_id
     and p.updated_at >= (lost ->> 'updatedAt')::timestamptz
     and not exists (
       select 1 from public.posts_history h
        where h.id = post_id and h.reason = 'lost' and h.data = lost
     )
$$;

revoke execute on function public.posts_history_record_loss(text, jsonb) from public, anon;
grant execute on function public.posts_history_record_loss(text, jsonb) to authenticated, service_role;

-- ------------------------------------------------------------- purge ledger
-- Ids hard-deleted after the tombstone TTL (digest.mjs and lib/backup.mjs both
-- delete them). RLS on and no policies: only the trigger writes it, and
-- sync_posts asks purged_among() rather than reading it.
create table if not exists public.purged_ids (
  id text primary key,
  purged_at timestamptz not null default now()
);

alter table public.purged_ids enable row level security;

create or replace function public.purged_ids_capture()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.purged_ids (id) values (old.id) on conflict do nothing;
  return null;
end;
$$;

drop trigger if exists posts_purged_after_delete on public.posts;
create trigger posts_purged_after_delete
  after delete on public.posts
  for each row
  when (old.data ->> 'purged' = 'true')
  execute function public.purged_ids_capture();

-- Which of these ids were purged, and when, as { id: purged_at }. An id stored
-- again since (a deliberate restore) is a live row, not a resurrection, so it
-- is left out.
create or replace function public.purged_among(ids text[])
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_object_agg(g.id, g.purged_at), '{}'::jsonb)
    from public.purged_ids g
   where g.id = any(ids)
     and not exists (select 1 from public.posts p where p.id = g.id)
$$;

revoke execute on function public.purged_among(text[]) from public, anon;
grant execute on function public.purged_among(text[]) to authenticated, service_role;

-- --------------------------------------------------------------- sync_posts
create or replace function public.sync_posts(incoming jsonb, since timestamptz default null)
returns jsonb
language plpgsql
as $$
declare
  item jsonb;
  stamp timestamptz;
  -- not `kind`: posts has a generated column of that name (v3)
  item_kind text;
  me uuid := coalesce(auth.uid(), public.owner_user_id());
  rejected jsonb := '[]'::jsonb;
  -- not `id`: a PL/pgSQL variable of that name makes `on conflict (id)` ambiguous
  -- and every item lands in `rejected` (the shipped 20260911-14 bodies had this)
  item_id text;
  accepted boolean;
  -- null: stored, or already current; 'stale': lost to the stored row; 'gone': purged
  outcome text;
  written integer;
  winner jsonb;
  born timestamptz;
  purged_map jsonb;
  stale_ids text[] := '{}';
  gone_ids text[] := '{}';
begin
  if jsonb_typeof(incoming) = 'array' then
    purged_map := public.purged_among(array(select value ->> 'id' from jsonb_array_elements(incoming)));
    for item in select value from jsonb_array_elements(incoming) loop
      item_id := item->>'id';
      accepted := false;
      outcome := null;
      begin
        if purged_map ? item_id then
          -- created after its id was purged: a new record reusing a deterministic id
          begin
            born := (item->>'createdAt')::timestamptz;
          exception when others then
            born := null;
          end;
          if born is null or born <= (purged_map->>item_id)::timestamptz then
            outcome := 'gone';
          end if;
        end if;
        item_kind := coalesce(item->>'kind', 'task');
        if outcome is null
           and (item ? 'id') and (item ? 'updatedAt')
           and item_kind in ('task', 'project', 'calendar', 'person', 'place', 'review', 'template', 'recipe', 'meal', 'grocery', 'journal', 'event', 'habit', 'routine')
           and (not item ? 'status'
                or (item_kind = 'project' and item->>'status' in ('active','paused','done','archived'))
                or (item_kind = 'task' and item->>'status' in
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
          get diagnostics written = row_count;
          if written = 0 then
            -- the WHERE kept a stored row at least as new; read it as the caller
            select p.data into winner from public.posts p where p.id = item_id;
            if not found then
              raise exception 'stale write onto a row the caller cannot see';
            end if;
            if winner is distinct from item then
              perform public.posts_history_record_loss(item_id, item);
              outcome := 'stale';
            end if;
          end if;
          accepted := true;
        end if;
      exception when others then
        accepted := false;
        outcome := null;
      end;
      if outcome = 'gone' then
        if not (item_id = any(gone_ids)) then
          gone_ids := gone_ids || item_id;
        end if;
      elsif item_id is not null and not accepted then
        rejected := rejected || jsonb_build_array(item_id);
      elsif outcome = 'stale' and not (item_id = any(stale_ids)) then
        stale_ids := stale_ids || item_id;
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
        where since is null or p2.synced_at > since
           -- a stale id's winner comes back whatever the cursor, so the client adopts it
           or p2.id = any(stale_ids)),
      '[]'::jsonb
    ),
    'rejected', rejected,
    'stale', to_jsonb(stale_ids),
    'gone', to_jsonb(gone_ids)
  );
end;
$$;

revoke execute on function public.sync_posts(jsonb, timestamptz) from public, anon;
grant execute on function public.sync_posts(jsonb, timestamptz) to authenticated, service_role;
