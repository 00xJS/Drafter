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
  -- grocery is here and meal is not: a week's shopping list is shared (one row
  -- per member, but everyone reads them), while a meal plan is the member's own
  -- since v3.15 — the ids carried no owner, so two people planning the same
  -- slot wrote the same row and one plan replaced the other
  if not (ids @> array['t1','p1','mum','nopi','pasta','grocery~2026-W37','tpl1']) then
    raise exception 'FAIL 3: peer should see the shared kinds, saw %', ids;
  end if;
  if ids && array['journal~2026-09-08~a1','rev1','cal1','meal~2026-09-08~dinner'] then
    raise exception 'FAIL 3: peer must not see the owner''s journal, review, calendar or meals, saw %', ids;
  end if;
  if (select count(*) from public.posts where id in ('journal~2026-09-08~a1','rev1','cal1','meal~2026-09-08~dinner')) <> 0 then
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
  -- Since v3.15 an edit history is the owner's alone, shared kinds included.
  -- A version's audience cannot be decided after the fact without re-deciding
  -- every version — share a note edited privately for a fortnight and each
  -- draft goes with it — and the Versions panel reads this table straight from
  -- the client with the reader's own JWT.
  if (select count(*) from public.posts_history where id = 'journal~2026-09-08~a1') <> 0 then
    raise exception 'FAIL 8: a peer can read the owner''s journal history';
  end if;
  if (select count(*) from public.posts_history where id = 't1') <> 0 then
    raise exception 'FAIL 8: a peer can read the owner''s history for a SHARED row';
  end if;
  raise notice 'ok 8: history is the owner''s alone';
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
    raise exception 'FAIL 12: a household peer should see an event (only journal, review, calendar, habit and routine are private)';
  end if;
  raise notice 'ok 12: a household peer sees the event';
end $$;
commit;

-- ===== v3.10 (level-up 1A) =====

-- ------- 13. habits and routines are owner-only at the database, not just in the app
-- v3.9 accepted both kinds but left the policies at journal/review/calendar, so a
-- household peer's sync pull and a direct select both handed them over.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated","email":"owner@example.test"}', true);
do $$
declare r jsonb;
begin
  r := public.sync_posts('[
    {"kind":"habit","id":"habit-walk","name":"Walk","days":[],"done":["2026-09-08"],"createdAt":"2026-09-08T09:00:00.000Z","updatedAt":"2026-09-08T09:00:00.000Z"},
    {"kind":"routine","id":"routine-am","name":"Morning","slot":"morning","steps":[],"createdAt":"2026-09-08T09:00:00.000Z","updatedAt":"2026-09-08T09:00:00.000Z"}
  ]'::jsonb, '2099-01-01');
  if jsonb_array_length(r -> 'rejected') <> 0 then
    raise exception 'FAIL 13: the owner''s habit or routine was rejected: %', r -> 'rejected';
  end if;
  -- an edit, so the habit has a history row the peer must not read either
  r := public.sync_posts('[{"kind":"habit","id":"habit-walk","name":"Walk","days":[],"done":["2026-09-08","2026-09-09"],"createdAt":"2026-09-08T09:00:00.000Z","updatedAt":"2026-09-09T09:00:00.000Z"}]'::jsonb, '2099-01-01');
  if (select count(*) from public.posts_history where id = 'habit-walk') <> 1 then
    raise exception 'FAIL 13: the habit edit should leave one history row';
  end if;
  raise notice 'ok 13: the owner stores a habit and a routine';
end $$;
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000b","role":"authenticated","email":"peer@example.test"}', true);
do $$
declare r jsonb; ids text[];
begin
  r := public.sync_posts('[]'::jsonb, null);
  select array_agg(x ->> 'id') into ids from jsonb_array_elements(r -> 'items') x;
  if ids && array['habit-walk', 'routine-am'] then
    raise exception 'FAIL 13: a peer''s sync pull returns the owner''s habit or routine: %', ids;
  end if;
  if not (ids @> array['t1', 'p1', 'nopi', 'pasta', 'ev1']) then
    raise exception 'FAIL 13: the peer should still see the shared kinds, saw %', ids;
  end if;
  if (select count(*) from public.posts where id in ('habit-walk', 'routine-am')) <> 0 then
    raise exception 'FAIL 13: direct select shows the peer the owner''s habit or routine';
  end if;
  if (select count(*) from public.posts_history where id = 'habit-walk') <> 0 then
    raise exception 'FAIL 13: the peer can read the owner''s habit history';
  end if;
  -- nor write over one: the upsert fails the USING check and comes back rejected
  r := public.sync_posts('[{"kind":"routine","id":"routine-am","name":"Mine now","slot":"morning","steps":[],"createdAt":"2026-09-08T09:00:00.000Z","updatedAt":"2026-09-10T09:00:00.000Z"}]'::jsonb, '2099-01-01');
  if not (r -> 'rejected') @> '["routine-am"]'::jsonb then
    raise exception 'FAIL 13: the peer''s write onto the owner''s routine should be rejected, got %', r -> 'rejected';
  end if;
  raise notice 'ok 13: a peer sees no habit, routine or their history, and still sees the shared kinds';
end $$;
commit;
do $$
begin
  if (select data ->> 'name' from public.posts where id = 'routine-am') <> 'Morning' then
    raise exception 'FAIL 13: the owner''s routine was changed by a peer';
  end if;
end $$;

-- ------------------------------ 14. an account that owns rows can be deleted
-- posts.user_id is ON DELETE SET NULL and NOT NULL at once, so deleting any
-- account with a single row failed outright (Admin's deleteUser promised the
-- rows would survive unowned). admin_prepare_user_deletion hands the shared rows
-- to the heir and removes the personal rows and their history first.
insert into auth.users (id, email) values ('00000000-0000-0000-0000-00000000000d', 'leaving@example.test');
insert into public.household_members (household_id, user_id, role) values
  ('00000000-0000-0000-0000-0000000000f0', '00000000-0000-0000-0000-00000000000d', 'member');
insert into public.households (id, name, created_by) values
  ('00000000-0000-0000-0000-0000000000f1', 'Flat', '00000000-0000-0000-0000-00000000000d'),
  ('00000000-0000-0000-0000-0000000000f2', 'Cousins', '00000000-0000-0000-0000-00000000000c');
insert into public.household_invites (household_id, user_id, invited_by) values
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-00000000000c', '00000000-0000-0000-0000-00000000000d'),
  ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-00000000000d', '00000000-0000-0000-0000-00000000000c');
insert into public.user_settings (user_id) values ('00000000-0000-0000-0000-00000000000d');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000d","role":"authenticated","email":"leaving@example.test"}', true);
do $$
declare r jsonb;
begin
  r := public.sync_posts('[
    {"kind":"task","id":"d-task","title":"Fix the gate","description":"","status":"todo","priority":"normal","tags":[],"createdAt":"2026-09-08T09:00:00.000Z","updatedAt":"2026-09-08T09:00:00.000Z"},
    {"kind":"person","id":"d-person","name":"Gran","color":"#f472b6","group":"family","createdAt":"2026-09-08T09:00:00.000Z","updatedAt":"2026-09-08T09:00:00.000Z"},
    {"kind":"habit","id":"d-habit","name":"Stretch","days":[],"done":[],"createdAt":"2026-09-08T09:00:00.000Z","updatedAt":"2026-09-08T09:00:00.000Z"},
    {"kind":"journal","id":"journal~2026-09-08~d1","date":"2026-09-08","body":"Moving out","createdAt":"2026-09-08T09:00:00.000Z","updatedAt":"2026-09-08T09:00:00.000Z"}
  ]'::jsonb, '2099-01-01');
  if jsonb_array_length(r -> 'rejected') <> 0 then
    raise exception 'FAIL 14: the leaving account''s rows were rejected: %', r -> 'rejected';
  end if;
  -- edits, so a shared row and a personal row both carry history
  r := public.sync_posts('[
    {"kind":"task","id":"d-task","title":"Fix the gate hinge","description":"","status":"todo","priority":"normal","tags":[],"createdAt":"2026-09-08T09:00:00.000Z","updatedAt":"2026-09-08T10:00:00.000Z"},
    {"kind":"journal","id":"journal~2026-09-08~d1","date":"2026-09-08","body":"Moving out on Friday","createdAt":"2026-09-08T09:00:00.000Z","updatedAt":"2026-09-08T10:00:00.000Z"}
  ]'::jsonb, '2099-01-01');
  if (select count(*) from public.posts_history where user_id = '00000000-0000-0000-0000-00000000000d') <> 2 then
    raise exception 'FAIL 14: expected two history rows for the leaving account';
  end if;
end $$;
commit;

create temp table d_before as
  select id, updated_at, synced_at, data from public.posts where user_id = '00000000-0000-0000-0000-00000000000d';

do $$
begin
  begin
    delete from auth.users where id = '00000000-0000-0000-0000-00000000000d';
  exception when not_null_violation then
    raise notice 'ok 14: unprepared, the delete fails on posts.user_id, as it did in production';
    return;
  end;
  raise exception 'FAIL 14: deleting an account that owns rows should fail until it is prepared';
end $$;

do $$
begin
  if has_function_privilege('authenticated', 'public.admin_prepare_user_deletion(uuid, uuid)', 'execute')
     or has_function_privilege('anon', 'public.admin_prepare_user_deletion(uuid, uuid)', 'execute') then
    raise exception 'FAIL 14: admin_prepare_user_deletion must be service-role only';
  end if;
  if not has_function_privilege('service_role', 'public.admin_prepare_user_deletion(uuid, uuid)', 'execute') then
    raise exception 'FAIL 14: the service role must be able to run admin_prepare_user_deletion';
  end if;
end $$;

begin;
set local role service_role;
do $$
declare r jsonb;
begin
  begin
    perform public.admin_prepare_user_deletion('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000000b');
    raise exception 'FAIL 14: the site owner must never be prepared for deletion';
  exception when raise_exception then
    if sqlerrm like 'FAIL%' then raise; end if;
  end;
  begin
    perform public.admin_prepare_user_deletion('00000000-0000-0000-0000-00000000000d', '00000000-0000-0000-0000-00000000000d');
    raise exception 'FAIL 14: an account must not inherit its own records';
  exception when raise_exception then
    if sqlerrm like 'FAIL%' then raise; end if;
  end;
  r := public.admin_prepare_user_deletion('00000000-0000-0000-0000-00000000000d', '00000000-0000-0000-0000-00000000000a');
  if r <> '{"reassigned": 2, "deleted": 2, "historyReassigned": 1, "historyDeleted": 1}'::jsonb then
    raise exception 'FAIL 14: unexpected counts from admin_prepare_user_deletion: %', r;
  end if;
  raise notice 'ok 14: prepared as the service role: %', r;
