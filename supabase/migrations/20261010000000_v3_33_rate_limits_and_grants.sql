-- v3.33: a rate limit every instance shares, and the grants every table relies
-- on written down.
--
-- ## 1. rate_limits
--
-- /api/ai spends the owner's NVIDIA and Anthropic quota, recipe import and
-- Find address fetch from our servers, and /api/log writes to client_errors.
-- Each capped its callers with a sliding window in the function's own memory
-- (netlify/functions/lib/ratelimit.mjs), and Netlify runs a function on
-- several instances and recycles them, so calls spread over cold starts were
-- never counted together. This is the shared count: one row per (subject,
-- bucket) — an account id, or 'site' for the Content-Security-Policy reports
-- that come with no account — and one statement that counts a call and says
-- whether it fits, the way agent_token_use counts a connection's minute.
--
-- The window starts at its first call and lasts p_window_seconds; a call past
-- the limit is refused and does not move it, so a caller that backs off is let
-- back in when it ends. The functions ask with the service key and fall back
-- to their own memory when the function is missing or slow, so code deployed
-- before this migration keeps working exactly as it did.
--
-- RLS on, no policies, revoked from anon and authenticated: the deny-all shape
-- of client_errors and agent_tokens. SECURITY DEFINER with the search path
-- fixed, and executable by the service role alone.
--
-- ## 2. Grants
--
-- supabase/config.toml: from 2026-10-30 a new public table reaches none of
-- anon, authenticated or service_role without an explicit GRANT. The tables
-- below were created before that and took their privileges from the old
-- default, so their migrations never granted anything. The default in
-- scripts/db-smoke-stubs.sql hid that; it is gone, and db-smoke-assert.sql
-- (v3.33-1) now holds every table to exactly what each role needs. This names
-- those needs where the database keeps them:
--
--   authenticated  posts: read, and write through sync_posts, which runs as
--                  its caller (and the realtime channel reads it too);
--                  posts_history: read, for the Versions panel; the
--                  household tables: read, which is what their policies say.
--   service_role   everything the Netlify functions, the nightly backup and
--                  the bot read and write.
--
-- Nothing is revoked. In production each grant restates what the old default
-- already gave, so this changes nothing there; the old default gave more (anon
-- and authenticated hold every privilege on these tables, with RLS doing the
-- refusing), and taking that back is a separate decision.

-- ---------------------------------------------------------------- rate_limits
create table if not exists public.rate_limits (
  -- an account id, or 'site' for a limit on everyone at once
  subject text not null check (char_length(subject) between 1 and 64),
  -- what is being limited: 'ai', 'log', 'recipe-import', 'geocode', 'csp-report'
  bucket text not null check (char_length(bucket) between 1 and 32),
  window_start timestamptz not null default now(),
  window_count integer not null default 1 check (window_count >= 0),
  primary key (subject, bucket)
);

alter table public.rate_limits enable row level security;   -- no policies: service role only
revoke all on public.rate_limits from anon, authenticated;
grant select, insert, update, delete on public.rate_limits to service_role;

-- One call counted, in one statement, so two instances asking at once meet a
-- row lock rather than both reading the same count. The count stops at one
-- past the limit: every call after that is refused alike, and the number never
-- runs away. Windows over for a day are deleted on the way, which keeps the
-- table at a row per account and bucket. The variables are not named after the
-- columns (a PL/pgSQL variable shadows a column of the same name).
create or replace function public.rate_limit_take(p_subject text, p_bucket text, p_limit integer, p_window_seconds integer)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  span interval;
  counted integer;
  started timestamptz;
begin
  if coalesce(p_subject, '') = '' or char_length(p_subject) > 64 or coalesce(p_bucket, '') = '' or char_length(p_bucket) > 32 then
    raise exception 'rate_limit_take: a subject of 1 to 64 characters and a bucket of 1 to 32 are required' using errcode = '22023';
  end if;
  if p_limit is null or p_limit < 1 or p_window_seconds is null or p_window_seconds < 1 or p_window_seconds > 86400 then
    raise exception 'rate_limit_take: the limit must be 1 or more and the window 1 to 86400 seconds' using errcode = '22023';
  end if;
  span := make_interval(secs => p_window_seconds);

  delete from public.rate_limits r where r.window_start < now() - interval '1 day';

  insert into public.rate_limits as r (subject, bucket, window_start, window_count)
  values (p_subject, p_bucket, now(), 1)
  on conflict (subject, bucket) do update
     set window_count = case when r.window_start > now() - span then least(r.window_count + 1, p_limit + 1) else 1 end,
         window_start = case when r.window_start > now() - span then r.window_start else now() end
  returning r.window_count, r.window_start into counted, started;

  return jsonb_build_object(
    'allowed', counted <= p_limit,
    'remaining', greatest(p_limit - counted, 0),
    'retry_after_ms', case when counted <= p_limit then 0
                           else greatest(0, ceil(extract(epoch from (started + span - now())) * 1000))::bigint end
  );
end;
$$;

revoke execute on function public.rate_limit_take(text, text, integer, integer) from public, anon, authenticated;
grant execute on function public.rate_limit_take(text, text, integer, integer) to service_role;

-- --------------------------------------------------------------------- grants
grant select, insert, update on public.posts to authenticated;
grant select on public.posts_history to authenticated;
grant select on public.households, public.household_members, public.household_invites to authenticated;

grant select, insert, update, delete on
  public.posts, public.posts_history, public.purged_ids, public.post_media,
  public.households, public.household_members, public.household_invites,
  public.user_settings, public.app_config
to service_role;
