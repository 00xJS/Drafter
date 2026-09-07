-- Per-user integration secrets: Google Calendar OAuth tokens and the personal
-- calendar-feed token. One row per Supabase user. No RLS policies on purpose:
-- only the Netlify functions (service role) read or write it — a browser
-- session never sees another user's tokens, nor its own.
create table if not exists public.user_settings (
  user_id uuid primary key references auth.users (id) on delete cascade,
  google_email text,
  google_refresh_token text,
  google_drafter_calendar_id text,
  google_oauth_state text,
  google_state_at timestamptz,
  feed_token text unique,
  updated_at timestamptz not null default now()
);

alter table public.user_settings enable row level security;

create or replace function public.touch_user_settings()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists user_settings_touch on public.user_settings;
create trigger user_settings_touch before update on public.user_settings
  for each row execute function public.touch_user_settings();
