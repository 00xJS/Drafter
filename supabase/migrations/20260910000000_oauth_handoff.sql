-- The iOS app cannot run an OAuth consent flow inside its own web view: the
-- callback must land in Safari, which has its own cookie jar. So the app asks
-- the API for a one-time handoff token and opens /api/<provider>/start?h=…
-- in Safari; that route redeems the token, sets the cookie there and forwards
-- to the provider. Service-role only, like every other secret in this table.
alter table public.user_settings
  add column if not exists oauth_handoff text,
  add column if not exists oauth_handoff_at timestamptz;

create index if not exists user_settings_oauth_handoff_idx on public.user_settings (oauth_handoff);
