-- Exercises the schema the way the app, the MCP server and the digest do.
-- Every block raises on failure, so psql -v ON_ERROR_STOP=1 turns any
-- regression into a non-zero exit. Runs after every migration has applied.
--
-- Cast of characters: owner A and peer B share a household; C is nobody.

-- ------------------------------------------------------------------ seed
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000000a', 'owner@example.test'),
  ('00000000-0000-0000-0000-00000000000b', 'peer@example.test'),
  ('00000000-0000-0000-0000-00000000000c', 'stranger@example.test');
insert into public.app_config (key, value) values ('owner_email', 'owner@example.test');
insert into public.households (id, name, created_by) values ('00000000-0000-0000-0000-0000000000f0', 'Home', '00000000-0000-0000-0000-00000000000a');
insert into public.household_members (household_id, user_id, role) values
  ('00000000-0000-0000-0000-0000000000f0', '00000000-0000-0000-0000-00000000000a', 'owner'),
  ('00000000-0000-0000-0000-0000000000f0', '00000000-0000-0000-0000-00000000000b', 'member');

-- ------------------------------------------------- 1. every kind is accepted
-- This is the test that would have caught the `id` variable making
-- `on conflict (id)` ambiguous: with that bug every item lands in rejected.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated","email":"owner@example.test"}', true);
do $$
declare r jsonb;
begin
  r := public.sync_posts('[
    {"kind":"task","id":"t1","title":"Call the electrician","description":"","status":"todo","priority":"high","tags":[],"createdAt":"2026-09-08T09:00:00.000Z","updatedAt":"2026-09-08T09:00:00.000Z"},
    {"kind":"project","id":"p1","name":"Kitchen","color":"#f97316","status":"active","createdAt":"2026-09-08T09:00:00.000Z","updatedAt":"2026-09-08T09:00:00.000Z"},
    {"kind":"person","id":"mum","name":"Mum","color":"#f472b6","group":"family","createdAt":"2026-09-08T09:00:00.000Z","updatedAt":"2026-09-08T09:00:00.000Z"},
    {"kind":"place","id":"nopi","name":"Nopi","color":"#22d3ee","category":"restaurant","createdAt":"2026-09-08T09:00:00.000Z","updatedAt":"2026-09-08T09:00:00.000Z"},
    {"kind":"recipe","id":"pasta","name":"Pasta","ingredients":[],"tags":[],"createdAt":"2026-09-08T09:00:00.000Z","updatedAt":"2026-09-08T09:00:00.000Z"},
    {"kind":"meal","id":"meal~2026-09-08~dinner","date":"2026-09-08","slot":"dinner","title":"Pasta","createdAt":"2026-09-08T09:00:00.000Z","updatedAt":"2026-09-08T09:00:00.000Z"},
    {"kind":"grocery","id":"grocery~2026-W37","weekKey":"2026-W37","items":[],"createdAt":"2026-09-08T09:00:00.000Z","updatedAt":"2026-09-08T09:00:00.000Z"},
    {"kind":"journal","id":"journal~2026-09-08~a1","date":"2026-09-08","body":"Quiet day","mood":4,"createdAt":"2026-09-08T09:00:00.000Z","updatedAt":"2026-09-08T09:00:00.000Z"},
    {"kind":"review","id":"rev1","period":"week","key":"2026-W36","top":["Sleep"],"createdAt":"2026-09-08T09:00:00.000Z","updatedAt":"2026-09-08T09:00:00.000Z"},
    {"kind":"template","id":"tpl1","name":"Trip","color":"#888","tasks":[],"createdAt":"2026-09-08T09:00:00.000Z","updatedAt":"2026-09-08T09:00:00.000Z"},
    {"kind":"calendar","id":"cal1","name":"iCloud","url":"https://example.test/secret.ics","color":"#888","enabled":true,"createdAt":"2026-09-08T09:00:00.000Z","updatedAt":"2026-09-08T09:00:00.000Z"}
  ]'::jsonb, null);
  if jsonb_array_length(r -> 'rejected') <> 0 then
    raise exception 'FAIL 1: sync_posts rejected valid records: %', r -> 'rejected';
  end if;
  if (select count(*) from public.posts) <> 11 then
    raise exception 'FAIL 1: expected 11 stored rows, found %', (select count(*) from public.posts);
  end if;
  if (select count(*) from public.posts where user_id <> '00000000-0000-0000-0000-00000000000a') <> 0 then
    raise exception 'FAIL 1: rows stored under the wrong owner';
  end if;
  if jsonb_array_length(r -> 'items') <> 11 then
    raise exception 'FAIL 1: a full exchange should echo all 11 rows, got %', jsonb_array_length(r -> 'items');
  end if;
  raise notice 'ok 1: every kind stored and echoed';