end $$;
commit;

do $$
begin
  delete from auth.users where id = '00000000-0000-0000-0000-00000000000d';
exception when others then
  raise exception 'FAIL 14: the prepared account still cannot be deleted: %', sqlerrm;
end $$;

do $$
begin
  if (select count(*) from public.posts where id in ('d-task', 'd-person') and user_id = '00000000-0000-0000-0000-00000000000a') <> 2 then
    raise exception 'FAIL 14: the shared rows should now belong to the heir';
  end if;
  if (select count(*) from public.posts where id in ('d-habit', 'journal~2026-09-08~d1')) <> 0 then
    raise exception 'FAIL 14: the personal rows should be gone';
  end if;
  if (select count(*) from public.posts_history where id = 'journal~2026-09-08~d1') <> 0 then
    raise exception 'FAIL 14: the journal''s history should be gone with it';
  end if;
  if (select count(*) from public.posts_history where id = 'd-task' and user_id = '00000000-0000-0000-0000-00000000000a') <> 1 then
    raise exception 'FAIL 14: the shared task''s history should follow it to the heir';
  end if;
  if exists (select 1 from public.posts where user_id = '00000000-0000-0000-0000-00000000000d')
     or exists (select 1 from public.posts_history where user_id = '00000000-0000-0000-0000-00000000000d') then
    raise exception 'FAIL 14: rows still point at the deleted account';
  end if;
  -- only the owner moved: enforce_lww let it through, content and stamp are as
  -- they were, and synced_at moved so every device pulls the new owner
  if exists (
    select 1 from public.posts p join d_before b using (id)
     where p.data is distinct from b.data or p.updated_at <> b.updated_at or p.synced_at <= b.synced_at
  ) then
    raise exception 'FAIL 14: reassignment must change only the owner and synced_at';
  end if;
  if (select count(*) from public.posts_history where id in ('d-task', 'd-person')) <> 1 then
    raise exception 'FAIL 14: an ownership change must not add a history row';
  end if;
  if exists (select 1 from public.household_members where user_id = '00000000-0000-0000-0000-00000000000d')
     or exists (select 1 from public.household_invites where user_id = '00000000-0000-0000-0000-00000000000d')
     or exists (select 1 from public.user_settings where user_id = '00000000-0000-0000-0000-00000000000d') then
    raise exception 'FAIL 14: membership, invitations or settings outlived the account';
  end if;
  if (select created_by from public.households where id = '00000000-0000-0000-0000-0000000000f1') is not null
     or (select invited_by from public.household_invites where household_id = '00000000-0000-0000-0000-0000000000f1') is not null then
    raise exception 'FAIL 14: households.created_by and household_invites.invited_by should be set null';
  end if;
  raise notice 'ok 14: the account is gone; shared rows and their history belong to the heir, personal rows and their history are deleted';
end $$;
drop table d_before;

-- --------------- 15. the sync canary: every kind stores, and nothing stays
do $$
begin
  if has_function_privilege('authenticated', 'public.sync_canary(text[])', 'execute')
     or has_function_privilege('anon', 'public.sync_canary(text[])', 'execute') then
    raise exception 'FAIL 15: sync_canary must be service-role only';
  end if;
  if not has_function_privilege('service_role', 'public.sync_canary(text[])', 'execute') then
    raise exception 'FAIL 15: the service role must be able to run sync_canary';
  end if;
end $$;

begin;
set local role service_role;
do $$
declare r jsonb; posts_before bigint; history_before bigint;
begin
  select count(*) into posts_before from public.posts;
  select count(*) into history_before from public.posts_history;
  -- every kind the app writes: SYNC_KINDS in shared/kinds.mjs
  r := public.sync_canary(array['task', 'project', 'calendar', 'person', 'place', 'review', 'template', 'recipe', 'meal', 'grocery', 'journal', 'event', 'habit', 'routine']);
  if r <> '{"ok": true, "checked": 14, "failures": []}'::jsonb then
    raise exception 'FAIL 15: the canary should pass for all 14 kinds, got %', r;
  end if;
  r := public.sync_canary(array['task', 'bogus']);
  if r <> '{"ok": false, "checked": 2, "failures": [{"kind": "bogus", "reason": "rejected"}]}'::jsonb then
    raise exception 'FAIL 15: a kind sync_posts does not know must fail, got %', r;
  end if;
  if (select count(*) from public.posts) <> posts_before or (select count(*) from public.posts_history) <> history_before then
    raise exception 'FAIL 15: the canary left rows behind';
  end if;
  raise notice 'ok 15: the canary passes all 14 kinds, fails a bogus one, and leaves posts and history as they were';
end $$;
commit;
do $$
begin
  if exists (select 1 from public.posts where id like 'canary~%') or exists (select 1 from public.posts_history where id like 'canary~%') then
    raise exception 'FAIL 15: a canary row was committed';
  end if;
end $$;

-- ...and it would have caught September: put the ambiguous `id` variable back
-- into sync_posts inside a transaction that is rolled back, and every kind fails
begin;
create or replace function public.sync_posts(incoming jsonb, since timestamptz default null)
returns jsonb
language plpgsql
as $$
declare
  item jsonb;
  id text;
  rejected jsonb := '[]'::jsonb;
begin
  for item in select value from jsonb_array_elements(incoming) loop
    id := item->>'id';
    begin
      insert into public.posts as p (id, updated_at, synced_at, data, user_id)
      values (item->>'id', (item->>'updatedAt')::timestamptz, clock_timestamp(), item, public.owner_user_id())
      on conflict (id) do update set data = excluded.data where excluded.updated_at > p.updated_at;
    exception when others then
      rejected := rejected || jsonb_build_array(id);
    end;
  end loop;
  return jsonb_build_object('items', '[]'::jsonb, 'rejected', rejected);
end;
$$;
set local role service_role;
do $$
declare r jsonb;
begin
  r := public.sync_canary(array['task', 'journal', 'habit']);
  if (r ->> 'ok')::boolean or jsonb_array_length(r -> 'failures') <> 3 then
    raise exception 'FAIL 15: with the September bug back, the canary must fail every kind, got %', r;
  end if;
  raise notice 'ok 15: with the ambiguous id put back, the canary fails every kind (%)', r -> 'failures' -> 0;
end $$;
rollback;

begin;
set local role service_role;
do $$
begin
  if not (public.sync_canary(array['task']) ->> 'ok')::boolean then
    raise exception 'FAIL 15: sync_posts should be itself again after the rolled-back break';
  end if;
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
declare r jsonb;
begin
  -- Since v3.15 history is the owner's alone, so the owner's lost version of a
  -- SHARED task is not the peer's to read either.
  if (select count(*) from public.posts_history where id = 'lu-t1' and reason = 'lost') <> 0 then
    raise exception 'FAIL v3.11-1: a peer can read the owner''s lost version of a shared task';
  end if;
  if (select count(*) from public.posts_history where id = 'journal~2026-09-10~lu') <> 0 then
    raise exception 'FAIL v3.11-1: a peer can read the owner''s lost journal line';
  end if;
  -- What must still work: posts_history_record_loss stamps the LOSER, so a
  -- member's own lost edit stays theirs and "Keep mine" can still offer it
  -- back. On a row of the peer's own, so nothing else in this file counts it.
  perform public.sync_posts('[{"kind":"task","id":"pl-t1","title":"Peer''s task","status":"todo","priority":"normal","createdAt":"2026-09-10T10:00:00.000Z","updatedAt":"2026-09-10T12:00:00.000Z"}]'::jsonb, '2099-01-01');
  r := public.sync_posts('[{"kind":"task","id":"pl-t1","title":"Peer''s older try","status":"todo","priority":"normal","createdAt":"2026-09-10T10:00:00.000Z","updatedAt":"2026-09-10T09:00:00.000Z"}]'::jsonb, '2099-01-01');
  if (r -> 'stale') is distinct from '["pl-t1"]'::jsonb then
    raise exception 'FAIL v3.15: the peer''s older push should be stale, got %', r - 'items';
  end if;
  if (select count(*) from public.posts_history h where h.id = 'pl-t1' and h.reason = 'lost' and h.data ->> 'title' = 'Peer''s older try') <> 1 then
    raise exception 'FAIL v3.15: a member must still be able to read the edit THEY lost';
  end if;
  raise notice 'ok v3.15: history is the owner''s, and a loser still keeps their own lost edit';
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

-- ===== v3.12 agent access (level-up P3-1a) =====
-- 20260921000000_agent_access: the three tables behind /api/mcp and the OAuth
-- server are the service role's alone, and their functions do what the
-- functions rely on. Inside one transaction now() stands still, which is what
-- lets these blocks move a window or a grace period by editing a timestamp.

-- ------------------------------ v3.12-1. RLS on, no policies, service role only
do $$
declare t text;
begin
  foreach t in array array['oauth_clients', 'agent_tokens', 'oauth_codes'] loop
    if not (select c.relrowsecurity from pg_class c where c.oid = ('public.' || t)::regclass) then
      raise exception 'FAIL v3.12-1: % has row level security off', t;
    end if;
    if exists (select 1 from pg_policies p where p.schemaname = 'public' and p.tablename = t) then
      raise exception 'FAIL v3.12-1: % has a policy; it must have none', t;
    end if;
    if has_table_privilege('anon', 'public.' || t, 'select') or has_table_privilege('authenticated', 'public.' || t, 'select')
       or has_table_privilege('authenticated', 'public.' || t, 'insert') or has_table_privilege('authenticated', 'public.' || t, 'update')
       or has_table_privilege('authenticated', 'public.' || t, 'delete') then
      raise exception 'FAIL v3.12-1: a client role holds a privilege on %', t;
    end if;
    if not (has_table_privilege('service_role', 'public.' || t, 'select') and has_table_privilege('service_role', 'public.' || t, 'insert')
            and has_table_privilege('service_role', 'public.' || t, 'update') and has_table_privilege('service_role', 'public.' || t, 'delete')) then
      raise exception 'FAIL v3.12-1: service_role lacks a privilege on % (a new table needs explicit grants)', t;
    end if;
  end loop;
  raise notice 'ok v3.12-1: oauth_clients, agent_tokens and oauth_codes have RLS on, no policies, and grants for the service role only';
end $$;

-- ------------------------------------------------ v3.12-2. the functions are service-only
do $$
declare f text;
begin
  foreach f in array array[
    'public.agent_token_use(text, integer)', 'public.oauth_redeem_code(text)', 'public.oauth_attach_grant(text, uuid)',
    'public.agent_token_rotate(text, text, text, text, interval, interval, interval)', 'public.oauth_client_use(text, integer)', 'public.oauth_prune()'
  ] loop
    if has_function_privilege('anon', f, 'execute') or has_function_privilege('authenticated', f, 'execute') then
      raise exception 'FAIL v3.12-2: a client role can execute %', f;
    end if;
    if not has_function_privilege('service_role', f, 'execute') then
      raise exception 'FAIL v3.12-2: service_role cannot execute %', f;
    end if;
  end loop;
  raise notice 'ok v3.12-2: the agent-access functions run for the service role only';
