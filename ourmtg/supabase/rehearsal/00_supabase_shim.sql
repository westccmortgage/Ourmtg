-- Migration-rehearsal shim: the minimum Supabase-shaped surface our migrations depend on.
--
-- PURPOSE: let the real migration chain run against a throwaway local Postgres so syntax,
-- constraints, indexes, RLS flags, and grant revocation are proven BEFORE anything is applied
-- to a real project. This is a rehearsal harness — it is never applied to any real database.
--
-- WHAT THIS IS NOT: Supabase. It does not reproduce GoTrue, PostgREST role switching, the
-- storage API, or how RLS behaves under a real anon/authenticated JWT. Those still require a
-- real project. See CONVERSATIONAL-1003-DEPLOYMENT-REQUIREMENTS.md.

-- Browser-facing roles PostgREST connects as. Our migrations revoke privileges FROM these,
-- so they must exist for the revoke statements to be meaningful rather than silently skipped.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end;
$$;

create schema if not exists auth;
create schema if not exists storage;

-- Minimal stand-in for auth.users: only the columns our foreign keys reference.
create table if not exists auth.users (
  id                 uuid primary key default gen_random_uuid(),
  email              text,
  phone              text,
  email_confirmed_at timestamptz,
  confirmed_at       timestamptz,
  created_at         timestamptz not null default now()
);

-- RLS policies call auth.uid(). In real Supabase this reads the JWT claim; here it returns a
-- settable value so policy expressions at least parse and plan.
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

create table if not exists storage.buckets (
  id                 text primary key,
  name               text,
  public             boolean not null default false,
  file_size_limit    bigint,
  allowed_mime_types text[],
  owner              uuid,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create table if not exists storage.objects (
  id         uuid primary key default gen_random_uuid(),
  bucket_id  text references storage.buckets(id),
  name       text,
  owner      uuid,
  created_at timestamptz not null default now()
);