end $$;
commit;

-- ------------------------------------------ 2. unknown kinds are rejected
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated","email":"owner@example.test"}', true);
do $$
declare r jsonb;
begin
  r := public.sync_posts('[{"kind":"widget","id":"w1","updatedAt":"2026-09-08T09:00:00.000Z"},{"kind":"task","id":"t-bad-status","status":"zombie","updatedAt":"2026-09-08T09:00:00.000Z"}]'::jsonb, '2099-01-01');
  if not (r -> 'rejected') @> '["w1","t-bad-status"]'::jsonb then
    raise exception 'FAIL 2: unknown kind / status should be rejected, got %', r -> 'rejected';
  end if;
  raise notice 'ok 2: unknown kind and invalid status rejected';
end $$;
commit;

-- ------------------------- 3. a household peer sees shared kinds, not personal
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000b","role":"authenticated","email":"peer@example.test"}', true);
do $$
declare r jsonb; ids text[];
begin
  r := public.sync_posts('[]'::jsonb, null);
  select array_agg(x ->> 'id' order by x ->> 'id') into ids from jsonb_array_elements(r -> 'items') x;
  if not (ids @> array['t1','p1','mum','nopi','pasta','meal~2026-09-08~dinner','grocery~2026-W37','tpl1']) then
    raise exception 'FAIL 3: peer should see the shared kinds, saw %', ids;
  end if;
  if ids && array['journal~2026-09-08~a1','rev1','cal1'] then
    raise exception 'FAIL 3: peer must not see the owner''s journal, review or calendar, saw %', ids;
  end if;
  if (select count(*) from public.posts where id in ('journal~2026-09-08~a1','rev1','cal1')) <> 0 then
    raise exception 'FAIL 3: direct select leaks a personal row to the peer';
  end if;
  raise notice 'ok 3: peer sees % shared rows and no personal ones', array_length(ids, 1);
end $$;
commit;

-- ----------------- 4. a peer cannot write into the owner's journal; own rows fine
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000b","role":"authenticated","email":"peer@example.test"}', true);
do $$
declare r jsonb;
begin
  r := public.sync_posts('[
    {"kind":"journal","id":"journal~2026-09-08~a1","date":"2026-09-08","body":"overwritten by peer","createdAt":"2026-09-08T09:00:00.000Z","updatedAt":"2026-09-08T12:00:00.000Z"},
    {"kind":"task","id":"t2","title":"Peer chore","description":"","status":"todo","priority":"normal","tags":[],"createdAt":"2026-09-08T09:00:00.000Z","updatedAt":"2026-09-08T09:00:00.000Z"}
  ]'::jsonb, '2099-01-01');
  if not (r -> 'rejected') @> '["journal~2026-09-08~a1"]'::jsonb then
    raise exception 'FAIL 4: the peer''s write onto the owner''s journal should be rejected, got %', r -> 'rejected';
  end if;
  if (r -> 'rejected') @> '["t2"]'::jsonb then
    raise exception 'FAIL 4: the peer''s own task in the same batch must still store';
  end if;
  raise notice 'ok 4: peer upsert onto a personal row rejected, own row stored';
end $$;
commit;
do $$
begin
  if (select data ->> 'body' from public.posts where id = 'journal~2026-09-08~a1') <> 'Quiet day' then
    raise exception 'FAIL 4: the owner''s journal body was changed by a peer';
  end if;
  if (select user_id from public.posts where id = 't2') <> '00000000-0000-0000-0000-00000000000b' then
    raise exception 'FAIL 4: t2 should belong to the peer';
  end if;
