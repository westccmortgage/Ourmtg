-- ============================================================
-- 037 — OurMTG portal invites (tokenized, expiring grant of portal_access).
--
-- FLOW (two halves of "mint/grant portal_access"):
--   1. portal-invite-create.mjs  (LO/owner-authed): creates a portal_invites row with
--      a random token, target role, and expiry. Emails the invite link. No grant yet.
--   2. portal-invite-accept.mjs  (portal-user-authed, after magic-link login): validates
--      the token (unused + unexpired + identity match), then MINTS portal_access +
--      upserts portal_users. The invite is single-use.
--
-- SECURITY
--   • Token is a 32-char random hex secret (server-generated), the sole credential of
--     the link. Bad/used/expired token → rejected before any grant.
--   • Identity binding on accept: the accepting auth user's VERIFIED email (or phone,
--     for phone invites) must match the invite target — a leaked link can't be redeemed
--     by a different logged-in user (mirrors the team-invite verified-email rule).
--   • Service-role writes only. Owners may read their own invites (RLS). Portal users
--     never read this table directly (accept happens server-side via service role).
--
-- Safe to re-run.
-- ============================================================

create table if not exists public.portal_invites (
  id            uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  loan_file_id  uuid not null references public.loan_files(id) on delete cascade,
  role          text not null check (role in ('borrower','coborrower','realtor')),
  token         text unique not null,
  email         text,
  phone         text,
  name          text,
  expires_at    timestamptz not null,
  accepted_at   timestamptz,
  accepted_by   uuid references auth.users(id) on delete set null,
  created_by    uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now()
);

-- Hot path: token lookup on accept.
create index if not exists portal_invites_token on public.portal_invites(token);
-- Owner list view.
create index if not exists portal_invites_owner on public.portal_invites(owner_user_id, created_at desc);
create index if not exists portal_invites_file on public.portal_invites(loan_file_id);

alter table public.portal_invites enable row level security;

-- Owners can read their own invites (to show pending invites in the LO UI later).
drop policy if exists "own portal_invites" on public.portal_invites;
create policy "own portal_invites" on public.portal_invites
  for select using (auth.uid() = owner_user_id);

-- All writes (create / accept) are service-role only — no authenticated write policy.