end $$;

-- ----------------------------------- v3.12-3. a signed-in client can read none of it
insert into public.oauth_clients (client_id, client_name, redirect_uris)
values ('dcr_smoke_seen_by_nobody', 'Seed', array['https://claude.ai/cb']);
insert into public.agent_tokens (user_id, kind, name, scopes, token_prefix, access_hash)
values ('00000000-0000-0000-0000-00000000000a', 'token', 'Seed', array['read'], 'drft_Seed', 'hash-seen-by-nobody');
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated","email":"owner@example.test"}', true);
do $$
declare t text;
begin
  foreach t in array array['oauth_clients', 'agent_tokens', 'oauth_codes'] loop
    begin
      execute format('select count(*) from public.%I', t);
      raise exception 'FAIL v3.12-3: the owner, signed in, could read %', t;
    exception when insufficient_privilege then
      null;
    end;
  end loop;
  begin
    perform public.agent_token_use('hash-seen-by-nobody', 60);
    raise exception 'FAIL v3.12-3: a signed-in client could check a token hash';
  exception when insufficient_privilege then
    null;
  end;
  raise notice 'ok v3.12-3: a signed-in client can neither read the tables nor call their functions, not even for its own rows';
end $$;
commit;

-- ------------------------------------- v3.12-4. agent_token_use: live tokens, and the window
begin;
set local role service_role;
do $$
declare r jsonb;
begin
  insert into public.agent_tokens (user_id, kind, name, scopes, token_prefix, access_hash)
  values ('00000000-0000-0000-0000-00000000000b', 'token', 'Laptop', array['read', 'write'], 'drft_Ab3x', 'hash-manual');
  r := public.agent_token_use('hash-manual', 2);
  if r ->> 'user_id' is distinct from '00000000-0000-0000-0000-00000000000b' or r ->> 'kind' is distinct from 'token'
     or r -> 'scopes' is distinct from '["read", "write"]'::jsonb or (r ->> 'over_limit')::boolean or r ->> 'grant_id' is null then
    raise exception 'FAIL v3.12-4: a live manual token should come back as its grant, got %', r;
  end if;
  if (select last_used_at from public.agent_tokens where access_hash = 'hash-manual') is null then
    raise exception 'FAIL v3.12-4: agent_token_use should stamp last_used_at';
  end if;
  if (public.agent_token_use('hash-manual', 2) ->> 'over_limit')::boolean then
    raise exception 'FAIL v3.12-4: the second call of a two-a-minute window is within it';
  end if;
  if not (public.agent_token_use('hash-manual', 2) ->> 'over_limit')::boolean then
    raise exception 'FAIL v3.12-4: the third call of a two-a-minute window is over it';
  end if;
  update public.agent_tokens set window_start = now() - interval '2 minutes' where access_hash = 'hash-manual';
  -- its own statement: a subquery beside the call would read the row as it was before the call
  r := public.agent_token_use('hash-manual', 2);
  if (r ->> 'over_limit')::boolean or (select window_count from public.agent_tokens where access_hash = 'hash-manual') <> 1 then
    raise exception 'FAIL v3.12-4: a window that started over a minute ago should start again at 1';
  end if;
  if public.agent_token_use('no-such-hash', 60) is not null then
    raise exception 'FAIL v3.12-4: an unknown hash should be null';
  end if;
  update public.agent_tokens set revoked_at = now() where access_hash = 'hash-manual';
  if public.agent_token_use('hash-manual', 60) is not null then
    raise exception 'FAIL v3.12-4: a revoked token should be null';
  end if;
  insert into public.oauth_clients (client_id, client_name, redirect_uris) values ('dcr_smoke_expiry', 'Expiry', array['https://claude.ai/cb']);
  insert into public.agent_tokens (user_id, kind, name, client_id, scopes, access_hash, access_expires_at, refresh_hash, refresh_expires_at)
  values ('00000000-0000-0000-0000-00000000000b', 'oauth', 'Expiry', 'dcr_smoke_expiry', array['read'], 'hash-expired', now() - interval '1 second', 'rt-expired', now() + interval '1 day');
  if public.agent_token_use('hash-expired', 60) is not null then
    raise exception 'FAIL v3.12-4: an expired access token should be null';
  end if;
  begin
    insert into public.agent_tokens (user_id, kind, name, scopes) values ('00000000-0000-0000-0000-00000000000b', 'token', 'Bad', array['admin']);
    raise exception 'FAIL v3.12-4: a scope outside read/write/journal was stored';
  exception when check_violation then
    null;
  end;
  begin
    insert into public.agent_tokens (user_id, kind, name) values ('00000000-0000-0000-0000-00000000000b', 'oauth', 'No client');
    raise exception 'FAIL v3.12-4: an oauth row without a client was stored';
  exception when check_violation then
    null;
  end;
  raise notice 'ok v3.12-4: agent_token_use returns a live token''s grant and counts its minute; unknown, revoked and expired tokens are null';
end $$;
commit;

-- -------------------------- v3.12-5. codes redeem once; a replay revokes what the code made
begin;
set local role service_role;
do $$
declare
  r jsonb;
  made uuid;
begin
  insert into public.oauth_clients (client_id, client_name, redirect_uris) values ('dcr_smoke_codes', 'Claude', array['https://claude.ai/cb']);
  insert into public.oauth_codes (code_hash, client_id, user_id, redirect_uri, code_challenge, scopes, resource, expires_at)
  values ('code-live', 'dcr_smoke_codes', '00000000-0000-0000-0000-00000000000a', 'https://claude.ai/cb', 'the-challenge',
          array['read', 'write'], 'https://site.test/api/mcp', now() + interval '5 minutes');
  r := public.oauth_redeem_code('code-live');
  if r is distinct from jsonb_build_object('outcome', 'ok', 'client_id', 'dcr_smoke_codes', 'user_id', '00000000-0000-0000-0000-00000000000a',
       'redirect_uri', 'https://claude.ai/cb', 'code_challenge', 'the-challenge', 'scopes', '["read", "write"]'::jsonb, 'resource', 'https://site.test/api/mcp') then
    raise exception 'FAIL v3.12-5: a live code should redeem with everything it was bound to, got %', r;
  end if;
  insert into public.agent_tokens (user_id, kind, name, client_id, scopes, access_hash, access_expires_at, refresh_hash, refresh_expires_at)
  values ('00000000-0000-0000-0000-00000000000a', 'oauth', 'Claude', 'dcr_smoke_codes', array['read', 'write'], 'at-from-code', now() + interval '1 hour', 'rt-from-code', now() + interval '90 days')
  returning id into made;
  if not public.oauth_attach_grant('code-live', made) then
    raise exception 'FAIL v3.12-5: oauth_attach_grant should find the code';
  end if;
  r := public.oauth_redeem_code('code-live');
  if r ->> 'outcome' is distinct from 'reused' then
    raise exception 'FAIL v3.12-5: a second redemption should be reused, got %', r;
  end if;
  if (select revoked_at from public.agent_tokens where id = made) is null or public.agent_token_use('at-from-code', 60) is not null then
    raise exception 'FAIL v3.12-5: replaying a code must revoke the connection it made';
  end if;
  insert into public.oauth_codes (code_hash, client_id, user_id, redirect_uri, code_challenge, scopes, resource, expires_at)
  values ('code-stale', 'dcr_smoke_codes', '00000000-0000-0000-0000-00000000000a', 'https://claude.ai/cb', 'c', array['read'], 'https://site.test/api/mcp', now() - interval '1 second');
  if public.oauth_redeem_code('code-stale') ->> 'outcome' is distinct from 'invalid' or public.oauth_redeem_code('code-none') ->> 'outcome' is distinct from 'invalid' then
    raise exception 'FAIL v3.12-5: an expired or unknown code should be invalid';
  end if;
  if (select used_at from public.oauth_codes where code_hash = 'code-stale') is not null then
    raise exception 'FAIL v3.12-5: an expired code must not be marked used';
  end if;
  raise notice 'ok v3.12-5: a code redeems once with its bindings; a replay is refused and revokes its connection; expired and unknown codes are invalid';
end $$;
commit;

-- ------------------- v3.12-6. refresh tokens rotate, forgive a retry, revoke on a replay
begin;
set local role service_role;
do $$
declare
  r jsonb;
  g uuid;
begin
  insert into public.oauth_clients (client_id, client_name, redirect_uris) values
    ('dcr_smoke_rotate', 'Claude', array['https://claude.ai/cb']),
    ('dcr_smoke_other', 'Other', array['https://claude.ai/cb']);
  insert into public.agent_tokens (user_id, kind, name, client_id, scopes, access_hash, access_expires_at, refresh_hash, refresh_expires_at)
  values ('00000000-0000-0000-0000-00000000000a', 'oauth', 'Claude', 'dcr_smoke_rotate', array['read', 'write', 'journal'], 'at-1', now() + interval '1 hour', 'rt-1', now() + interval '90 days')
  returning id into g;

  r := public.agent_token_rotate('dcr_smoke_rotate', 'rt-1', 'at-2', 'rt-2');
  if r is distinct from jsonb_build_object('outcome', 'rotated', 'grant_id', g, 'user_id', '00000000-0000-0000-0000-00000000000a', 'scopes', '["read", "write", "journal"]'::jsonb) then
    raise exception 'FAIL v3.12-6: the current refresh token should rotate, got %', r;
  end if;
  if (select (refresh_hash, prev_refresh_hash, access_hash) from public.agent_tokens where id = g) is distinct from ('rt-2'::text, 'rt-1'::text, 'at-2'::text)
     or public.agent_token_use('at-1', 60) is not null or public.agent_token_use('at-2', 60) is null then
    raise exception 'FAIL v3.12-6: rotation should replace both hashes and keep the old refresh as prev';
  end if;
  if public.agent_token_rotate('dcr_smoke_other', 'rt-2', 'x-1', 'x-2') ->> 'outcome' is distinct from 'invalid' then
    raise exception 'FAIL v3.12-6: another client cannot rotate this refresh token';
  end if;

  -- the client never saw that answer and retries with rt-1 inside the grace window
  r := public.agent_token_rotate('dcr_smoke_rotate', 'rt-1', 'at-3', 'rt-3');
  if r ->> 'outcome' is distinct from 'rotated' or (select refresh_hash from public.agent_tokens where id = g) is distinct from 'rt-3' then
    raise exception 'FAIL v3.12-6: the previous refresh token inside the grace window should rotate again, got %', r;
  end if;
  if public.agent_token_rotate('dcr_smoke_rotate', 'rt-2', 'x-3', 'x-4') ->> 'outcome' is distinct from 'invalid' then
    raise exception 'FAIL v3.12-6: the pair a grace retry replaced must be dead';
  end if;

  -- a minute later rt-1 can only be a stolen copy
  update public.agent_tokens set refreshed_at = now() - interval '2 minutes' where id = g;
  r := public.agent_token_rotate('dcr_smoke_rotate', 'rt-1', 'at-4', 'rt-4');
  if r ->> 'outcome' is distinct from 'reused' or (select revoked_at from public.agent_tokens where id = g) is null then
    raise exception 'FAIL v3.12-6: a replayed refresh token after the grace window must revoke the connection, got %', r;
  end if;
  if public.agent_token_rotate('dcr_smoke_rotate', 'rt-3', 'x-5', 'x-6') ->> 'outcome' is distinct from 'invalid' or public.agent_token_use('at-3', 60) is not null then
    raise exception 'FAIL v3.12-6: nothing of a revoked connection may work';
  end if;

  insert into public.agent_tokens (user_id, kind, name, client_id, scopes, access_hash, access_expires_at, refresh_hash, refresh_expires_at)
  values ('00000000-0000-0000-0000-00000000000a', 'oauth', 'Old', 'dcr_smoke_rotate', array['read'], 'at-old', now() - interval '1 day', 'rt-old', now() - interval '1 second');
  if public.agent_token_rotate('dcr_smoke_rotate', 'rt-old', 'x-7', 'x-8') ->> 'outcome' is distinct from 'invalid' then
    raise exception 'FAIL v3.12-6: an expired refresh token should be invalid';
  end if;
  raise notice 'ok v3.12-6: refresh tokens rotate for their own client, a retry inside 60 s rotates again, a later replay revokes the connection';