end $$;

-- -------------------------- 5. a stranger sees nothing and stores nothing here
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000c","role":"authenticated","email":"stranger@example.test"}', true);
do $$
declare r jsonb;
begin
  r := public.sync_posts('[]'::jsonb, null);
  if jsonb_array_length(r -> 'items') <> 0 then
    raise exception 'FAIL 5: a user outside the household sees % rows', jsonb_array_length(r -> 'items');
  end if;
  raise notice 'ok 5: stranger sees nothing';
end $$;
commit;

-- ------------------- 6. the service role (digest, MCP) writes as the owner
begin;
set local role service_role;
do $$
declare r jsonb;
begin
  r := public.sync_posts('[{"kind":"task","id":"t3","title":"From an agent","description":"","status":"todo","priority":"normal","tags":[],"createdAt":"2026-09-08T09:00:00.000Z","updatedAt":"2026-09-08T09:00:00.000Z"}]'::jsonb, '2099-01-01');
  if jsonb_array_length(r -> 'rejected') <> 0 then
    raise exception 'FAIL 6: service-role write rejected: %', r -> 'rejected';
  end if;
  if (select user_id from public.posts where id = 't3') <> public.owner_user_id() then
    raise exception 'FAIL 6: a service-role write should belong to the owner';
  end if;
  raise notice 'ok 6: service role writes as the owner';
end $$;
commit;

-- ------------------------------------------ 7. last write wins, stale skipped
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated","email":"owner@example.test"}', true);
do $$
declare r jsonb;
begin
  r := public.sync_posts('[{"kind":"task","id":"t1","title":"STALE","description":"","status":"todo","priority":"high","tags":[],"createdAt":"2026-09-08T09:00:00.000Z","updatedAt":"2026-09-08T08:00:00.000Z"}]'::jsonb, '2099-01-01');
  if (select data ->> 'title' from public.posts where id = 't1') <> 'Call the electrician' then
    raise exception 'FAIL 7: an older stamp must not overwrite a newer row';
  end if;
  r := public.sync_posts('[{"kind":"task","id":"t1","title":"Call the electrician (renamed)","description":"","status":"todo","priority":"high","tags":[],"createdAt":"2026-09-08T09:00:00.000Z","updatedAt":"2026-09-08T10:00:00.000Z"}]'::jsonb, '2099-01-01');
  if (select data ->> 'title' from public.posts where id = 't1') <> 'Call the electrician (renamed)' then
    raise exception 'FAIL 7: a newer stamp must win';
  end if;
  if jsonb_array_length(r -> 'rejected') <> 0 then
    raise exception 'FAIL 7: newer write reported rejected';
  end if;
  raise notice 'ok 7: last write wins';
end $$;
commit;

-- ------------------------------ 8. history is kept, and stays personal too
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated","email":"owner@example.test"}', true);
do $$
declare r jsonb;
begin
  r := public.sync_posts('[{"kind":"journal","id":"journal~2026-09-08~a1","date":"2026-09-08","body":"Quiet day, then a walk","mood":4,"createdAt":"2026-09-08T09:00:00.000Z","updatedAt":"2026-09-08T21:00:00.000Z"}]'::jsonb, '2099-01-01');
  if (select count(*) from public.posts_history where id = 'journal~2026-09-08~a1') <> 1 then
    raise exception 'FAIL 8: a content change should leave one history row';
  end if;
  -- overwritten versions only: since v3.11 step 7's older push is kept too, as 'lost'
  if (select count(*) from public.posts_history where id = 't1' and reason is null) <> 1 then
    raise exception 'FAIL 8: the task rename in step 7 should have one history row';
  end if;
  raise notice 'ok 8: history captured';
end $$;
commit;
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000b","role":"authenticated","email":"peer@example.test"}', true);
do $$
begin
  if (select count(*) from public.posts_history where id = 'journal~2026-09-08~a1') <> 0 then
    raise exception 'FAIL 8: a peer can read the owner''s journal history';
  end if;
  if (select count(*) from public.posts_history where id = 't1' and reason is null) <> 1 then
    raise exception 'FAIL 8: a peer should still see shared history';
  end if;
  raise notice 'ok 8: history follows the same scope';
