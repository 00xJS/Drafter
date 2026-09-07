-- Watermark for the "due now" nudge so a delayed or repeated scheduled run
-- neither duplicates a notification nor silently skips one.
alter table public.user_settings
  add column if not exists last_due_check timestamptz;
