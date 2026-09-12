-- v3.13: notes (kind = 'note').
--
-- Notes were one rich-text pad per project, stored on the project row
-- (data->>'notesHtml'). The app now centres on one ongoing project, so that is
-- one pad, and the owner asked for several: separate notes for separate
-- things. A note is its own record — title, the same sanitized HTML body the
-- project pad stores (photos referenced by media id), an optional projectId, a
-- pinned flag. Existing project pads are never rewritten; the Notes screen
-- lists them beside note records and still saves them to the project.
--
-- sync_posts rejects any kind it has not been told about, and the client keeps
-- a refused row dirty and re-pushes it forever: habits and routines sat on the
-- phone looking saved that way until v3.9. Ship this BEFORE the client build
-- that writes notes; nothing on the client changes, its rows simply go through.
--
-- Notes are SHARED with the household, like tasks and projects, so the posts
-- and posts_history policies and account deletion are unchanged (PERSONAL_KINDS
-- in shared/kinds.mjs does not grow).
--
-- Below: the v3.11 sync_posts body (20260920000000) with 'note' added to the
-- allowlist, nothing else changed; and the sync canary (20260919020000) giving
-- its synthetic note a title and a body, as it gives a task and a project theirs.

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
           and item_kind in ('task', 'project', 'calendar', 'person', 'place', 'review', 'template', 'recipe', 'meal', 'grocery', 'journal', 'event', 'habit', 'routine', 'note')
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

-- -------------------------------------------------------------- sync_canary
-- The 20260919020000 body; the only change is the synthetic note's fields. The
-- hourly digest passes every kind in SYNC_KINDS, so 'note' is checked from the
-- first run after the client's list grows.
create or replace function public.sync_canary(kinds text[])
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  k text;
  -- not `id`: see 20260915 — a variable named after a column is how this all started
  canary_id text;
  stamp text;
  answer jsonb;
  reason text;
  checked integer := 0;
  failures jsonb := '[]'::jsonb;
begin
  foreach k in array coalesce(kinds, '{}'::text[]) loop
    checked := checked + 1;
    if coalesce(k, '') = '' then
      failures := failures || jsonb_build_array(jsonb_build_object('kind', k, 'reason', 'empty kind'));
      continue;
    end if;
    canary_id := 'canary~' || k || '~' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12);
    stamp := to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
    reason := null;
    begin
      -- the fewest fields sync_posts insists on: id, updatedAt, a known kind, and
      -- a valid status for the two kinds whose status it checks; a note carries
      -- the title and body the app always writes
      answer := public.sync_posts(
        jsonb_build_array(
          jsonb_build_object('kind', k, 'id', canary_id, 'createdAt', stamp, 'updatedAt', stamp)
          || case k
               when 'task' then '{"status":"todo","title":"Sync canary"}'::jsonb
               when 'project' then '{"status":"active","name":"Sync canary"}'::jsonb
               when 'note' then '{"title":"Sync canary","body":"<p>Sync canary</p>"}'::jsonb
               else '{}'::jsonb
             end
        ),
        now()
      );
      if coalesce(answer -> 'rejected', '[]'::jsonb) ? canary_id then
        reason := 'rejected';
      elsif not exists (select 1 from public.posts p where p.id = canary_id) then
        reason := 'accepted but not stored';
      end if;
      -- undo the write; plpgsql variables (reason) are not rolled back with it
      raise exception using errcode = 'DRCAN', message = 'sync canary: roll back';
    exception
      when sqlstate 'DRCAN' then
        null;
      when others then
        reason := sqlerrm;
    end;
    if reason is not null then
      failures := failures || jsonb_build_array(jsonb_build_object('kind', k, 'reason', reason));
    end if;
  end loop;
  return jsonb_build_object(
    'ok', checked > 0 and jsonb_array_length(failures) = 0,
    'checked', checked,
    'failures', failures
  );
end;
$$;

revoke execute on function public.sync_canary(text[]) from public, anon, authenticated;
grant execute on function public.sync_canary(text[]) to service_role;