end $$;
commit;

-- ------------------------------ v3.12-7. the token-endpoint throttle, and housekeeping
begin;
set local role service_role;
do $$
declare r jsonb;
begin
  insert into public.oauth_clients (client_id, client_name, redirect_uris) values ('dcr_smoke_throttle', 'Busy', array['https://claude.ai/cb']);
  r := public.oauth_client_use('dcr_smoke_throttle', 2);
  if r is distinct from jsonb_build_object('client_id', 'dcr_smoke_throttle', 'client_name', 'Busy', 'redirect_uris', '["https://claude.ai/cb"]'::jsonb, 'over_limit', false) then
    raise exception 'FAIL v3.12-7: oauth_client_use should return the client, got %', r;
  end if;
  perform public.oauth_client_use('dcr_smoke_throttle', 2);
  if not (public.oauth_client_use('dcr_smoke_throttle', 2) ->> 'over_limit')::boolean then
    raise exception 'FAIL v3.12-7: the third token request of a two-a-minute window is over it';
  end if;
  if public.oauth_client_use('dcr_nobody', 30) is not null then
    raise exception 'FAIL v3.12-7: an unknown client should be null';
  end if;

  insert into public.oauth_clients (client_id, client_name, redirect_uris, created_at) values
    ('dcr_smoke_abandoned', 'Never finished', array['https://claude.ai/cb'], now() - interval '8 days'),
    ('dcr_smoke_fresh', 'Just registered', array['https://claude.ai/cb'], now());
  update public.oauth_clients set created_at = now() - interval '8 days' where client_id = 'dcr_smoke_codes';
  insert into public.oauth_codes (code_hash, client_id, user_id, redirect_uri, code_challenge, scopes, resource, expires_at)
  values ('code-ancient', 'dcr_smoke_fresh', '00000000-0000-0000-0000-00000000000a', 'https://claude.ai/cb', 'c', array['read'], 'https://site.test/api/mcp', now() - interval '2 days');
  perform public.oauth_prune();
  if exists (select 1 from public.oauth_clients where client_id = 'dcr_smoke_abandoned') then
    raise exception 'FAIL v3.12-7: a week-old client with no connection should be pruned';
  end if;
  if not exists (select 1 from public.oauth_clients where client_id = 'dcr_smoke_codes') or not exists (select 1 from public.oauth_clients where client_id = 'dcr_smoke_fresh') then
    raise exception 'FAIL v3.12-7: a client with a connection, or a new one, must survive the prune';
  end if;
  if exists (select 1 from public.oauth_codes where code_hash = 'code-ancient') or not exists (select 1 from public.oauth_codes where code_hash = 'code-live') then
    raise exception 'FAIL v3.12-7: only codes a day past expiry are pruned';
  end if;
  raise notice 'ok v3.12-7: oauth_client_use throttles per client; oauth_prune drops abandoned clients and day-old expired codes only';
end $$;
commit;

-- ---------------------------------- v3.12-8. deleting an account deletes its connections
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000d1', 'leaving@example.test');
insert into public.agent_tokens (user_id, kind, name, scopes, access_hash)
values ('00000000-0000-0000-0000-0000000000d1', 'token', 'Leaving', array['read'], 'hash-leaving');
insert into public.oauth_codes (code_hash, client_id, user_id, redirect_uri, code_challenge, scopes, resource, expires_at)
values ('code-leaving', 'dcr_smoke_fresh', '00000000-0000-0000-0000-0000000000d1', 'https://claude.ai/cb', 'c', array['read'], 'https://site.test/api/mcp', now() + interval '5 minutes');
delete from auth.users where id = '00000000-0000-0000-0000-0000000000d1';
do $$
begin
  if exists (select 1 from public.agent_tokens where user_id = '00000000-0000-0000-0000-0000000000d1')
     or exists (select 1 from public.oauth_codes where user_id = '00000000-0000-0000-0000-0000000000d1') then
    raise exception 'FAIL v3.12-8: an account''s tokens and codes must go with it';
  end if;
  raise notice 'ok v3.12-8: deleting an account deletes its tokens and codes';
end $$;

-- ===== v3.13 notes (level-up) =====
-- 20260922000000_v3_13_notes: sync_posts takes kind = 'note'. A SHARED note is
-- the household's like a task — the owner stores one, a peer sees it and may
-- edit it, a stranger can do neither — and the sync canary covers it. Since
-- v3.16 sharing is per note, so the note here carries the flag; v3.16 below
-- covers the private case and un-sharing.

-- ------------------------------------------------ v3.13-1. the owner stores a note
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated","email":"owner@example.test"}', true);
do $$
declare r jsonb;
begin
  r := public.sync_posts('[
    {"kind":"note","id":"note-paint","title":"Paint colours","body":"<p>Sage for the hall</p><p><img data-media=\"m-swatch\" alt=\"swatch\"></p>","projectId":"p1","pinned":true,"shared":true,"createdAt":"2026-09-12T09:00:00.000Z","updatedAt":"2026-09-12T09:00:00.000Z"}
  ]'::jsonb, '2099-01-01');
  if jsonb_array_length(r -> 'rejected') <> 0 then
    raise exception 'FAIL v3.13-1: sync_posts rejected the owner''s note: %', r -> 'rejected';
  end if;
  if (select user_id from public.posts where id = 'note-paint') is distinct from '00000000-0000-0000-0000-00000000000a' then
    raise exception 'FAIL v3.13-1: the note should be stored under the owner';
  end if;
  if (select data from public.posts where id = 'note-paint') ->> 'body' is distinct from '<p>Sage for the hall</p><p><img data-media="m-swatch" alt="swatch"></p>'
     or (select kind from public.posts where id = 'note-paint') is distinct from 'note' then
    raise exception 'FAIL v3.13-1: the note''s kind or body did not survive the write';
  end if;
  raise notice 'ok v3.13-1: the owner stores a note, body and photo reference intact';
end $$;
commit;

-- ------------------------- v3.13-2. a household peer sees the note and may edit it
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000b","role":"authenticated","email":"peer@example.test"}', true);
do $$
declare r jsonb; ids text[];
begin
  r := public.sync_posts('[]'::jsonb, null);
  select array_agg(x ->> 'id') into ids from jsonb_array_elements(r -> 'items') x;
  if not ('note-paint' = any(ids)) then
    raise exception 'FAIL v3.13-2: a peer''s sync pull should return the owner''s note, saw %', ids;
  end if;
  if (select count(*) from public.posts where id = 'note-paint') <> 1 then
    raise exception 'FAIL v3.13-2: direct select should show the peer the owner''s note';
  end if;
  -- shared like a task: the peer's edit is a household edit, not a refused write
  r := public.sync_posts('[
    {"kind":"note","id":"note-paint","title":"Paint colours","body":"<p>Sage for the hall, white for the ceiling</p>","projectId":"p1","pinned":true,"shared":true,"createdAt":"2026-09-12T09:00:00.000Z","updatedAt":"2026-09-12T10:00:00.000Z"}
  ]'::jsonb, '2099-01-01');
  if jsonb_array_length(r -> 'rejected') <> 0 then
    raise exception 'FAIL v3.13-2: the peer''s edit of a shared note was rejected: %', r -> 'rejected';
  end if;
  -- Since v3.15 the history belongs to the owner: the peer may read and edit
  -- the shared note itself, but not the versions it was before.
  if (select count(*) from public.posts_history where id = 'note-paint') <> 0 then
    raise exception 'FAIL v3.13-2: the peer can read the owner''s note history';
  end if;
  raise notice 'ok v3.13-2: a peer sees the owner''s note and edits it, but not its past';
end $$;
commit;
do $$
begin
  if (select data ->> 'body' from public.posts where id = 'note-paint') is distinct from '<p>Sage for the hall, white for the ceiling</p>' then
    raise exception 'FAIL v3.13-2: the peer''s edit did not land';
  end if;
  if (select user_id from public.posts where id = 'note-paint') is distinct from '00000000-0000-0000-0000-00000000000a' then
    raise exception 'FAIL v3.13-2: an edit must not change whose note it is';
  end if;
end $$;

-- --------------------------------------- v3.13-3. a stranger neither sees nor writes it
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000c","role":"authenticated","email":"stranger@example.test"}', true);
do $$
declare r jsonb; ids text[];
begin
  r := public.sync_posts('[]'::jsonb, null);
  select coalesce(array_agg(x ->> 'id'), '{}') into ids from jsonb_array_elements(r -> 'items') x;
  if 'note-paint' = any(ids) then
    raise exception 'FAIL v3.13-3: a stranger''s sync pull returns the owner''s note';
  end if;
  if (select count(*) from public.posts where id = 'note-paint') <> 0
     or (select count(*) from public.posts_history where id = 'note-paint') <> 0 then
    raise exception 'FAIL v3.13-3: direct select shows a stranger the note or its history';
  end if;
  r := public.sync_posts('[{"kind":"note","id":"note-paint","title":"Mine now","body":"","createdAt":"2026-09-12T09:00:00.000Z","updatedAt":"2026-09-12T11:00:00.000Z"}]'::jsonb, '2099-01-01');
  if not (r -> 'rejected') @> '["note-paint"]'::jsonb then
    raise exception 'FAIL v3.13-3: a stranger''s write onto the note should be rejected, got %', r;
  end if;
  raise notice 'ok v3.13-3: a stranger cannot see the note, its history, or write over it';
