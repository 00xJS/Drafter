-- v3.16: a note is yours until you share it.
--
-- Notes were household-wide, like tasks. That is the wrong default for the one
-- place in the app where people write things down before deciding who they are
-- for: "for each note, we want to be able to share or not share". So `shared`
-- on the note's data decides, and this file makes the DATABASE the thing that
-- decides — not the client. A peer's select cannot return an unshared note, so
-- no screen, no export, no agent and no future feature can leak one by
-- forgetting to filter.
--
-- Existing notes have no `shared`, so every note already written becomes
-- private to whoever wrote it. That is deliberate and was chosen: a note
-- written when notes were shared was not written to be shared forever, and
-- re-sharing is one tap.
--
-- ## Revoking
--
-- Un-sharing is the hard half. A peer holding a cached copy asks for rows
-- newer than its cursor; the note it can no longer see simply is not in the
-- answer, which is indistinguishable from "nothing changed". It would sit in
-- their Notes list forever.
--
-- The obvious fix — a share epoch on households, bumped by a trigger — was
-- designed and thrown away: sync_posts is SECURITY INVOKER, `households` has
-- only a SELECT policy, so the trigger's UPDATE would touch zero rows and
-- raise nothing. Revocation would look like it worked and not revoke.
--
-- What is done instead needs no new state at all. sync_posts already runs as
-- the caller under RLS, so it can simply say which of OTHER people's notes the
-- caller can see right now — `peerNotes` — computed in the same statement as
-- `items`, so the two can never disagree. A client drops any peer-owned note
-- that is not in that list. Nothing to bump, nothing to get out of step, and
-- it self-heals: whatever went wrong, the next round states the truth again.
--
-- Only peers' notes are listed, because only they can be revoked: your own
-- notes are visible to you whatever the flag says. In a household of two that
-- is a handful of ids per round.
--
-- `note` is the only kind that works this way. Every other kind is all or
-- nothing: task, project, person, place, template, recipe, grocery and event
-- are the household's, and the kinds in PERSONAL_KINDS are their owner's. A
-- second per-record kind would need this policy clause widened, the peerNotes
-- query widened, and the client's revokedNotes to stop testing kind === 'note'
-- — three places, deliberately named for what they do rather than generalised
-- ahead of a second case.
--
-- An old client ignores the new key and behaves exactly as it does today; a
-- new client against an old server sees no key and does not drop anything.
-- Both halves ship independently, which they do (Netlify and Supabase).

-- ------------------------------------------------------------ posts policy
-- The 20260924000000 body, with one clause: a peer sees a note only when its
-- owner shared it. Notes are NOT in the personal-kinds list — a shared note is
-- genuinely shared, and the household branch is where that is decided — so the
-- condition sits here rather than in shared/kinds.mjs.
--
-- `for all` means this also gates UPDATE and DELETE: a peer cannot write to a
-- note they cannot read, so un-sharing is not something another member can undo.
--
-- The `with check` half matters as much. A shared note is editable by the
-- household, like a task — and without a clause there, a peer's edit could
-- come back without `shared` and make somebody else's note private on their
-- behalf. A stale client that predates this migration would do exactly that,
-- since it strips the field it does not know. So a write onto a note that is
-- not yours has to leave it shared; only the owner decides otherwise.
drop policy if exists "household access" on public.posts;
create policy "household access" on public.posts
  for all to authenticated
  using (
    user_id = auth.uid()
    or (
      user_id in (select public.household_user_ids())
      and coalesce(data ->> 'kind', 'task') not in ('journal', 'review', 'calendar', 'habit', 'routine', 'garment', 'outfit', 'wear', 'meal')
      -- absent reads as not shared, which is what every note written before today has
      and (coalesce(data ->> 'kind', 'task') <> 'note' or coalesce(data ->> 'shared', 'false') = 'true')
    )
  )
  with check (
    user_id in (select public.household_user_ids())
    and (
      user_id = auth.uid()
      or coalesce(data ->> 'kind', 'task') <> 'note'
      or coalesce(data ->> 'shared', 'false') = 'true'
    )
  );

-- ------------------------------------------------------------------ sync_posts
-- The 20260923000000 body, with `peerNotes` added to the answer. Nothing else
-- in it changes; it is repeated whole because a function is replaced whole.
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
    -- Every note of SOMEONE ELSE'S this account can see at this instant,
    -- whatever the cursor says. A cached peer note missing from it was
    -- un-shared (or the household changed), and the client drops it — the only
    -- way a reader ever learns, since an invisible row cannot be sent.
    -- `kind` is the stored generated column, so posts_kind_idx serves this.
    'peerNotes', coalesce(
      (select jsonb_agg(p3.id) from public.posts p3 where p3.kind = 'note' and p3.user_id <> me),
      '[]'::jsonb
    )
  );
end;
$$;