end $$;
commit;

-- ------------------ 9. a content-free purge tombstone is accepted and marked deleted
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated","email":"owner@example.test"}', true);
do $$
declare r jsonb;
begin
  r := public.sync_posts('[{"kind":"person","id":"mum","name":"","deletedAt":"2026-09-08T22:00:00.000Z","purged":true,"createdAt":"2026-09-08T22:00:00.000Z","updatedAt":"2026-09-08T22:00:00.000Z"}]'::jsonb, '2099-01-01');
  if jsonb_array_length(r -> 'rejected') <> 0 then
    raise exception 'FAIL 9: purge tombstone rejected: %', r -> 'rejected';
  end if;
  if (select deleted from public.posts where id = 'mum') is not true then
    raise exception 'FAIL 9: tombstone not marked deleted';
  end if;
  raise notice 'ok 9: purge tombstone accepted';
end $$;
commit;

-- ------------------------------------------ 10. the digest opt-in column exists
do $$
begin
  if (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'user_settings' and column_name = 'digest_journal') <> 1 then
    raise exception 'FAIL 10: user_settings.digest_journal missing';
  end if;
  raise notice 'ok 10: user_settings.digest_journal present';
end $$;

-- ------- 11. every user_settings column the Netlify functions write must exist
-- The digest PATCHes these in one body. A column that does not exist makes
-- PostgREST reject the WHOLE body, so a missing `nudged` silently took
-- last_digest_day and last_due_check down with it and the morning digest
-- re-sent on every hourly run. Keep this list in step with digest.mjs.
do $$
declare missing text;
begin
  select string_agg(c, ', ' order by c) into missing
  from unnest(array['nudged', 'last_digest_day', 'last_due_check', 'push_subscriptions',
                    'digest_email', 'digest_hour', 'digest_journal', 'timezone']) as c
  where not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'user_settings' and column_name = c
  );
  if missing is not null then
    raise exception 'FAIL 11: user_settings missing column(s) the digest writes: %', missing;
  end if;
  raise notice 'ok 11: every user_settings column the digest writes exists';
end $$;

-- ------------- 12. an `event` row round-trips and stays household-visible
-- Events are the one calendar kind you write yourself. Unlike `calendar`
-- (a subscription carrying a feed token) they are NOT owner-only: a block of
-- time on a family calendar is meant to be seen.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated","email":"owner@example.test"}', true);
do $$
declare r jsonb;
begin
  r := public.sync_posts('[{"kind":"event","id":"ev1","title":"Dentist","start":"2026-09-20T14:00:00.000Z","end":"2026-09-20T15:00:00.000Z","allDay":false,"createdAt":"2026-09-09T10:00:00.000Z","updatedAt":"2026-09-09T10:00:00.000Z"}]'::jsonb, '2099-01-01');
  if jsonb_array_length(r -> 'rejected') <> 0 then
    raise exception 'FAIL 12: an event was rejected: %', r -> 'rejected';
  end if;
  if (select data ->> 'title' from public.posts where id = 'ev1') <> 'Dentist' then
    raise exception 'FAIL 12: the event did not round-trip';
  end if;
  raise notice 'ok 12: an event row is accepted and stored';
end $$;
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000b","role":"authenticated","email":"peer@example.test"}', true);
do $$
begin
  if (select count(*) from public.posts where id = 'ev1') <> 1 then
    raise exception 'FAIL 12: a household peer should see an event (only journal/review/calendar are private)';
  end if;
  raise notice 'ok 12: a household peer sees the event';
end $$;
commit;

-- ===== v3.11 (level-up 1B-S) =====
-- sync_posts answers { items, rejected, stale, gone }. A push that loses to the
-- stored row comes back in `stale`, its winner is echoed whatever the cursor,
-- and the loser is kept in posts_history as 'lost'. A purged id comes back in
-- `gone` and is never stored again. The ids are this section's own, so nothing
-- leans on the sections above.