end $$;
commit;
do $$
begin
  if (select data ->> 'title' from public.posts where id = 'note-paint') is distinct from 'Paint colours' then
    raise exception 'FAIL v3.13-3: the note was changed by a stranger';
  end if;
end $$;

-- --------------------------------- v3.13-4. the canary passes every kind, 'note' too
begin;
set local role service_role;
do $$
declare r jsonb; posts_before bigint; history_before bigint;
begin
  select count(*) into posts_before from public.posts;
  select count(*) into history_before from public.posts_history;
  -- every kind the app writes: SYNC_KINDS in shared/kinds.mjs
  r := public.sync_canary(array['task', 'project', 'calendar', 'person', 'place', 'review', 'template', 'recipe', 'meal', 'grocery', 'journal', 'event', 'habit', 'routine', 'note']);
  if r <> '{"ok": true, "checked": 15, "failures": []}'::jsonb then
    raise exception 'FAIL v3.13-4: the canary should pass for all 15 kinds, got %', r;
  end if;
  if (select count(*) from public.posts) <> posts_before or (select count(*) from public.posts_history) <> history_before then
    raise exception 'FAIL v3.13-4: the canary left rows behind';
  end if;
  raise notice 'ok v3.13-4: the canary passes all 15 kinds, note included, and leaves posts and history as they were';
end $$;
commit;

-- -------------- v3.13-5. the daily snapshots are no signed-in account's to read
-- The nightly backup writes them with the service key, so they have no owner.
-- An ownerless object under backups/ is no signed-in account's, not even the
-- owner's: Admin downloads them with the service key. An ownerless photo from
-- before objects had owners stays readable.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated","email":"owner@example.test"}', true);
insert into storage.objects (bucket_id, name, owner) values
  ('media', 'bk-owner-photo', '00000000-0000-0000-0000-00000000000a');
commit;
begin;
set local role service_role;
insert into storage.objects (bucket_id, name, owner) values
  ('media', 'backups/00000000-0000-0000-0000-00000000000a/2026-09-14.json', null),
  ('media', 'bk-legacy-photo', null);
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000b","role":"authenticated","email":"peer@example.test"}', true);
do $$
declare names text[];
begin
  select coalesce(array_agg(name order by name), '{}') into names from storage.objects
   where bucket_id = 'media' and (name like 'bk-%' or name like 'backups/%');
  if names <> array['bk-legacy-photo', 'bk-owner-photo'] then
    raise exception 'FAIL v3.13-5: a household peer should see the owner''s photo and the legacy one, never a backup; saw %', names;
  end if;
  raise notice 'ok v3.13-5: a household peer sees the household''s photos but no backup';
end $$;
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000c","role":"authenticated","email":"stranger@example.test"}', true);
do $$
declare names text[];
begin
  select coalesce(array_agg(name order by name), '{}') into names from storage.objects
   where bucket_id = 'media' and (name like 'bk-%' or name like 'backups/%');
  if names <> array['bk-legacy-photo'] then
    raise exception 'FAIL v3.13-5: a stranger should see only the ownerless legacy photo, saw %', names;
  end if;
  raise notice 'ok v3.13-5: a stranger sees no backup and no household photo';
end $$;
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated","email":"owner@example.test"}', true);
do $$
declare names text[];
begin
  select coalesce(array_agg(name order by name), '{}') into names from storage.objects
   where bucket_id = 'media' and (name like 'bk-%' or name like 'backups/%');
  if names <> array['bk-legacy-photo', 'bk-owner-photo'] then
    raise exception 'FAIL v3.13-5: the owner should see their photo and the legacy one, not the backup; saw %', names;
  end if;
  raise notice 'ok v3.13-5: the owner too reads backups only through Admin''s service-key download';
end $$;
commit;

-- leave storage as it was for any step after this one
begin;
set local role service_role;
delete from storage.objects where bucket_id = 'media' and (name like 'bk-%' or name like 'backups/%');
commit;
-- ===== v3.14 (wardrobe) =====
-- 20260923000000_v3_14_wardrobe: sync_posts takes kind = 'garment', 'outfit' and
-- 'wear', and all three are personal like the journal — stored under their
-- owner, never a household peer's to read, write over or inherit — the canary
-- covers them, and a garment photo under personal/<user id>/ is its uploader's
-- alone while note photos stay household-wide.

-- ------------------- v3.14-1. the owner stores a garment, an outfit and a look
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated","email":"owner@example.test"}', true);
do $$
declare r jsonb;
begin
  r := public.sync_posts('[
    {"kind":"garment","id":"g-tee","name":"White tee","type":"top","photoId":"personal/00000000-0000-0000-0000-00000000000a/7f3c9a10","thumbId":"personal/00000000-0000-0000-0000-00000000000a/7f3c9a11","backPhotoId":"personal/00000000-0000-0000-0000-00000000000a/7f3c9a12","backThumbId":"personal/00000000-0000-0000-0000-00000000000a/7f3c9a13","showBack":true,"occasion":"work","color":"#f5f5f0","createdAt":"2026-09-13T08:00:00.000Z","updatedAt":"2026-09-13T08:00:00.000Z"},
    {"kind":"outfit","id":"o-friday","name":"Friday","garmentIds":["g-tee","g-jeans"],"createdAt":"2026-09-13T08:00:00.000Z","updatedAt":"2026-09-13T08:00:00.000Z"},
    {"kind":"wear","id":"wear~2026-09-13~a1b2c3d4e5","date":"2026-09-13","garmentIds":["g-tee","g-jeans"],"createdAt":"2026-09-13T08:00:00.000Z","updatedAt":"2026-09-13T08:00:00.000Z"}
  ]'::jsonb, '2099-01-01');
  if jsonb_array_length(r -> 'rejected') <> 0 then
    raise exception 'FAIL v3.14-1: sync_posts rejected the owner''s wardrobe: %', r -> 'rejected';
  end if;
  if (select count(*) from public.posts
       where id in ('g-tee', 'o-friday', 'wear~2026-09-13~a1b2c3d4e5') and user_id = '00000000-0000-0000-0000-00000000000a') <> 3 then
    raise exception 'FAIL v3.14-1: the garment, the outfit and the look should all be stored under the owner';
  end if;
  if (select kind from public.posts where id = 'g-tee') is distinct from 'garment'
     or (select kind from public.posts where id = 'o-friday') is distinct from 'outfit'
     or (select kind from public.posts where id = 'wear~2026-09-13~a1b2c3d4e5') is distinct from 'wear' then
    raise exception 'FAIL v3.14-1: a wardrobe row has the wrong kind column';
  end if;
  if (select data ->> 'photoId' from public.posts where id = 'g-tee') is distinct from 'personal/00000000-0000-0000-0000-00000000000a/7f3c9a10' then
    raise exception 'FAIL v3.14-1: the garment''s photo reference did not survive the write';
  end if;
  -- its back photo, the back first and what it is worn for are plain fields of the record, stored as sent
  if (select data ->> 'backPhotoId' from public.posts where id = 'g-tee') is distinct from 'personal/00000000-0000-0000-0000-00000000000a/7f3c9a12'
     or (select data ->> 'backThumbId' from public.posts where id = 'g-tee') is distinct from 'personal/00000000-0000-0000-0000-00000000000a/7f3c9a13'
     or (select data ->> 'showBack' from public.posts where id = 'g-tee') is distinct from 'true'
     or (select data ->> 'occasion' from public.posts where id = 'g-tee') is distinct from 'work' then
    raise exception 'FAIL v3.14-1: the garment''s back photo, back-first or occasion did not survive the write';
  end if;
  -- an edit, so the look has a history row a peer must not read either
  r := public.sync_posts('[{"kind":"wear","id":"wear~2026-09-13~a1b2c3d4e5","date":"2026-09-13","garmentIds":["g-tee"],"createdAt":"2026-09-13T08:00:00.000Z","updatedAt":"2026-09-13T09:00:00.000Z"}]'::jsonb, '2099-01-01');
  if jsonb_array_length(r -> 'rejected') <> 0 then
    raise exception 'FAIL v3.14-1: the owner''s edit of the look was rejected: %', r -> 'rejected';
  end if;
  if (select count(*) from public.posts_history where id = 'wear~2026-09-13~a1b2c3d4e5') <> 1 then
    raise exception 'FAIL v3.14-1: the look''s edit should leave exactly one history row';
  end if;
  raise notice 'ok v3.14-1: the owner stores a garment, an outfit and a look, each under the owner with its kind';
end $$;
commit;

-- ---- v3.14-2. a household peer sees none of it, cannot write over a look, logs its own
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000b","role":"authenticated","email":"peer@example.test"}', true);
do $$
declare r jsonb; ids text[];
begin
  r := public.sync_posts('[]'::jsonb, null);
  select coalesce(array_agg(x ->> 'id'), '{}') into ids from jsonb_array_elements(r -> 'items') x;
  if ids && array['g-tee', 'o-friday', 'wear~2026-09-13~a1b2c3d4e5'] then
    raise exception 'FAIL v3.14-2: a peer''s sync pull returns the owner''s wardrobe: %', ids;
  end if;
  if not ('note-paint' = any(ids)) then
    raise exception 'FAIL v3.14-2: the peer should still see the shared note, saw %', ids;
  end if;
  if (select count(*) from public.posts where id in ('g-tee', 'o-friday', 'wear~2026-09-13~a1b2c3d4e5')) <> 0 then
    raise exception 'FAIL v3.14-2: direct select shows the peer the owner''s wardrobe';
  end if;
  if (select count(*) from public.posts_history where id in ('g-tee', 'o-friday', 'wear~2026-09-13~a1b2c3d4e5')) <> 0 then
    raise exception 'FAIL v3.14-2: the peer can read the history of the owner''s look';
  end if;
  -- the same day logged on both accounts: a write onto the owner's id fails the USING check
  r := public.sync_posts('[{"kind":"wear","id":"wear~2026-09-13~a1b2c3d4e5","date":"2026-09-13","garmentIds":["g-peer"],"createdAt":"2026-09-13T08:00:00.000Z","updatedAt":"2026-09-13T12:00:00.000Z"}]'::jsonb, '2099-01-01');
  if not (r -> 'rejected') @> '["wear~2026-09-13~a1b2c3d4e5"]'::jsonb then
    raise exception 'FAIL v3.14-2: the peer''s write onto the owner''s look should be rejected, got %', r;
  end if;
  -- ...while the peer's own look for that day, under its own random suffix, stores
  r := public.sync_posts('[{"kind":"wear","id":"wear~2026-09-13~b1b2c3d4e5","date":"2026-09-13","garmentIds":["g-peer"],"createdAt":"2026-09-13T08:00:00.000Z","updatedAt":"2026-09-13T08:00:00.000Z"}]'::jsonb, '2099-01-01');
  if jsonb_array_length(r -> 'rejected') <> 0 then
    raise exception 'FAIL v3.14-2: the peer''s own look was rejected: %', r -> 'rejected';
  end if;
  raise notice 'ok v3.14-2: a peer sees none of the owner''s wardrobe or its history, cannot write over a look, and logs its own';
