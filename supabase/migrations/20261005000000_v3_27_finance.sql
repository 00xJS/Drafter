-- v3.27: Bills becomes Finance — paydays, and accounts you keep a balance for.
--
-- Two changes, one of which needs nothing here at all.
--
-- A PAYDAY is a bill with the sign the other way round: `bill.kind = 'income'`
-- on an ordinary task. That is exactly the shape of one — a payer, an amount,
-- a repeat and a date — and keeping it a task puts it on the calendar, in the
-- reminders and on Today with no second machinery. It is a field inside `data`,
-- so the database has nothing to learn.
--
-- An ACCOUNT does need a kind: a name, a type, and the balances that have been
-- typed in for it over time. The household's, like a bill — two people who
-- share the rent share the picture — so it is NOT personal.
--
-- Drafter does not connect to a bank and never will. An account here holds
-- what somebody typed in, and every figure built on it is arithmetic over that
-- and over the bills and paydays already written down.
--
-- sync_posts rejects any kind it has not been told about, and the client keeps
-- a refused row dirty and re-pushes it forever ("n unsynced"). Apply this
-- BEFORE the client build that writes accounts. The owner approves
-- `supabase db push`, after `supabase migration list --linked` and
-- `supabase db push --dry-run`.
--
-- Below: sync_posts (the v3.26 body with 'account' added) and sync_canary (the
-- same, with the synthetic account's fields). The posts policy and account
-- deletion do NOT change: an account is household-readable like a bill, and an
-- heir inherits it for the same reason they inherit the rent.

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
           and item_kind in ('task', 'project', 'calendar', 'person', 'place', 'review', 'template', 'recipe', 'meal', 'grocery', 'journal', 'event', 'habit', 'routine', 'note', 'garment', 'outfit', 'wear', 'snooze', 'message', 'chat', 'account')
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

-- -------------------------------------------------------------- sync_canary
-- The 20261004000000 body; the only change is the synthetic account's fields.
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
               when 'message' then '{"body":"Sync canary"}'::jsonb
               when 'chat' then '{"role":"you","text":"Sync canary"}'::jsonb
               when 'account' then '{"name":"Sync canary","type":"checking","balances":[]}'::jsonb
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