-- -------------------- v3.11 seed: committed first, so a later cursor passes it
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated","email":"owner@example.test"}', true);
do $$
declare r jsonb;
begin
  r := public.sync_posts('[
    {"kind":"task","id":"lu-t1","title":"Paint the fence","description":"","status":"todo","priority":"normal","tags":[],"createdAt":"2026-09-10T10:00:00.000Z","updatedAt":"2026-09-10T10:00:00.000Z"},
    {"kind":"journal","id":"journal~2026-09-10~lu","date":"2026-09-10","body":"Fence day","createdAt":"2026-09-10T10:00:00.000Z","updatedAt":"2026-09-10T10:00:00.000Z"}
  ]'::jsonb, '2099-01-01');
  if jsonb_array_length(r -> 'rejected') <> 0
     or (r -> 'stale') is distinct from '[]'::jsonb or (r -> 'gone') is distinct from '[]'::jsonb then
    raise exception 'FAIL v3.11 seed: a clean push should answer rejected, stale and gone all empty, got %', r - 'items';
  end if;
end $$;
commit;

-- ------ v3.11-1. an older push is stale: the stored row stays, is echoed, the loser is filed
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated","email":"owner@example.test"}', true);
do $$
declare
  r jsonb;
  n int;
  older jsonb := '[{"kind":"task","id":"lu-t1","title":"Paint the fence blue","description":"","status":"todo","priority":"normal","tags":[],"createdAt":"2026-09-10T10:00:00.000Z","updatedAt":"2026-09-10T09:00:00.000Z"}]';
begin
  -- the point of since = now(): without the stale echo this row would not come back
  if (select synced_at from public.posts where id = 'lu-t1') >= now() then
    raise exception 'FAIL v3.11-1: setup — the stored row must be older than the cursor';
  end if;
  r := public.sync_posts(older, now());
  if (r -> 'stale') is distinct from '["lu-t1"]'::jsonb or jsonb_array_length(r -> 'rejected') <> 0 then
    raise exception 'FAIL v3.11-1: an older push should be stale, not rejected, got %', r - 'items';
  end if;
  if (select data ->> 'title' from public.posts where id = 'lu-t1') is distinct from 'Paint the fence' then
    raise exception 'FAIL v3.11-1: the older push changed the stored row';
  end if;
  select count(*) into n from jsonb_array_elements(r -> 'items') x where x ->> 'id' = 'lu-t1' and x ->> 'title' = 'Paint the fence';
  if n <> 1 or jsonb_array_length(r -> 'items') <> 1 then
    raise exception 'FAIL v3.11-1: with since = now() items should be exactly the stored winner, got %', r -> 'items';
  end if;
  if (select count(*) from public.posts_history
       where id = 'lu-t1' and reason = 'lost' and data ->> 'title' = 'Paint the fence blue'
         and updated_at = '2026-09-10T09:00:00.000Z' and user_id = '00000000-0000-0000-0000-00000000000a') <> 1 then
    raise exception 'FAIL v3.11-1: the owner should see the losing version as one posts_history row with reason lost';
  end if;
  -- a full exchange lists the winner once, and the same loser pushed again is not filed twice
  r := public.sync_posts(older, null);
  select count(*) into n from jsonb_array_elements(r -> 'items') x where x ->> 'id' = 'lu-t1';
  if n <> 1 or (r -> 'stale') is distinct from '["lu-t1"]'::jsonb then
    raise exception 'FAIL v3.11-1: a full exchange should list lu-t1 once in items and in stale, got % copies', n;
  end if;
  if (select count(*) from public.posts_history where id = 'lu-t1' and reason = 'lost') <> 1 then
    raise exception 'FAIL v3.11-1: the same loser pushed twice should be filed once';
  end if;
  -- a personal kind loses the same way; its scope is checked below
  r := public.sync_posts('[{"kind":"journal","id":"journal~2026-09-10~lu","date":"2026-09-10","body":"Fence day, draft","createdAt":"2026-09-10T10:00:00.000Z","updatedAt":"2026-09-10T09:30:00.000Z"}]'::jsonb, '2099-01-01');
  if (r -> 'stale') is distinct from '["journal~2026-09-10~lu"]'::jsonb
     or (select count(*) from public.posts_history where id = 'journal~2026-09-10~lu' and reason = 'lost') <> 1 then
    raise exception 'FAIL v3.11-1: an older journal push should be stale and filed for the owner, got %', r - 'items';
  end if;
  raise notice 'ok v3.11-1: an older push is stale; the stored row is unchanged, echoed once past the cursor, the loser kept as lost';