end $$;
commit;
do $$
begin
  if (select data -> 'garmentIds' from public.posts where id = 'wear~2026-09-13~a1b2c3d4e5') is distinct from '["g-tee"]'::jsonb then
    raise exception 'FAIL v3.14-2: the owner''s look was changed by a peer';
  end if;
  if (select user_id from public.posts where id = 'wear~2026-09-13~b1b2c3d4e5') is distinct from '00000000-0000-0000-0000-00000000000b' then
    raise exception 'FAIL v3.14-2: the peer''s look should be stored under the peer';
  end if;
end $$;
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated","email":"owner@example.test"}', true);
do $$
begin
  if (select count(*) from public.posts where id = 'wear~2026-09-13~b1b2c3d4e5') <> 0 then
    raise exception 'FAIL v3.14-2: the owner can see the peer''s look';
  end if;
end $$;
commit;

-- ---------------------------------- v3.14-3. a stranger sees none of it either
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000c","role":"authenticated","email":"stranger@example.test"}', true);
do $$
declare r jsonb; ids text[];
begin
  r := public.sync_posts('[]'::jsonb, null);
  select coalesce(array_agg(x ->> 'id'), '{}') into ids from jsonb_array_elements(r -> 'items') x;
  if ids && array['g-tee', 'o-friday', 'wear~2026-09-13~a1b2c3d4e5'] then
    raise exception 'FAIL v3.14-3: a stranger''s sync pull returns the owner''s wardrobe: %', ids;
  end if;
  if (select count(*) from public.posts where id in ('g-tee', 'o-friday', 'wear~2026-09-13~a1b2c3d4e5')) <> 0
     or (select count(*) from public.posts_history where id in ('g-tee', 'o-friday', 'wear~2026-09-13~a1b2c3d4e5')) <> 0 then
    raise exception 'FAIL v3.14-3: direct select shows a stranger the owner''s wardrobe or its history';
  end if;
  raise notice 'ok v3.14-3: a stranger sees none of the owner''s wardrobe or its history';
end $$;
commit;

-- ------------------------ v3.14-4. the canary passes every kind, the wardrobe too
begin;
set local role service_role;
do $$
declare r jsonb; posts_before bigint; history_before bigint;
begin
  select count(*) into posts_before from public.posts;
  select count(*) into history_before from public.posts_history;
  -- every kind the app writes: SYNC_KINDS in shared/kinds.mjs
  r := public.sync_canary(array['task', 'project', 'calendar', 'person', 'place', 'review', 'template', 'recipe', 'meal', 'grocery', 'journal', 'event', 'habit', 'routine', 'note', 'garment', 'outfit', 'wear']);
  if r <> '{"ok": true, "checked": 18, "failures": []}'::jsonb then
    raise exception 'FAIL v3.14-4: the canary should pass for all 18 kinds, got %', r;
  end if;
  if (select count(*) from public.posts) <> posts_before or (select count(*) from public.posts_history) <> history_before then
    raise exception 'FAIL v3.14-4: the canary left rows behind';
  end if;
  raise notice 'ok v3.14-4: the canary passes all 18 kinds, the wardrobe included, and leaves posts and history as they were';
end $$;
commit;

-- ------------- v3.14-5. a leaving member's wardrobe is deleted, never inherited
-- step 14 deleted …0d, so this needs an account of its own
insert into auth.users (id, email) values ('00000000-0000-0000-0000-00000000000e', 'moving@example.test');
insert into public.household_members (household_id, user_id, role) values
  ('00000000-0000-0000-0000-0000000000f0', '00000000-0000-0000-0000-00000000000e', 'member');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000e","role":"authenticated","email":"moving@example.test"}', true);
do $$
declare r jsonb;
begin
  r := public.sync_posts('[
    {"kind":"garment","id":"e-coat","name":"Wool coat","type":"outerwear","photoId":"personal/00000000-0000-0000-0000-00000000000e/e0c0a7f1","createdAt":"2026-09-13T08:00:00.000Z","updatedAt":"2026-09-13T08:00:00.000Z"},
    {"kind":"outfit","id":"e-outfit","garmentIds":["e-coat"],"createdAt":"2026-09-13T08:00:00.000Z","updatedAt":"2026-09-13T08:00:00.000Z"},
    {"kind":"wear","id":"wear~2026-09-13~e1e2e3e4e5","date":"2026-09-13","garmentIds":["e-coat"],"createdAt":"2026-09-13T08:00:00.000Z","updatedAt":"2026-09-13T08:00:00.000Z"},
    {"kind":"task","id":"e-task","title":"Return the keys","description":"","status":"todo","priority":"normal","tags":[],"createdAt":"2026-09-13T08:00:00.000Z","updatedAt":"2026-09-13T08:00:00.000Z"}
  ]'::jsonb, '2099-01-01');
  if jsonb_array_length(r -> 'rejected') <> 0 then
    raise exception 'FAIL v3.14-5: the leaving account''s rows were rejected: %', r -> 'rejected';
  end if;
  -- an edit, so the look carries history
  r := public.sync_posts('[{"kind":"wear","id":"wear~2026-09-13~e1e2e3e4e5","date":"2026-09-13","garmentIds":["e-coat","e-boots"],"createdAt":"2026-09-13T08:00:00.000Z","updatedAt":"2026-09-13T09:00:00.000Z"}]'::jsonb, '2099-01-01');
  if (select count(*) from public.posts_history where id = 'wear~2026-09-13~e1e2e3e4e5') <> 1 then
    raise exception 'FAIL v3.14-5: the look''s edit should leave one history row';
  end if;
end $$;
commit;

begin;
set local role service_role;
do $$
declare r jsonb;
begin
  r := public.admin_prepare_user_deletion('00000000-0000-0000-0000-00000000000e', '00000000-0000-0000-0000-00000000000a');
  if r <> '{"reassigned": 1, "deleted": 3, "historyReassigned": 0, "historyDeleted": 1}'::jsonb then
    raise exception 'FAIL v3.14-5: unexpected counts from admin_prepare_user_deletion: %', r;
  end if;
  raise notice 'ok v3.14-5: prepared as the service role: %', r;
end $$;
commit;

do $$
begin
  delete from auth.users where id = '00000000-0000-0000-0000-00000000000e';
exception when others then
  raise exception 'FAIL v3.14-5: the prepared account still cannot be deleted: %', sqlerrm;
end $$;

do $$
begin
  if exists (select 1 from public.posts where id in ('e-coat', 'e-outfit', 'wear~2026-09-13~e1e2e3e4e5'))
     or exists (select 1 from public.posts_history where id in ('e-coat', 'e-outfit', 'wear~2026-09-13~e1e2e3e4e5')) then
    raise exception 'FAIL v3.14-5: the leaving member''s wardrobe or its history outlived the account';
  end if;
  if (select user_id from public.posts where id = 'e-task') is distinct from '00000000-0000-0000-0000-00000000000a' then
    raise exception 'FAIL v3.14-5: the shared task should now belong to the heir';
  end if;
  raise notice 'ok v3.14-5: the account is gone; its wardrobe and that history are deleted, its task belongs to the heir';
end $$;

-- ----------- v3.14-6. storage: personal/<user id>/ is its uploader's alone
-- The stub grants authenticated the table, as Supabase does, so the media
-- policies run as a real signed-in account.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated","email":"owner@example.test"}', true);
insert into storage.objects (bucket_id, name, owner) values
  ('media', 'personal/00000000-0000-0000-0000-00000000000a/p1', '00000000-0000-0000-0000-00000000000a'),
  ('media', 'n1', '00000000-0000-0000-0000-00000000000a');
commit;
-- written with the service key: no owner, like the daily snapshots
begin;
set local role service_role;
insert into storage.objects (bucket_id, name, owner) values
  ('media', 'backups/00000000-0000-0000-0000-00000000000a/2026-09-13.json', null),
  ('media', 'legacy-null', null);
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000b","role":"authenticated","email":"peer@example.test"}', true);
do $$
declare names text[]; n integer;
begin
  select coalesce(array_agg(name order by name), '{}') into names from storage.objects where bucket_id = 'media';
  if names <> array['legacy-null', 'n1'] then
    raise exception 'FAIL v3.14-6: the peer should see the household photo and the legacy one only, saw %', names;
  end if;
  begin
    insert into storage.objects (bucket_id, name, owner)
      values ('media', 'personal/00000000-0000-0000-0000-00000000000a/x', '00000000-0000-0000-0000-00000000000b');
    raise exception 'FAIL v3.14-6: the peer wrote into the owner''s personal folder';
  exception when insufficient_privilege then
    null;
  end;
  insert into storage.objects (bucket_id, name, owner)
    values ('media', 'personal/00000000-0000-0000-0000-00000000000b/mine', '00000000-0000-0000-0000-00000000000b');
  update storage.objects set name = name where name = 'personal/00000000-0000-0000-0000-00000000000a/p1';
  get diagnostics n = row_count;
  if n <> 0 then
    raise exception 'FAIL v3.14-6: the peer replaced the owner''s personal photo';
  end if;
  delete from storage.objects where name = 'personal/00000000-0000-0000-0000-00000000000a/p1';
  get diagnostics n = row_count;
  if n <> 0 then
    raise exception 'FAIL v3.14-6: the peer deleted the owner''s personal photo';
  end if;
  begin
    update storage.objects set name = 'personal/00000000-0000-0000-0000-00000000000a/stolen'
     where name = 'personal/00000000-0000-0000-0000-00000000000b/mine';
    raise exception 'FAIL v3.14-6: the peer moved its photo into the owner''s folder';
  exception when insufficient_privilege then
    null;
  end;
  raise notice 'ok v3.14-6: a peer sees household and legacy photos, never another''s personal one or a backup, and writes only into its own folder';
