-- Post Pilot schema: one row per post, full post JSON in `data`,
-- key fields exposed as generated columns so bots can filter via plain REST.

create table if not exists public.posts (
  id text primary key,
  updated_at timestamptz not null,
  data jsonb not null,
  status text generated always as (data ->> 'status') stored,
  title text generated always as (data ->> 'title') stored,
  scheduled_for text generated always as (data ->> 'scheduledFor') stored,
  posted_at text generated always as (data ->> 'postedAt') stored,
  deleted boolean generated always as ((data ? 'deletedAt')) stored
);

create index if not exists posts_status_idx on public.posts (status);

-- Row level security: enabled with no policies here — the owner-scoped access
-- policy is created in the next migration, keyed to app_config so no personal
-- data lives in this repo. Bots use the service_role key, which bypasses RLS.
alter table public.posts enable row level security;

-- Last-write-wins sync: upsert each incoming post only if newer, return everything.
-- Both the app and bots should write through this so stale copies never clobber edits.
create or replace function public.sync_posts(incoming jsonb)
returns jsonb
language plpgsql
as $$
declare
  item jsonb;
begin
  if jsonb_typeof(incoming) = 'array' then
    for item in select value from jsonb_array_elements(incoming) loop
      if (item ? 'id') and (item ? 'updatedAt') then
        insert into public.posts as p (id, updated_at, data)
        values (item ->> 'id', (item ->> 'updatedAt')::timestamptz, item)
        on conflict (id) do update
          set updated_at = excluded.updated_at, data = excluded.data
          where excluded.updated_at > p.updated_at;
      end if;
    end loop;
  end if;
  return coalesce((select jsonb_agg(p2.data order by p2.updated_at) from public.posts p2), '[]'::jsonb);
end;
$$;

revoke execute on function public.sync_posts(jsonb) from public, anon;
grant execute on function public.sync_posts(jsonb) to authenticated, service_role;
