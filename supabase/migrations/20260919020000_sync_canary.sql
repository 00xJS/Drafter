-- Sync canary: the database proves, on demand, that sync_posts still stores
-- every kind the app writes.
--
-- In September production rejected every write for days and nothing said so:
-- a PL/pgSQL variable named `id` made `on conflict (id)` ambiguous, the
-- per-item exception handler turned that into a `rejected` id, `db push`
-- looked green, and the client quietly dropped the ids. The hourly digest now
-- calls this with every kind (SYNC_KINDS in shared/kinds.mjs), keeps the answer
-- for Admin → Data, and tells the owner when a kind fails.
--
-- For each kind: one minimal synthetic row goes through the real sync_posts,
-- the answer is checked (not rejected, and actually stored), and then a private
-- exception rolls the sub-block back — nothing persists, not in posts and not in
-- posts_history. Any other exception is a failure carrying its message.
--
-- It runs as the caller, and only the service role may call it, so it
-- exercises exactly the path the digest, the inbound webhook and the MCP server
-- write through (auth.uid() is null, rows land as owner_user_id()).

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
      -- a valid status for the two kinds whose status it checks
      answer := public.sync_posts(
        jsonb_build_array(
          jsonb_build_object('kind', k, 'id', canary_id, 'createdAt', stamp, 'updatedAt', stamp)
          || case k
               when 'task' then '{"status":"todo","title":"Sync canary"}'::jsonb
               when 'project' then '{"status":"active","name":"Sync canary"}'::jsonb
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