end $$;
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated","email":"owner@example.test"}', true);
do $$
declare names text[]; n integer;
begin
  select coalesce(array_agg(name order by name), '{}') into names from storage.objects where bucket_id = 'media';
  if not (names @> array['n1', 'personal/00000000-0000-0000-0000-00000000000a/p1']) then
    raise exception 'FAIL v3.14-6: the owner should see their own photos, saw %', names;
  end if;
  if names && array['backups/00000000-0000-0000-0000-00000000000a/2026-09-13.json', 'personal/00000000-0000-0000-0000-00000000000b/mine'] then
    raise exception 'FAIL v3.14-6: the owner sees a backup or the peer''s personal photo: %', names;
  end if;
  update storage.objects set name = 'personal/00000000-0000-0000-0000-00000000000a/p1-replaced'
   where name = 'personal/00000000-0000-0000-0000-00000000000a/p1';
  get diagnostics n = row_count;
  if n <> 1 then
    raise exception 'FAIL v3.14-6: the owner could not replace their own personal photo';
  end if;
  delete from storage.objects where name = 'personal/00000000-0000-0000-0000-00000000000a/p1-replaced';
  get diagnostics n = row_count;
  if n <> 1 then
    raise exception 'FAIL v3.14-6: the owner could not delete their own personal photo';
  end if;
  raise notice 'ok v3.14-6: the owner sees, replaces and deletes their own personal photo, and no backup';
end $$;
commit;

-- ------------- v3.14-7. what the wardrobe-photo clean-up reads, and may delete
-- The nightly sweep (sweepPersonalPhotos in netlify/functions/lib/backup.mjs)
-- and Admin's account deletion read every garment row with the service key
-- (posts?kind=eq.garment) and delete a photo under personal/<user id>/ only
-- when no live piece, or piece in Trash, points at it. Pinned here: the kind
-- column finds live, trashed and purged pieces; a piece in Trash keeps its
-- photo ids, so its photos are kept; a piece deleted forever keeps none, so
-- its photos are found only by nothing pointing at them; no piece anywhere
-- points into a deleted account's folder; and the uploader-only storage
-- policies do not hold back the service role the Storage API runs as.
-- storage.objects.owner has no foreign key in this stub and is unverified on
-- Supabase, which is why Admin deletes the photos before the sign-in.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated","email":"owner@example.test"}', true);
do $$
declare r jsonb;
begin
  r := public.sync_posts('[
    {"kind":"garment","id":"g-coat","name":"Rain coat","type":"outerwear","photoId":"personal/00000000-0000-0000-0000-00000000000a/c0a7c0a7","thumbId":"personal/00000000-0000-0000-0000-00000000000a/c0a7c0a8","createdAt":"2026-09-13T08:00:00.000Z","updatedAt":"2026-09-13T08:00:00.000Z","deletedAt":"2026-09-13T08:00:00.000Z"},
    {"kind":"garment","id":"g-hat","name":"Sun hat","type":"accessory","photoId":"personal/00000000-0000-0000-0000-00000000000a/4a7a4a7a","createdAt":"2026-09-13T08:00:00.000Z","updatedAt":"2026-09-13T08:00:00.000Z"}
  ]'::jsonb, '2099-01-01');
  if jsonb_array_length(r -> 'rejected') <> 0 then
    raise exception 'FAIL v3.14-7: the owner''s pieces were rejected: %', r -> 'rejected';
  end if;
  -- Delete forever: the content-free tombstone the app writes (purgeTombstone in src/sync.ts)
  r := public.sync_posts('[
    {"kind":"garment","id":"g-hat","name":"","type":"accessory","purged":true,"deletedAt":"2026-09-13T09:00:00.000Z","createdAt":"2026-09-13T09:00:00.000Z","updatedAt":"2026-09-13T09:00:00.000Z"}
  ]'::jsonb, '2099-01-01');
  if jsonb_array_length(r -> 'rejected') <> 0 then
    raise exception 'FAIL v3.14-7: the Delete forever tombstone was rejected: %', r -> 'rejected';
  end if;
end $$;
commit;

begin;
set local role service_role;
do $$
declare referenced text[]; n integer; fks integer;
begin
  if (select count(*) from public.posts where kind = 'garment' and id in ('g-tee', 'g-coat', 'g-hat')) <> 3 then
    raise exception 'FAIL v3.14-7: the service role should find the live, the trashed and the purged piece by kind';
  end if;
  if (select data ->> 'photoId' from public.posts where id = 'g-coat') is distinct from 'personal/00000000-0000-0000-0000-00000000000a/c0a7c0a7'
     or (select data ->> 'deletedAt' from public.posts where id = 'g-coat') is null then
    raise exception 'FAIL v3.14-7: a piece in Trash should keep its photo ids, so the sweep keeps its photos';
  end if;
  if (select data ? 'photoId' or data ? 'thumbId' from public.posts where id = 'g-hat')
     or (select data ->> 'purged' from public.posts where id = 'g-hat') is distinct from 'true' then
    raise exception 'FAIL v3.14-7: a piece deleted forever should be stored content-free, pointing at no photo';
  end if;
  -- garmentMediaIds (shared/media.mjs) in SQL: every photo a live piece, or one in Trash, points at,
  -- front and back (mediaIdsOf)
  select coalesce(array_agg(p order by p), '{}') into referenced
    from public.posts, lateral (values (data ->> 'photoId'), (data ->> 'thumbId'), (data ->> 'backPhotoId'), (data ->> 'backThumbId')) v(p)
   where kind = 'garment' and coalesce(data ->> 'purged', 'false') <> 'true' and p is not null;
  if referenced <> array[
    'personal/00000000-0000-0000-0000-00000000000a/7f3c9a10',
    'personal/00000000-0000-0000-0000-00000000000a/7f3c9a11',
    'personal/00000000-0000-0000-0000-00000000000a/7f3c9a12',
    'personal/00000000-0000-0000-0000-00000000000a/7f3c9a13',
    'personal/00000000-0000-0000-0000-00000000000a/c0a7c0a7',
    'personal/00000000-0000-0000-0000-00000000000a/c0a7c0a8'
  ] then
    raise exception 'FAIL v3.14-7: the photos pieces point at should be the live and the trashed piece''s, back photos too, got %', referenced;
  end if;
  -- step v3.14-5 deleted …0e, whose coat had a photo: nothing may still point into that folder
  if exists (select 1 from public.posts
              where kind = 'garment'
                and (data ->> 'photoId' like 'personal/00000000-0000-0000-0000-00000000000e/%'
                  or data ->> 'thumbId' like 'personal/00000000-0000-0000-0000-00000000000e/%'
                  or data ->> 'backPhotoId' like 'personal/00000000-0000-0000-0000-00000000000e/%'
                  or data ->> 'backThumbId' like 'personal/00000000-0000-0000-0000-00000000000e/%')) then
    raise exception 'FAIL v3.14-7: a piece still points into the deleted account''s personal folder';
  end if;
  insert into storage.objects (bucket_id, name, owner) values
    ('media', 'personal/00000000-0000-0000-0000-00000000000e/e0c0a7f1', '00000000-0000-0000-0000-00000000000e');
  delete from storage.objects
   where bucket_id = 'media'
     and name in ('personal/00000000-0000-0000-0000-00000000000e/e0c0a7f1', 'personal/00000000-0000-0000-0000-00000000000b/mine');
  get diagnostics n = row_count;
  if n <> 2 then
    raise exception 'FAIL v3.14-7: the service role should delete any account''s personal photo by name, deleted %', n;
  end if;
  if not exists (select 1 from storage.objects where name = 'n1')
     or not exists (select 1 from storage.objects where name = 'backups/00000000-0000-0000-0000-00000000000a/2026-09-13.json') then
    raise exception 'FAIL v3.14-7: deleting personal photos by name took the household photo or a backup with them';
  end if;
  select count(*) into fks from pg_constraint where conrelid = 'storage.objects'::regclass and contype = 'f';
  raise notice 'ok v3.14-7: the clean-up finds live, trashed and purged pieces by kind; Trash keeps its photo ids, Delete forever keeps none; nothing points into a deleted account''s folder; the service role deletes personal photos by name and nothing else (storage.objects has % foreign key(s) here, a stub; unverified on Supabase)', fks;
end $$;
commit;

-- ===== v3.16 per-note sharing =====
-- 20260925000000_v3_16_note_sharing: a note is its owner's until they share it.
-- The policy decides, not the client, so nothing downstream can leak one by
-- forgetting to filter — and sync_posts answers `peerNotes` so that the person
-- already holding a copy learns when it is taken back. Un-sharing is invisible
-- otherwise: a row a reader may no longer select is simply absent from their
-- delta, which is what "nothing changed" looks like.

-- --------------------------- v3.16-1. the owner's private note stays the owner's
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated","email":"owner@example.test"}', true);
do $$
declare r jsonb; ids text[];
begin
  r := public.sync_posts('[
    {"kind":"note","id":"note-diary","title":"Not for sharing","body":"<p>Only mine</p>","createdAt":"2026-09-18T09:00:00.000Z","updatedAt":"2026-09-18T09:00:00.000Z"},
    {"kind":"note","id":"note-false","title":"Explicitly not","body":"<p>Also mine</p>","shared":false,"createdAt":"2026-09-18T09:00:00.000Z","updatedAt":"2026-09-18T09:00:00.000Z"}
  ]'::jsonb, '2099-01-01');
  if jsonb_array_length(r -> 'rejected') <> 0 then
    raise exception 'FAIL v3.16-1: sync_posts rejected the owner''s own notes: %', r -> 'rejected';
  end if;
  r := public.sync_posts('[]'::jsonb, null);
  select array_agg(x ->> 'id') into ids from jsonb_array_elements(r -> 'items') x;
  if not ('note-diary' = any(ids)) or not ('note-false' = any(ids)) then
    raise exception 'FAIL v3.16-1: the owner must always read their own notes, saw %', ids;
  end if;
  -- peerNotes is about OTHER people's notes; the owner's own are never in it
  if (r -> 'peerNotes') @> '["note-diary"]'::jsonb or (r -> 'peerNotes') @> '["note-paint"]'::jsonb then
    raise exception 'FAIL v3.16-1: peerNotes named the caller''s own note: %', r -> 'peerNotes';
  end if;
  raise notice 'ok v3.16-1: a note with no flag, and one with shared:false, are the owner''s to read and nobody''s to see';
end $$;
commit;

