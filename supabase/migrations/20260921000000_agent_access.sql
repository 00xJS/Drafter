-- v3.12: agent access. Assistants (Claude on the web and phone, Claude Code,
-- anything else that speaks MCP) reach a user's planner through /api/mcp with
-- a bearer token that belongs to that user and acts only as that user.
--
-- Three tables, all service-role only (RLS on, no policies, explicit grants —
-- supabase/config.toml documents that new public tables are no longer exposed
-- by default, so without the grant the service role itself would get 42501):
--
--   oauth_clients  apps that registered themselves (RFC 7591, public clients)
--   agent_tokens   one row per connection: a manual token from Settings →
--                  Assistants, or an OAuth grant with its rotating refresh token
--   oauth_codes    single-use authorization codes, five minutes each
--
-- Secrets are never stored: every token and code is kept as its SHA-256 hex
-- and looked up by equality. The functions below are the only multi-step
-- writes; each is one statement per outcome, so two requests racing on the
-- same token or code meet a row lock, not a half-done update.
--
-- The functions return jsonb rather than `returns table (user_id …, scopes …)`:
-- a RETURNS TABLE column is a PL/pgSQL variable, and a variable named after a
-- column of the table the body reads is the trap `id` was in sync_posts.

-- ------------------------------------------------------------------- tables
create table public.oauth_clients (
  client_id text primary key,                                   -- 'dcr_' + base64url(16 bytes)
  client_name text not null check (char_length(client_name) between 1 and 100),
  redirect_uris text[] not null check (cardinality(redirect_uris) between 1 and 5),
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  window_start timestamptz,
  window_count integer not null default 0                       -- token-endpoint throttle
);

create table public.agent_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null check (kind in ('token', 'oauth')),
  name text not null check (char_length(name) between 1 and 80),
  client_id text references public.oauth_clients (client_id) on delete cascade,
  redirect_host text,
  resource text,                                                -- '<site>/api/mcp' on oauth rows
  scopes text[] not null default array['read', 'write'] check (scopes <@ array['read', 'write', 'journal']),
  token_prefix text,                                            -- e.g. 'drft_Ab3x' (manual rows)
  access_hash text unique,                                      -- sha256 hex of the bearer
  access_expires_at timestamptz,                                -- null: a manual token, no expiry
  refresh_hash text unique,
  prev_refresh_hash text,
  refreshed_at timestamptz,
  refresh_expires_at timestamptz,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  window_start timestamptz,
  window_count integer not null default 0,
  revoked_at timestamptz,
  check ((kind = 'oauth') = (client_id is not null))
);

create index agent_tokens_user_idx on public.agent_tokens (user_id) where revoked_at is null;
-- a refresh token presented after its rotation is looked up here (grace retry, or reuse)
create index agent_tokens_prev_refresh_idx on public.agent_tokens (prev_refresh_hash) where prev_refresh_hash is not null;

