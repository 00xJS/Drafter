-- v3.14: the wardrobe — garments, saved outfits and what was worn
-- (kind = 'garment', 'outfit', 'wear').
--
-- A garment is one piece of clothing: a name, a type (top, bottom, onepiece,
-- outerwear, shoes, accessory) and a photo in the media store. An outfit is a
-- saved combination of garment ids. A wear is one look worn on a day, with an
-- id of wear~YYYY-MM-DD~random, as a journal entry's is: posts.id is one key for
-- everybody, and a household peer can neither see nor update another member's
-- personal row, so a day-only id would have the second member's write rejected
-- (and re-pushed forever) the first time both logged the same day.
--
-- All three are PERSONAL, like journal, review, calendar, habit and routine:
-- owner-only at the database, never sent to a household peer's device.
--
-- sync_posts rejects any kind it has not been told about, and the client keeps
-- a refused row dirty and re-pushes it forever ("n unsynced"). Apply this BEFORE
-- the client build that writes these kinds, and redeploy the bot edge function
-- (its own PERSONAL_KINDS copy grew too). The owner approves `supabase db push`,
-- after `supabase migration list --linked` and `supabase db push --dry-run`.
--
-- Below:
--   * sync_posts: the v3.13 body (20260922000000) with the three kinds added to
--     the allowlist, nothing else changed;
--   * the posts and posts_history policies: 20260919000000's text with the three
--     kinds added to the personal list (PERSONAL_KINDS in shared/kinds.mjs;
--     src/__tests__/srv-kinds.test.ts holds them together);
--   * admin_prepare_user_deletion: 20260919010000's body with the same list, so
--     a leaving member's wardrobe is deleted with their journal, never inherited;
--   * sync_canary: the v3.13 body, giving the three synthetic rows the fields
--     the app writes, as it gives a task, a project and a note theirs;
--   * the media bucket's policies (20260908050000). Garment photos are the first
--     personal media: they live under personal/<user id>/, and an object there is
--     its uploader's alone. Note photos and task images stay household-wide. The
--     select policy also stops handing service-written objects with no owner
--     under backups/ (the daily snapshots, which hold journals) to every
--     signed-in account; no client reads them — Admin signs them server-side.

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
           and item_kind in ('task', 'project', 'calendar', 'person', 'place', 'review', 'template', 'recipe', 'meal', 'grocery', 'journal', 'event', 'habit', 'routine', 'note', 'garment', 'outfit', 'wear')
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

-- ------------------------------------------------------ personal-kind policies
-- 20260919000000's text with the three kinds added; nothing else changes.
drop policy if exists "household access" on public.posts;
create policy "household access" on public.posts
  for all to authenticated
  using (
    user_id = auth.uid()
    or (user_id in (select public.household_user_ids()) and coalesce(data ->> 'kind', 'task') not in ('journal', 'review', 'calendar', 'habit', 'routine', 'garment', 'outfit', 'wear'))
  )
  with check (user_id in (select public.household_user_ids()));

drop policy if exists "household history select" on public.posts_history;
create policy "household history select" on public.posts_history
  for select to authenticated
  using (
    user_id = auth.uid()
    or (user_id in (select public.household_user_ids()) and coalesce(data ->> 'kind', 'task') not in ('journal', 'review', 'calendar', 'habit', 'routine', 'garment', 'outfit', 'wear'))
  );

-- ------------------------------------------------------------ account deletion
-- 20260919010000's body; the personal list gains the wardrobe, so an heir never
-- inherits someone's clothes and what they wore, any more than their diary.
create or replace function public.admin_prepare_user_deletion(target uuid, heir uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  personal constant text[] := array['journal', 'review', 'calendar', 'habit', 'routine', 'garment', 'outfit', 'wear'];
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

-- -------------------------------------------------------------- sync_canary
-- The 20260922000000 body; the only change is three more synthetic rows' fields.
-- The hourly digest passes every kind in SYNC_KINDS, so the wardrobe is checked
-- from the first run after the client's list grows.
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

-- ---------------------------------------------------------------- media bucket
-- 20260908050000 scoped every object to the household, because note photos and
-- task images are shared. Garment photos are personal like the garment: stored
-- under personal/<user id>/, readable, replaceable and deletable by their
-- uploader alone, and nobody may write into another account's folder. Objects
-- written with the service key have no owner; the owner-null branch no longer
-- reaches personal/ or the backups/ snapshots.
drop policy if exists "household media select" on storage.objects;
create policy "household media select" on storage.objects for select to authenticated
  using (
    bucket_id = 'media'
    and (
      owner = auth.uid()
      or (owner in (select public.household_user_ids()) and name not like 'personal/%')
      or (owner is null and name not like 'personal/%' and name not like 'backups/%')
    )
  );

drop policy if exists "household media insert" on storage.objects;
create policy "household media insert" on storage.objects for insert to authenticated
  with check (
    bucket_id = 'media'
    and (name not like 'personal/%' or name like ('personal/' || auth.uid()::text || '/%'))
  );

drop policy if exists "household media update" on storage.objects;
create policy "household media update" on storage.objects for update to authenticated
  using (
    bucket_id = 'media'
    and (owner = auth.uid() or (owner in (select public.household_user_ids()) and name not like 'personal/%'))
  )
  with check (
    bucket_id = 'media'
    and (name not like 'personal/%' or name like ('personal/' || auth.uid()::text || '/%'))
  );

drop policy if exists "household media delete" on storage.objects;
create policy "household media delete" on storage.objects for delete to authenticated
  using (
    bucket_id = 'media'
    and (owner = auth.uid() or (owner in (select public.household_user_ids()) and name not like 'personal/%'))
  );