end $$;
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000b","role":"authenticated","email":"peer@example.test"}', true);
do $$
begin
  if (select count(*) from public.posts_history where id = 'lu-t1' and reason = 'lost') <> 1 then
    raise exception 'FAIL v3.11-1: a household peer should see a shared task''s lost version, like its other history';
  end if;
  if (select count(*) from public.posts_history where id = 'journal~2026-09-10~lu') <> 0 then
    raise exception 'FAIL v3.11-1: a peer can read the owner''s lost journal line';
  end if;
end $$;
commit;
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000c","role":"authenticated","email":"stranger@example.test"}', true);
do $$
begin
  if (select count(*) from public.posts_history where id in ('lu-t1', 'journal~2026-09-10~lu')) <> 0 then
    raise exception 'FAIL v3.11-1: a stranger can read lost versions';
  end if;
  raise notice 'ok v3.11-1: lost versions follow the history policy (household for a task, owner only for a journal, never a stranger)';
end $$;
commit;

-- -------- v3.11-2. a newer push wins and is not stale; the stored version again is a no-op
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated","email":"owner@example.test"}', true);
do $$
declare
  r jsonb;
  newer jsonb := '[{"kind":"task","id":"lu-t1","title":"Paint the fence green","description":"","status":"todo","priority":"normal","tags":[],"createdAt":"2026-09-10T10:00:00.000Z","updatedAt":"2026-09-10T11:00:00.000Z"}]';
begin
  r := public.sync_posts(newer, '2099-01-01');
  if (r -> 'stale') is distinct from '[]'::jsonb or jsonb_array_length(r -> 'rejected') <> 0 then
    raise exception 'FAIL v3.11-2: a newer push should be accepted and not stale, got %', r - 'items';
  end if;
  if (select data ->> 'title' from public.posts where id = 'lu-t1') is distinct from 'Paint the fence green' then
    raise exception 'FAIL v3.11-2: a newer push must win';
  end if;
  if (select count(*) from public.posts_history where id = 'lu-t1' and reason is null and data ->> 'title' = 'Paint the fence') <> 1 then
    raise exception 'FAIL v3.11-2: the overwritten version should be kept as before, with no reason';
  end if;
  -- exactly what is stored: a retry after a lost response, or a full resync
  r := public.sync_posts(newer, '2099-01-01');
  if (r -> 'stale') is distinct from '[]'::jsonb or jsonb_array_length(r -> 'rejected') <> 0 then
    raise exception 'FAIL v3.11-2: re-pushing the stored version is not a conflict, got %', r - 'items';
  end if;
  if (select count(*) from public.posts_history where id = 'lu-t1') <> 2 then
    raise exception 'FAIL v3.11-2: re-pushing the stored version should file nothing';
  end if;
  raise notice 'ok v3.11-2: a newer push wins and is not stale; re-pushing the stored version is a no-op';
end $$;
commit;

-- ----- v3.11-3. a stale push onto a row the caller cannot see is rejected, not stale
-- Its winner could not be echoed, and the same push with a newer stamp is rejected already.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000c","role":"authenticated","email":"stranger@example.test"}', true);
do $$
declare r jsonb;
begin
  r := public.sync_posts('[{"kind":"task","id":"lu-t1","title":"Not yours","description":"","status":"todo","priority":"normal","tags":[],"createdAt":"2026-09-10T10:00:00.000Z","updatedAt":"2026-09-10T08:00:00.000Z"}]'::jsonb, '2099-01-01');
  if (r -> 'rejected') is distinct from '["lu-t1"]'::jsonb or (r -> 'stale') is distinct from '[]'::jsonb
     or (r -> 'items') is distinct from '[]'::jsonb then
    raise exception 'FAIL v3.11-3: a stranger''s older push should be rejected and echo nothing, got %', r;
  end if;
