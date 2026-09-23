-- v3.32: notices, the notification hub's records.
--
-- A notice tells one member what the other did to a task they share —
-- "Maria finished “Take bins out”" — or keeps the morning digest and an alarm
-- for whoever they went to, so one swiped away unread is still there in the
-- hub on Home. The server writes them (netlify/functions/notify.mjs and
-- digest.mjs) as the RECIPIENT's rows, so the kind is personal: nobody else
-- in the household reads a notice, not even the member it is about.
--
-- Two statements, both additive and safe to run twice:
--   * the kind, the v3.31 way: one row in record_kinds, nothing redefined;
--   * "Tell me when someone updates a task we share" (Settings → Reminders),
--     kept with the other push preferences in user_settings, which only the
--     service role reads. On unless switched off, as a row without it reads.
--
-- Apply it before the functions that write notices are deployed. Until then
-- they find the kind missing (record_kind_allowed) and write none, and a
-- preference sent to /api/push is not saved.

insert into public.record_kinds (kind, personal, shared_default)
values ('notice', true, null)
on conflict (kind) do nothing;

alter table public.user_settings
  add column if not exists notify_activity boolean not null default true;
