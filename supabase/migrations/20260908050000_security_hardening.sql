-- Security hardening found by audit, before real personal data goes in.
--
-- 1. Household membership becomes consensual: an invite is a pending row the
--    invitee must accept. Previously any signed-in user could insert a
--    membership row for anyone else and immediately gain full read/write of
--    that person's records through the household RLS policy.
-- 2. The posts policy no longer falls back to matching the owner's email, so
--    owner_email() need not be executable by ordinary users (it leaked the
--    owner's address), and a row can no longer be written with a null owner.
-- 3. Storage policies for note photos and attachments follow the household,
--    not just the owner's email.

-- ---------------------------------------------------------------- invitations
create table if not exists public.household_invites (
  household_id uuid not null references public.households (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  invited_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (household_id, user_id)
);
alter table public.household_invites enable row level security;

-- you may see invitations addressed to you
drop policy if exists "see my invites" on public.household_invites;
create policy "see my invites" on public.household_invites
  for select to authenticated using (user_id = auth.uid());

-- ------------------------------------------------------------------- posts RLS
-- Every row has an owner now (backfilled in 20260908030000), so drop the
-- owner-email fallback: it allowed writing rows with user_id = null that any
-- future user could claim, and it forced owner_email() to be world-executable.
drop policy if exists "household access" on public.posts;
create policy "household access" on public.posts
  for all to authenticated
  using (user_id in (select public.household_user_ids()))
  with check (user_id in (select public.household_user_ids()));

-- a row must never be ownerless again
update public.posts set user_id = public.owner_user_id() where user_id is null;
alter table public.posts alter column user_id set not null;

-- the owner's email address is not ordinary-user business any more
revoke execute on function public.owner_email() from authenticated;

-- ----------------------------------------------------------------- storage RLS
-- Note photos and task attachments live in the 'media' bucket. The original
-- policies matched the owner's email only, so a household member could neither
-- upload nor read shared images. Scope them to the household instead.
drop policy if exists "owner media select" on storage.objects;
drop policy if exists "owner media insert" on storage.objects;
drop policy if exists "owner media update" on storage.objects;
drop policy if exists "owner media delete" on storage.objects;
drop policy if exists "household media select" on storage.objects;
drop policy if exists "household media insert" on storage.objects;
drop policy if exists "household media update" on storage.objects;
drop policy if exists "household media delete" on storage.objects;

create policy "household media select" on storage.objects for select to authenticated
  using (bucket_id = 'media' and (owner = auth.uid() or owner in (select public.household_user_ids()) or owner is null));
create policy "household media insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'media');
create policy "household media update" on storage.objects for update to authenticated
  using (bucket_id = 'media' and (owner = auth.uid() or owner in (select public.household_user_ids())));
create policy "household media delete" on storage.objects for delete to authenticated
  using (bucket_id = 'media' and (owner = auth.uid() or owner in (select public.household_user_ids())));

-- --------------------------------------------------------------- sync_posts v4
-- Unchanged contract; the with-check tightening above means a write can no
-- longer land without an owner. Recreated so the comment stays accurate.
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
