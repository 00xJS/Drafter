-- Outlook / Microsoft 365 calendars. Unlike Google (one account per user),
-- several Microsoft accounts can be connected at once — a personal one and a
-- work one — so the tokens live in a jsonb array rather than single columns.
-- Service-role only, like every other secret in this table.
alter table public.user_settings
  add column if not exists microsoft_accounts jsonb not null default '[]'::jsonb,
  add column if not exists ms_oauth_state text,
  add column if not exists ms_state_at timestamptz;

create index if not exists user_settings_ms_state_idx on public.user_settings (ms_oauth_state);
