-- v3.31: one table decides the record kinds.
--
-- HOW TO ADD A KIND FROM NOW ON: one migration, and nothing redefined —
--
--   insert into public.record_kinds (kind, personal, shared_default)
--   values ('<kind>', false, null)
--   on conflict (kind) do nothing;
--
-- `personal` true keeps every row of the kind to its owner, even inside a
-- household. `shared_default` null means the kind's audience is not decided
-- per record; true or false means each row decides with its own `shared`,
-- and this is what a row that carries none means. Then the code's lists:
-- SYNC_KINDS, and PERSONAL_KINDS or SHARED_BY_DEFAULT, in shared/kinds.mjs,
-- and the bot's copies in supabase/functions/bot/index.ts, which
-- src/__tests__/srv-kinds.test.ts and mcp.test.ts hold to this table. Apply it
-- BEFORE the client build that writes the kind: sync_posts refuses a kind it
-- has not been told about, and the client re-pushes a refused row forever.
--
-- Why. Every kind used to be written into the database four times over —
-- sync_posts' allowlist, the "household access" policy's personal list and
-- per-record clauses, account deletion's copies of both, and
-- posts_private_flag's — and sync_posts alone was redefined in 21 migrations
-- to add a word to one line. Those now read public.record_kinds through the
-- helpers below. This is a refactor: the table is seeded with exactly what
-- the v3.27 definitions enforce (the guard below refuses to apply otherwise),
-- and every signature, grant, return shape and outcome stays the same.
--
-- What still names kinds, on purpose:
--   * sync_posts' status check for a task and a project — validation of a
--     field, not which kinds exist;
--   * sync_posts' `peerNotes` (note) and `peerShared` (note, task) — the
--     revocation lists the shipped clients read (peerVisibleByKind in
--     src/sync.ts). A meal decides per record too and has never been listed;
--     listing it would change the answer, which a refactor does not;
--   * sync_canary, not redefined: its CASE only adds realistic fields, and
--     any other kind, one added by an insert included, goes through its
--     `else '{}'`, which sync_posts accepts.
-- posts_history's policy is not redefined either: it has been your own rows
-- and nothing else since v3.15, with no kind in it.
--
-- One transaction, so a refusal changes nothing. The owner approves
-- `supabase db push`, after `supabase migration list --linked` and
-- `supabase db push --dry-run`.

begin;

-- ------------------------------------------------------------- record_kinds
-- RLS on, no policies, no privilege for a client role: the deny-all convention
-- of user_settings, purged_ids and agent_tokens. A client reads it only through
-- the SECURITY DEFINER helpers below; the service role may read it; only a
-- migration writes it.
create table if not exists public.record_kinds (
  kind text primary key,
  -- every row of the kind is its owner's alone, even inside a household
  personal boolean not null default false,
  -- null: the kind's audience is not decided per record. true or false: each
  -- row decides with its own `shared`, and this is what a row without one means
  shared_default boolean,
  constraint record_kinds_kind_format check (kind ~ '^[a-z][a-z0-9_]*$'),
  -- a personal kind is nobody else's whatever a row says, so it takes no default
  constraint record_kinds_personal_not_per_record check (not (personal and shared_default is not null))
);

alter table public.record_kinds enable row level security;
revoke all on public.record_kinds from public, anon, authenticated, service_role;
grant select on public.record_kinds to service_role;

comment on table public.record_kinds is
  'Every kind sync_posts stores and who may read it. Add a kind with an insert migration (see 20261008000000_v3_31_record_kinds.sql).';

-- Exactly what v3.27 enforces: the 22 kinds of its sync_posts allowlist, the
-- ten its posts policy keeps from a peer, the three whose audience it decides
-- per record.
insert into public.record_kinds (kind, personal, shared_default) values
  ('task',     false, true),   -- the household's until withheld (v3.19)
  ('project',  false, null),
  ('calendar', true,  null),   -- a subscription carries its feed token
  ('person',   false, null),
  ('place',    false, null),
  ('review',   true,  null),
  ('template', false, null),
  ('recipe',   false, null),
  ('meal',     false, true),   -- the week's food; a slot can be kept (v3.21, v3.22)
  ('grocery',  false, null),
  ('journal',  true,  null),
  ('event',    false, null),
  ('habit',    true,  null),
  ('routine',  true,  null),
  ('note',     false, false),  -- its owner's until shared (v3.16)
  ('garment',  true,  null),
  ('outfit',   true,  null),
  ('wear',     true,  null),
  ('snooze',   true,  null),
  ('message',  false, null),   -- the household's thread, by kind (v3.26)
  ('chat',     true,  null),   -- a turn with the assistant (v3.26)
  ('account',  false, null)
on conflict (kind) do nothing;

