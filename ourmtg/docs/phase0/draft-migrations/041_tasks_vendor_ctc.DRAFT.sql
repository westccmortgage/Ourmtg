-- ============================================================================
-- DRAFT — DO NOT APPLY.  Phase 0 planning artifact (Phase 3 target, OWNER-GATED).
-- Objects: loan_tasks, loan_vendor_orders, loan_cash_to_close.
-- Build ONLY the pieces the owner confirms (summary §7 decisions #3/#4).
-- Reconciled against migrations 036–039. See docs/OURMTG-TARGET-DATA-MODEL.md B2/B4/B5.
-- Guarded non-runnable below; lives OUTSIDE supabase/migrations/.
-- ============================================================================
DO $$ BEGIN
  RAISE EXCEPTION 'DRAFT migration — not for execution. Owner must confirm scope before any 041 is authored.';
END $$;

-- ---------------------------------------------------------------------------
-- loan_tasks — stored, assignable tasks. DISTINCT from loan_conditions (which owns
-- the underwriting open/submitted/cleared lifecycle). Do not merge the two models.
-- ---------------------------------------------------------------------------
create table if not exists public.loan_tasks (
  id                uuid primary key default gen_random_uuid(),
  owner_user_id     uuid not null references auth.users(id) on delete cascade,
  loan_file_id      uuid not null references public.loan_files(id) on delete cascade,
  assignee_user_id  uuid references auth.users(id) on delete set null,  -- owner or portal_team member
  audience          text not null default 'team' check (audience in ('team','borrower')),
  title             text not null,
  detail            text,
  status            text not null default 'open' check (status in ('open','done','cancelled')),
  due_at            timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists loan_tasks_owner on public.loan_tasks (owner_user_id, status, due_at);
create index if not exists loan_tasks_file on public.loan_tasks (loan_file_id);
drop trigger if exists t_loan_tasks_upd on public.loan_tasks;
create trigger t_loan_tasks_upd before update on public.loan_tasks
  for each row execute function set_updated_at();

alter table public.loan_tasks enable row level security;
-- Internal read by owner; borrower-audience tasks readable by borrower/coborrower grant.
drop policy if exists "own loan_tasks" on public.loan_tasks;
create policy "own loan_tasks" on public.loan_tasks for select
  using (auth.uid() = owner_user_id);
drop policy if exists "borrower loan_tasks" on public.loan_tasks;
create policy "borrower loan_tasks" on public.loan_tasks for select
  using (
    audience = 'borrower' and exists (
      select 1 from public.portal_access pa
      where pa.loan_file_id = loan_tasks.loan_file_id
        and pa.portal_user = auth.uid()
        and pa.visibility in ('borrower','coborrower')
    )
  );

-- ---------------------------------------------------------------------------
-- loan_vendor_orders — appraisal/title/escrow/insurance status. Escrow/title exist today
-- only as milestone-only ACCESS roles (038); this adds tracked orders. Realtor/borrower
-- exposure is milestone-only through the gateway, never direct financial detail.
-- ---------------------------------------------------------------------------
create table if not exists public.loan_vendor_orders (
  id            uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  loan_file_id  uuid not null references public.loan_files(id) on delete cascade,
  vendor_type   text not null check (vendor_type in ('appraisal','title','escrow','insurance')),
  vendor_name   text,
  status        text not null default 'ordered' check (status in ('ordered','in_progress','received','cleared','cancelled')),
  ordered_at    timestamptz,
  received_at   timestamptz,
  detail        jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists loan_vendor_orders_file on public.loan_vendor_orders (loan_file_id, vendor_type);
drop trigger if exists t_loan_vendor_orders_upd on public.loan_vendor_orders;
create trigger t_loan_vendor_orders_upd before update on public.loan_vendor_orders
  for each row execute function set_updated_at();

alter table public.loan_vendor_orders enable row level security;
-- Internal-only direct read; milestone exposure is column-scoped via the gateway.
drop policy if exists "own loan_vendor_orders" on public.loan_vendor_orders;
create policy "own loan_vendor_orders" on public.loan_vendor_orders for select
  using (auth.uid() = owner_user_id);

-- ---------------------------------------------------------------------------
-- loan_cash_to_close — ACTUAL cash-to-close ledger (distinct from the client-side estimate
-- in BuildFile.jsx/Calculator.jsx). Borrower/coborrower exposure via gateway; never realtor.
-- ---------------------------------------------------------------------------
create table if not exists public.loan_cash_to_close (
  id            uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  loan_file_id  uuid not null references public.loan_files(id) on delete cascade,
  line_key      text not null,
  label         text not null,
  amount        numeric not null,
  direction     text not null check (direction in ('credit','charge')),
  source        text not null default 'manual',   -- LE | CD | manual
  as_of         date,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists loan_cash_to_close_file on public.loan_cash_to_close (loan_file_id);
drop trigger if exists t_loan_cash_to_close_upd on public.loan_cash_to_close;
create trigger t_loan_cash_to_close_upd before update on public.loan_cash_to_close
  for each row execute function set_updated_at();

alter table public.loan_cash_to_close enable row level security;
drop policy if exists "borrower loan_cash_to_close" on public.loan_cash_to_close;
create policy "borrower loan_cash_to_close" on public.loan_cash_to_close for select
  using (
    exists (
      select 1 from public.portal_access pa
      where pa.loan_file_id = loan_cash_to_close.loan_file_id
        and pa.portal_user = auth.uid()
        and pa.visibility in ('borrower','coborrower')
    )
  );

-- -- VERIFY (after a REAL apply) -------------------------------------------------
-- select count(*) from information_schema.tables where table_schema='public'
--   and table_name in ('loan_tasks','loan_vendor_orders','loan_cash_to_close'); -- expect 3
--
-- -- ROLLBACK -------------------------------------------------------------------
-- drop table if exists public.loan_cash_to_close;
-- drop table if exists public.loan_vendor_orders;
-- drop table if exists public.loan_tasks;