-- ---------------- v3.16-2. a peer reads the shared note and not the private ones
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000b","role":"authenticated","email":"peer@example.test"}', true);
do $$
declare r jsonb; ids text[];
begin
  r := public.sync_posts('[]'::jsonb, null);
  select coalesce(array_agg(x ->> 'id'), '{}') into ids from jsonb_array_elements(r -> 'items') x;
  if 'note-diary' = any(ids) or 'note-false' = any(ids) then
    raise exception 'FAIL v3.16-2: a peer''s pull returned a private note, saw %', ids;
  end if;
  if not ('note-paint' = any(ids)) then
    raise exception 'FAIL v3.16-2: a peer''s pull should still return the shared note, saw %', ids;
  end if;
  if (select count(*) from public.posts where id in ('note-diary', 'note-false')) <> 0 then
    raise exception 'FAIL v3.16-2: a direct select shows the peer a private note';
  end if;
  -- the whole set of the owner's notes this peer may read, whatever the cursor
  if not ((r -> 'peerNotes') @> '["note-paint"]'::jsonb) then
    raise exception 'FAIL v3.16-2: peerNotes should name the shared note, got %', r -> 'peerNotes';
  end if;
  if (r -> 'peerNotes') @> '["note-diary"]'::jsonb or (r -> 'peerNotes') @> '["note-false"]'::jsonb then
    raise exception 'FAIL v3.16-2: peerNotes named a private note, got %', r -> 'peerNotes';
  end if;
  -- a write onto a note it cannot read is refused, so a private note cannot be taken over
  r := public.sync_posts('[{"kind":"note","id":"note-diary","title":"Mine now","body":"","shared":true,"createdAt":"2026-09-18T09:00:00.000Z","updatedAt":"2026-09-18T12:00:00.000Z"}]'::jsonb, '2099-01-01');
  if not (r -> 'rejected') @> '["note-diary"]'::jsonb then
    raise exception 'FAIL v3.16-2: a peer''s write onto a private note should be rejected, got %', r;
  end if;
  -- and a peer may not un-share what is not theirs: the with check refuses it
  r := public.sync_posts('[{"kind":"note","id":"note-paint","title":"Paint colours","body":"<p>Sage</p>","projectId":"p1","pinned":true,"createdAt":"2026-09-12T09:00:00.000Z","updatedAt":"2026-09-18T12:00:00.000Z"}]'::jsonb, '2099-01-01');
  if not (r -> 'rejected') @> '["note-paint"]'::jsonb then
    raise exception 'FAIL v3.16-2: a peer un-shared the owner''s note, got %', r;
  end if;
  raise notice 'ok v3.16-2: a peer reads the shared note only, is named it in peerNotes, and can neither take a private note nor un-share a shared one';
end $$;
commit;
do $$
begin
  if (select data ->> 'title' from public.posts where id = 'note-diary') is distinct from 'Not for sharing' then
    raise exception 'FAIL v3.16-2: the private note was changed by a peer';
  end if;
  if coalesce((select data ->> 'shared' from public.posts where id = 'note-paint'), 'false') <> 'true' then
    raise exception 'FAIL v3.16-2: the shared note came back un-shared after the peer''s refused write';
  end if;
end $$;

-- ------------------------------ v3.16-3. un-sharing reaches the peer holding it
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated","email":"owner@example.test"}', true);
do $$
declare r jsonb;
begin
  r := public.sync_posts('[
    {"kind":"note","id":"note-paint","title":"Paint colours","body":"<p>Sage for the hall</p>","projectId":"p1","pinned":true,"createdAt":"2026-09-12T09:00:00.000Z","updatedAt":"2026-09-18T13:00:00.000Z"}
  ]'::jsonb, '2099-01-01');
  if jsonb_array_length(r -> 'rejected') <> 0 then
    raise exception 'FAIL v3.16-3: the owner could not un-share their own note: %', r -> 'rejected';
  end if;
end $$;
commit;
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000b","role":"authenticated","email":"peer@example.test"}', true);
do $$
declare r jsonb; ids text[];
begin
  -- the delta a device with a cursor asks for: the un-shared note cannot be in
  -- it, which is exactly why peerNotes has to be there
  r := public.sync_posts('[]'::jsonb, '2026-09-18T00:00:00.000Z');
  select coalesce(array_agg(x ->> 'id'), '{}') into ids from jsonb_array_elements(r -> 'items') x;
  if 'note-paint' = any(ids) then
    raise exception 'FAIL v3.16-3: the un-shared note came back in the peer''s delta, saw %', ids;
  end if;
  if (r -> 'peerNotes') @> '["note-paint"]'::jsonb then
    raise exception 'FAIL v3.16-3: peerNotes still names the un-shared note, got %', r -> 'peerNotes';
  end if;
  if (select count(*) from public.posts where id = 'note-paint') <> 0 then
    raise exception 'FAIL v3.16-3: a direct select still shows the peer the un-shared note';
  end if;
  raise notice 'ok v3.16-3: un-sharing takes the note out of the peer''s reach, and peerNotes is how their cached copy finds out';
end $$;
commit;

-- ===== v3.17 note transfers =====
-- 20260926000000_v3_17_note_transfers: the two places a note's audience is
-- decided by something other than the posts policy — an account being deleted,
-- and a "Delete forever" tombstone.

-- ---------------------- v3.17-1. an heir inherits the shared note, not the rest
-- A member of the owner's household who is about to leave for good. ...000d was
-- deleted back at step 14, so this needs an account of its own.
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000a7', 'leaver@example.test');
insert into public.household_members (household_id, user_id, role) values
  ('00000000-0000-0000-0000-0000000000f0', '00000000-0000-0000-0000-0000000000a7', 'member');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a7","role":"authenticated","email":"leaver@example.test"}', true);
do $$
declare r jsonb;
begin
  r := public.sync_posts('[
    {"kind":"note","id":"leaver-open","title":"Rota","body":"<p>Shared</p>","shared":true,"createdAt":"2026-09-18T09:00:00.000Z","updatedAt":"2026-09-18T09:00:00.000Z"},
    {"kind":"note","id":"leaver-shut","title":"Diary-ish","body":"<p>Mine</p>","createdAt":"2026-09-18T09:00:00.000Z","updatedAt":"2026-09-18T09:00:00.000Z"},
    {"kind":"note","id":"leaver-false","title":"Also mine","body":"<p>Mine</p>","shared":false,"createdAt":"2026-09-18T09:00:00.000Z","updatedAt":"2026-09-18T09:00:00.000Z"},
    {"kind":"task","id":"leaver-task","title":"Bins","description":"","status":"todo","priority":"normal","tags":[],"createdAt":"2026-09-18T09:00:00.000Z","updatedAt":"2026-09-18T09:00:00.000Z"}
  ]'::jsonb, '2099-01-01');
  if jsonb_array_length(r -> 'rejected') <> 0 then
    raise exception 'FAIL v3.17-1: the leaver could not store their own rows: %', r -> 'rejected';
  end if;
  -- a second version of the shared note, so there is history to reason about
  r := public.sync_posts('[
    {"kind":"note","id":"leaver-open","title":"Rota","body":"<p>Shared, edited</p>","shared":true,"createdAt":"2026-09-18T09:00:00.000Z","updatedAt":"2026-09-18T10:00:00.000Z"}
  ]'::jsonb, '2099-01-01');
  if jsonb_array_length(r -> 'rejected') <> 0 then
    raise exception 'FAIL v3.17-1: the leaver could not edit their own note: %', r -> 'rejected';
  end if;
end $$;
commit;
begin;
set local role service_role;
do $$
declare r jsonb; n integer;
begin
  r := public.admin_prepare_user_deletion('00000000-0000-0000-0000-0000000000a7', '00000000-0000-0000-0000-00000000000a');
  -- the two private notes are deleted, like a personal kind
  select count(*) into n from public.posts where id in ('leaver-shut', 'leaver-false');
  if n <> 0 then
    raise exception 'FAIL v3.17-1: an heir inherited % note(s) their author never shared', n;
  end if;
  -- the shared note and the task pass to the heir, because both are household work
  if (select user_id from public.posts where id = 'leaver-open') is distinct from '00000000-0000-0000-0000-00000000000a'
     or (select user_id from public.posts where id = 'leaver-task') is distinct from '00000000-0000-0000-0000-00000000000a' then
    raise exception 'FAIL v3.17-1: the shared note or the task did not reach the heir';
  end if;
  -- and no version of any note of theirs went with it: a draft's audience was never decided
  select count(*) into n from public.posts_history where id in ('leaver-open', 'leaver-shut', 'leaver-false');
  if n <> 0 then
    raise exception 'FAIL v3.17-1: % note version(s) survived the deletion', n;
  end if;
  raise notice 'ok v3.17-1: an heir gets the shared note and the task, never a private note, and never a note''s drafts (%)', r;
end $$;
commit;

-- ------------- v3.17-2. a purge tombstone that keeps the flag may still be written
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated","email":"owner@example.test"}', true);
do $$
declare r jsonb;
begin
  r := public.sync_posts('[
    {"kind":"note","id":"note-purge","title":"To be purged","body":"<p>text</p>","shared":true,"createdAt":"2026-09-18T09:00:00.000Z","updatedAt":"2026-09-18T09:00:00.000Z"}
  ]'::jsonb, '2099-01-01');
  if jsonb_array_length(r -> 'rejected') <> 0 then
    raise exception 'FAIL v3.17-2: the owner could not store the note: %', r -> 'rejected';
  end if;
end $$;
commit;
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000b","role":"authenticated","email":"peer@example.test"}', true);
do $$
declare r jsonb;
begin
  -- What "Delete forever" writes: a content-free tombstone. Without the flag
  -- the with check refuses it — the row would sit dirty on the peer's device
  -- for good, which is what src/syncengine.ts purge() now prevents by copying
  -- `shared` onto the tombstone.
  r := public.sync_posts('[
    {"kind":"note","id":"note-purge","title":"","body":"","deletedAt":"2026-09-18T11:00:00.000Z","purged":true,"createdAt":"2026-09-18T11:00:00.000Z","updatedAt":"2026-09-18T11:00:00.000Z"}
  ]'::jsonb, '2099-01-01');
  if not (r -> 'rejected') @> '["note-purge"]'::jsonb then
    raise exception 'FAIL v3.17-2: a flagless tombstone should be refused — that is the bug being guarded, got %', r;
  end if;
  -- the same tombstone, carrying the flag the row it replaces had
  r := public.sync_posts('[
    {"kind":"note","id":"note-purge","title":"","body":"","shared":true,"deletedAt":"2026-09-18T11:00:00.000Z","purged":true,"createdAt":"2026-09-18T11:00:00.000Z","updatedAt":"2026-09-18T11:00:00.000Z"}
  ]'::jsonb, '2099-01-01');
  if jsonb_array_length(r -> 'rejected') <> 0 then
    raise exception 'FAIL v3.17-2: a peer could not purge a note its owner shared with them: %', r -> 'rejected';
  end if;
  raise notice 'ok v3.17-2: Delete forever on a shared note lands when its tombstone keeps the flag, and is refused without it';
end $$;
commit;
