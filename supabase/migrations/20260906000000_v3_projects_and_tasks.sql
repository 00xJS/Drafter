-- v3: the planner becomes project management. The `posts` table keeps its name
-- and shape (full record JSON in `data`), but a record is now a task or a
-- project, discriminated by data->>'kind'. Pre-v3 rows (social posts, no
-- `kind`) stay as they are: every reader converts them on read (the app via
-- schema.ts, the MCP server via shared/domain.mjs), so nothing is rewritten.

alter table public.posts
  add column if not exists kind text generated always as (coalesce(data ->> 'kind', 'task')) stored,
  add column if not exists project_id text generated always as (data ->> 'projectId') stored,
  -- a task's due date, or a legacy post's scheduled time
  add column if not exists due_at text generated always as (coalesce(data ->> 'dueAt', data ->> 'scheduledFor')) stored;

create index if not exists posts_kind_idx on public.posts (kind);
create index if not exists posts_project_idx on public.posts (project_id);

-- sync_posts v3: same contract, wider status validation (task, project and
-- legacy post statuses). Everything else — delta cursor, LWW upsert, future
-- timestamp clamp, skip-invalid — is unchanged.
create or replace function public.sync_posts(incoming jsonb, since timestamptz default null)
returns jsonb
language plpgsql
as $$
declare
  item jsonb;
  stamp timestamptz;
  kind text;
begin
  if jsonb_typeof(incoming) = 'array' then
    for item in select value from jsonb_array_elements(incoming) loop
      begin
        kind := coalesce(item->>'kind', 'task');
        if (item ? 'id') and (item ? 'updatedAt')
           and kind in ('task', 'project')
           and (not item ? 'status'
                or (kind = 'project' and item->>'status' in ('active','paused','done','archived'))
                or (kind = 'task' and item->>'status' in
                      ('wishlist','todo','doing','blocked','done','canceled',
                       'idea','draft','scheduled','posted'))) then
          stamp := (item->>'updatedAt')::timestamptz;
          -- clamp runaway future timestamps (clock-skewed or hallucinating bots)
          if stamp > now() + interval '5 minutes' then
            stamp := now();
            item := jsonb_set(item, '{updatedAt}', to_jsonb(to_char(stamp at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));
          end if;
          insert into public.posts as p (id, updated_at, data)
          values (item->>'id', stamp, item)
          on conflict (id) do update
            set updated_at = excluded.updated_at, data = excluded.data
            where excluded.updated_at > p.updated_at;
        end if;
      exception when others then
        -- unparseable timestamp or similar: skip the item, keep the batch
        null;
      end;
    end loop;
  end if;
  return coalesce(
    (select jsonb_agg(p2.data order by p2.updated_at)
       from public.posts p2
      where since is null or p2.updated_at > since),
    '[]'::jsonb
  );
end;
$$;

revoke execute on function public.sync_posts(jsonb, timestamptz) from public, anon;
grant execute on function public.sync_posts(jsonb, timestamptz) to authenticated, service_role;
