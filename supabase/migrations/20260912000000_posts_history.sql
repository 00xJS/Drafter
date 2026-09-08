-- Record history: keep prior jsonb versions when posts.data changes so a
-- stale overwrite (device, MCP, or a sync race) can be restored from the editor.
-- Select is household-scoped; clients never insert. A nightly job (Netlify
-- backup) drops rows older than 60 days.

create table if not exists public.posts_history (
  id text not null,
  updated_at timestamptz not null,
  user_id uuid not null,
  data jsonb not null,
  replaced_at timestamptz not null default now()
);

create index if not exists posts_history_id_replaced_idx
  on public.posts_history (id, replaced_at desc);

create index if not exists posts_history_replaced_idx
  on public.posts_history (replaced_at);

alter table public.posts_history enable row level security;

drop policy if exists "household history select" on public.posts_history;
create policy "household history select" on public.posts_history
  for select to authenticated
  using (user_id in (select public.household_user_ids()));

-- no client insert/update/delete — only the trigger (and service role) write

create or replace function public.posts_history_capture()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.data is distinct from old.data then
    insert into public.posts_history (id, updated_at, user_id, data, replaced_at)
    values (old.id, old.updated_at, old.user_id, old.data, now());
  end if;
  return new;
end;
$$;

drop trigger if exists posts_history_before_update on public.posts;
create trigger posts_history_before_update
  before update on public.posts
  for each row
  execute function public.posts_history_capture();
