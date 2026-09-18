-- v3.17: a private note is not inherited, and a purge tombstone may still be written.
--
-- Two holes v3.16 left. Both are about a note whose audience is per record
-- meeting code that still decides by kind alone.
--
-- ## An heir must not inherit what was never shared
--
-- admin_prepare_user_deletion deletes the target's personal kinds and hands
-- everything else to the heir. `note` is not a personal kind and should not
-- become one — a SHARED note is genuinely household work, and passing it on is
-- right, the same as a task. But since v3.16 most notes are nobody's but their
-- author's, and "everything else" handed those to the heir: into their Notes
-- list, their ICS feed, their nightly backup and their MCP tools. In a
-- household of two the heir is simply the other person.
--
-- So the question is asked of the record, not the kind. An unshared note is
-- deleted with the personal rows; a shared one is reassigned with the tasks.
--
-- The `personal` array is unchanged, so shared/kinds.mjs PERSONAL_KINDS and
-- src/__tests__/srv-kinds.test.ts still agree with it. The note rule sits
-- beside it, because it is a different kind of rule.
--
-- History goes further: EVERY note version of the target's is deleted, shared
-- note or not. v3.15 made posts_history owner-only saying "a version's
-- audience cannot be decided later without re-deciding every version — share a
-- note edited privately for a fortnight and each draft would go with it". That
-- argument does not stop being true because the author's account is closing.
-- The note passes to the heir if it was shared; the drafts it used to be do not.
--
-- ## A purge tombstone carries the flag
--
-- "Delete forever" writes a content-free tombstone (purgeTombstone in
-- src/sync.ts): kind, id, stamps, and empty fields. For a note that means no
-- `shared`, so v3.16's `with check` refused it from anyone but the owner, and
-- the row sat dirty for good. The client now copies the flag onto the
-- tombstone, which is the real fix; this migration only records why, because
-- the policy is what refused it and a future reader will look here first.

create or replace function public.admin_prepare_user_deletion(target uuid, heir uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  personal constant text[] := array['journal', 'review', 'calendar', 'habit', 'routine', 'garment', 'outfit', 'wear', 'meal'];
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

  -- every version of every note goes, shared or not: a draft's audience was
  -- never decided, and deciding it now is what v3.15 refused to do
  delete from public.posts_history h
   where h.user_id = target
     and (coalesce(h.data ->> 'kind', 'task') = any (personal)
          or coalesce(h.data ->> 'kind', 'task') = 'note');
  get diagnostics history_removed = row_count;
  update public.posts_history h set user_id = heir where h.user_id = target;
  get diagnostics history_moved = row_count;

  delete from public.posts p
   where p.user_id = target
     and (coalesce(p.data ->> 'kind', 'task') = any (personal)
          or (coalesce(p.data ->> 'kind', 'task') = 'note' and coalesce(p.data ->> 'shared', 'false') <> 'true'));
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
