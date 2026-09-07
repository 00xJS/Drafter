-- Households: every record belongs to a user; members of the same household
-- see and edit each other's records. Replaces the single-owner-email policy.
-- Existing rows are assigned to the owner (app_config.owner_email).

-- 0. The last-write-wins trigger guarded EVERY update, including administrative
--    ones like the ownership backfill below (which leaves data untouched).
--    Narrow it to content writes: any change to data or updated_at still needs
--    a strictly newer stamp, so the protection is unchanged for real writers.
create or replace function public.enforce_lww()
returns trigger
language plpgsql
as $$
begin
  if (new.data is distinct from old.data or new.updated_at is distinct from old.updated_at)
     and new.updated_at <= old.updated_at then
    raise exception 'stale write rejected: updated_at must be strictly newer (last-write-wins)';
  end if;
  return new;
end;
$$;

-- 1. ownership column + backfill
alter table public.posts add column if not exists user_id uuid references auth.users (id) on delete set null;

create or replace function public.owner_user_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select u.id from auth.users u where u.email = public.owner_email() limit 1
$$;
revoke execute on function public.owner_user_id() from public, anon;
grant execute on function public.owner_user_id() to authenticated, service_role;

update public.posts set user_id = public.owner_user_id() where user_id is null;
create index if not exists posts_user_idx on public.posts (user_id);

-- 2. households
create table if not exists public.households (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);
create table if not exists public.household_members (
  household_id uuid not null references public.households (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null default 'member',
  joined_at timestamptz not null default now(),
  primary key (household_id, user_id)
);
alter table public.households enable row level security;
alter table public.household_members enable row level security;

-- security definer helpers avoid recursive policies
create or replace function public.my_household_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select household_id from public.household_members where user_id = auth.uid()
$$;
revoke execute on function public.my_household_ids() from public, anon;
grant execute on function public.my_household_ids() to authenticated;

/** Me plus everyone who shares a household with me. */
create or replace function public.household_user_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select auth.uid()
  union
  select m.user_id from public.household_members m where m.household_id in (select public.my_household_ids())
$$;
revoke execute on function public.household_user_ids() from public, anon;
grant execute on function public.household_user_ids() to authenticated;

drop policy if exists "members read households" on public.households;
create policy "members read households" on public.households
  for select to authenticated using (id in (select public.my_household_ids()));
drop policy if exists "members read members" on public.household_members;
create policy "members read members" on public.household_members
  for select to authenticated using (household_id in (select public.my_household_ids()));
-- membership changes go through the service-role function only

-- 3. posts policy: my records and my household's
drop policy if exists "owner full access" on public.posts;
drop policy if exists "household access" on public.posts;
create policy "household access" on public.posts
  for all to authenticated
  using (user_id in (select public.household_user_ids()) or (user_id is null and (auth.jwt() ->> 'email') = public.owner_email()))
  with check (user_id in (select public.household_user_ids()) or user_id is null);

-- 4. sync_posts stamps new rows with the caller (service role: the owner) and
--    returns ownerId alongside each record so the app knows whose it is.
create or replace function public.sync_posts(incoming jsonb, since timestamptz default null)
returns jsonb
language plpgsql
as $$
declare
  item jsonb;
  stamp timestamptz;
  kind text;
  me uuid := coalesce(auth.uid(), public.owner_user_id());
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
          item := item - 'ownerId';
          insert into public.posts as p (id, updated_at, data, user_id)
          values (item->>'id', stamp, item, me)
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
    (select jsonb_agg(p2.data || jsonb_build_object('ownerId', p2.user_id) order by p2.updated_at)
       from public.posts p2
      where since is null or p2.updated_at > since),
    '[]'::jsonb
  );
end;
$$;

revoke execute on function public.sync_posts(jsonb, timestamptz) from public, anon;
grant execute on function public.sync_posts(jsonb, timestamptz) to authenticated, service_role;
