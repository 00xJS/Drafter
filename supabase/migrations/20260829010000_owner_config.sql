-- Owner-scoped access without hard-coding personal data in the repo:
-- the owner's email lives in app_config (service_role-only), and the posts
-- policy compares the session's email against it via a definer function.
--
-- After applying, set the owner once (service_role key):
--   POST /rest/v1/app_config  {"key": "owner_email", "value": "you@example.com"}
-- Until that row exists, no authenticated session can read or write posts.

create table if not exists public.app_config (
  key text primary key,
  value text not null
);

-- no policies on purpose: only service_role can touch it
alter table public.app_config enable row level security;

create or replace function public.owner_email()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select value from public.app_config where key = 'owner_email'
$$;

revoke execute on function public.owner_email() from public, anon;
grant execute on function public.owner_email() to authenticated;

drop policy if exists "owner full access" on public.posts;

create policy "owner full access" on public.posts
  for all to authenticated
  using ((auth.jwt() ->> 'email') = public.owner_email())
  with check ((auth.jwt() ->> 'email') = public.owner_email());