create table public.oauth_codes (
  code_hash text primary key,
  client_id text not null references public.oauth_clients (client_id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  redirect_uri text not null,
  code_challenge text not null,
  scopes text[] not null,
  resource text not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  grant_id uuid references public.agent_tokens (id) on delete cascade
);

create index oauth_codes_expires_idx on public.oauth_codes (expires_at);

alter table public.oauth_clients enable row level security;   -- no policies: service role only
alter table public.agent_tokens enable row level security;
alter table public.oauth_codes enable row level security;

revoke all on public.oauth_clients, public.agent_tokens, public.oauth_codes from anon, authenticated;
grant select, insert, update, delete on public.oauth_clients, public.agent_tokens, public.oauth_codes to service_role;

-- ---------------------------------------------------------------- functions

-- A bearer on /api/mcp: the live, unexpired connection it belongs to, with
-- last_used_at stamped and a one-minute request window advanced. Null when
-- the hash matches nothing usable. `over_limit` is the caller's to act on.
create or replace function public.agent_token_use(p_hash text, p_limit integer default 60)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  hit jsonb;
begin
  update public.agent_tokens t
     set last_used_at = now(),
         window_count = case when t.window_start > now() - interval '1 minute' then t.window_count + 1 else 1 end,
         window_start = case when t.window_start > now() - interval '1 minute' then t.window_start else now() end
   where t.access_hash = p_hash
     and t.revoked_at is null
     and (t.access_expires_at is null or t.access_expires_at > now())
  returning jsonb_build_object(
    'grant_id', t.id,
    'user_id', t.user_id,
    'scopes', to_jsonb(t.scopes),
    'kind', t.kind,
    'over_limit', t.window_count > p_limit
  ) into hit;
  return hit;
end;
$$;

-- Redeem an authorization code exactly once. A second redemption means the
-- code leaked (RFC 6749 §4.1.2): the connection the first one made is revoked.
create or replace function public.oauth_redeem_code(p_hash text)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  hit jsonb;
  leaked_grant uuid;
begin
  update public.oauth_codes c
     set used_at = now()
   where c.code_hash = p_hash
     and c.used_at is null
     and c.expires_at > now()
  returning jsonb_build_object(
    'outcome', 'ok',
    'client_id', c.client_id,
    'user_id', c.user_id,
    'redirect_uri', c.redirect_uri,
    'code_challenge', c.code_challenge,
    'scopes', to_jsonb(c.scopes),
    'resource', c.resource
  ) into hit;
  if hit is not null then
    return hit;
  end if;

  select c.grant_id into leaked_grant
    from public.oauth_codes c
   where c.code_hash = p_hash and c.used_at is not null;
  if found then
    update public.agent_tokens t set revoked_at = now() where t.id = leaked_grant and t.revoked_at is null;
    return jsonb_build_object('outcome', 'reused');
  end if;
  return jsonb_build_object('outcome', 'invalid');
end;
$$;

-- Remember which connection a code made, so a replay of the code can revoke it.
create or replace function public.oauth_attach_grant(p_hash text, p_grant uuid)
returns boolean
language plpgsql
set search_path = public
as $$
begin
  update public.oauth_codes c set grant_id = p_grant where c.code_hash = p_hash and c.grant_id is null;
  return found;
end;
$$;

-- Refresh-token rotation (OAuth 2.1 §4.3.1):
--   1. the current refresh token rotates: new access and refresh hashes, the old one kept as prev;
--   2. the previous one again, within the grace window of that rotation (a client that never saw
--      the response and retried), rotates again — the pair it missed dies;
--   3. the previous one after that window is a replay by someone else: the connection is revoked;
--   4. anything else is invalid.
create or replace function public.agent_token_rotate(
  p_client_id text,
  p_refresh_hash text,
  p_new_access_hash text,
  p_new_refresh_hash text,
  p_access_ttl interval default '1 hour',
  p_refresh_ttl interval default '90 days',
  p_grace interval default '60 seconds'
)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  hit jsonb;
begin
  update public.agent_tokens t
     set prev_refresh_hash = t.refresh_hash,
         refresh_hash = p_new_refresh_hash,
         access_hash = p_new_access_hash,
         access_expires_at = now() + p_access_ttl,
         refresh_expires_at = now() + p_refresh_ttl,
         refreshed_at = now()
   where t.refresh_hash = p_refresh_hash
     and t.client_id = p_client_id
     and t.revoked_at is null
     and (t.refresh_expires_at is null or t.refresh_expires_at > now())
  returning jsonb_build_object('outcome', 'rotated', 'grant_id', t.id, 'user_id', t.user_id, 'scopes', to_jsonb(t.scopes)) into hit;
  if hit is not null then
    return hit;
  end if;

  -- refreshed_at is left alone: the grace window runs from the first rotation, not from each retry
  update public.agent_tokens t
     set refresh_hash = p_new_refresh_hash,
         access_hash = p_new_access_hash,
         access_expires_at = now() + p_access_ttl,
         refresh_expires_at = now() + p_refresh_ttl
   where t.prev_refresh_hash = p_refresh_hash
     and t.client_id = p_client_id
     and t.revoked_at is null
     and t.refreshed_at > now() - p_grace
  returning jsonb_build_object('outcome', 'rotated', 'grant_id', t.id, 'user_id', t.user_id, 'scopes', to_jsonb(t.scopes)) into hit;
  if hit is not null then
    return hit;
  end if;

  update public.agent_tokens t
     set revoked_at = now()
   where t.prev_refresh_hash = p_refresh_hash
     and t.revoked_at is null
  returning jsonb_build_object('outcome', 'reused', 'grant_id', t.id, 'user_id', t.user_id, 'scopes', to_jsonb(t.scopes)) into hit;
  if hit is not null then
    return hit;
  end if;
  return jsonb_build_object('outcome', 'invalid');
end;
$$;

-- The token endpoint's per-client throttle: the client, with last_used_at
-- stamped and a one-minute window advanced. Null for an unknown client.
create or replace function public.oauth_client_use(p_client_id text, p_limit integer default 30)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  hit jsonb;
begin
  update public.oauth_clients k
     set last_used_at = now(),
         window_count = case when k.window_start > now() - interval '1 minute' then k.window_count + 1 else 1 end,
         window_start = case when k.window_start > now() - interval '1 minute' then k.window_start else now() end
   where k.client_id = p_client_id
  returning jsonb_build_object(
    'client_id', k.client_id,
    'client_name', k.client_name,
    'redirect_uris', to_jsonb(k.redirect_uris),
    'over_limit', k.window_count > p_limit
  ) into hit;
  return hit;
end;
$$;

-- Housekeeping, run on every registration: codes a day past expiry, and
-- clients a week old that never completed a grant.
create or replace function public.oauth_prune()
returns void
language plpgsql
set search_path = public
as $$
begin
  delete from public.oauth_codes c where c.expires_at < now() - interval '1 day';
  delete from public.oauth_clients k
   where k.created_at < now() - interval '7 days'
     and not exists (select 1 from public.agent_tokens t where t.client_id = k.client_id);
end;
$$;

revoke execute on function public.agent_token_use(text, integer) from public, anon, authenticated;
revoke execute on function public.oauth_redeem_code(text) from public, anon, authenticated;
revoke execute on function public.oauth_attach_grant(text, uuid) from public, anon, authenticated;
revoke execute on function public.agent_token_rotate(text, text, text, text, interval, interval, interval) from public, anon, authenticated;
revoke execute on function public.oauth_client_use(text, integer) from public, anon, authenticated;
revoke execute on function public.oauth_prune() from public, anon, authenticated;

grant execute on function public.agent_token_use(text, integer) to service_role;
grant execute on function public.oauth_redeem_code(text) to service_role;
grant execute on function public.oauth_attach_grant(text, uuid) to service_role;
grant execute on function public.agent_token_rotate(text, text, text, text, interval, interval, interval) to service_role;
grant execute on function public.oauth_client_use(text, integer) to service_role;
grant execute on function public.oauth_prune() to service_role;
