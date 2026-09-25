-- v3.34: a write the server makes for an account is that account's, and the
-- rate limits' sweep has an index.
--
-- ## 1. sync_posts_as
--
-- Email-in, Sunday's review draft, email-in's triage and the notices are
-- written by the Netlify functions with the service key. sync_posts has no
-- signed-in caller there (auth.uid() is null), so two things it did went to
-- the site owner when they were someone else's:
--
--   * a NEW row was born the site owner's, and the function handed it over
--     afterwards with a PATCH of user_id. Until that PATCH the site owner's
--     device could pull the row (the other member's forwarded email, whole)
--     and keep it; and the PATCH left synced_at where it was, so a device of
--     the new owner's that synced in between never heard of the row at all;
--   * a write that LOST to a newer copy was filed in posts_history under the
--     site owner (posts_history_record_loss), so the other member's email,
--     or their notice, could reach the site owner's Versions panel.
--
-- sync_posts_as(p_owner, incoming) is sync_posts written as p_owner, for the
-- service role alone: a new row is theirs from the instant it exists, with
-- the synced_at of that instant; a loss is filed under them; and a row stored
-- under anyone else is refused (it comes back in `rejected`) and never
-- touched, so a write for one account cannot land on another's. It answers
-- { items, rejected, stale, gone } as sync_posts does, with every row past
-- the cursor left out: `items` holds only a stale write's winner.
--
-- How, without a second copy of sync_posts: for the length of the call the
-- transaction names the account (the setting drafter.write_as). A BEFORE
-- INSERT trigger gives a new row to that account, and
-- posts_history_record_loss files a loss under it. Both read the setting only
-- where auth.uid() is null, which is the service role: a signed-in client
-- never meets it, whatever it sends, and its rows and its losses are its own
-- exactly as before. A client cannot set it either (PostgREST sets no such
-- setting from a request). The plain sync_posts under the service key (the
-- bot, the sync canary) is unchanged: it writes, and loses, as the site
-- owner, which is who the bot acts for.
--
-- ## 2. rate_limits (window_start)
--
-- rate_limit_take (v3.33) deletes every window over for a day on each call,
-- and nothing indexed window_start, so each call read the whole table.
-- Email-in counted every key it was sent before looking it up, so a flood of
-- made-up keys was a row each, and every count after it swept all of them.
-- Email-in no longer counts a key nobody holds; this index keeps the sweep a
-- lookup however many rows there are.
--
-- ## Deploy
--
-- Apply this BEFORE deploying the functions that call it. They also run
-- against a database without it: PostgREST answers 404 for a function it does
-- not have, and netlify/functions/lib/writeas.mjs then writes as it did
-- before (sync_posts, then the hand-over PATCH, which now moves synced_at from
-- the function's clock). Only this migration closes the two gaps above.
-- Everything here is safe to run twice.

-- --------------------------------------------------------- a new row's owner
create or replace function public.posts_write_as()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  named text;
begin
  -- the service role only: a signed-in caller's row is always its own
  if auth.uid() is null then
    named := nullif(current_setting('drafter.write_as', true), '');
    if named is not null then
      new.user_id := named::uuid;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists posts_write_as on public.posts;
create trigger posts_write_as
  before insert on public.posts
  for each row
  execute function public.posts_write_as();

-- ------------------------------------------------------------ a loss's owner
-- The 20260920000000 body with the named account between the caller and the
-- site owner. A signed-in caller's loss is still filed under the caller, so a
-- direct call still cannot put words in anyone else's history.
create or replace function public.posts_history_record_loss(post_id text, lost jsonb)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.posts_history (id, updated_at, user_id, data, replaced_at, reason)
  select p.id, (lost ->> 'updatedAt')::timestamptz,
         coalesce(auth.uid(), nullif(current_setting('drafter.write_as', true), '')::uuid, public.owner_user_id()),
         lost, now(), 'lost'
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

-- ------------------------------------------------------------- sync_posts_as
-- SECURITY INVOKER: it runs as the service role, which is already past every
-- policy, and grants nothing a caller did not have. The variables are not
-- named after posts' columns (a PL/pgSQL variable shadows a column).
create or replace function public.sync_posts_as(p_owner uuid, incoming jsonb)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  -- ids stored under someone other than p_owner: refused, never written
  theirs text[];
  mine jsonb;
  answer jsonb;
begin
  if p_owner is null then
    raise exception 'sync_posts_as: the account to write as is required' using errcode = '22023';
  end if;
  if auth.uid() is not null then
    raise exception 'sync_posts_as: for the service role only' using errcode = '42501';
  end if;
  if jsonb_typeof(incoming) is distinct from 'array' then
    return jsonb_build_object('items', '[]'::jsonb, 'rejected', '[]'::jsonb, 'stale', '[]'::jsonb, 'gone', '[]'::jsonb);
  end if;

  theirs := array(
    select distinct p.id
      from public.posts p
     where p.id in (select e.value ->> 'id' from jsonb_array_elements(incoming) e)
       and p.user_id is distinct from p_owner);
  mine := coalesce(
    (select jsonb_agg(e.value order by e.ordinality)
       from jsonb_array_elements(incoming) with ordinality e
      where (e.value ->> 'id') is null or not ((e.value ->> 'id') = any(theirs))),
    '[]'::jsonb);

  perform set_config('drafter.write_as', p_owner::text, true);
  -- a cursor past every row: the answer is the verdicts, and a stale write's winner
  answer := public.sync_posts(mine, 'infinity');
  perform set_config('drafter.write_as', '', true);

  return jsonb_build_object(
    'items', coalesce(answer -> 'items', '[]'::jsonb),
    'rejected', coalesce(answer -> 'rejected', '[]'::jsonb) || to_jsonb(theirs),
    'stale', coalesce(answer -> 'stale', '[]'::jsonb),
    'gone', coalesce(answer -> 'gone', '[]'::jsonb));
end;
$$;

revoke execute on function public.sync_posts_as(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.sync_posts_as(uuid, jsonb) to service_role;

-- ------------------------------------------------------ rate_limits' sweep
create index if not exists rate_limits_window_start_idx on public.rate_limits (window_start);
