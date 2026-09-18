-- v3.19: a task can be kept to yourself, and says which it is.
--
-- "I want to see which tasks are shared vs which are private with a simple
-- glance." Tasks had no such thing: every task in a household was the
-- household's, and the only narrowing was Mine / Everyone, which filters by
-- who is doing it rather than who can see it.
--
-- So `shared` decides a task too, as it has decided a note since v3.16 — with
-- the OPPOSITE default, which is the whole of the difference between the two
-- kinds. A note is the place people write things down before deciding who they
-- are for, so it is private until shared. A task is household work: the board,
-- Today, the calendar and the ICS feed are all built on both members seeing
-- it, and 54 tasks written before today were written to be seen. So for a task
-- ABSENT reads as SHARED, and only an explicit `shared = false` withholds one.
--
--     note:  coalesce(data ->> 'shared', 'false') = 'true'
--     task:  coalesce(data ->> 'shared', 'true')  = 'true'
--
-- Nothing is migrated: every task already written keeps no flag and stays
-- shared, which is what it already was.
--
-- ## The second per-record kind
--
-- 20260925000000 named the three things a second one would have to widen, and
-- this is all three: the policy clause below, the `peerNotes` query in
-- sync_posts, and (in the client) revokedNotes' `kind !== 'note'` test. They
-- were deliberately not generalised ahead of a second case; now there is one,
-- and sync_posts answers `peerShared` — peer-owned rows of EITHER per-record
-- kind that the caller can see — beside the `peerNotes` it already answered.
--
-- Both are returned for one release. `peerNotes` is what every shipped client
-- reads, and the iOS app carries its own bundle: it lags the web by a build,
-- so dropping the old key would leave a phone unable to learn that a note had
-- been un-shared until someone rebuilt it. A new client prefers `peerShared`
-- and ignores `peerNotes`; an old one does the reverse; neither sees a key it
-- does not understand.
--
-- ## The flag has to survive a client that has never heard of it
--
-- This is where a task differs from a note in a way that matters. The app's
-- sanitizers are whitelists, so a build that predates a field DROPS it, and
-- sync_posts overwrites `data` wholesale. For a note that fails safe: an old
-- client strips `shared: true` and the note goes private, which loses the
-- owner's intent but discloses nothing. For a task it would fail OPEN — strip
-- `shared: false` and a private task is the household's again, silently, on
-- the owner's own phone, because a write onto your own row is one the `with
-- check` half has no reason to refuse.
--
-- So the database keeps the flag when a write does not mention it:
-- posts_private_flag below. An absent key means "this writer has nothing to
-- say about the audience", not "make it public". Both answers a v3.19 client
-- gives are explicit — `false` to withhold, `true` to overturn a stored
-- `false` — so nothing it does is ever mistaken for silence.

-- ------------------------------------------------------------ posts policy
-- The 20260925000000 body with the per-record clause widened to two kinds,
-- each with its own default. `for all` means this gates UPDATE and DELETE as
-- well: a peer cannot write to a task they cannot read, so making one private
-- is not something the other member can undo.
--
-- The `with check` half says the same thing about writes onto somebody else's
-- row: a peer's edit (or a stale client that strips the field) must leave a
-- task shared and a note shared. Only the owner decides otherwise, and the
-- owner's own writes are the branch above it.
drop policy if exists "household access" on public.posts;
create policy "household access" on public.posts
  for all to authenticated
  using (
    user_id = auth.uid()
    or (
      user_id in (select public.household_user_ids())
      and coalesce(data ->> 'kind', 'task') not in ('journal', 'review', 'calendar', 'habit', 'routine', 'garment', 'outfit', 'wear', 'meal')
      -- a note is private unless it says otherwise; a task is the household's unless it does
      and (coalesce(data ->> 'kind', 'task') <> 'note' or coalesce(data ->> 'shared', 'false') = 'true')
      and (coalesce(data ->> 'kind', 'task') <> 'task' or coalesce(data ->> 'shared', 'true') = 'true')
    )
  )
  with check (
    user_id in (select public.household_user_ids())
    and (
      user_id = auth.uid()
      or (
        (coalesce(data ->> 'kind', 'task') <> 'note' or coalesce(data ->> 'shared', 'false') = 'true')
        and (coalesce(data ->> 'kind', 'task') <> 'task' or coalesce(data ->> 'shared', 'true') = 'true')
      )
    )
  );

-- ------------------------------------------------- keeping a private task private
-- A write that does not mention `shared` leaves a stored `false` where it is.
-- Only a task: a note's absent key is how its owner UN-shares it (the client
-- writes the flag out rather than writing `false`), so the same rule there
-- would make un-sharing impossible. A task's client writes both answers out
-- loud precisely so that silence can mean what it says here.
--
-- Named after `posts_lww` on purpose: BEFORE triggers fire in name order, so
-- the last-write-wins guard still sees exactly what the client sent.
create or replace function public.posts_private_flag()
returns trigger
language plpgsql
as $$
begin
  if coalesce(old.data ->> 'kind', 'task') = 'task'
     and coalesce(new.data ->> 'kind', 'task') = 'task'
     and old.data ->> 'shared' = 'false'
     and not (new.data ? 'shared') then
    new.data := jsonb_set(new.data, '{shared}', 'false'::jsonb);
  end if;
  return new;
end;
$$;

drop trigger if exists posts_private_flag on public.posts;
create trigger posts_private_flag
  before update on public.posts
  for each row
  execute function public.posts_private_flag();

-- ------------------------------------------------------------------ sync_posts
-- The 20260925000000 body with `peerShared` added beside `peerNotes`. Nothing
-- else in it changes; it is repeated whole because a function is replaced whole.
create or replace function public.sync_posts(incoming jsonb, since timestamptz default null)
returns jsonb
language plpgsql
as $$
declare
  item jsonb;
  stamp timestamptz;
  -- not `kind`: posts has a generated column of that name (v3)
  item_kind text;
  me uuid := coalesce(auth.uid(), public.owner_user_id());
  rejected jsonb := '[]'::jsonb;
  -- not `id`: a PL/pgSQL variable of that name makes `on conflict (id)` ambiguous
  -- and every item lands in `rejected` (the shipped 20260911-14 bodies had this)
  item_id text;
  accepted boolean;
  -- null: stored, or already current; 'stale': lost to the stored row; 'gone': purged
  outcome text;
  written integer;
  winner jsonb;
  born timestamptz;
  purged_map jsonb;
  stale_ids text[] := '{}';
  gone_ids text[] := '{}';
begin
  if jsonb_typeof(incoming) = 'array' then
    purged_map := public.purged_among(array(select value ->> 'id' from jsonb_array_elements(incoming)));
    for item in select value from jsonb_array_elements(incoming) loop
      item_id := item->>'id';
      accepted := false;
      outcome := null;
      begin
        if purged_map ? item_id then
          -- created after its id was purged: a new record reusing a deterministic id
          begin
            born := (item->>'createdAt')::timestamptz;
          exception when others then
            born := null;
          end;
          if born is null or born <= (purged_map->>item_id)::timestamptz then
            outcome := 'gone';
          end if;
        end if;
        item_kind := coalesce(item->>'kind', 'task');
        if outcome is null
           and (item ? 'id') and (item ? 'updatedAt')
           and item_kind in ('task', 'project', 'calendar', 'person', 'place', 'review', 'template', 'recipe', 'meal', 'grocery', 'journal', 'event', 'habit', 'routine', 'note', 'garment', 'outfit', 'wear')
           and (not item ? 'status'
                or (item_kind = 'project' and item->>'status' in ('active','paused','done','archived'))
                or (item_kind = 'task' and item->>'status' in
                      ('wishlist','todo','doing','blocked','done','canceled',
                       'idea','draft','scheduled','posted'))) then
          stamp := (item->>'updatedAt')::timestamptz;
          if stamp > now() + interval '5 minutes' then
            stamp := now();
            item := jsonb_set(item, '{updatedAt}', to_jsonb(to_char(stamp at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));
          end if;
          item := item - 'ownerId' - 'syncedAt';
          insert into public.posts as p (id, updated_at, synced_at, data, user_id)
          values (item->>'id', stamp, clock_timestamp(), item, me)
          on conflict (id) do update
            set updated_at = excluded.updated_at,
                data = excluded.data,
                synced_at = clock_timestamp()
            where excluded.updated_at > p.updated_at;
          get diagnostics written = row_count;
          if written = 0 then
            -- the WHERE kept a stored row at least as new; read it as the caller
            select p.data into winner from public.posts p where p.id = item_id;
            if not found then
              raise exception 'stale write onto a row the caller cannot see';
            end if;
            if winner is distinct from item then
              perform public.posts_history_record_loss(item_id, item);
              outcome := 'stale';
            end if;
          end if;
          accepted := true;
        end if;
      exception when others then
        accepted := false;
        outcome := null;
      end;
      if outcome = 'gone' then
        if not (item_id = any(gone_ids)) then
          gone_ids := gone_ids || item_id;
        end if;
      elsif item_id is not null and not accepted then
        rejected := rejected || jsonb_build_array(item_id);
      elsif outcome = 'stale' and not (item_id = any(stale_ids)) then
        stale_ids := stale_ids || item_id;
      end if;
    end loop;
  end if;
  return jsonb_build_object(
    'items', coalesce(
      (select jsonb_agg(
                p2.data || jsonb_build_object(
                  'ownerId', p2.user_id,
                  'syncedAt', to_char(p2.synced_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
                )
                order by p2.synced_at
              )
         from public.posts p2
        where since is null or p2.synced_at > since
           -- a stale id's winner comes back whatever the cursor, so the client adopts it
           or p2.id = any(stale_ids)),
      '[]'::jsonb
    ),
    'rejected', rejected,
    'stale', to_jsonb(stale_ids),
    'gone', to_jsonb(gone_ids),
    -- v3.16's answer, kept for one release: a client that predates v3.19 reads
    -- this one, and the iOS bundle lags the web by a build.
    'peerNotes', coalesce(
      (select jsonb_agg(p3.id) from public.posts p3 where p3.kind = 'note' and p3.user_id <> me),
      '[]'::jsonb
    ),
    -- Every row of SOMEONE ELSE'S, of a kind whose audience is per record, that
    -- this account can see at this instant — whatever the cursor says. A cached
    -- peer row missing from it was withheld (or the household changed), and the
    -- client drops it. It is the only way a reader ever learns: a row they may
    -- no longer select is simply absent from their delta, which is exactly what
    -- "nothing changed" looks like.
    -- `kind` is the stored generated column, so posts_kind_idx serves this.
    'peerShared', coalesce(
      (select jsonb_agg(p4.id) from public.posts p4 where p4.kind in ('note', 'task') and p4.user_id <> me),
      '[]'::jsonb
    )
  );
end;
$$;

-- --------------------------------------------------- an heir inherits the work
-- The 20260926000000 body, with a private task treated as v3.17 treats an
-- unshared note: it was never the household's, so it is deleted with the
-- personal rows rather than handed to somebody else's account.
--
-- Its history goes with it. A note's versions are ALL deleted, shared or not,
-- because v3.15 refused to decide a draft's audience after the fact; a task's
-- are not, because a task's history is the household's record of household
-- work. But the versions of a task that is private NOW would otherwise outlive
-- the row and land in the heir's account, where posts_history's select policy
-- shows a household every version it holds — the content of a private task,
-- one editor panel away. So they go with the row they belong to.
create or replace function public.admin_prepare_user_deletion(target uuid, heir uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  personal constant text[] := array['journal', 'review', 'calendar', 'habit', 'routine', 'garment', 'outfit', 'wear', 'meal'];
  private_tasks text[];
  moved integer;
  removed integer;
  history_moved integer;
  history_removed integer;
begin
  if target is null or heir is null then
    raise exception 'admin_prepare_user_deletion: target and heir are both required';
  end if;
  if target = heir then
    raise exception 'admin_prepare_user_deletion: an account cannot inherit its own records';
  end if;
  if target = public.owner_user_id() then
    raise exception 'admin_prepare_user_deletion: refusing to prepare the site owner for deletion';
  end if;
  if not exists (select 1 from auth.users u where u.id = heir) then
    raise exception 'admin_prepare_user_deletion: the heir % has no account', heir;
  end if;

  -- read before the delete below takes the rows away
  private_tasks := array(
    select p.id from public.posts p
     where p.user_id = target
       and coalesce(p.data ->> 'kind', 'task') = 'task'
       and coalesce(p.data ->> 'shared', 'true') <> 'true');

  -- every version of every note goes, shared or not: a draft's audience was
  -- never decided, and deciding it now is what v3.15 refused to do
  delete from public.posts_history h
   where h.user_id = target
     and (coalesce(h.data ->> 'kind', 'task') = any (personal)
          or coalesce(h.data ->> 'kind', 'task') = 'note'
          or h.id = any (private_tasks));
  get diagnostics history_removed = row_count;
  update public.posts_history h set user_id = heir where h.user_id = target;
  get diagnostics history_moved = row_count;

  delete from public.posts p
   where p.user_id = target
     and (coalesce(p.data ->> 'kind', 'task') = any (personal)
          or (coalesce(p.data ->> 'kind', 'task') = 'note' and coalesce(p.data ->> 'shared', 'false') <> 'true')
          or (coalesce(p.data ->> 'kind', 'task') = 'task' and coalesce(p.data ->> 'shared', 'true') <> 'true'));
  get diagnostics removed = row_count;
  update public.posts p set user_id = heir, synced_at = clock_timestamp() where p.user_id = target;
  get diagnostics moved = row_count;

  return jsonb_build_object(
    'reassigned', moved,
    'deleted', removed,
    'historyReassigned', history_moved,
    'historyDeleted', history_removed
  );
end;
$$;

revoke execute on function public.admin_prepare_user_deletion(uuid, uuid) from public, anon, authenticated;
grant execute on function public.admin_prepare_user_deletion(uuid, uuid) to service_role;
