-- v3.29: making it safe to run.
--
-- Two small tables, both the service role's alone — RLS on, no policies,
-- revoked from anon and authenticated, and granted to the service role
-- explicitly (supabase/config.toml: new public tables are no longer exposed by
-- default). The same deny-all shape as user_settings and agent_tokens.
--
--   client_errors  what broke on a device. /api/log (netlify/functions/log.mjs)
--                  writes it for a signed-in account, one row per distinct
--                  error, counting repeats; Admin → Data lists it; the nightly
--                  backup deletes a row nobody has hit for 30 days. A row holds
--                  the error's message and stack, the build, web or the iOS
--                  shell, which screen and the page's path — never a record.
--                  shared/errorreport.mjs is what may go in it.
--
--   job_runs       the last run of each scheduled job (the nightly backup, the
--                  hourly digest): when, whether it worked, its counts and the
--                  first few failures. The owner's Today shows a banner when a
--                  job stops or fails (src/syncalarm.ts).
--
-- Neither is read by the app directly: Admin reads both through /api/admin with
-- the service key. Code deployed before this migration is applied loses
-- nothing — /api/log stores nothing and the jobs skip their record — so the
-- order does not matter, but the error list and the job records start here.

-- ----------------------------------------------------------- client_errors
create table if not exists public.client_errors (
  id uuid primary key default gen_random_uuid(),
  -- who hit it last; an account deleted later leaves its errors behind, unnamed
  user_id uuid references auth.users (id) on delete set null,
  -- shared/errorreport.mjs fingerprintOf: the message and the frame it was
  -- thrown from, on one platform — never the build, so a bug that outlives a
  -- deploy stays one row
  fingerprint text not null unique,
  first_at timestamptz not null default now(),
  last_at timestamptz not null default now(),
  count integer not null default 1 check (count > 0),
  build text check (build is null or char_length(build) <= 64),
  platform text check (platform is null or char_length(platform) <= 16),
  view text check (view is null or char_length(view) <= 32),
  message text not null check (char_length(message) between 1 and 500),
  stack text check (stack is null or char_length(stack) <= 4096),
  path text check (path is null or char_length(path) <= 200)
);

-- Admin lists the most recent first, and the nightly purge cuts by last_at
create index if not exists client_errors_recent_idx on public.client_errors (last_at desc);

alter table public.client_errors enable row level security;   -- no policies: service role only
revoke all on public.client_errors from anon, authenticated;
grant select, insert, update, delete on public.client_errors to service_role;

-- One statement per batch: a report whose fingerprint is already here adds its
-- count and becomes the row's latest (build, screen, stack); a new one is a new
-- row. Reports in one batch that share a fingerprint are summed first, since
-- ON CONFLICT may touch a row only once per statement. The parameters carry a
-- p_ prefix because a SQL function's parameter named after a column is read as
-- the column.
create or replace function public.log_client_errors(p_user uuid, p_reports jsonb)
returns integer
language sql
set search_path = public
as $$
  with incoming as (
    select left(e.r ->> 'fingerprint', 64) as fp,
           left(e.r ->> 'message', 500) as msg,
           left(e.r ->> 'stack', 4096) as trace,
           left(e.r ->> 'build', 64) as build_id,
           left(e.r ->> 'platform', 16) as platform_name,
           left(e.r ->> 'view', 32) as view_name,
           left(e.r ->> 'path', 200) as page_path,
           case when (e.r ->> 'count') ~ '^[0-9]{1,6}$' then least(greatest((e.r ->> 'count')::integer, 1), 1000) else 1 end as n,
           e.pos
      from jsonb_array_elements(case when jsonb_typeof(p_reports) = 'array' then p_reports else '[]'::jsonb end) with ordinality as e(r, pos)
     where jsonb_typeof(e.r) = 'object'
       and coalesce(e.r ->> 'fingerprint', '') <> ''
       and coalesce(e.r ->> 'message', '') <> ''
  ), merged as (
    select distinct on (fp) fp, msg, trace, build_id, platform_name, view_name, page_path,
           least(sum(n) over (partition by fp), 1000000)::integer as total
      from incoming
     order by fp, pos desc
  ), stored as (
    insert into public.client_errors as c (user_id, fingerprint, message, stack, build, platform, view, path, count)
    select p_user, fp, msg, trace, build_id, platform_name, view_name, page_path, total from merged
    on conflict (fingerprint) do update
       set last_at = now(),
           count = least(c.count::bigint + excluded.count, 2147483647)::integer,
           user_id = excluded.user_id,
           message = excluded.message,
           stack = excluded.stack,
           build = excluded.build,
           platform = excluded.platform,
           view = excluded.view,
           path = excluded.path
    returning 1
  )
  select count(*)::integer from stored
$$;

revoke execute on function public.log_client_errors(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.log_client_errors(uuid, jsonb) to service_role;

-- ---------------------------------------------------------------- job_runs
create table if not exists public.job_runs (
  job text primary key,
  ran_at timestamptz not null,
  ok boolean not null,
  counts jsonb not null default '{}'::jsonb,
  -- the first few messages; failure_count says how many there were
  failures jsonb not null default '[]'::jsonb,
  failure_count integer not null default 0,
  -- the first run of the current streak of failures; null while it works
  failing_since timestamptz,
  last_ok_at timestamptz,
  -- the backup's: the last run that wrote every snapshot, whatever else failed
  last_good_at timestamptz
);

alter table public.job_runs enable row level security;   -- no policies: service role only
revoke all on public.job_runs from anon, authenticated;
grant select, insert, update, delete on public.job_runs to service_role;
