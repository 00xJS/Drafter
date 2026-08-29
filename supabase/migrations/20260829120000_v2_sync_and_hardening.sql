-- v2 hardening: the last-write-wins rule moves into the database (so raw REST
-- writers can't clobber newer data), sync_posts gains a delta cursor and input
-- validation, and media gets an owner-scoped storage bucket.

-- 1. LWW enforced for every write path, not just the RPC.
create or replace function public.enforce_lww()
returns trigger
language plpgsql
as $$
begin
  if new.updated_at <= old.updated_at then
    raise exception 'stale write rejected: updated_at must be strictly newer (last-write-wins)';
  end if;
  return new;
end;
$$;

drop trigger if exists posts_lww on public.posts;
create trigger posts_lww before update on public.posts
  for each row execute function public.enforce_lww();

-- 2. sync_posts v2: optional `since` cursor for delta sync (null = full
--    exchange, which is what pre-v2 clients send), plus validation — invalid
--    items are skipped instead of stored verbatim.
drop function if exists public.sync_posts(jsonb);
drop function if exists public.sync_posts(jsonb, timestamptz);

create function public.sync_posts(incoming jsonb, since timestamptz default null)
returns jsonb
language plpgsql
as $$
declare
  item jsonb;
  stamp timestamptz;
begin
  if jsonb_typeof(incoming) = 'array' then
    for item in select value from jsonb_array_elements(incoming) loop
      begin
        if (item ? 'id') and (item ? 'updatedAt')
           and (not item ? 'status'
                or item->>'status' in ('idea','draft','scheduled','posted','canceled')) then
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

-- 3. Owner-scoped media bucket (images sync across devices; backup-complete).
insert into storage.buckets (id, name, public)
values ('media', 'media', false)
on conflict (id) do nothing;

drop policy if exists "owner media select" on storage.objects;
drop policy if exists "owner media insert" on storage.objects;
drop policy if exists "owner media update" on storage.objects;
drop policy if exists "owner media delete" on storage.objects;

create policy "owner media select" on storage.objects for select to authenticated
  using (bucket_id = 'media' and (auth.jwt() ->> 'email') = public.owner_email());
create policy "owner media insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'media' and (auth.jwt() ->> 'email') = public.owner_email());
create policy "owner media update" on storage.objects for update to authenticated
  using (bucket_id = 'media' and (auth.jwt() ->> 'email') = public.owner_email());
create policy "owner media delete" on storage.objects for delete to authenticated
  using (bucket_id = 'media' and (auth.jwt() ->> 'email') = public.owner_email());
