-- The daily backups are no signed-in account's to read.
--
-- The nightly backup (netlify/functions/lib/backup.mjs) writes each account's
-- snapshot to media/backups/<user id>/<date>.json with the service key, so
-- those objects carry no owner. "household media select" (20260908050000)
-- lets any signed-in account read an object with no owner, which was meant for
-- photos uploaded before objects recorded one. It therefore handed every
-- account's snapshot, journal included, to every other signed-in account.
--
-- An object with no owner stays readable, except under backups/.
--
-- Nothing in the app reads backups/ as a signed-in user. Admin → Backups lists
-- and downloads the snapshots through the admin function, with the service key
-- and a five-minute signed URL, and no policy stops that.
--
-- Insert, update and delete are unchanged. The wardrobe's v3.14 media policy
-- keeps this exclusion.
drop policy if exists "household media select" on storage.objects;
create policy "household media select" on storage.objects for select to authenticated
  using (
    bucket_id = 'media'
    and (
      owner = auth.uid()
      or owner in (select public.household_user_ids())
      or (owner is null and name not like 'backups/%')
    )
  );
