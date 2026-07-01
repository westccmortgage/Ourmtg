-- ============================================================
-- 038 — OurMTG team access + third-party roles + hardening.
--
-- WHAT THIS ADDS
--   1. portal_team — the LO's staff (processor / assistant). A team member gets
--      INTERNAL access to every loan file their owner owns: review queue, file
--      detail, document review, invites. Resolved in code (portal.mjs resolveAccess
--      short-circuits owner OR team → visibility 'owner'); writes stay service-role.
--   2. escrow / title — third-party MILESTONE-ONLY roles. Same structural position
--      as realtors: the 036 policies on loan_documents / loan_conditions require
--      visibility in ('borrower','coborrower'), so these new roles are automatically
--      blocked from financial data at the DB layer with zero policy changes.
--   3. Tightens the loan_messages read policy to borrower/co-borrower only. The
--      timeline includes document labels ("Uploaded: Bank statements — 2 months"),
--      which is financial context third parties (and realtors) don't need; no
--      current UI surface for them reads it.
--
-- Safe to re-run (create-if-not-exists + drop/create constraints and policies).
-- Apply AFTER 036 and 037.
-- ============================================================

-- ── portal_team ───────────────────────────────────────────────────────────────
-- owner_user_id  = the broker/LO (GRCRM auth user) whose files the member may work
-- member_user_id = the staff member's auth user (they sign in via magic link too)
create table if not exists public.portal_team (
  id             uuid primary key default gen_random_uuid(),
  owner_user_id  uuid not null references auth.users(id) on delete cascade,
  member_user_id uuid not null references auth.users(id) on delete cascade,
  role           text not null default 'processor'
                  check (role in ('processor','assistant')),
  created_at     timestamptz not null default now(),
  unique (owner_user_id, member_user_id)
);
create index if not exists portal_team_member on public.portal_team(member_user_id);
create index if not exists portal_team_owner  on public.portal_team(owner_user_id);
alter table public.portal_team enable row level security;

-- A member may see their own memberships; an owner may see their own team.
-- Writes (add/remove) are service-role only via portal-team-set.
drop policy if exists "own portal_team member" on public.portal_team;
create policy "own portal_team member" on public.portal_team
  for select using (auth.uid() = member_user_id);
drop policy if exists "own portal_team owner" on public.portal_team;
create policy "own portal_team owner" on public.portal_team
  for select using (auth.uid() = owner_user_id);

-- ── Third-party roles: escrow / title ─────────────────────────────────────────
-- Extend the role/visibility check constraints. Default Postgres names are
-- <table>_<column>_check (constraints were declared inline in 036/037).
alter table public.portal_users
  drop constraint if exists portal_users_role_check;
alter table public.portal_users
  add constraint portal_users_role_check
  check (role in ('borrower','coborrower','realtor','escrow','title'));

alter table public.portal_access
  drop constraint if exists portal_access_visibility_check;
alter table public.portal_access
  add constraint portal_access_visibility_check
  check (visibility in ('borrower','coborrower','realtor','escrow','title'));

alter table public.portal_invites
  drop constraint if exists portal_invites_role_check;
alter table public.portal_invites
  add constraint portal_invites_role_check
  check (role in ('borrower','coborrower','realtor','escrow','title'));

-- ── Harden loan_messages: timeline is borrower/co-borrower reading only ───────
drop policy if exists "portal read messages" on public.loan_messages;
create policy "portal read messages" on public.loan_messages for select using (
  exists (
    select 1 from public.portal_access pa
    where pa.loan_file_id = loan_messages.loan_file_id
      and pa.portal_user  = auth.uid()
      and pa.visibility in ('borrower','coborrower')
  )
);

-- Done. Team resolution, ad-hoc document requests, condition management, and
-- messaging all go through the gateway (service role) — no new write policies.
