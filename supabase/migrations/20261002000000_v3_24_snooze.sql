-- v3.24: a nudge can be put off (kind = 'snooze').
--
-- Today asks you about people you have not seen, places you meant to go back
-- to and what is coming up. The only answers were "done" and leaving it there
-- to ask again tomorrow. A snooze is the third: "not this fortnight". It is
-- never forever — every option carries a day it comes back — so nothing is
-- quietly dropped.
--
-- It is PERSONAL, and that is the whole point. Maria putting her mother off for
-- two weeks is not Joseph saying he has called her, any more than Maria's work
-- day is his. Owner-only at the database, never sent to a household peer.
--
-- One row per thing, keyed snooze~<person|place|event>~<target id>, so putting
-- the same nudge off again overwrites rather than piling rows up.
--
-- sync_posts rejects any kind it has not been told about, and the client keeps
-- a refused row dirty and re-pushes it forever ("n unsynced"). Apply this
-- BEFORE the client build that writes snoozes. The owner approves
-- `supabase db push`, after `supabase migration list --linked` and
-- `supabase db push --dry-run`.
--
-- Below:
--   * sync_posts: the v3.19 body (20260928000000) with 'snooze' added to the
--     allowlist, nothing else changed;
--   * the posts policy: 20261001000000's text with 'snooze' in the personal
--     list (PERSONAL_KINDS in shared/kinds.mjs; src/__tests__/srv-kinds.test.ts
--     holds them together). posts_history's select policy has been owner-only
--     since 20260924000000, so it already covers this;
--   * admin_prepare_user_deletion: 20261001000000's body with the same list, so
--     a leaving member's snoozes go with their journal rather than to an heir;
--   * sync_canary: the v3.14 body, giving the synthetic snooze row the fields
--     the app writes.

-- ------------------------------------------------------------------ sync_posts
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
           and item_kind in ('task', 'project', 'calendar', 'person', 'place', 'review', 'template', 'recipe', 'meal', 'grocery', 'journal', 'event', 'habit', 'routine', 'note', 'garment', 'outfit', 'wear', 'snooze')
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
    'gone', to_jsonb(gone_ids),
    -- v3.16's answer, kept for one release: a client that predates v3.19 reads
    -- this one, and the iOS bundle lags the web by a build.
    'peerNotes', coalesce(
      (select jsonb_agg(p3.id) from public.posts p3 where p3.kind = 'note' and p3.user_id <> me),
      '[]'::jsonb
    ),
    -- Every row of SOMEONE ELSE'S, of a kind whose audience is per record, that
    -- this account can see at this instant — whatever the cursor says. A cached
    -- peer row missing from it was withheld (or the household changed), and the
    -- client drops it. It is the only way a reader ever learns: a row they may
    -- no longer select is simply absent from their delta, which is exactly what
    -- "nothing changed" looks like.
    -- `kind` is the stored generated column, so posts_kind_idx serves this.
    'peerShared', coalesce(
      (select jsonb_agg(p4.id) from public.posts p4 where p4.kind in ('note', 'task') and p4.user_id <> me),
      '[]'::jsonb
    )
  );
end;
$$;

-- ------------------------------------------------------------ posts policy
-- The 20261001000000 body, with 'snooze' among the kinds a peer never sees.
drop policy if exists "household access" on public.posts;
create policy "household access" on public.posts
  for all to authenticated
  using (
    user_id = auth.uid()
    or (
      user_id in (select public.household_user_ids())
      and coalesce(data ->> 'kind', 'task') not in ('journal', 'review', 'calendar', 'habit', 'routine', 'garment', 'outfit', 'wear', 'snooze')
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

-- ------------------------------------------------------------ account deletion
-- The 20261001000000 body; `personal` gains 'snooze', so an heir never inherits
-- whose nudges somebody had put off.
create or replace function public.admin_prepare_user_deletion(target uuid, heir uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  personal constant text[] := array['journal', 'review', 'calendar', 'habit', 'routine', 'garment', 'outfit', 'wear', 'snooze'];
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

-- -------------------------------------------------------------- sync_canary
-- The 20260923000000 body; the only change is the synthetic snooze row's fields.
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
      -- a valid status for the two kinds whose status it checks; a note and the
      -- wardrobe's three carry the fields the app always writes
      answer := public.sync_posts(
        jsonb_build_array(
          jsonb_build_object('kind', k, 'id', canary_id, 'createdAt', stamp, 'updatedAt', stamp)
          || case k
               when 'task' then '{"status":"todo","title":"Sync canary"}'::jsonb
               when 'project' then '{"status":"active","name":"Sync canary"}'::jsonb
               when 'note' then '{"title":"Sync canary","body":"<p>Sync canary</p>"}'::jsonb
               when 'garment' then '{"name":"Sync canary","type":"top"}'::jsonb
               when 'outfit' then '{"garmentIds":["canary"]}'::jsonb
               when 'wear' then '{"date":"2026-01-01","garmentIds":["canary"]}'::jsonb
               when 'snooze' then '{"target":"person","targetId":"canary","until":"2026-01-01T00:00:00.000Z"}'::jsonb
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
