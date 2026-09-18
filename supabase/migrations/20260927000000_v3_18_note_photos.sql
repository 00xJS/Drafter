-- v3.18: a photo is as private as the record it is in.
--
-- v3.16 made a note private until its owner shares it, and said the database
-- decides so that "no screen, export, agent or future feature can leak one by
-- forgetting to filter". That was true of the note's TEXT and false of its
-- pictures. A note photo uploads to the media bucket under a bare uid
-- (src/media.ts saveMedia, called with no options from RichNotes.tsx), and
-- "household media select" (20260923000000) granted every household member
-- select on every bare id. So a housemate could not read the note, and could
-- download the payslip pasted into it — and delete it.
--
-- The obvious fix is the wrong one. The policy's FIRST branch is
-- `owner = auth.uid()`, so the personal/ prefix hides an object from PEERS,
-- not from its uploader. That is why it works for garments, which are never
-- shared. Filing note photos under personal/ would make every genuinely shared
-- note's pictures unreadable by the person it was shared with.
--
-- ## What this does instead
--
-- Nothing moves. A trigger records which media ids each record references, and
-- the storage policy asks whether the caller can read a record that references
-- this object. A photo's audience becomes its record's, automatically, with
-- nothing to keep in step.
--
-- The read path has NO security definer in it: storage.objects consults
-- post_media, whose policy consults posts, whose "household access" policy is
-- evaluated as the caller. So v3.16 remains the one thing that decides who may
-- read a note, and this file does not restate that rule anywhere.
--
-- ## Why added_by exists
--
-- Without it, a housemate could paste <img data-media="<your id>"> into a note
-- of their own, share it, and read your photo. `added_by = storage.objects.owner`
-- means a reference only counts when the hand that put it in the record is the
-- hand that uploaded the object.
--
-- This is not theoretical. `authenticated` holds INSERT, UPDATE and DELETE on
-- public.posts (checked on the live project), so a member can write to the
-- table directly over PostgREST without going through sync_posts — and
-- sync_posts is the only thing that forces user_id = me. The "household
-- access" with check merely requires user_id in household_user_ids(), so a
-- member can author a row attributed to a peer. Any scheme keying off the
-- ROW's owner rather than the REFERENCE's author is therefore mintable.
--
-- ## Deliberately not covered
--
-- A photo a peer already downloaded is in their IndexedDB and their browser
-- cache. Un-sharing drops the record from their device; it cannot reach blobs
-- they already hold. Nothing here pretends otherwise.

-- ------------------------------------------------------------ the index
create table if not exists public.post_media (
  post_id  text not null references public.posts(id) on delete cascade,
  -- not a foreign key: storage.objects is Supabase's, and a reference may be
  -- written before its upload lands (the offline queue in src/media.ts)
  media_id text not null,
  -- who put this reference here, which is the whole of the anti-forgery rule
  added_by uuid,
  primary key (post_id, media_id)
);
create index if not exists post_media_media_idx on public.post_media (media_id);
alter table public.post_media enable row level security;
grant select on public.post_media to authenticated;
-- on delete cascade: the nightly hard-delete of aged tombstones
-- (netlify/functions/lib/backup.mjs) takes the references with it, so there is
-- no second sweep to forget. Same shape as purged_ids in 20260920000000.

-- --------------------------------------------------- where a media id can be
-- Four places, all of them checked against the client:
--   data.body        a note's rich text          (RichNotes.tsx:122)
--   data.notesHtml   a project's pad, same editor (types.ts:162)
--   data.mediaIds[]  a task's images             (taskeditor/Images.tsx:35)
--   data.attachments[].id  a task's files        (taskeditor/Attachments.tsx:20)
--
-- A kind that stores an id somewhere new makes those photos peer-invisible
-- until this function learns the field — the same shape of trap as the
-- sync_posts allowlist, and loud in the safe direction. The smoke block has a
-- case per field so a forgotten one fails there first.
create or replace function public.record_media_ids(data jsonb)
returns text[] language sql immutable as $$
  select coalesce(array_agg(distinct id), '{}')
  from (
    select m[1] as id
      from regexp_matches(coalesce(data ->> 'body', '') || coalesce(data ->> 'notesHtml', ''),
                          'data-media="([^"]+)"', 'g') m
    union all
    select jsonb_array_elements_text(
             case when jsonb_typeof(data -> 'mediaIds') = 'array' then data -> 'mediaIds' else '[]'::jsonb end)
    union all
    select a ->> 'id'
      from jsonb_array_elements(
             case when jsonb_typeof(data -> 'attachments') = 'array' then data -> 'attachments' else '[]'::jsonb end) a
  ) s
  -- bare ids only: no body may name personal/<someone>/… or a backups/… snapshot
  -- and pull it into anyone's view
  where id is not null and id <> '' and id not like '%/%'
