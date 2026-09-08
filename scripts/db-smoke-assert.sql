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
  if (select count(*) from public.posts_history where id = 't1') <> 1 then
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
  if (select count(*) from public.posts_history where id = 't1') <> 1 then
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
