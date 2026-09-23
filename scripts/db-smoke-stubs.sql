-- Minimal stand-ins for what Supabase provides around our schema, so every
-- migration in supabase/migrations can be applied to a throwaway Postgres and
-- sync_posts exercised as a real role. Not a Supabase replacement: just enough
-- for the policies, the auth helpers and the storage policies to compile.

create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;

create schema auth;
create table auth.users (id uuid primary key, email text);
-- the JWT of the current request: the smoke test sets request.jwt.claims per transaction
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(auth.jwt() ->> 'sub', '')::uuid
$$;
create function auth.role() returns text language sql stable as $$
  select auth.jwt() ->> 'role'
$$;

create schema storage;
create table storage.buckets (id text primary key, name text, public boolean);
create table storage.objects (id uuid default gen_random_uuid() primary key, bucket_id text, name text, owner uuid);
alter table storage.objects enable row level security;
-- Supabase grants these for real; without them `set local role authenticated`
-- cannot touch the table, and the media policies could never be exercised
grant select, insert, update, delete on storage.objects to authenticated, service_role;

grant usage on schema public, auth, storage to anon, authenticated, service_role;

-- No default privileges on public. This file used to grant every new table
-- and function to anon, authenticated and service_role as it was created,
-- which is what Supabase did until it stopped: from 2026-10-30 a new public
-- table reaches none of those roles without an explicit GRANT
-- (supabase/config.toml, [api]). With the default here, a migration that
-- forgot its grants passed this test and then failed in production. Now a
-- table has exactly what its migrations grant, and db-smoke-assert.sql
-- (v3.33-1) holds every table to the list of what each role needs.
-- Functions keep Postgres's own default, EXECUTE for PUBLIC, until a
-- migration revokes it.