$$;

-- ------------------------------------------------------------ the trigger
create or replace function public.post_media_index()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  ids   text[] := public.record_media_ids(new.data);
  -- auth.uid() is the hand actually holding the session. The fallback is for a
  -- service-key writer; nothing writes a body that way today (inbound.mjs
  -- writes tasks with no media, digest.mjs writes reviews, the MCP server uses
  -- the user's own JWT), and if one ever does its references are attributed to
  -- the row's owner — worth knowing before writing such a thing.
  actor uuid := coalesce(auth.uid(), new.user_id);
begin
  delete from public.post_media m where m.post_id = new.id and not (m.media_id = any(ids));
  insert into public.post_media (post_id, media_id, added_by)
  select new.id, x, actor from unnest(ids) x
  -- keeps the FIRST hand: a peer editing a shared note does not re-attribute a
  -- photo they did not paste
  on conflict (post_id, media_id) do nothing;
  return null;
end $$;

-- AFTER, so posts_lww and the history capture have already had their say. Two
-- triggers rather than one: an INSERT trigger's WHEN clause may not reference
-- OLD, and the UPDATE one must not fire on a write that leaves data alone
-- (household.mjs re-points user_id without touching it).
drop trigger if exists posts_media_index_ins on public.posts;
create trigger posts_media_index_ins after insert on public.posts
  for each row execute function public.post_media_index();
drop trigger if exists posts_media_index_upd on public.posts;
create trigger posts_media_index_upd after update on public.posts
  for each row when (new.data is distinct from old.data)
  execute function public.post_media_index();

-- Every media id already referenced by a record that exists. Without this,
-- every photo in every task and note written before today goes peer-invisible
-- on push and stays that way until that record is next edited.
--
-- A function rather than a bare statement so the smoke test can run the real
-- thing: at migration time `posts` is empty in the smoke cluster, so a bare
-- statement would ship untested. It is also the repair if the index is ever
-- suspected of having drifted — it only ever adds, so running it twice is safe.
--
-- `added_by` has to be guessed here, and the guess is the record's owner. For
-- a photo someone else uploaded into a record you own, the guess is wrong and
-- the photo goes owner-only: a broken image, never a leak. With no shared
-- notes at the time of writing this cannot bite in practice.
create or replace function public.post_media_backfill()
returns integer language plpgsql security definer set search_path = public as $$
declare added integer;
begin
  insert into public.post_media (post_id, media_id, added_by)
  select p.id, x, p.user_id from public.posts p, unnest(public.record_media_ids(p.data)) x
  on conflict (post_id, media_id) do nothing;
  get diagnostics added = row_count;
  return added;
end $$;

revoke execute on function public.post_media_backfill() from public, anon, authenticated;
grant execute on function public.post_media_backfill() to service_role;

select public.post_media_backfill();

-- ------------------------------------------------------------ the policies
-- A reference is readable when the record holding it is. Nothing else needs to
-- know the note rule.
drop policy if exists "media refs follow their record" on public.post_media;
create policy "media refs follow their record" on public.post_media
  for select to authenticated
  using (exists (select 1 from public.posts p where p.id = post_id));

-- The 20260923000000 body, with the blanket household branch — the leak —
-- replaced by one that asks whether a record vouches for this object.
drop policy if exists "household media select" on storage.objects;
create policy "household media select" on storage.objects for select to authenticated
  using (
    bucket_id = 'media'
    and (
      -- your own upload, wherever it lives
      owner = auth.uid()
      or (
        name not like 'personal/%'
        and name not like 'backups/%'
        and (
          exists (
            select 1 from public.post_media m
             where m.media_id = storage.objects.name
               and m.added_by = storage.objects.owner
          )
          -- objects written with the service key have no owner, as before
          or storage.objects.owner is null
        )
      )
    )
  );

-- Nothing in the app deletes or overwrites a bare id — deleteMedia is called
-- for garments only — so these need not be as open as they were. A housemate
-- could previously delete a photo out of your note; now only its uploader can.
drop policy if exists "household media update" on storage.objects;
create policy "household media update" on storage.objects for update to authenticated
  using (bucket_id = 'media' and owner = auth.uid())
  with check (
    bucket_id = 'media'
    and (name not like 'personal/%' or name like ('personal/' || auth.uid()::text || '/%'))
  );

drop policy if exists "household media delete" on storage.objects;
create policy "household media delete" on storage.objects for delete to authenticated
  using (bucket_id = 'media' and owner = auth.uid());