-- ---------------------------------------------------------------- the guard
-- The seed must be exactly what the definitions being replaced enforce, or
-- this refactor would quietly add, drop or re-decide a kind. So read them as
-- the database holds them — sync_posts' allowlist, the posts policy's personal
-- list and per-record clauses (both halves), account deletion's personal list
-- and posts_private_flag's kinds — and refuse on any difference.
do $$
declare
  posts_src text;
  deletion_src text;
  flag_src text;
  reads text;
  writes text;
  seed jsonb;
  live jsonb;
  k text;
  -- one per-record clause as pg_get_expr prints it: the kind, then its default
  per_record constant text := '<> ''([a-z_]+)''::text\) OR \(COALESCE\(\(data ->> ''shared''::text\), ''(true|false)''::text\) = ''true''::text\)';
begin
  select p.prosrc into posts_src from pg_proc p where p.oid = 'public.sync_posts(jsonb, timestamptz)'::regprocedure;
  -- applied once already: sync_posts asks the table, and no list is left to read
  if posts_src like '%record_kind_allowed%' then
    return;
  end if;
  select p.prosrc into deletion_src from pg_proc p where p.oid = 'public.admin_prepare_user_deletion(uuid, uuid)'::regprocedure;
  select p.prosrc into flag_src from pg_proc p where p.oid = 'public.posts_private_flag()'::regprocedure;
  select pg_get_expr(pol.polqual, pol.polrelid), pg_get_expr(pol.polwithcheck, pol.polrelid)
    into reads, writes
    from pg_policy pol
   where pol.polrelid = 'public.posts'::regclass and pol.polname = 'household access';

  seed := jsonb_build_object(
    'the sync_posts allowlist',
      (select jsonb_agg(r.kind order by r.kind) from public.record_kinds r),
    'the posts policy''s personal kinds',
      (select jsonb_agg(r.kind order by r.kind) from public.record_kinds r where r.personal),
    'account deletion''s personal kinds',
      (select jsonb_agg(r.kind order by r.kind) from public.record_kinds r where r.personal),
    'the posts policy''s per-record reads',
      (select jsonb_object_agg(r.kind, r.shared_default) from public.record_kinds r where r.shared_default is not null),
    'the posts policy''s per-record writes',
      (select jsonb_object_agg(r.kind, r.shared_default) from public.record_kinds r where r.shared_default is not null),
    'the kinds posts_private_flag keeps private',
      (select jsonb_agg(r.kind order by r.kind) from public.record_kinds r where r.shared_default));
  live := jsonb_build_object(
    'the sync_posts allowlist',
      (select jsonb_agg(m[1] order by m[1])
         from regexp_matches(substring(posts_src from 'item_kind in \(([^)]*)\)'), '''([a-z_]+)''', 'g') m),
    'the posts policy''s personal kinds',
      (select jsonb_agg(m[1] order by m[1])
         from regexp_matches(substring(reads from '<> ALL \(ARRAY\[([^]]*)\]\)'), '''([a-z_]+)''', 'g') m),
    'account deletion''s personal kinds',
      (select jsonb_agg(m[1] order by m[1])
         from regexp_matches(substring(deletion_src from 'personal constant text\[\] := array\[([^]]*)\]'), '''([a-z_]+)''', 'g') m),
    'the posts policy''s per-record reads',
      (select jsonb_object_agg(m[1], m[2]::boolean) from regexp_matches(reads, per_record, 'g') m),
    'the posts policy''s per-record writes',
      (select jsonb_object_agg(m[1], m[2]::boolean) from regexp_matches(writes, per_record, 'g') m),
    'the kinds posts_private_flag keeps private',
      (select jsonb_agg(m[1] order by m[1])
         from regexp_matches(substring(flag_src from '''task''\) in \(([^)]*)\)'), '''([a-z_]+)''', 'g') m));
  for k in select jsonb_object_keys(seed) loop
    if (live -> k) is distinct from (seed -> k) then
      raise exception 'v3.31 refused: record_kinds does not match % as the database enforces it now (seed %, live %). Nothing was changed.',
        k, seed -> k, live -> k;
    end if;
  end loop;
end $$;

-- ----------------------------------------------------------------- helpers
-- STABLE, SECURITY DEFINER, a fixed search_path, like purged_among(): the only
-- way a client role reads record_kinds, and none of them says more than the
-- app's own bundle does. A kind nobody has heard of is not personal and not
-- per record — exactly as it read when the lists were written out.

-- May sync_posts store a row of this kind?
create or replace function public.record_kind_allowed(p_kind text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.record_kinds r where r.kind = p_kind)
$$;

-- For a kind whose audience is decided per record, what a row without
-- `shared` means; null for any other kind.
create or replace function public.record_kind_shared_default(p_kind text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select r.shared_default from public.record_kinds r where r.kind = p_kind
$$;

-- Does the row's own `shared` leave it the household's? Always, for a kind
-- whose audience is not per record. The flag is compared as text, as the
-- policy always compared it (`data ->> 'shared'`): JSON true and the string
-- "true" share, and a JSON null is absent.
create or replace function public.record_shared(p_kind text, p_shared text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select coalesce(p_shared, r.shared_default::text) = 'true'
       from public.record_kinds r
      where r.kind = p_kind and r.shared_default is not null),
    true)
$$;

-- May a household member read someone else's row of this kind, carrying this
-- `shared`? Not if the kind is personal, and not if the row's own flag
-- withholds it.
create or replace function public.record_peer_visible(p_kind text, p_shared text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select not r.personal
            and (r.shared_default is null or coalesce(p_shared, r.shared_default::text) = 'true')
       from public.record_kinds r
      where r.kind = p_kind),
    true)
$$;

revoke execute on function public.record_kind_allowed(text) from public, anon;
revoke execute on function public.record_kind_shared_default(text) from public, anon;
revoke execute on function public.record_shared(text, text) from public, anon;
revoke execute on function public.record_peer_visible(text, text) from public, anon;
grant execute on function public.record_kind_allowed(text) to authenticated, service_role;
grant execute on function public.record_kind_shared_default(text) to authenticated, service_role;
grant execute on function public.record_shared(text, text) to authenticated, service_role;
grant execute on function public.record_peer_visible(text, text) to authenticated, service_role;

-- ------------------------------------------------------------------ sync_posts
-- The 20261005000000 body with the allowlist read from record_kinds. Nothing
-- else in it changes.
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
           -- record_kinds (v3.31): a kind added there is stored with nothing here redefined
           and public.record_kind_allowed(item_kind)
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
    -- Notes and tasks: the kinds the shipped clients revoke. Not read from
    -- record_kinds (a meal is per record and was never listed) — see the top.
    'peerShared', coalesce(
      (select jsonb_agg(p4.id) from public.posts p4 where p4.kind in ('note', 'task') and p4.user_id <> me),
      '[]'::jsonb
    )
  );
end;
$$;

revoke execute on function public.sync_posts(jsonb, timestamptz) from public, anon;
grant execute on function public.sync_posts(jsonb, timestamptz) to authenticated, service_role;

-- ------------------------------------------------------------ posts policy
-- The 20261004000000 body with its personal list and per-record clauses read
-- from record_kinds. The halves are the same as ever: a peer READS a row of a
-- kind that is not personal and that its own flag does not withhold; a peer's
-- WRITE onto somebody else's row must leave it shared, and does not look at
-- `personal` — it never did (the authorship gap is the owner's open question,
-- not this refactor's).
drop policy if exists "household access" on public.posts;
create policy "household access" on public.posts
  for all to authenticated
  using (
    user_id = auth.uid()
    or (
      user_id in (select public.household_user_ids())
      and public.record_peer_visible(coalesce(data ->> 'kind', 'task'), data ->> 'shared')
    )
  )
  with check (
    user_id in (select public.household_user_ids())
    and (
      user_id = auth.uid()
      or public.record_shared(coalesce(data ->> 'kind', 'task'), data ->> 'shared')
    )
  );

-- ------------------------------------------------------------ account deletion
-- The 20261004000000 body with its lists read from record_kinds. An heir gets
-- what the household could already read, and nothing else: rows a peer could
-- not see are deleted (a personal kind, a note never shared, a task or a meal
-- withheld). Versions go on the same rule, plus every version of a kind that is
-- private by default (a note: a draft's audience was never decided, v3.15) and
-- every version of a row that is withheld today (v3.20).
create or replace function public.admin_prepare_user_deletion(target uuid, heir uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  private_rows text[];
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

  -- rows of a kind the household shares by default (a task, a meal) that the
  -- account withheld
  private_rows := array(
    select p.id from public.posts p
     where p.user_id = target
       and public.record_kind_shared_default(coalesce(p.data ->> 'kind', 'task')) is true
       and not public.record_shared(coalesce(p.data ->> 'kind', 'task'), p.data ->> 'shared'));

  delete from public.posts_history h
   where h.user_id = target
     and (not public.record_peer_visible(coalesce(h.data ->> 'kind', 'task'), h.data ->> 'shared')
          or public.record_kind_shared_default(coalesce(h.data ->> 'kind', 'task')) is false
          or h.id = any (private_rows));
  get diagnostics history_removed = row_count;
  update public.posts_history h set user_id = heir where h.user_id = target;
  get diagnostics history_moved = row_count;

  delete from public.posts p
   where p.user_id = target
     and not public.record_peer_visible(coalesce(p.data ->> 'kind', 'task'), p.data ->> 'shared');
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

-- ------------------------------------------------ keeping a private row private
-- The 20261001000000 body with its kinds read from record_kinds: a write that
-- does not mention `shared` leaves a stored `false` where it is, for a kind the
-- household shares by default (a task, a meal). Not for a note, whose absent
-- key is how its owner un-shares it. The cheap tests go first, so the table is
-- asked only when a stored `false` meets a write without the flag.
create or replace function public.posts_private_flag()
returns trigger
language plpgsql
as $$
begin
  if old.data ->> 'shared' = 'false'
     and not (new.data ? 'shared')
     and coalesce(new.data ->> 'kind', 'task') = coalesce(old.data ->> 'kind', 'task')
     and public.record_kind_shared_default(coalesce(old.data ->> 'kind', 'task')) is true then
    new.data := jsonb_set(new.data, '{shared}', 'false'::jsonb);
  end if;
  return new;
end;
$$;

commit;