end $$;
commit;
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000b","role":"authenticated","email":"peer@example.test"}', true);
do $$
declare r jsonb;
begin
  r := public.sync_posts('[{"kind":"journal","id":"journal~2026-09-10~lu","date":"2026-09-10","body":"peer was here","createdAt":"2026-09-10T10:00:00.000Z","updatedAt":"2026-09-10T08:00:00.000Z"}]'::jsonb, '2099-01-01');
  if (r -> 'rejected') is distinct from '["journal~2026-09-10~lu"]'::jsonb or (r -> 'items') is distinct from '[]'::jsonb then
    raise exception 'FAIL v3.11-3: a peer''s older push onto the owner''s journal should be rejected and echo nothing, got %', r;
  end if;
end $$;
commit;
do $$
begin
  if exists (select 1 from public.posts_history
              where id in ('lu-t1', 'journal~2026-09-10~lu') and reason = 'lost'
                and user_id <> '00000000-0000-0000-0000-00000000000a') then
    raise exception 'FAIL v3.11-3: a rejected push must not be filed as lost';
  end if;
  if (select data ->> 'body' from public.posts where id = 'journal~2026-09-10~lu') is distinct from 'Fence day' then
    raise exception 'FAIL v3.11-3: the owner''s journal changed';
  end if;
  raise notice 'ok v3.11-3: a stale push onto a row the caller cannot see is rejected and files nothing';
end $$;

-- ------------ v3.11-4. calling the loss helper directly files only under the caller
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000c","role":"authenticated","email":"stranger@example.test"}', true);
select public.posts_history_record_loss('lu-t1', '{"kind":"task","id":"lu-t1","title":"Forged","updatedAt":"2026-09-01T00:00:00.000Z"}'::jsonb);
commit;
do $$
begin
  if exists (select 1 from public.posts_history where data ->> 'title' = 'Forged' and user_id <> '00000000-0000-0000-0000-00000000000c') then
    raise exception 'FAIL v3.11-4: a direct call filed a version under someone else''s name';
  end if;
end $$;
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated","email":"owner@example.test"}', true);
do $$
begin
  if exists (select 1 from public.posts_history where data ->> 'title' = 'Forged') then
    raise exception 'FAIL v3.11-4: a stranger''s direct call reached the owner''s history';
  end if;
  raise notice 'ok v3.11-4: the loss helper files only under the caller, out of the owner''s sight';
end $$;
commit;

-- ------- v3.11-5. a purged id stays purged; a record born after the purge may reuse it
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated","email":"owner@example.test"}', true);
do $$
declare r jsonb;
begin
  r := public.sync_posts('[
    {"kind":"person","id":"lu-gone","name":"","deletedAt":"2025-01-01T00:00:00.000Z","purged":true,"createdAt":"2025-01-01T00:00:00.000Z","updatedAt":"2025-01-01T00:00:00.000Z"},
    {"kind":"meal","id":"meal~2025-01-05~dinner","title":"","date":"","slot":"dinner","deletedAt":"2025-01-01T00:00:00.000Z","purged":true,"createdAt":"2025-01-01T00:00:00.000Z","updatedAt":"2025-01-01T00:00:00.000Z"},
    {"kind":"person","id":"lu-trash","name":"Old friend","deletedAt":"2025-01-01T00:00:00.000Z","createdAt":"2024-06-01T00:00:00.000Z","updatedAt":"2025-01-01T00:00:00.000Z"}
  ]'::jsonb, '2099-01-01');
  if jsonb_array_length(r -> 'rejected') <> 0 then
    raise exception 'FAIL v3.11-5: tombstones rejected: %', r -> 'rejected';
  end if;
end $$;
commit;
-- the digest's delete (and lib/backup.mjs's), as the service role, limited to this section's ids
begin;
set local role service_role;
delete from public.posts
 where deleted and updated_at < now() - interval '90 days' and data ->> 'purged' = 'true'
   and id in ('lu-gone', 'meal~2025-01-05~dinner');
-- deleting anything that is not a purged tombstone is not a purge
delete from public.posts where id = 'lu-trash';
commit;
do $$
begin
  if (select count(*) from public.purged_ids where id in ('lu-gone', 'meal~2025-01-05~dinner')) <> 2 then
    raise exception 'FAIL v3.11-5: hard-deleting a purged tombstone should ledger its id';
  end if;
  if exists (select 1 from public.purged_ids where id = 'lu-trash') then
    raise exception 'FAIL v3.11-5: only purged tombstones belong in the ledger';
  end if;
