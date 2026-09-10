-- v3.7: the column the hourly digest has been writing since fix-first 8.
--
-- shared/digest.mjs returns `nudgedNext` ({ personId | placeId: dayKey }) so a
-- name repeats at most every PERSON_NUDGE_GAP_DAYS, and netlify/functions/
-- digest.mjs PATCHes it back as user_settings.nudged — but no migration ever
-- created the column. PostgREST rejects the whole PATCH body, lib/backup.mjs's
-- rest() throws on the non-2xx, and digest.mjs's per-user catch swallows it.
--
-- last_digest_day and last_due_check ride in that same body, so neither
-- watermark has ever persisted: production shows both null on every row. The
-- damage is currently invisible only because no account has push or the email
-- digest turned on — the digest computes lines and sends nothing. Turn either
-- on and `last_digest_day !== day` stays true all day, so the morning digest
-- re-sends on every hourly run until midnight.
--
-- Lesson, same shape as the `id` variable that made sync_posts reject every
-- write: a green `db push` proves the migrations applied, not that the code
-- calling the schema agrees with it. scripts/db-smoke-assert.sql now asserts
-- every user_settings column the functions write actually exists.
alter table public.user_settings
  add column if not exists nudged jsonb not null default '{}'::jsonb;

comment on column public.user_settings.nudged is
  'personId|placeId -> dayKey of the last digest that named them; caps repeat nudges (shared/digest.mjs).';
