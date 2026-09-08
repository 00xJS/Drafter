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

grant usage on schema public, auth, storage to anon, authenticated, service_role;
grant all on all tables in schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