end $$;
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated","email":"owner@example.test"}', true);
do $$
declare
  r jsonb;
  born text := to_char((clock_timestamp() + interval '1 second') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
begin
  if (select count(*) from public.purged_ids) <> 0 then
    raise exception 'FAIL v3.11-5: purged_ids must not be readable by a client';
  end if;
  -- a device offline past the TTL pushes its live copies back, edited since the tombstone
  r := public.sync_posts('[
    {"kind":"person","id":"lu-gone","name":"Back again","color":"#888","group":"friends","createdAt":"2024-12-01T00:00:00.000Z","updatedAt":"2025-06-01T00:00:00.000Z"},
    {"kind":"meal","id":"meal~2025-01-05~dinner","date":"2025-01-05","slot":"dinner","title":"Old pasta","updatedAt":"2025-06-01T00:00:00.000Z"}
  ]'::jsonb, '2099-01-01');
  if (r -> 'gone') is distinct from '["lu-gone", "meal~2025-01-05~dinner"]'::jsonb
     or jsonb_array_length(r -> 'rejected') <> 0 or (r -> 'stale') is distinct from '[]'::jsonb then
    raise exception 'FAIL v3.11-5: purged ids should come back in gone and nowhere else, got %', r - 'items';
  end if;
  if exists (select 1 from public.posts where id in ('lu-gone', 'meal~2025-01-05~dinner')) then
    raise exception 'FAIL v3.11-5: a purged id was stored again';
  end if;
  -- planning that dinner again is a new record, created after the purge: it stores
  r := public.sync_posts(jsonb_build_array(jsonb_build_object(
         'kind', 'meal', 'id', 'meal~2025-01-05~dinner', 'date', '2025-01-05', 'slot', 'dinner',
         'title', 'New pasta', 'createdAt', born, 'updatedAt', born)), '2099-01-01');
  if (r -> 'gone') is distinct from '[]'::jsonb or jsonb_array_length(r -> 'rejected') <> 0
     or (select data ->> 'title' from public.posts where id = 'meal~2025-01-05~dinner') is distinct from 'New pasta' then
    raise exception 'FAIL v3.11-5: a record created after its id was purged should store, got %', r - 'items';
  end if;
  -- with the id stored again, the offline copy is an ordinary older push
  r := public.sync_posts('[{"kind":"meal","id":"meal~2025-01-05~dinner","date":"2025-01-05","slot":"dinner","title":"Old pasta","updatedAt":"2025-06-01T00:00:00.000Z"}]'::jsonb, '2099-01-01');
  if (r -> 'stale') is distinct from '["meal~2025-01-05~dinner"]'::jsonb or (r -> 'gone') is distinct from '[]'::jsonb then
    raise exception 'FAIL v3.11-5: once stored again, an older copy is stale, not gone, got %', r - 'items';
  end if;
  raise notice 'ok v3.11-5: a purged id is ledgered and comes back in gone, never stored; a record created after the purge stores';
end $$;
commit;
do $$
begin
  if exists (select 1 from public.posts where id = 'lu-gone') then
    raise exception 'FAIL v3.11-5: lu-gone came back';
  end if;
end $$;

-- ------------------- v3.11-6. sync_posts and its helpers keep the RPC's grants
do $$
declare f text;
begin
  foreach f in array array['public.sync_posts(jsonb, timestamptz)', 'public.purged_among(text[])', 'public.posts_history_record_loss(text, jsonb)'] loop
    if has_function_privilege('anon', f, 'execute') then
      raise exception 'FAIL v3.11-6: anon can execute %', f;
    end if;
    if not (has_function_privilege('authenticated', f, 'execute') and has_function_privilege('service_role', f, 'execute')) then
      raise exception 'FAIL v3.11-6: authenticated and service_role must be able to execute %', f;
    end if;
  end loop;
  raise notice 'ok v3.11-6: sync_posts and its helpers run for authenticated and service_role, not anon';
end $$;
