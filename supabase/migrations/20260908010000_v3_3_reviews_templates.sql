-- v3.3: reviews and templates join the table. Only the kind allow-list changes.
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
           and kind in ('task', 'project', 'calendar', 'person', 'review', 'template')
           and (not item ? 'status'
                or (kind = 'project' and item->>'status' in ('active','paused','done','archived'))
                or (kind = 'task' and item->>'status' in
                      ('wishlist','todo','doing','blocked','done','canceled',
                       'idea','draft','scheduled','posted'))) then
          stamp := (item->>'updatedAt')::timestamptz;
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
