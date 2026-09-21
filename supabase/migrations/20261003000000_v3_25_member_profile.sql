-- v3.25: a member has a face.
--
-- Settings held one thing about you — the name the household sees — and every
-- surface that had to draw you took the first two letters of it. A photo is
-- one column: the id of an object in the media bucket, uploaded by the app the
-- way a note's photo is.
--
-- It is deliberately NOT a personal/<user id>/ object. The whole point of the
-- picture is that the other member sees it on a task you were handed, so it
-- goes in the household-readable part of the bucket, which the 20260923000000
-- policies already describe. Nothing else about it is new: the app uploads it,
-- the nightly sweep leaves it alone (that sweep only ever looks inside
-- personal/), and clearing it writes null.
--
-- user_settings has no RLS policies on purpose — only the Netlify functions
-- (service role) read or write it — so this column is reached exactly the way
-- display_name already is, through /api/household.

alter table public.user_settings
  add column if not exists avatar_media_id text;

comment on column public.user_settings.avatar_media_id is
  'Object id in the media bucket for this member''s picture, or null. Household-readable by design: a bare id, never under personal/.';
