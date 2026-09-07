-- Push subscriptions and digest preferences, per user.
alter table public.user_settings
  add column if not exists push_subscriptions jsonb not null default '[]'::jsonb,
  add column if not exists digest_email boolean not null default false,
  add column if not exists digest_hour integer not null default 8,
  add column if not exists timezone text,
  add column if not exists last_digest_day text,
  add column if not exists inbound_token text unique,
  add column if not exists display_name text;
